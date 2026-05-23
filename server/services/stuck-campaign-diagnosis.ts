/**
 * Stuck-campaign diagnosis (Task #181).
 *
 * Detects campaigns that are silently stalled — i.e. neither making
 * progress nor surfacing an explicit `pause_reason` to the operator.
 * Used by both:
 *
 *   1. The expanded `runCampaignGuardianPoll` in `server/workers.ts`,
 *      which takes corrective action on every tick (re-enqueue, fail
 *      stale heartbeat, or pause with a precise reason); and
 *
 *   2. The admin endpoint `GET /api/admin/stuck-campaigns`, which
 *      returns the same per-campaign diagnosis for the UI / on-call
 *      operators, and feeds the per-reason Prometheus gauge
 *      `critsend_campaigns_stuck_total{reason="..."}`.
 *
 * The patterns covered here close every "stuck pending" gap observed
 * in the production incident that motivated this task — see
 * `docs/architecture-history.md` Task #181 for the forensic detail.
 *
 * All thresholds default to safe values but can be overridden via env
 * for emergency tuning. Out-of-range values fall back to the default.
 */

import { sql } from "drizzle-orm";
import { db } from "../db";

function envInt(name: string, defaultValue: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return defaultValue;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < min || v > max) return defaultValue;
  return Math.floor(v);
}

/** Minutes a scheduled campaign may sit past its scheduled_at without a job before we re-promote it. */
export const STUCK_SCHEDULED_MIN = envInt("STUCK_SCHEDULED_MIN", 10, 1, 24 * 60);
/** Minutes a `sending` campaign may have no active job before the guardian re-enqueues. Matches existing behavior. */
export const STUCK_SENDING_NO_JOB_MIN = envInt("STUCK_SENDING_NO_JOB_MIN", 2, 1, 24 * 60);
/** Minutes a `processing` job's heartbeat may be stale before we fail it and re-enqueue. */
export const STUCK_HEARTBEAT_STALE_MIN = envInt("STUCK_HEARTBEAT_STALE_MIN", 5, 1, 24 * 60);
/** Minutes a `sending` campaign may make zero progress (no sends/failures/defers) before mid-flight-crash branch fires. */
export const STUCK_NO_PROGRESS_MIN = envInt("STUCK_NO_PROGRESS_MIN", 10, 1, 24 * 60);
/** Maximum campaign-job retry_count before we stop auto-retrying and pause with `retry_budget_exceeded`. */
export const STUCK_MAX_JOB_RETRIES = envInt("STUCK_MAX_JOB_RETRIES", 10, 1, 100);
/**
 * Number of trailing failed jobs inspected when deciding whether
 * `retry_budget_exceeded` is an *infrastructure* incident (pool
 * timeout, lock timeout, …) rather than a *campaign-specific* failure
 * (MTA reject loop, content rejection, bounce burst). If all of the
 * last N error_messages carry the `transient=true` marker emitted by
 * `handleJobError`, we extend the budget instead of pausing — see
 * 2026-05-23 incident, campaign #3050.
 */
export const STUCK_TRANSIENT_LOOKBACK = envInt("STUCK_TRANSIENT_LOOKBACK", 5, 1, 50);
/**
 * Where to rewind `retry_count` to when we extend a transient retry
 * budget. We don't reset to 0 (that would mask a genuine fault loop);
 * we leave it `STUCK_MAX_JOB_RETRIES - this` short of the cap so a
 * fresh round of normal exponential backoff fires before re-triggering
 * the guardian. Default 2 → after extension, retry_count = 8 (10-2).
 */
export const STUCK_TRANSIENT_REWIND = envInt("STUCK_TRANSIENT_REWIND", 2, 1, 50);

export type StuckReason =
  | "scheduled_past_due_no_job"
  | "sending_no_active_job"
  | "sending_stale_heartbeat"
  | "sending_retry_budget_exceeded"
  | "sending_retry_budget_extended_transient"
  | "mid_flight_crash";

export type StuckAction =
  | "reenqueue"
  | "fail_job_and_reenqueue"
  | "pause_retry_budget_exceeded"
  | "extend_retry_budget_transient";

export interface StuckCampaign {
  id: string;
  name: string;
  status: string;
  pauseReason: string | null;
  reason: StuckReason;
  action: StuckAction;
  detail: string;
  jobId?: string | null;
  retryCount?: number | null;
}

/**
 * Single forensic snapshot: returns every campaign currently matching
 * any "stuck" pattern, with the diagnosis the guardian will act on.
 * Read-only — never mutates DB state.
 *
 * Each campaign appears at most once: the first matching branch in
 * priority order wins (scheduled → no-job → stale-heartbeat →
 * retry-exhausted → mid-flight-crash). This keeps the guardian's
 * per-tick action set unambiguous and the Prometheus gauge labels
 * non-overlapping.
 */
export async function diagnoseStuckCampaigns(): Promise<StuckCampaign[]> {
  const out: StuckCampaign[] = [];
  const seen = new Set<string>();

  // (1) Scheduled past-due, no job ever inserted.
  //     The scheduled-campaign poller normally promotes these inside
  //     STUCK_SCHEDULED_MIN minutes; if it didn't, treat as stuck.
  const scheduled = await db.execute(sql`
    SELECT c.id, c.name, c.status, c.pause_reason, c.scheduled_at
    FROM campaigns c
    WHERE c.status = 'scheduled'
      AND c.scheduled_at IS NOT NULL
      AND c.scheduled_at < NOW() - (${STUCK_SCHEDULED_MIN} || ' minutes')::interval
      AND NOT EXISTS (
        SELECT 1 FROM campaign_jobs cj
        WHERE cj.campaign_id = c.id
          AND cj.status IN ('pending', 'processing')
      )
  `);
  for (const r of scheduled.rows as Array<any>) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push({
      id: r.id,
      name: r.name,
      status: r.status,
      pauseReason: r.pause_reason ?? null,
      reason: "scheduled_past_due_no_job",
      action: "reenqueue",
      detail: `scheduled_at=${r.scheduled_at?.toISOString?.() ?? r.scheduled_at} is more than ${STUCK_SCHEDULED_MIN}min in the past with no pending/processing job`,
    });
  }

  // (2) `sending` with no active job (existing guardian branch).
  //     Excludes campaigns whose last job failed within
  //     STUCK_SENDING_NO_JOB_MIN minutes (retry-in-flight via
  //     enqueueCampaignJobWithRetry's next_retry_at delay).
  const sendingNoJob = await db.execute(sql`
    SELECT c.id, c.name, c.status, c.pause_reason
    FROM campaigns c
    WHERE c.status = 'sending'
      AND NOT EXISTS (
        SELECT 1 FROM campaign_jobs cj
        WHERE cj.campaign_id = c.id
          AND (
            cj.status IN ('pending', 'processing')
            OR (cj.status = 'failed' AND cj.completed_at > NOW() - (${STUCK_SENDING_NO_JOB_MIN} || ' minutes')::interval)
          )
      )
  `);
  for (const r of sendingNoJob.rows as Array<any>) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push({
      id: r.id,
      name: r.name,
      status: r.status,
      pauseReason: r.pause_reason ?? null,
      reason: "sending_no_active_job",
      action: "reenqueue",
      detail: `status='sending' but no pending/processing/recently-failed job within ${STUCK_SENDING_NO_JOB_MIN}min`,
    });
  }

  // (3) `sending` with only a `processing` job whose heartbeat is stale.
  //     The sender heartbeats every 30s (campaign-sender.ts
  //     HEARTBEAT_INTERVAL). Anything past STUCK_HEARTBEAT_STALE_MIN
  //     minutes means the worker is dead or wedged. We don't wait for
  //     the 30-min cleanupStaleJobs sweep — fail the job now and
  //     re-enqueue so progress resumes within one guardian tick.
  const staleHb = await db.execute(sql`
    SELECT c.id, c.name, c.status, c.pause_reason,
           cj.id AS job_id, cj.retry_count, cj.heartbeat
    FROM campaigns c
    JOIN campaign_jobs cj ON cj.campaign_id = c.id
    WHERE c.status = 'sending'
      AND cj.status = 'processing'
      AND (
        cj.heartbeat IS NULL
        OR cj.heartbeat < NOW() - (${STUCK_HEARTBEAT_STALE_MIN} || ' minutes')::interval
      )
      AND cj.started_at IS NOT NULL
      AND cj.started_at < NOW() - (${STUCK_HEARTBEAT_STALE_MIN} || ' minutes')::interval
      AND NOT EXISTS (
        SELECT 1 FROM campaign_jobs cj2
        WHERE cj2.campaign_id = c.id
          AND cj2.status = 'pending'
      )
  `);
  for (const r of staleHb.rows as Array<any>) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push({
      id: r.id,
      name: r.name,
      status: r.status,
      pauseReason: r.pause_reason ?? null,
      reason: "sending_stale_heartbeat",
      action: "fail_job_and_reenqueue",
      detail: `processing job ${r.job_id} heartbeat=${r.heartbeat ? new Date(r.heartbeat).toISOString() : "NULL"} is older than ${STUCK_HEARTBEAT_STALE_MIN}min`,
      jobId: r.job_id,
      retryCount: Number(r.retry_count ?? 0),
    });
  }

  // (4) `sending` with retry budget exhausted. handleJobError /
  //     handleJobCompletion stop re-enqueuing once retryUntil expires,
  //     but they leave the campaign in `status='sending'` with the last
  //     `campaign_jobs.status='failed'` and no successor — invisible to
  //     the user. Detect by retry_count >= STUCK_MAX_JOB_RETRIES with no
  //     pending successor.
  // 2026-05-23 incident (campaign #3050 Darel): a 3-hour Postgres pool
  // saturation triggered 13 consecutive job retries, ALL with the
  // `transient=true` marker — every error was "timeout exceeded when
  // trying to connect" on the main pool. The original guard fired
  // `pause_retry_budget_exceeded` and the campaign sat indefinitely
  // with 87k pending + 1M deferred until manual operator intervention,
  // even though by then the pool had been healthy for hours.
  //
  // Distinction: a campaign-specific failure (MTA reject loop, content
  // rejection, bounce burst) deserves the pause — it needs human
  // review. An infrastructure incident does not — once the pool/lock/
  // network recovers the same campaign-job retries succeed unchanged.
  // We inspect the trailing N error_messages and classify the burst.
  //
  // The `transient=true` marker is reliably emitted by
  // `handleJobError` (workers.ts) for every error classified by
  // `classifyDbError` as recoverable. Matching on this string is a
  // tight coupling but it's the existing wire format already written
  // to campaign_jobs.error_message for hundreds of thousands of rows.
  const retryExhausted = await db.execute(sql`
    SELECT
      c.id, c.name, c.status, c.pause_reason,
      cj.id AS job_id, cj.retry_count, cj.error_message,
      (
        SELECT array_agg(cj3.error_message ORDER BY cj3.completed_at DESC)
        FROM (
          SELECT cj2.error_message, cj2.completed_at
          FROM campaign_jobs cj2
          WHERE cj2.campaign_id = c.id AND cj2.status = 'failed'
          ORDER BY cj2.completed_at DESC NULLS LAST
          LIMIT ${STUCK_TRANSIENT_LOOKBACK}
        ) cj3
      ) AS recent_errors
    FROM campaigns c
    JOIN LATERAL (
      SELECT cj.id, cj.retry_count, cj.error_message, cj.completed_at
      FROM campaign_jobs cj
      WHERE cj.campaign_id = c.id AND cj.status = 'failed'
      ORDER BY cj.completed_at DESC NULLS LAST
      LIMIT 1
    ) cj ON TRUE
    WHERE c.status = 'sending'
      AND cj.retry_count >= ${STUCK_MAX_JOB_RETRIES}
      AND NOT EXISTS (
        SELECT 1 FROM campaign_jobs cj2
        WHERE cj2.campaign_id = c.id
          AND cj2.status IN ('pending', 'processing')
      )
  `);
  for (const r of retryExhausted.rows as Array<any>) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    const recent: string[] = Array.isArray(r.recent_errors) ? r.recent_errors.filter((x: unknown) => typeof x === "string") : [];
    const allTransient = recent.length >= STUCK_TRANSIENT_LOOKBACK && recent.every((m) => /transient=true/i.test(m));
    if (allTransient) {
      // Infrastructure incident: extend the budget, do not pause.
      out.push({
        id: r.id,
        name: r.name,
        status: r.status,
        pauseReason: r.pause_reason ?? null,
        reason: "sending_retry_budget_extended_transient",
        action: "extend_retry_budget_transient",
        detail: `last ${recent.length} failed jobs all carry transient=true (infrastructure incident, not campaign fault); rewinding retry_count ${r.retry_count}→${Math.max(0, STUCK_MAX_JOB_RETRIES - STUCK_TRANSIENT_REWIND)} and re-enqueuing with max backoff. Last error: ${String(r.error_message ?? "").slice(0, 200)}`,
        jobId: r.job_id,
        retryCount: Number(r.retry_count ?? 0),
      });
    } else {
      out.push({
        id: r.id,
        name: r.name,
        status: r.status,
        pauseReason: r.pause_reason ?? null,
        reason: "sending_retry_budget_exceeded",
        action: "pause_retry_budget_exceeded",
        detail: `last campaign_job ${r.job_id} retry_count=${r.retry_count} >= ${STUCK_MAX_JOB_RETRIES} with no successor; last error: ${String(r.error_message ?? "").slice(0, 200)}`,
        jobId: r.job_id,
        retryCount: Number(r.retry_count ?? 0),
      });
    }
  }

  // (5) Mid-flight crash: ghost-sweep blind spot. status='sending',
  //     started_at NOT NULL, campaign_sends rows exist, but the cached
  //     progress counters (sent + failed + deferred) haven't advanced
  //     in STUCK_NO_PROGRESS_MIN minutes AND no active job/heartbeat
  //     is in flight. We use the campaign's `updated_at` proxy — the
  //     COALESCE of `started_at`, the max completed_at of its jobs,
  //     and the max sent_at of its sends — to derive a "last progress"
  //     timestamp without a dedicated column.
  const midFlight = await db.execute(sql`
    SELECT c.id, c.name, c.status, c.pause_reason,
           c.started_at,
           c.last_send_at
    FROM campaigns c
    WHERE c.status = 'sending'
      AND c.started_at IS NOT NULL
      AND EXISTS (SELECT 1 FROM campaign_sends cs WHERE cs.campaign_id = c.id)
      AND NOT EXISTS (
        SELECT 1 FROM campaign_jobs cj
        WHERE cj.campaign_id = c.id
          AND (
            cj.status = 'pending'
            OR (cj.status = 'processing' AND (cj.heartbeat IS NULL OR cj.heartbeat > NOW() - (${STUCK_HEARTBEAT_STALE_MIN} || ' minutes')::interval))
            OR (cj.status = 'failed' AND cj.completed_at > NOW() - (${STUCK_SENDING_NO_JOB_MIN} || ' minutes')::interval)
          )
      )
      AND COALESCE(c.last_send_at, c.started_at)
          < NOW() - (${STUCK_NO_PROGRESS_MIN} || ' minutes')::interval
  `);
  for (const r of midFlight.rows as Array<any>) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    const last = r.last_send_at ?? r.started_at;
    out.push({
      id: r.id,
      name: r.name,
      status: r.status,
      pauseReason: r.pause_reason ?? null,
      reason: "mid_flight_crash",
      action: "reenqueue",
      detail: `last send/start at ${last ? new Date(last).toISOString() : "n/a"}; no progress for ≥${STUCK_NO_PROGRESS_MIN}min and no active job`,
    });
  }

  return out;
}

/**
 * Aggregate per-reason counts for the Prometheus gauge.
 */
export function countByReason(stuck: StuckCampaign[]): Record<StuckReason, number> {
  const counts: Record<StuckReason, number> = {
    scheduled_past_due_no_job: 0,
    sending_no_active_job: 0,
    sending_stale_heartbeat: 0,
    sending_retry_budget_exceeded: 0,
    sending_retry_budget_extended_transient: 0,
    mid_flight_crash: 0,
  };
  for (const s of stuck) counts[s.reason] = (counts[s.reason] ?? 0) + 1;
  return counts;
}
