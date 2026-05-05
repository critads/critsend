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

const TOKEN_CACHE_MAX = Number(process.env.TRACKING_TOKEN_CACHE_MAX || 50_000);
const tokenCache = new Map<string, ResolvedToken>();

function tokenCacheEvict(): void {
  if (tokenCache.size <= TOKEN_CACHE_MAX) return;
  const oldest = tokenCache.keys().next().value;
  if (oldest !== undefined) tokenCache.delete(oldest);
}

export async function resolveTrackingTokenViaTrackingPool(token: string): Promise<ResolvedToken | null> {
  if (tokenCache.has(token)) {
    const cached = tokenCache.get(token)!;
    tokenCache.delete(token);
    tokenCache.set(token, cached);
    trackingTokenCacheTotal.inc({ result: "hit" });
    return cached;
  }
  trackingTokenCacheTotal.inc({ result: "miss" });

  const sql = `SELECT type, campaign_id, subscriber_id, link_id
     FROM tracking_tokens WHERE token = $1`;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await trackingPool.query(sql, [token]);
      if (result.rows.length === 0) return null;
      const resolved: ResolvedToken = {
        type: result.rows[0].type,
        campaignId: result.rows[0].campaign_id,
        subscriberId: result.rows[0].subscriber_id,
        linkId: result.rows[0].link_id ?? null,
      };
      tokenCache.set(token, resolved);
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

export async function getCampaignTagsViaTrackingPool(campaignId: string): Promise<{
  openTag: string | null;
  clickTag: string | null;
  unsubscribeTag: string | null;
} | null> {
  const result = await trackingPool.query(
    `SELECT open_tag, click_tag, unsubscribe_tag
     FROM campaigns WHERE id = $1`,
    [campaignId],
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    openTag: row.open_tag || null,
    clickTag: row.click_tag || null,
    unsubscribeTag: row.unsubscribe_tag || null,
  };
}
