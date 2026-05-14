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
 * tables and corrects any drift. For engagement counters (unique_opens_count,
 * etc.) it uses direct assignment from campaign_stats so it can correct both
 * undercounts AND overcounts. It is idempotent and read-mostly: rows that
 * already match are not touched.
 *
 * Scope: by default we only reconcile campaigns whose latest tracking
 * activity (or send activity) is within the last RECONCILE_WINDOW_HOURS.
 * Pass `{ scope: "all" }` to walk the full table — used by the one-shot
 * recovery script.
 */

import { pool as mainPool, isInStartupGrace } from "../db";
import { logger } from "../logger";
import {
  counterDriftFixedTotal,
  counterDriftRunDurationMs,
  counterDriftLastRunAt,
} from "../metrics";

const effectivePool = mainPool;

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
/** Hard wall-clock budget per reconcile tick. If a single query is still
 *  running at this mark, the dedicated client is released back to the
 *  pool (terminating the in-flight statement_timeout) and the tick logs
 *  the offending stage. This guarantees the reconciler never holds a
 *  pool slot for the full 120 s pg statement_timeout. */
const RECONCILE_TICK_BUDGET_MS = Number(process.env.COUNTER_RECONCILE_TICK_BUDGET_MS || 30 * 1000);

type ReconcileStage =
  | "idle"
  | "sent_count"
  | "first_open_at"
  | "first_click_at"
  | "engagement_counters";

export async function reconcileCounters(
  options: { scope?: "recent" | "all" } = {},
): Promise<ReconcileResult> {
  const start = Date.now();
  const scope = options.scope ?? "recent";
  // Track which stage is currently running so the 30 s budget guard can
  // tell operators exactly which query stalled.
  let currentStage: ReconcileStage = "idle";
  let aborted = false;

  // Dedicated client so we can:
  //  (a) set a per-session `statement_timeout` slightly under the wall
  //      budget — the server-side hard kill that always wins;
  //  (b) capture `pg_backend_pid()` so the wall-clock guard can issue a
  //      `pg_cancel_backend()` from a fresh connection if the in-flight
  //      query refuses to honour statement_timeout (e.g. waiting on a
  //      socket read);
  //  (c) destroy the connection on abort by releasing it with an error,
  //      forcing pg-pool to close the underlying socket — Postgres then
  //      rolls back the in-flight statement immediately.
  const client = await effectivePool.connect();
  let backendPid: number | null = null;
  let clientReleased = false;
  const releaseClient = (err?: Error): void => {
    if (clientReleased) return;
    clientReleased = true;
    try { client.release(err as any); } catch { /* pool may already have evicted */ }
  };

  const guard = setTimeout(() => {
    aborted = true;
    logger.error(
      `[COUNTER RECONCILER] tick exceeded ${RECONCILE_TICK_BUDGET_MS}ms budget — stage=${currentStage} (scope=${scope}, pid=${backendPid ?? "?"}). ` +
        `Issuing pg_cancel_backend + destroying client to release the pool slot now.`,
    );
    // Best-effort server-side cancel from a separate, short-lived
    // connection — we don't await this, as the abort path must not
    // itself hold a pool slot for any meaningful duration.
    if (backendPid != null) {
      effectivePool
        .query(`SELECT pg_cancel_backend($1)`, [backendPid])
        .catch((err) =>
          logger.warn(`[COUNTER RECONCILER] pg_cancel_backend(${backendPid}) failed: ${err?.message || err}`),
        );
    }
    // Destroy the stalled client (release with an Error tells pg-pool
    // not to return it to the pool — it closes the socket, which
    // Postgres notices and aborts the running statement).
    releaseClient(new Error("reconciler tick budget exceeded"));
  }, RECONCILE_TICK_BUDGET_MS);
  guard.unref();
  const checkBudget = (): void => {
    if (aborted) {
      throw new Error(`[COUNTER RECONCILER] aborted at stage=${currentStage} (>${RECONCILE_TICK_BUDGET_MS}ms budget)`);
    }
  };

  // Per-session statement_timeout = budget − 5s safety margin. This is
  // the canonical termination path; the wall-clock guard above is the
  // backstop for cases where pg's own timer is delayed.
  const sessionTimeoutMs = Math.max(5000, RECONCILE_TICK_BUDGET_MS - 5000);
  try {
    await client.query(`SET statement_timeout = ${sessionTimeoutMs}`);
    const pidRow = await client.query(`SELECT pg_backend_pid() AS pid`);
    backendPid = Number(pidRow.rows[0]?.pid) || null;
  } catch (err) {
    clearTimeout(guard);
    releaseClient(err as Error);
    throw err;
  }

  // Recent-activity campaign set: any campaign with a send OR a tracking event
  // in the last RECONCILE_WINDOW_HOURS. Used as the gating set for all three
  // updates so that an old campaign with a fresh open/click still reconciles.
  //
  // Task #148: previously the `recent_campaigns` CTE was only applied as a
  // post-aggregation filter on the UPDATE row, but the `truth` CTE itself
  // still scanned the FULL `campaign_stats` table (~20M rows in prod) before
  // the join — tripping the pool's 120s statement_timeout. We now push the
  // recent-campaigns filter INTO every `truth` CTE so each scope-recent run
  // touches only the active subset (typically <100 campaigns).
  const recentCampaignsCte =
    scope === "all"
      ? ""
      : `WITH recent_campaigns AS (
          SELECT campaign_id FROM campaign_sends
            WHERE sent_at > NOW() - INTERVAL '${RECONCILE_WINDOW_HOURS} hours'
          UNION
          SELECT campaign_id FROM campaign_stats
            WHERE "timestamp" > NOW() - INTERVAL '${RECONCILE_WINDOW_HOURS} hours'
        ),`;
  // For scope=all we still need a leading WITH; the `truth` CTE supplies it.
  const truthLead = scope === "all" ? "WITH truth AS" : `${recentCampaignsCte} truth AS`;
  const inRecentRow = scope === "all" ? "" : `AND campaign_id IN (SELECT campaign_id FROM recent_campaigns)`;

  let sentCountFixed = 0;
  let firstOpenFixed = 0;
  let firstClickFixed = 0;
  let engagementCountersFixed = 0;
  try {
  // 1. campaigns.sent_count (fill-only — never reduces)
  currentStage = "sent_count";
  const sentRes = await client.query(
    `${truthLead} (
       SELECT campaign_id, COUNT(*)::bigint AS cnt
         FROM campaign_sends
        WHERE status = 'sent'
          ${inRecentRow}
        GROUP BY campaign_id
     )
     UPDATE campaigns c
        SET sent_count = truth.cnt
       FROM truth
      WHERE c.id = truth.campaign_id
        AND c.sent_count < truth.cnt`,
  );
  sentCountFixed = sentRes.rowCount ?? 0;
  checkBudget();

  // 2. campaign_sends.first_open_at
  currentStage = "first_open_at";
  const openRes = await client.query(
    `${truthLead} (
       SELECT campaign_id, subscriber_id, MIN("timestamp") AS first_ts
         FROM campaign_stats
        WHERE type = 'open'
          ${inRecentRow}
        GROUP BY campaign_id, subscriber_id
     )
     UPDATE campaign_sends cs
        SET first_open_at = truth.first_ts
       FROM truth
      WHERE cs.campaign_id = truth.campaign_id
        AND cs.subscriber_id = truth.subscriber_id
        AND cs.first_open_at IS NULL`,
  );
  firstOpenFixed = openRes.rowCount ?? 0;
  checkBudget();

  // 3. campaign_sends.first_click_at
  currentStage = "first_click_at";
  const clickRes = await client.query(
    `${truthLead} (
       SELECT campaign_id, subscriber_id, MIN("timestamp") AS first_ts
         FROM campaign_stats
        WHERE type = 'click'
          ${inRecentRow}
        GROUP BY campaign_id, subscriber_id
     )
     UPDATE campaign_sends cs
        SET first_click_at = truth.first_ts
       FROM truth
      WHERE cs.campaign_id = truth.campaign_id
        AND cs.subscriber_id = truth.subscriber_id
        AND cs.first_click_at IS NULL`,
  );
  firstClickFixed = clickRes.rowCount ?? 0;
  checkBudget();

  // 4. Cached engagement counters on campaigns.* — single UPDATE that re-derives
  currentStage = "engagement_counters";
  //    all six counters from campaign_stats via direct assignment. The truth
  //    from campaign_stats is always authoritative; if the cached counter
  //    drifted above truth (e.g. a bug in an earlier code version inflated
  //    unique_opens_count), this corrects it downward. Previous versions used
  //    GREATEST() (fill-only) which could never fix overcounts — resulting in
  //    >100% open rates on the /campaigns list.
  const engagementRes = await client.query(
    `${truthLead} (
       SELECT campaign_id,
              COUNT(*) FILTER (WHERE type = 'open')::bigint                          AS total_opens,
              COUNT(DISTINCT subscriber_id) FILTER (WHERE type = 'open')::bigint     AS unique_opens,
              COUNT(*) FILTER (WHERE type = 'click')::bigint                         AS total_clicks,
              COUNT(DISTINCT subscriber_id) FILTER (WHERE type = 'click')::bigint    AS unique_clicks,
              COUNT(DISTINCT subscriber_id) FILTER (WHERE type = 'unsubscribe')::bigint AS unsubscribes,
              COUNT(DISTINCT subscriber_id) FILTER (WHERE type = 'complaint')::bigint  AS complaints
         FROM campaign_stats
        WHERE TRUE
          ${inRecentRow}
        GROUP BY campaign_id
     )
     UPDATE campaigns c
        SET total_opens_count   = truth.total_opens,
            unique_opens_count  = truth.unique_opens,
            total_clicks_count  = truth.total_clicks,
            unique_clicks_count = truth.unique_clicks,
            unsubscribes_count  = truth.unsubscribes,
            complaints_count    = truth.complaints
       FROM truth
      WHERE c.id = truth.campaign_id
        AND ( c.total_opens_count   IS DISTINCT FROM truth.total_opens
           OR c.unique_opens_count  IS DISTINCT FROM truth.unique_opens
           OR c.total_clicks_count  IS DISTINCT FROM truth.total_clicks
           OR c.unique_clicks_count IS DISTINCT FROM truth.unique_clicks
           OR c.unsubscribes_count  IS DISTINCT FROM truth.unsubscribes
           OR c.complaints_count    IS DISTINCT FROM truth.complaints )`,
  );
  engagementCountersFixed = engagementRes.rowCount ?? 0;
  currentStage = "idle";
  } finally {
    clearTimeout(guard);
    // If we got here via the abort path, releaseClient was already
    // called with an error and this is a no-op. On the happy path,
    // releaseClient() returns the client cleanly to the pool.
    releaseClient(aborted ? new Error("reconciler aborted") : undefined);
  }

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

const RECONCILER_INITIAL_DELAY_MS = Number(process.env.COUNTER_RECONCILE_INITIAL_DELAY_MS || 5 * 60 * 1000);

export function startCounterReconciler(): void {
  if (timer) return;
  logger.info(`[COUNTER RECONCILER] started: initial delay=${RECONCILER_INITIAL_DELAY_MS}ms, interval=${RECONCILE_INTERVAL_MS}ms, window=${RECONCILE_WINDOW_HOURS}h`);

  setTimeout(() => {
    if (isInStartupGrace()) {
      logger.info("[COUNTER RECONCILER] Still in startup grace — deferring initial run");
      return;
    }
    reconcileCounters().catch((err) =>
      logger.error(`[COUNTER RECONCILER] initial run failed: ${err instanceof Error ? err.message : String(err)}`),
    );
  }, RECONCILER_INITIAL_DELAY_MS);

  timer = setInterval(() => {
    if (isInStartupGrace()) return;
    reconcileCounters().catch((err) =>
      logger.error(`[COUNTER RECONCILER] tick failed: ${err instanceof Error ? err.message : String(err)}`),
    );
  }, RECONCILE_INTERVAL_MS);
  timer.unref();
}

export function stopCounterReconciler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
