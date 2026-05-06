/**
 * Read-side queries for tracking endpoints.
 *
 * All tracking-route lookups (token resolution, campaign-tag lookups) MUST
 * go through the dedicated trackingPool — never the main pool. That is the
 * whole point of having a separate tracking pool: a campaign-blast pixel
 * firehose cannot be allowed to drain the main pool's connection budget
 * (login / dashboard / imports must stay responsive).
 *
 * These helpers mirror the small subset of `storage.*` calls the tracking
 * routes need, but issue queries against `trackingPool`.
 */
import { trackingPool } from "./tracking-pool";
import { isPoolCheckoutError } from "./db";
import { TrackingPoolUnavailableError } from "./tracking-buffer";
import { trackingTokenCacheTotal } from "./metrics";
import { logger } from "./logger";

type ResolvedToken = {
  type: string;
  campaignId: string;
  subscriberId: string;
  linkId: string | null;
};

const MISS_SENTINEL: unique symbol = Symbol("MISS");
type CacheEntry = ResolvedToken | typeof MISS_SENTINEL;

const TOKEN_CACHE_MAX = Number(process.env.TRACKING_TOKEN_CACHE_MAX || 50_000);
const NEGATIVE_TTL_MS = 30_000;

const tokenCache = new Map<string, CacheEntry>();
const negativeTTL = new Map<string, number>();
const tokenInflight = new Map<string, Promise<ResolvedToken | null>>();

function tokenCacheEvict(): void {
  if (tokenCache.size <= TOKEN_CACHE_MAX) return;
  const oldest = tokenCache.keys().next().value;
  if (oldest !== undefined) {
    tokenCache.delete(oldest);
    negativeTTL.delete(oldest);
  }
}

export async function resolveTrackingTokenViaTrackingPool(token: string): Promise<ResolvedToken | null> {
  const cached = tokenCache.get(token);
  if (cached !== undefined) {
    if (cached === MISS_SENTINEL) {
      const expiresAt = negativeTTL.get(token);
      if (expiresAt !== undefined && Date.now() > expiresAt) {
        tokenCache.delete(token);
        negativeTTL.delete(token);
      } else {
        tokenCache.delete(token);
        tokenCache.set(token, cached);
        trackingTokenCacheTotal.inc({ result: "hit" });
        return null;
      }
    } else {
      tokenCache.delete(token);
      tokenCache.set(token, cached);
      trackingTokenCacheTotal.inc({ result: "hit" });
      return cached;
    }
  }
  trackingTokenCacheTotal.inc({ result: "miss" });

  const existing = tokenInflight.get(token);
  if (existing) return existing;

  const promise = _resolveTokenFromDB(token).finally(() => tokenInflight.delete(token));
  tokenInflight.set(token, promise);
  return promise;
}

async function _resolveTokenFromDB(token: string): Promise<ResolvedToken | null> {
  const sql = `SELECT type, campaign_id, subscriber_id, link_id
     FROM tracking_tokens WHERE token = $1`;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await trackingPool.query(sql, [token]);
      if (result.rows.length === 0) {
        tokenCache.set(token, MISS_SENTINEL);
        negativeTTL.set(token, Date.now() + NEGATIVE_TTL_MS);
        tokenCacheEvict();
        return null;
      }
      const resolved: ResolvedToken = {
        type: result.rows[0].type,
        campaignId: result.rows[0].campaign_id,
        subscriberId: result.rows[0].subscriber_id,
        linkId: result.rows[0].link_id ?? null,
      };
      tokenCache.set(token, resolved);
      negativeTTL.delete(token);
      tokenCacheEvict();
      return resolved;
    } catch (err) {
      lastErr = err;
      if (!isPoolCheckoutError(err)) throw err;
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, 100));
        logger.warn(
          `[TRACKING QUERIES] resolveTrackingToken(${token}) tracking-pool checkout timeout — retrying once`,
        );
        continue;
      }
    }
  }
  throw new TrackingPoolUnavailableError(
    `Tracking pool unavailable resolving token ${token} after retry`,
    lastErr,
  );
}

export function getTokenCacheStats(): { size: number; max: number } {
  return { size: tokenCache.size, max: TOKEN_CACHE_MAX };
}

export async function warmTokenCache(): Promise<number> {
  try {
    const result = await trackingPool.query(
      `SELECT t.token, t.type, t.campaign_id, t.subscriber_id, t.link_id
       FROM tracking_tokens t
       INNER JOIN campaigns c ON c.id = t.campaign_id
       WHERE c.status IN ('sending', 'paused', 'completed')
         AND c.created_at > NOW() - INTERVAL '7 days'
       ORDER BY c.status = 'sending' DESC, c.status = 'paused' DESC, t.campaign_id
       LIMIT $1`,
      [TOKEN_CACHE_MAX],
    );

    let loaded = 0;
    for (const row of result.rows) {
      if (tokenCache.size >= TOKEN_CACHE_MAX) break;
      const resolved: ResolvedToken = {
        type: row.type,
        campaignId: row.campaign_id,
        subscriberId: row.subscriber_id,
        linkId: row.link_id ?? null,
      };
      tokenCache.set(row.token, resolved);
      loaded++;
    }

    logger.info(`[TRACKING QUERIES] Token cache warmed: ${loaded} tokens loaded for active campaigns`);
    return loaded;
  } catch (err: any) {
    logger.warn(`[TRACKING QUERIES] Token cache warming failed (non-fatal): ${err?.message || err}`);
    return 0;
  }
}

export async function warmLinkCache(): Promise<number> {
  try {
    const { primeLinkCache } = await import("./tracking-buffer");
    const LINK_CACHE_MAX = Number(process.env.TRACKING_LINK_CACHE_MAX || 5_000);

    const result = await trackingPool.query(
      `SELECT cl.id, cl.destination_url
       FROM campaign_links cl
       INNER JOIN campaigns c ON c.id = cl.campaign_id
       WHERE c.status IN ('sending', 'paused', 'completed')
         AND c.created_at > NOW() - INTERVAL '7 days'
       ORDER BY c.status = 'sending' DESC, c.status = 'paused' DESC, cl.campaign_id
       LIMIT $1`,
      [LINK_CACHE_MAX],
    );

    const entries: Array<[string, string]> = result.rows.map(
      (row: any) => [row.id, row.destination_url] as [string, string],
    );
    primeLinkCache(entries);

    logger.info(`[TRACKING QUERIES] Link cache warmed: ${entries.length} destinations loaded for active campaigns`);
    return entries.length;
  } catch (err: any) {
    logger.warn(`[TRACKING QUERIES] Link cache warming failed (non-fatal): ${err?.message || err}`);
    return 0;
  }
}

const CAMPAIGN_TAGS_CACHE_MAX = 5_000;
type CampaignTags = { openTag: string | null; clickTag: string | null; unsubscribeTag: string | null };
const campaignTagsCache = new Map<string, CampaignTags>();
const campaignTagsInflight = new Map<string, Promise<CampaignTags | null>>();

export async function getCampaignTagsViaTrackingPool(campaignId: string): Promise<CampaignTags | null> {
  const cached = campaignTagsCache.get(campaignId);
  if (cached) {
    campaignTagsCache.delete(campaignId);
    campaignTagsCache.set(campaignId, cached);
    return cached;
  }

  const existing = campaignTagsInflight.get(campaignId);
  if (existing) return existing;

  const promise = _fetchCampaignTagsFromDB(campaignId).finally(() => campaignTagsInflight.delete(campaignId));
  campaignTagsInflight.set(campaignId, promise);
  return promise;
}

async function _fetchCampaignTagsFromDB(campaignId: string): Promise<CampaignTags | null> {
  const result = await trackingPool.query(
    `SELECT open_tag, click_tag, unsubscribe_tag
     FROM campaigns WHERE id = $1`,
    [campaignId],
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  const tags: CampaignTags = {
    openTag: row.open_tag || null,
    clickTag: row.click_tag || null,
    unsubscribeTag: row.unsubscribe_tag || null,
  };
  campaignTagsCache.set(campaignId, tags);
  if (campaignTagsCache.size > CAMPAIGN_TAGS_CACHE_MAX) {
    const oldest = campaignTagsCache.keys().next().value;
    if (oldest !== undefined) campaignTagsCache.delete(oldest);
  }
  return tags;
}
