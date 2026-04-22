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

export async function resolveTrackingTokenViaTrackingPool(token: string): Promise<{
  type: string;
  campaignId: string;
  subscriberId: string;
  linkId: string | null;
} | null> {
  const result = await trackingPool.query(
    `SELECT type, campaign_id, subscriber_id, link_id
     FROM tracking_tokens WHERE token = $1`,
    [token],
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    type: row.type,
    campaignId: row.campaign_id,
    subscriberId: row.subscriber_id,
    linkId: row.link_id ?? null,
  };
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
