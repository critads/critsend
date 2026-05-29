/**
 * campaigns-list-cache.ts — short in-process cache for the /api/campaigns
 * list response, with cross-process invalidation.
 *
 * Why: `GET /api/campaigns` is the heaviest read on the web DB pool (a
 * count(*), a join, and an aggregate over campaign_sends ~67M rows) and the
 * page polls it while any campaign is "sending", multiplied by every open
 * tab. Under load that self-saturated the pool and the load-shed middleware
 * returned 503 ("Serveur momentanément occupé"). Caching the list response
 * for a few minutes means one DB read serves every client until a campaign
 * actually changes — the live sent/failed/pending counters keep flowing to
 * connected clients over SSE (see client/src/hooks/use-job-stream.ts), so a
 * short cache is invisible in practice.
 *
 * Pattern mirrors analytics-ops.ts (getAnalyticsCached / publish /
 * subscribe) so split-process mode (web + worker) stays consistent: writes
 * happen in the worker but reads happen in the web process — each has its
 * own in-process cache, so invalidation fans out over Redis pub/sub.
 *
 * Invalidation is wired into the campaign STATE-transition write paths
 * (create / update / delete / atomic status change), NOT the per-send
 * counter increments (finalizeSend, incrementCampaign*Count). That keeps the
 * cache alive during active sending — exactly when protection matters most —
 * while still dropping it the moment a campaign is created, launched,
 * edited, paused, completed, or removed.
 */
import { logger } from "../logger";

const CACHE_TTL_MS = Number(process.env.CAMPAIGNS_LIST_CACHE_TTL_MS || 3 * 60 * 1000); // 3 minutes

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

function pruneExpired(now: number): void {
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key);
  }
}

/**
 * Build a stable cache key from the list query parameters. Dates are
 * serialised to epoch millis so two equal bounds always hash identically.
 */
export function buildCampaignsListCacheKey(params: {
  page: number;
  limit: number;
  search?: string;
  originalsOnly: boolean;
  scheduledFrom?: Date;
  scheduledTo?: Date;
}): string {
  return JSON.stringify({
    p: params.page,
    l: params.limit,
    s: params.search ?? "",
    o: params.originalsOnly ? 1 : 0,
    f: params.scheduledFrom ? params.scheduledFrom.getTime() : 0,
    t: params.scheduledTo ? params.scheduledTo.getTime() : 0,
  });
}

/**
 * Read-through cache. Pass `forceRefresh=true` (e.g. `?refresh=true`) to
 * bypass the lookup; the recomputed value still repopulates the cache.
 */
export async function getCampaignsListCached<T>(
  key: string,
  fn: () => Promise<T>,
  forceRefresh = false,
): Promise<T> {
  const now = Date.now();
  if (!forceRefresh) {
    const hit = cache.get(key);
    if (hit && hit.expiresAt > now) return hit.value as T;
  }
  const value = await fn();
  cache.set(key, { value, expiresAt: now + CACHE_TTL_MS });
  if (cache.size > 200) pruneExpired(now);
  return value;
}

/**
 * Clear the *local* in-process cache. In split-process mode use
 * `publishCampaignsListInvalidation()` so the web instance (which serves the
 * reads) also drops its copy when a worker mutates a campaign.
 */
export function invalidateCampaignsListCache(): void {
  cache.clear();
}

const CAMPAIGNS_LIST_INVALIDATION_CHANNEL = "campaigns-list-invalidation";

/**
 * Cross-process invalidation. Clears the local cache immediately and, when
 * Redis is configured, fans the invalidation out so every process (web +
 * worker + any clustered web instances) drops its cache. Best-effort: a
 * failed publish never blocks the calling write.
 */
export function publishCampaignsListInvalidation(): void {
  invalidateCampaignsListCache();
  try {
    // Lazy-require so this module stays usable in unit tests without Redis.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { redisConnection, isRedisConfigured } = require("../redis");
    if (isRedisConfigured && redisConnection) {
      redisConnection
        .publish(CAMPAIGNS_LIST_INVALIDATION_CHANNEL, "1")
        .catch(() => { /* best-effort fan-out */ });
    }
  } catch {
    // Redis module unavailable — local-only invalidation is the best we can do.
  }
}

/**
 * Subscribe a *dedicated* Redis subscriber connection to the invalidation
 * channel. Subscriptions block the connection from issuing other commands,
 * so callers must pass a connection used only for pub/sub. Call once from
 * server/index.ts (web) — the same dedicated subscriber already used for the
 * SSE bridge and analytics invalidation.
 */
export function startCampaignsListInvalidationSubscriber(redisSubscriber: any): void {
  redisSubscriber.subscribe(CAMPAIGNS_LIST_INVALIDATION_CHANNEL);
  redisSubscriber.on("message", (channel: string, _message: string) => {
    if (channel !== CAMPAIGNS_LIST_INVALIDATION_CHANNEL) return;
    invalidateCampaignsListCache();
  });
  logger.info(`[CAMPAIGNS_CACHE] Invalidation subscriber started (ttl=${CACHE_TTL_MS}ms)`);
}
