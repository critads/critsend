/**
 * analytics-ops.ts — bootstrap, rollup, and short-cache helpers for analytics.
 *
 * Three responsibilities:
 *   1. runAnalyticsBootstrapMigrations() — idempotent CREATE INDEX CONCURRENTLY
 *      for the four composite/secondary indexes that every analytics route
 *      depends on. Safe to call repeatedly; safe to fire-and-forget on startup.
 *   2. runAnalyticsRollup(days) — rebuild the analytics_daily rollup for the
 *      last N days. Called from the worker scheduler and from the manual
 *      /api/analytics/rollup endpoint.
 *   3. getAnalyticsCached / invalidateAnalyticsCache — 5-minute in-process
 *      cache mirroring the segment-count pattern, used by all heavy analytics
 *      routes. `?refresh=true` callers invalidate and re-read.
 */
import { pool } from "../db";
import { logger } from "../logger";

// ─────────────────────────────────────────────────────────────────────────────
// Index bootstrap
// ─────────────────────────────────────────────────────────────────────────────

const REQUIRED_INDEXES: Array<{ name: string; ddl: string }> = [
  {
    name: "campaign_stats_campaign_type_idx",
    ddl: `CREATE INDEX CONCURRENTLY IF NOT EXISTS campaign_stats_campaign_type_idx
          ON campaign_stats (campaign_id, type)`,
  },
  {
    name: "campaign_stats_timestamp_idx",
    ddl: `CREATE INDEX CONCURRENTLY IF NOT EXISTS campaign_stats_timestamp_idx
          ON campaign_stats (timestamp)`,
  },
  {
    name: "campaign_sends_sent_at_idx",
    ddl: `CREATE INDEX CONCURRENTLY IF NOT EXISTS campaign_sends_sent_at_idx
          ON campaign_sends (sent_at)`,
  },
  {
    name: "subscribers_import_date_idx",
    ddl: `CREATE INDEX CONCURRENTLY IF NOT EXISTS subscribers_import_date_idx
          ON subscribers (import_date)`,
  },
];

let bootstrapStarted = false;

/**
 * Fire-and-forget. CREATE INDEX CONCURRENTLY can take many minutes on a
 * 14M-row table, so we never await this on the request path. The
 * `IF NOT EXISTS` guard makes this idempotent across restarts.
 *
 * Each statement runs on its own pool connection — CONCURRENTLY is rejected
 * inside an explicit transaction, but pool.query() is autocommit per call.
 */
export function runAnalyticsBootstrapMigrations(): void {
  if (bootstrapStarted) return;
  bootstrapStarted = true;

  (async () => {
    for (const idx of REQUIRED_INDEXES) {
      const t0 = Date.now();
      try {
        await pool.query(idx.ddl);
        const ms = Date.now() - t0;
        logger.info(`[ANALYTICS_BOOTSTRAP] Index ready: ${idx.name} (${ms}ms)`);
      } catch (err: any) {
        // A previous failed CONCURRENTLY can leave an INVALID index behind.
        // Drop it and let the next startup retry. Don't crash the process.
        logger.warn(`[ANALYTICS_BOOTSTRAP] Failed to create ${idx.name}: ${err?.message || err}`);
        try {
          await pool.query(`DROP INDEX CONCURRENTLY IF EXISTS ${idx.name}`);
        } catch {
          /* ignore */
        }
      }
    }
    logger.info("[ANALYTICS_BOOTSTRAP] All required analytics indexes processed");
  })().catch((err) => {
    logger.error("[ANALYTICS_BOOTSTRAP] Unexpected bootstrap error", { error: String(err) });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Rollup
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Aggregate the last `days` days of campaign_sends + campaign_stats into the
 * analytics_daily rollup table. ON CONFLICT (date, campaign_id) DO UPDATE
 * makes this idempotent — a 7-day incremental rollup overwrites whatever the
 * previous 7-day rollup wrote, which is exactly what we want.
 *
 * Pass a large `days` value (e.g. 3650) for an initial all-time backfill.
 */
export async function runAnalyticsRollup(days: number): Promise<void> {
  const t0 = Date.now();

  await pool.query(
    `INSERT INTO analytics_daily (id, date, campaign_id, total_sent, total_delivered,
        total_opens, unique_opens, total_clicks, unique_clicks, total_bounces,
        total_unsubscribes, total_complaints, subscriber_growth, subscriber_churn, updated_at)
    SELECT
      gen_random_uuid(),
      d.date,
      d.campaign_id,
      COALESCE(sends.total_sent, 0),
      COALESCE(sends.total_delivered, 0),
      COALESCE(stats.total_opens, 0),
      COALESCE(stats.unique_opens, 0),
      COALESCE(stats.total_clicks, 0),
      COALESCE(stats.unique_clicks, 0),
      COALESCE(sends.total_bounces, 0),
      COALESCE(stats.total_unsubscribes, 0),
      COALESCE(stats.total_complaints, 0),
      0, 0, NOW()
    FROM (
      SELECT DISTINCT sent_at::date AS date, campaign_id
      FROM campaign_sends
      WHERE sent_at >= NOW() - $1::int * INTERVAL '1 day'
      UNION
      SELECT DISTINCT timestamp::date AS date, campaign_id
      FROM campaign_stats
      WHERE timestamp >= NOW() - $1::int * INTERVAL '1 day'
    ) d
    LEFT JOIN (
      SELECT
        sent_at::date AS date,
        campaign_id,
        COUNT(*)::int AS total_sent,
        COUNT(*) FILTER (WHERE status = 'sent')::int AS total_delivered,
        COUNT(*) FILTER (WHERE status = 'bounced')::int AS total_bounces
      FROM campaign_sends
      WHERE sent_at >= NOW() - $1::int * INTERVAL '1 day'
      GROUP BY sent_at::date, campaign_id
    ) sends ON sends.date = d.date AND sends.campaign_id = d.campaign_id
    LEFT JOIN (
      SELECT
        timestamp::date AS date,
        campaign_id,
        COUNT(*) FILTER (WHERE type = 'open')::int AS total_opens,
        COUNT(DISTINCT subscriber_id) FILTER (WHERE type = 'open')::int AS unique_opens,
        COUNT(*) FILTER (WHERE type = 'click')::int AS total_clicks,
        COUNT(DISTINCT subscriber_id) FILTER (WHERE type = 'click')::int AS unique_clicks,
        COUNT(*) FILTER (WHERE type = 'unsubscribe')::int AS total_unsubscribes,
        COUNT(*) FILTER (WHERE type = 'complaint')::int AS total_complaints
      FROM campaign_stats
      WHERE timestamp >= NOW() - $1::int * INTERVAL '1 day'
      GROUP BY timestamp::date, campaign_id
    ) stats ON stats.date = d.date AND stats.campaign_id = d.campaign_id
    ON CONFLICT (date, campaign_id) DO UPDATE SET
      total_sent = EXCLUDED.total_sent,
      total_delivered = EXCLUDED.total_delivered,
      total_opens = EXCLUDED.total_opens,
      unique_opens = EXCLUDED.unique_opens,
      total_clicks = EXCLUDED.total_clicks,
      unique_clicks = EXCLUDED.unique_clicks,
      total_bounces = EXCLUDED.total_bounces,
      total_unsubscribes = EXCLUDED.total_unsubscribes,
      total_complaints = EXCLUDED.total_complaints,
      updated_at = NOW()`,
    [days]
  );

  await pool.query(
    `INSERT INTO analytics_daily (id, date, campaign_id, total_sent, total_delivered,
        total_opens, unique_opens, total_clicks, unique_clicks, total_bounces,
        total_unsubscribes, total_complaints, subscriber_growth, subscriber_churn, updated_at)
    SELECT
      gen_random_uuid(), import_date::date, NULL,
      0, 0, 0, 0, 0, 0, 0, 0, 0,
      COUNT(*)::int, 0, NOW()
    FROM subscribers
    WHERE import_date >= NOW() - $1::int * INTERVAL '1 day'
    GROUP BY import_date::date
    ON CONFLICT (date, campaign_id) DO UPDATE SET
      subscriber_growth = EXCLUDED.subscriber_growth,
      updated_at = NOW()`,
    [days]
  );

  logger.info(`[ANALYTICS_ROLLUP] Completed for last ${days} days in ${Date.now() - t0}ms`);

  // Cached metrics derived from the rollup are now stale.
  // Use the cross-process publisher: rollup runs in the worker process but
  // analytics reads happen in the web process — each has its own in-memory
  // cache. publishAnalyticsInvalidation() clears the local cache and fans
  // the invalidation out via Redis so the web instance drops its cache too.
  publishAnalyticsInvalidation();
}

// ─────────────────────────────────────────────────────────────────────────────
// Short cache (mirrors getSegmentSubscriberCountCached pattern)
// ─────────────────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

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
 * Read-through cache. Pass `forceRefresh=true` to bypass the lookup; the
 * recomputed value still populates the cache for subsequent callers.
 */
export async function getAnalyticsCached<T>(
  key: string,
  fn: () => Promise<T>,
  forceRefresh = false
): Promise<T> {
  const now = Date.now();
  if (!forceRefresh) {
    const hit = cache.get(key);
    if (hit && hit.expiresAt > now) return hit.value as T;
  }
  const value = await fn();
  cache.set(key, { value, expiresAt: now + CACHE_TTL_MS });
  // Opportunistic cleanup so the map doesn't grow unbounded with stale keys.
  if (cache.size > 100) pruneExpired(now);
  return value;
}

/**
 * Invalidate by exact key, by prefix, or (no arg) the whole cache. Called
 * from the rollup completion hook and from any code path that materially
 * changes the underlying data (e.g. campaign send completion).
 *
 * IMPORTANT: this clears the *local* in-process cache only. In split-process
 * mode (web + worker), data-mutating events happen in the worker but reads
 * happen in the web process — each has its own cache. Use
 * `publishAnalyticsInvalidation()` instead to fan out via Redis pub/sub so
 * both processes drop their cached values.
 */
export function invalidateAnalyticsCache(prefix?: string): void {
  if (!prefix) {
    cache.clear();
    return;
  }
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}

const ANALYTICS_INVALIDATION_CHANNEL = "analytics-invalidation";

/**
 * Cross-process invalidation. Clears the local cache immediately and, when
 * Redis is wired up, publishes to a channel that both web and worker
 * processes subscribe to so every instance drops the same keys.
 */
export function publishAnalyticsInvalidation(prefix?: string): void {
  invalidateAnalyticsCache(prefix);
  // Lazy-require so this module remains usable in unit tests without Redis.
  // The worker-side publisher uses the regular ioredis client (not a
  // dedicated subscriber connection — only subscriptions need that).
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { redisConnection, isRedisConfigured } = require("../redis");
    if (isRedisConfigured && redisConnection) {
      redisConnection
        .publish(ANALYTICS_INVALIDATION_CHANNEL, JSON.stringify({ prefix: prefix ?? null }))
        .catch(() => { /* best-effort fan-out */ });
    }
  } catch {
    // Redis module unavailable — local-only invalidation is the best we can do.
  }
}

/**
 * Subscribe a *dedicated* Redis subscriber connection to the analytics
 * invalidation channel. Subscriptions block the connection from issuing
 * other commands, so callers must pass a connection used only for pub/sub.
 * Call once from server/index.ts (web) and worker-main.ts (worker).
 */
export function startAnalyticsInvalidationSubscriber(redisSubscriber: any): void {
  redisSubscriber.subscribe(ANALYTICS_INVALIDATION_CHANNEL);
  redisSubscriber.on("message", (channel: string, message: string) => {
    if (channel !== ANALYTICS_INVALIDATION_CHANNEL) return;
    try {
      const { prefix } = JSON.parse(message) as { prefix: string | null };
      invalidateAnalyticsCache(prefix ?? undefined);
    } catch {
      // Malformed message — drop entire cache to be safe.
      invalidateAnalyticsCache();
    }
  });
}

export function parseRefreshFlag(query: any): boolean {
  return query?.refresh === "true" || query?.refresh === "1";
}
