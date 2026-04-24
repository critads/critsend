/**
 * Counter-drift reconciler.
 *
 * Some campaign analytics live in derived counter columns that are
 * maintained incrementally by the live send/track paths:
 *
 *   campaigns.sent_count            ← bumped by bulkFinalizeSends
 *   campaign_sends.first_open_at    ← marked by tracking-buffer flush
 *   campaign_sends.first_click_at   ← marked by tracking-buffer flush
 *
 * The source of truth for each is a different table:
 *
 *   campaigns.sent_count            ↔ COUNT(*) FROM campaign_sends WHERE status='sent'
 *   campaign_sends.first_open_at    ↔ MIN(timestamp) FROM campaign_stats WHERE type='open'
 *   campaign_sends.first_click_at   ↔ MIN(timestamp) FROM campaign_stats WHERE type='click'
 *
 * If the live path drops a write (process restart mid-flush, pool error,
 * silent exception), the counter silently reads 0 even though the raw
 * data is intact. The /campaigns analytics page then shows zeros.
 *
 * This worker periodically re-derives the counters from the source-of-truth
 * tables and fills in any gaps. It is idempotent and read-mostly: rows that
 * already match are not touched.
 *
 * Scope: by default we only reconcile campaigns whose latest tracking
 * activity (or send activity) is within the last RECONCILE_WINDOW_HOURS.
 * Pass `{ scope: "all" }` to walk the full table — used by the one-shot
 * recovery script.
 */

import { trackingPool } from "../tracking-pool";
import { pool as mainPool } from "../db";
import { TRACKING_POOL_MAX } from "../connection-budget";
import { logger } from "../logger";
import {
  counterDriftFixedTotal,
  counterDriftRunDurationMs,
  counterDriftLastRunAt,
} from "../metrics";

const effectivePool = TRACKING_POOL_MAX > 0 ? trackingPool : mainPool;

const RECONCILE_INTERVAL_MS = Number(process.env.COUNTER_RECONCILE_INTERVAL_MS || 15 * 60 * 1000);
const RECONCILE_WINDOW_HOURS = Number(process.env.COUNTER_RECONCILE_WINDOW_HOURS || 24);

export interface ReconcileResult {
  sentCountFixed: number;
  firstOpenFixed: number;
  firstClickFixed: number;
  engagementCountersFixed: number;
  durationMs: number;
}

/**
 * Run one pass of the reconciler. Safe to call concurrently with the live
 * tracking-buffer flush — every UPDATE is guarded so it only ever fills a
 * NULL or corrects a value that disagrees with the source-of-truth count.
 */
export async function reconcileCounters(
  options: { scope?: "recent" | "all" } = {},
): Promise<ReconcileResult> {
  const start = Date.now();
  const scope = options.scope ?? "recent";

  // Recent-activity campaign set: any campaign with a send OR a tracking event
  // in the last RECONCILE_WINDOW_HOURS. Used as the gating set for all three
  // updates so that an old campaign with a fresh open/click still reconciles.
  const recentCampaignsCte =
    scope === "all"
      ? ""
      : `, recent_campaigns AS (
          SELECT campaign_id FROM campaign_sends
            WHERE sent_at > NOW() - INTERVAL '${RECONCILE_WINDOW_HOURS} hours'
          UNION
          SELECT campaign_id FROM campaign_stats
            WHERE "timestamp" > NOW() - INTERVAL '${RECONCILE_WINDOW_HOURS} hours'
        )`;
  const inRecent = scope === "all" ? "" : `AND cs.campaign_id IN (SELECT campaign_id FROM recent_campaigns)`;
  const inRecentCampaign = scope === "all" ? "" : `AND c.id IN (SELECT campaign_id FROM recent_campaigns)`;

  // 1. campaigns.sent_count (fill-only — never reduces)
  const sentRes = await effectivePool.query(
    `WITH truth AS (
       SELECT campaign_id, COUNT(*)::bigint AS cnt
         FROM campaign_sends
        WHERE status = 'sent'
        GROUP BY campaign_id
     )${recentCampaignsCte}
     UPDATE campaigns c
        SET sent_count = truth.cnt
       FROM truth
      WHERE c.id = truth.campaign_id
        AND c.sent_count < truth.cnt
        ${inRecentCampaign}`,
  );
  const sentCountFixed = sentRes.rowCount ?? 0;

  // 2. campaign_sends.first_open_at
  const openRes = await effectivePool.query(
    `WITH truth AS (
       SELECT campaign_id, subscriber_id, MIN("timestamp") AS first_ts
         FROM campaign_stats
        WHERE type = 'open'
        GROUP BY campaign_id, subscriber_id
     )${recentCampaignsCte}
     UPDATE campaign_sends cs
        SET first_open_at = truth.first_ts
       FROM truth
      WHERE cs.campaign_id = truth.campaign_id
        AND cs.subscriber_id = truth.subscriber_id
        AND cs.first_open_at IS NULL
        ${inRecent}`,
  );
  const firstOpenFixed = openRes.rowCount ?? 0;

  // 3. campaign_sends.first_click_at
  const clickRes = await effectivePool.query(
    `WITH truth AS (
       SELECT campaign_id, subscriber_id, MIN("timestamp") AS first_ts
         FROM campaign_stats
        WHERE type = 'click'
        GROUP BY campaign_id, subscriber_id
     )${recentCampaignsCte}
     UPDATE campaign_sends cs
        SET first_click_at = truth.first_ts
       FROM truth
      WHERE cs.campaign_id = truth.campaign_id
        AND cs.subscriber_id = truth.subscriber_id
        AND cs.first_click_at IS NULL
        ${inRecent}`,
  );
  const firstClickFixed = clickRes.rowCount ?? 0;

  // 4. Cached engagement counters on campaigns.* — single UPDATE that re-derives
  //    all six counters from campaign_stats. Fill-only: only writes a column when
  //    the cached value is strictly LESS than the source-of-truth count, so the
  //    reconciler can never destroy real data on demo or partial-restore DBs.
  //
  //    The aggregate is heavy (full GROUP BY over campaign_stats) but it runs
  //    on the trackingPool every 15 min in the recent-window mode and only
  //    once per recovery in scope:"all" mode, so it never affects request-path
  //    latency.
  const engagementRes = await effectivePool.query(
    `WITH truth AS (
       SELECT campaign_id,
              COUNT(*) FILTER (WHERE type = 'open')::bigint                          AS total_opens,
              COUNT(DISTINCT subscriber_id) FILTER (WHERE type = 'open')::bigint     AS unique_opens,
              COUNT(*) FILTER (WHERE type = 'click')::bigint                         AS total_clicks,
              COUNT(DISTINCT subscriber_id) FILTER (WHERE type = 'click')::bigint    AS unique_clicks,
              COUNT(DISTINCT subscriber_id) FILTER (WHERE type = 'unsubscribe')::bigint AS unsubscribes,
              COUNT(DISTINCT subscriber_id) FILTER (WHERE type = 'complaint')::bigint  AS complaints
         FROM campaign_stats
        GROUP BY campaign_id
     )${recentCampaignsCte}
     UPDATE campaigns c
        SET total_opens_count   = GREATEST(c.total_opens_count,   truth.total_opens),
            unique_opens_count  = GREATEST(c.unique_opens_count,  truth.unique_opens),
            total_clicks_count  = GREATEST(c.total_clicks_count,  truth.total_clicks),
            unique_clicks_count = GREATEST(c.unique_clicks_count, truth.unique_clicks),
            unsubscribes_count  = GREATEST(c.unsubscribes_count,  truth.unsubscribes),
            complaints_count    = GREATEST(c.complaints_count,    truth.complaints)
       FROM truth
      WHERE c.id = truth.campaign_id
        AND ( c.total_opens_count   < truth.total_opens
           OR c.unique_opens_count  < truth.unique_opens
           OR c.total_clicks_count  < truth.total_clicks
           OR c.unique_clicks_count < truth.unique_clicks
           OR c.unsubscribes_count  < truth.unsubscribes
           OR c.complaints_count    < truth.complaints )
        ${inRecentCampaign}`,
  );
  const engagementCountersFixed = engagementRes.rowCount ?? 0;

  const durationMs = Date.now() - start;

  if (sentCountFixed > 0) counterDriftFixedTotal.inc({ counter: "sent_count" }, sentCountFixed);
  if (firstOpenFixed > 0) counterDriftFixedTotal.inc({ counter: "first_open_at" }, firstOpenFixed);
  if (firstClickFixed > 0) counterDriftFixedTotal.inc({ counter: "first_click_at" }, firstClickFixed);
  if (engagementCountersFixed > 0) counterDriftFixedTotal.inc({ counter: "engagement_counters" }, engagementCountersFixed);
  counterDriftRunDurationMs.set(durationMs);
  counterDriftLastRunAt.set(Math.floor(Date.now() / 1000));

  if (sentCountFixed + firstOpenFixed + firstClickFixed + engagementCountersFixed > 0) {
    logger.warn(
      `[COUNTER RECONCILER] fixed drift (scope=${scope}): sent_count=${sentCountFixed} first_open_at=${firstOpenFixed} first_click_at=${firstClickFixed} engagement=${engagementCountersFixed} in ${durationMs}ms`,
    );
  } else {
    logger.info(`[COUNTER RECONCILER] no drift (scope=${scope}, ${durationMs}ms)`);
  }

  return { sentCountFixed, firstOpenFixed, firstClickFixed, engagementCountersFixed, durationMs };
}

let timer: NodeJS.Timeout | null = null;

export function startCounterReconciler(): void {
  if (timer) return;
  // Stagger first run slightly to avoid colliding with startup spike.
  setTimeout(() => {
    reconcileCounters().catch((err) =>
      logger.error(`[COUNTER RECONCILER] initial run failed: ${err instanceof Error ? err.message : String(err)}`),
    );
  }, 60_000);

  timer = setInterval(() => {
    reconcileCounters().catch((err) =>
      logger.error(`[COUNTER RECONCILER] tick failed: ${err instanceof Error ? err.message : String(err)}`),
    );
  }, RECONCILE_INTERVAL_MS);
  timer.unref();
  logger.info(`[COUNTER RECONCILER] started: interval=${RECONCILE_INTERVAL_MS}ms, window=${RECONCILE_WINDOW_HOURS}h`);
}

export function stopCounterReconciler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
