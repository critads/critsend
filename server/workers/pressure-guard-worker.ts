/**
 * Pressure-guard deferred-drain worker (Task #144).
 *
 * Polls every 30s for campaign_sends rows where:
 *   status='pending' AND eligible_at IS NOT NULL AND eligible_at <= NOW()
 *
 * Rows are claimed FOR UPDATE SKIP LOCKED, ordered by campaigns.started_at
 * ASC NULLS FIRST (so the oldest campaign's deferred queue drains first —
 * FIFO across the whole platform), grouped by campaign, and re-CAS'd against
 * subscribers.last_sent_at. Winners are sent via the existing
 * sendEmailWithNullsink path; losers have their eligible_at bumped forward
 * by another window. Cascades infinitely (never gives up; no max_defer).
 *
 * Re-checks unsubscribe / suppression at dispatch time: if the contact has
 * the campaign's unsubscribeTag, the configured bounce tag ("BCK"), or
 * suppressed_until > NOW(), the row is force-failed instead of sent.
 */

import { sql } from "drizzle-orm";
import { db, pool } from "../db";
import { toPgTextArray } from "../utils/pg-array";
import { logger } from "../logger";
import { storage } from "../storage";
import { sendEmailWithNullsink } from "../email-service";
import { PRESSURE_WINDOW_HOURS, getPressureGuardBootstrapState } from "../services/pressure-guard";
import {
  pressureGuardSentAfterDeferTotal,
  pressureGuardPendingDeferred,
  pressureGuardDeferredIndexSizeBytes,
} from "../metrics";
import { LOCK_KEYS } from "../bootstrap-lock";
import type { Campaign, Mta, Subscriber } from "@shared/schema";
import crypto from "crypto";

// Task #149: stable per-process holder ID for lease-based leader election.
// Used to recognise our own lease rows when reclaiming an expired lease
// (so we can refresh in-place without bouncing between holders).
const LEADER_HOLDER_ID = `${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
const LEASE_TTL_MS = envInt("PRESSURE_LEADER_LEASE_TTL_MS", 60_000, 5_000, 5 * 60_000);
const LEASE_REFRESH_MS = Math.max(2_000, Math.floor(LEASE_TTL_MS / 3));

// Bounded env parser: rejects NaN / non-finite / out-of-range values and
// falls back to the supplied default. Prevents misconfiguration from
// turning the cadenced jobs into a tight loop (e.g. PRESSURE_MAINTENANCE_INTERVAL_MS=0)
// or from disabling them silently via "abc".
function envInt(name: string, defaultValue: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return defaultValue;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < min || v > max) {
    // eslint-disable-next-line no-console
    console.warn(`[PRESSURE_GUARD_WORKER] ignoring out-of-range ${name}=${raw}; using default ${defaultValue}`);
    return defaultValue;
  }
  return Math.floor(v);
}

const POLL_INTERVAL_MS = envInt("PRESSURE_GUARD_POLL_MS", 30_000, 1_000, 24 * 60 * 60_000);
const BATCH_PER_CAMPAIGN = envInt("PRESSURE_GUARD_BATCH", 200, 1, 100_000);
const MAX_CAMPAIGNS_PER_TICK = envInt("PRESSURE_GUARD_MAX_CAMPAIGNS", 5, 1, 1_000);
// Task #153: bounded-parallel drain. Each drainCampaign call peaks at ~2
// main-pool connections (claim txn + finalize txn) plus per-send work that
// is mostly SMTP I/O. With DRAIN_PARALLELISM=4 the per-tick peak DB
// footprint is ~8 connections — well within the 30-slot main pool.
// Default stays at 1 (current sequential behavior) to avoid regressing
// any existing deployment; opt-in by setting the env var (typically 4).
// Cap of 16 prevents runaway pool saturation if misconfigured.
const DRAIN_PARALLELISM = envInt("PRESSURE_GUARD_DRAIN_PARALLELISM", 1, 1, 16);
// Task #154: parallelize the SMTP send loop INSIDE drainCampaign. Previously
// the per-batch dispatch was a strict `for await` loop — every send waited
// for the previous SMTP RTT to complete, capping per-campaign throughput at
// ~1/(SMTP_RTT) sends/sec (~10 sends/sec for ~100ms RTT, i.e. 600/min/campaign).
// With DRAIN_PARALLELISM=4 that ceiling was ~2,400 sends/min cluster-wide —
// not enough to keep up with a 800k+ deferred backlog.
// SMTP send is pure I/O (Nodemailer pool handles connection reuse), so
// parallelizing N sends per campaign multiplies throughput linearly until
// either the MTA's max connections, the Nodemailer pool, or the network
// becomes the bottleneck. With DRAIN_PARALLELISM=4 × SMTP_CONCURRENCY=20,
// peak SMTP fan-out is 80 simultaneous sends across all in-flight campaigns,
// which fits comfortably in typical Nodemailer pool sizes (5-10 per MTA × 7 MTAs).
// Cap of 100 prevents runaway resource exhaustion if misconfigured.
const SMTP_CONCURRENCY = envInt("PRESSURE_GUARD_SMTP_CONCURRENCY", 20, 1, 100);
// Task #145 R3: refresh the index-size gauge hourly, but only run the
// expensive VACUUM (ANALYZE) + REINDEX policy once per day during the
// configured off-peak hour (default 03:00 server-local). Min 60s
// prevents tight-loop storms; max 7d caps gauge staleness.
// Cluster-wide once/day is enforced by a CAS UPDATE on
// pressure_maintenance_state.last_heavy_run_date (see runMaintenanceTick).
const MAINTENANCE_INTERVAL_MS = envInt("PRESSURE_MAINTENANCE_INTERVAL_MS", 60 * 60_000, 60_000, 7 * 24 * 60 * 60_000);
const MAINTENANCE_OFFPEAK_HOUR = envInt("PRESSURE_MAINTENANCE_OFFPEAK_HOUR", 3, 0, 23);
// Task #145 R15: audit TTL — drop pressure_flush_audit rows older than
// PRESSURE_FLUSH_AUDIT_RETENTION_DAYS (default 365).
const AUDIT_TTL_INTERVAL_MS = envInt("PRESSURE_AUDIT_TTL_INTERVAL_MS", 24 * 60 * 60_000, 60 * 60_000, 7 * 24 * 60 * 60_000);
const AUDIT_RETENTION_DAYS = envInt("PRESSURE_FLUSH_AUDIT_RETENTION_DAYS", 365, 1, 3650);

let pollInterval: NodeJS.Timeout | null = null;
let maintenanceInterval: NodeJS.Timeout | null = null;
let auditTtlInterval: NodeJS.Timeout | null = null;
let isPolling = false;

export function startPressureGuardWorker() {
  if (pollInterval) return;
  logger.info(`[PRESSURE_GUARD_WORKER] Starting (poll=${POLL_INTERVAL_MS}ms, batch=${BATCH_PER_CAMPAIGN}, max-campaigns=${MAX_CAMPAIGNS_PER_TICK}, drain-parallelism=${DRAIN_PARALLELISM}, smtp-concurrency=${SMTP_CONCURRENCY}, window=${PRESSURE_WINDOW_HOURS}h)`);
  pollInterval = setInterval(pollDeferredQueue, POLL_INTERVAL_MS);
  // Kick off after a short delay to let bootstrap run first.
  setTimeout(pollDeferredQueue, 5_000);
  // R3 + R15 cadenced background jobs (also leader-elected).
  maintenanceInterval = setInterval(runMaintenanceTick, MAINTENANCE_INTERVAL_MS);
  auditTtlInterval = setInterval(runAuditTtlTick, AUDIT_TTL_INTERVAL_MS);
  setTimeout(runMaintenanceTick, 30_000);
  setTimeout(runAuditTtlTick, 60_000);
}

export function stopPressureGuardWorker() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
  if (maintenanceInterval) {
    clearInterval(maintenanceInterval);
    maintenanceInterval = null;
  }
  if (auditTtlInterval) {
    clearInterval(auditTtlInterval);
    auditTtlInterval = null;
  }
  logger.info("[PRESSURE_GUARD_WORKER] Stopped");
}

/**
 * Task #149: lease-table-based leader election for cross-cluster
 * single-flighting of cadenced background jobs.
 *
 * Replaces the previous `withSessionLock` (built on session-level
 * `pg_try_advisory_lock`), which is fundamentally incompatible with
 * Neon's PgBouncer transaction-pooled endpoints: each `pg.Client.query`
 * is routed to a different physical backend, so the `acquire` and
 * `unlock` queries land on different connections. Acquired locks leak
 * indefinitely on the original backend (constated stuck PIDs in prod,
 * `application_name=pgbouncer`, idle, executing unrelated queries).
 *
 * The lease table approach is immune to this:
 *   • acquire/refresh/release are each a single atomic statement, so
 *     PgBouncer can route them to any backend without consequence;
 *   • leases self-recover after a node crash via the `expires_at` TTL;
 *   • holder identity is preserved across refreshes via `holder_id`.
 *
 * Usage: pass a numeric lock key (we reuse the same `LOCK_KEYS.*`
 * constants for label parity with logs and metrics). Returns the result
 * of `fn` when leadership is acquired, or `null` if another node holds
 * a fresh lease.
 */
async function withLeaderLease<T>(lockKey: number, label: string, fn: () => Promise<T>): Promise<T | null> {
  const lockKeyStr = `pressure_guard:${lockKey}`;
  const ttlMs = LEASE_TTL_MS;

  // Atomic acquire/reclaim: insert a fresh lease, OR steal one whose
  // `expires_at` has elapsed, OR refresh-in-place if we already hold it.
  // Returns at most one row whose `holder_id` equals ours iff we won.
  let acquired = false;
  try {
    const r = await pool.query<{ holder_id: string }>(
      `INSERT INTO pressure_guard_leader (lock_key, holder_id, expires_at)
       VALUES ($1, $2, NOW() + ($3 || ' milliseconds')::interval)
       ON CONFLICT (lock_key) DO UPDATE
       SET holder_id = EXCLUDED.holder_id,
           expires_at = EXCLUDED.expires_at
       WHERE pressure_guard_leader.expires_at < NOW()
          OR pressure_guard_leader.holder_id = EXCLUDED.holder_id
       RETURNING holder_id`,
      [lockKeyStr, LEADER_HOLDER_ID, String(ttlMs)],
    );
    acquired = r.rows[0]?.holder_id === LEADER_HOLDER_ID;
  } catch (err: any) {
    // Table may not exist yet on first boot before bootstrap has run —
    // log and bail (caller treats null as "not leader this tick").
    logger.warn(`[${label}] lease acquire failed (non-fatal, will retry next tick): ${err?.message || err}`);
    return null;
  }
  if (!acquired) return null;

  // Background refresh while `fn` runs. We CAS-refresh: only extend the
  // expiry if WE still hold the row, otherwise stop refreshing (we lost
  // ownership during a clock skew / previous tick straggler).
  let stopRefresh = false;
  const refreshTimer = setInterval(async () => {
    if (stopRefresh) return;
    try {
      const upd = await pool.query(
        `UPDATE pressure_guard_leader
         SET expires_at = NOW() + ($1 || ' milliseconds')::interval
         WHERE lock_key = $2 AND holder_id = $3
         RETURNING 1`,
        [String(ttlMs), lockKeyStr, LEADER_HOLDER_ID],
      );
      if ((upd.rowCount ?? 0) === 0) {
        // Lost ownership — stop refreshing; `fn` continues but the next
        // tick will re-elect cleanly.
        stopRefresh = true;
        logger.warn(`[${label}] lease refresh lost ownership of ${lockKeyStr} — another node took over`);
      }
    } catch (err: any) {
      logger.warn(`[${label}] lease refresh failed (non-fatal): ${err?.message || err}`);
    }
  }, LEASE_REFRESH_MS);
  refreshTimer.unref();

  try {
    return await fn();
  } finally {
    stopRefresh = true;
    clearInterval(refreshTimer);
    // Best-effort release: clear our row so another node can claim
    // immediately without waiting for the TTL.
    try {
      await pool.query(
        `UPDATE pressure_guard_leader
         SET expires_at = NOW()
         WHERE lock_key = $1 AND holder_id = $2`,
        [lockKeyStr, LEADER_HOLDER_ID],
      );
    } catch (err: any) {
      logger.warn(`[${label}] lease release failed (non-fatal, TTL will reclaim): ${err?.message || err}`);
    }
  }
}

async function pollDeferredQueue() {
  if (isPolling) return;
  // Task #149: emit canonical tick line even on early-bails so every tick
  // is observable via `pm2 logs | grep PRESSURE_GUARD_WORKER tick:`.
  const bs = getPressureGuardBootstrapState();
  if (bs !== "ready") {
    logger.info(
      `[PRESSURE_GUARD_WORKER] tick: leader_acquired=N (bootstrap=${bs}), bootstrap=${bs}, ` +
      `has_pending=?, eligible_campaigns=0, drained_calls=0, errors=0`,
    );
    return;
  }
  isPolling = true;
  try {
    // R5: leader election. When multiple worker processes run (split web
    // + worker mode, multi-replica), only one node should drain a tick;
    // others bail immediately so we never double-claim under SKIP LOCKED
    // *and* never burn duplicate gauge resets.
    const ran = await withLeaderLease(LOCK_KEYS.PRESSURE_DRAIN, "PRESSURE_DRAIN", async () => {
      await pollDeferredQueueInner();
      return true;
    });
    if (ran === null) {
      // Task #149: emit the canonical per-tick line in the same shape as
      // the leader path so a single grep `tick: ` regex covers every
      // possible outcome (leader-empty, leader-drained, non-leader,
      // bootstrap-not-ready).
      logger.info(
        `[PRESSURE_GUARD_WORKER] tick: leader_acquired=N (another node holds the lease), ` +
        `bootstrap=ready, has_pending=?, eligible_campaigns=0, drained_calls=0, errors=0`,
      );
      return;
    }
  } catch (err: any) {
    logger.error(`[PRESSURE_GUARD_WORKER] poll error: ${err?.message || err}`);
  } finally {
    isPolling = false;
  }
}

// Hot-path scalability cap (Task #145 R17): the per-campaign gauge does
// `GROUP BY campaign_id` over the whole deferred queue, which costs more
// as the backlog grows. To keep the 30s tick cheap when 100k+ rows are
// deferred across many campaigns, we (a) early-exit when the queue is
// empty, (b) cap the gauge to the top N campaigns by deferred count.
const GAUGE_TOP_N = envInt("PRESSURE_GAUGE_TOP_N", 50, 1, 1_000);

async function pollDeferredQueueInner() {
  // Task #149: defensive per-tick counters so the end-of-function INFO
  // line gives ops a single grep target for "is the drain alive and
  // doing anything?" — independent of whether any campaign actually
  // gets drained on a given tick.
  let bootstrapStateLabel: string = "ready";
  let hasPending = false;
  let eligibleCampaigns = 0;
  let drainedCalls = 0;
  let errorCount = 0;
  try {
    const bs = getPressureGuardBootstrapState();
    bootstrapStateLabel = bs;
    if (bs !== "ready") {
      logger.info(`[PRESSURE_GUARD_WORKER] tick: leader_acquired=Y, bootstrap=${bs}, has_pending=?, eligible_campaigns=0, drained_calls=0, errors=0`);
      return;
    }
    // R17 step 1: cheap pre-check via the partial index
    // `campaign_sends_pressure_deferred_idx`. EXISTS short-circuits on
    // the first matching row, so this is O(1) even with millions of
    // rows in campaign_sends. When the queue is empty (the common case
    // outside actual pressure events) we reset the gauge and bail in
    // a single index probe.
    const probe = await db.execute(sql`
      SELECT EXISTS (
        SELECT 1 FROM campaign_sends
        WHERE status = 'pending' AND eligible_at IS NOT NULL
        LIMIT 1
      ) AS has_any
    `);
    const hasAny = (probe.rows[0] as { has_any?: boolean } | undefined)?.has_any === true;
    hasPending = hasAny;
    if (!hasAny) {
      try { pressureGuardPendingDeferred.reset(); } catch {}
      return;
    }

    // R17 step 2: bounded per-campaign gauge. We refresh AT MOST
    // GAUGE_TOP_N labels per tick (default 50), ordered by descending
    // deferred count, so observability stays intact for the campaigns
    // an operator actually cares about while the work to compute the
    // gauge stays bounded regardless of how many distinct campaigns
    // contribute to the backlog. Stale labels for campaigns that fell
    // out of the top-N are dropped on every refresh via .reset().
    try {
      const g = await db.execute(sql`
        SELECT campaign_id, COUNT(*)::int AS n
        FROM campaign_sends
        WHERE status = 'pending' AND eligible_at IS NOT NULL
        GROUP BY campaign_id
        ORDER BY n DESC
        LIMIT ${GAUGE_TOP_N}
      `);
      pressureGuardPendingDeferred.reset();
      for (const row of g.rows) {
        pressureGuardPendingDeferred.set(
          { campaign_id: (row as any).campaign_id as string },
          Number((row as any).n ?? 0),
        );
      }
    } catch (err: any) {
      logger.warn(`[PRESSURE_GUARD_WORKER] gauge refresh failed (non-fatal): ${err?.message || err}`);
    }

    // Pick the next N campaigns that have eligible deferred rows, ordered FIFO.
    // The index `campaign_sends_pressure_deferred_idx` covers the
    // `WHERE status='pending' AND eligible_at IS NOT NULL` filter,
    // and the eligible_at <= NOW() bound seeks into the leading sorted
    // edge of that index. The JOIN with campaigns is cheap (390 rows
    // total) and ordered by started_at via the planner.
    //
    // Task #155: include 'paused' campaigns. A paused campaign retains
    // its already-deferred rows in campaign_sends — the user wants
    // those to keep draining naturally so pausing doesn't trap thousands
    // of contacts in cooldown indefinitely. Pause stops NEW sends only;
    // the existing pressure-guard backlog continues. Excluded statuses
    // are 'completed', 'cancelled', 'draft', 'failed' — those should
    // never have a draining queue.
    //
    // Task #155: explicit per-statement timeout + per-tick error capture.
    // The previous implementation ran with whatever the connection's
    // default statement_timeout was (60s in prod), and on timeout the
    // exception was caught by the outer poll inner-error handler which
    // rolled the failure into a single line — operators couldn't tell
    // if eligible_campaigns=0 meant "queue is empty" or "query timed out".
    // We now scope a 25s timeout for THIS query only and surface a
    // dedicated WARN line so the per-tick summary stays accurate.
    // SET LOCAL only applies inside a transaction, so we use a dedicated
    // pool client with explicit BEGIN/COMMIT to scope the 25s timeout to
    // this query. Without this, the eligibility query inherits the
    // connection's default statement_timeout (60s in prod) and on timeout
    // the exception was swallowed by the outer poll handler — operators
    // then saw eligible_campaigns=0 and could not distinguish "queue is
    // empty" from "query timed out under DB pressure".
    let campaignsRes: { rows: any[] };
    const eligClient = await pool.connect();
    try {
      await eligClient.query("BEGIN");
      await eligClient.query("SET LOCAL statement_timeout = '25s'");
      // Task #152: ORDER BY c.created_at (not c.started_at). The campaign
      // sender writes startedAt: new Date() at every (re)launch
      // (server/services/campaign-sender.ts:270), so a PM2 restart that
      // auto-resumes 10 campaigns in parallel rewrites all their started_at
      // to the same minute — the FIFO order then reflects the restart
      // order, not the real campaign age. Constated 2026-05-15: 12 active
      // campaigns from 05-13 and 05-14 all had started_at clustered at
      // 05-15 06:35-07:02 after a restart, so the deferred backlog of the
      // 05-13 campaigns was draining at the same priority as the 05-14
      // ones (essentially random). created_at is set once at row insert
      // and is never bumped, so it reliably reflects launch ancestry.
      const r = await eligClient.query<{ campaign_id: string; created_at: Date | null }>(
        `SELECT DISTINCT cs.campaign_id, c.created_at
         FROM campaign_sends cs
         JOIN campaigns c ON c.id = cs.campaign_id
         WHERE cs.status = 'pending'
           AND cs.eligible_at IS NOT NULL
           AND cs.eligible_at <= NOW()
           AND c.status IN ('sending', 'paused')
         ORDER BY c.created_at ASC NULLS FIRST
         LIMIT $1`,
        [MAX_CAMPAIGNS_PER_TICK],
      );
      await eligClient.query("COMMIT");
      campaignsRes = { rows: r.rows };
    } catch (err: any) {
      try { await eligClient.query("ROLLBACK"); } catch {}
      errorCount += 1;
      logger.warn(
        `[PRESSURE_GUARD_WORKER] eligibility query failed (treating as empty this tick — ` +
        `eligible_campaigns will report 0 but errors=${errorCount}): ${err?.message || err}`,
      );
      campaignsRes = { rows: [] };
    } finally {
      eligClient.release();
    }

    eligibleCampaigns = campaignsRes.rows.length;
    // Task #153: bounded-parallel drain. The previous implementation
    // awaited each drainCampaign sequentially, which capped per-tick
    // throughput at ~1 campaign × BATCH rows / drain-duration. With 8-10
    // active campaigns each holding 100k+ deferred rows (constated 2026-05-14
    // prod incident: 321k due_now after 10 simultaneous launches on
    // overlapping audiences), the sequential drain produced ~1500 sends/min
    // total — completely insufficient. Parallelizing with a small fixed
    // concurrency cap (typically 4) multiplies throughput proportionally
    // without saturating the main pool. JS is single-threaded so the
    // drainedCalls/errorCount increments inside the worker functions are
    // race-free even though the surrounding awaits interleave.
    const queue = campaignsRes.rows.slice();
    const workers: Promise<void>[] = [];
    const parallelism = Math.min(DRAIN_PARALLELISM, queue.length);
    for (let i = 0; i < parallelism; i++) {
      workers.push((async () => {
        while (queue.length > 0) {
          const row = queue.shift();
          if (!row) break;
          const campaignId = (row as any).campaign_id as string;
          try {
            await drainCampaign(campaignId);
            drainedCalls += 1;
          } catch (err: any) {
            errorCount += 1;
            logger.error(`[PRESSURE_GUARD_WORKER] drainCampaign(${campaignId}) failed: ${err?.message || err}`);
          }
        }
      })());
    }
    await Promise.all(workers);
  } catch (err: any) {
    errorCount += 1;
    logger.error(`[PRESSURE_GUARD_WORKER] poll inner error: ${err?.message || err}`);
  } finally {
    // Task #149: single-line per-tick summary for ops grep. This MUST
    // emit on every tick (drain or no drain) so a future silent-bail is
    // immediately distinguishable from a healthy idle worker.
    logger.info(
      `[PRESSURE_GUARD_WORKER] tick: leader_acquired=Y, bootstrap=${bootstrapStateLabel}, ` +
      `has_pending=${hasPending ? "Y" : "N"}, eligible_campaigns=${eligibleCampaigns}, ` +
      `drained_calls=${drainedCalls}, errors=${errorCount}`,
    );
  }
}

/**
 * Task #145 R3: refresh `critsend_pressure_deferred_index_size_bytes`
 * and, when bloat exceeds `PRESSURE_REINDEX_BLOAT_BYTES` (default 256 MB),
 * run REINDEX CONCURRENTLY on the partial deferred index. Both read and
 * REINDEX are guarded by a session-level advisory lock so multi-replica
 * deployments only ever issue the REINDEX from one node.
 */
async function runMaintenanceTick() {
  if (getPressureGuardBootstrapState() !== "ready") return;
  await withLeaderLease(LOCK_KEYS.PRESSURE_MAINTENANCE, "PRESSURE_MAINTENANCE", async () => {
    try {
      const r = await pool.query<{ size_bytes: string | null }>(
        `SELECT pg_relation_size('campaign_sends_pressure_deferred_idx')::bigint AS size_bytes`,
      );
      const sizeBytes = Number(r.rows[0]?.size_bytes ?? 0);
      pressureGuardDeferredIndexSizeBytes.set(sizeBytes);

      // R3 maintenance policy:
      //   • Hourly gauge tick refreshes pressureGuardDeferredIndexSizeBytes.
      //   • Once per day cluster-wide, on or after MAINTENANCE_OFFPEAK_HOUR
      //     (default 03:00), enforced by a CAS UPDATE on
      //     pressure_maintenance_state.last_heavy_run_date:
      //       - VACUUM (ANALYZE) campaign_sends            (unconditional)
      //       - REINDEX INDEX CONCURRENTLY <deferred idx>  (unconditional)
      //   The CAS guarantees only ONE worker across the cluster runs
      //   heavy ops on a given calendar day. The "on or after" window
      //   (rather than "exactly equal to") prevents a missed day if
      //   workers restart shortly after the off-peak hour.
      const now = new Date();
      const inOffPeakWindow = now.getHours() >= MAINTENANCE_OFFPEAK_HOUR;
      if (inOffPeakWindow) {
        const cas = await pool.query(
          `UPDATE pressure_maintenance_state
           SET last_heavy_run_date = CURRENT_DATE
           WHERE id = true AND (last_heavy_run_date IS NULL OR last_heavy_run_date < CURRENT_DATE)
           RETURNING last_heavy_run_date`,
        );
        if ((cas.rowCount ?? 0) > 0) {
          logger.info(`[PRESSURE_MAINTENANCE] off-peak: claimed daily heavy slot, running VACUUM + REINDEX`);
          try {
            await pool.query(`VACUUM (ANALYZE) campaign_sends`);
            logger.info(`[PRESSURE_MAINTENANCE] VACUUM (ANALYZE) campaign_sends completed`);
          } catch (err: any) {
            logger.warn(`[PRESSURE_MAINTENANCE] VACUUM (ANALYZE) failed (non-fatal): ${err?.message || err}`);
          }
          try {
            await pool.query(`REINDEX INDEX CONCURRENTLY campaign_sends_pressure_deferred_idx`);
            logger.info(`[PRESSURE_MAINTENANCE] REINDEX CONCURRENTLY completed`);
          } catch (err: any) {
            logger.warn(`[PRESSURE_MAINTENANCE] REINDEX failed (non-fatal): ${err?.message || err}`);
          }
        }
      }
    } catch (err: any) {
      // pg_relation_size throws if the relation doesn't exist — boot race,
      // index still building. Treat as a soft no-op.
      logger.warn(`[PRESSURE_MAINTENANCE] tick failed (non-fatal): ${err?.message || err}`);
    }
  });
}

/**
 * Task #145 R15: enforce a 12-month TTL on pressure_flush_audit so the
 * table doesn't grow unbounded for long-lived deployments. Runs daily,
 * leader-elected.
 */
async function runAuditTtlTick() {
  if (getPressureGuardBootstrapState() !== "ready") return;
  await withLeaderLease(LOCK_KEYS.PRESSURE_AUDIT_TTL, "PRESSURE_AUDIT_TTL", async () => {
    try {
      const r = await pool.query(
        `DELETE FROM pressure_flush_audit
         WHERE created_at < NOW() - ($1::int || ' days')::interval`,
        [AUDIT_RETENTION_DAYS],
      );
      if ((r.rowCount ?? 0) > 0) {
        logger.info(`[PRESSURE_AUDIT_TTL] Deleted ${r.rowCount} pressure_flush_audit row(s) older than ${AUDIT_RETENTION_DAYS} days`);
      }
    } catch (err: any) {
      logger.warn(`[PRESSURE_AUDIT_TTL] tick failed (non-fatal): ${err?.message || err}`);
    }
  });
}

// Exported for tests: drives a single drain wave for `campaignId`. Tests
// can call this directly to assert FIFO cascade and unsubscribe-during-
// window behavior without spinning up the full poll interval.
export async function drainCampaign(campaignId: string): Promise<void> {
  const campaign: Campaign | undefined = await storage.getCampaign(campaignId);
  if (!campaign) return;
  const mta: Mta | undefined = campaign.mtaId ? await storage.getMta(campaign.mtaId) : undefined;
  if (!mta) {
    logger.warn(`[PRESSURE_GUARD_WORKER] Campaign ${campaignId} has no MTA; skipping`);
    return;
  }

  // Claim a batch under SKIP LOCKED so concurrent workers don't double-pick.
  // We use a dedicated client for the row-level lock + atomic transition.
  const client = await pool.connect();
  let claimedSubIds: string[] = [];
  try {
    await client.query("BEGIN");
    const claim = await client.query(
      `SELECT subscriber_id FROM campaign_sends
       WHERE campaign_id = $1
         AND status = 'pending' AND eligible_at IS NOT NULL AND eligible_at <= NOW()
       ORDER BY eligible_at ASC
       LIMIT $2
       FOR UPDATE SKIP LOCKED`,
      [campaignId, BATCH_PER_CAMPAIGN],
    );
    claimedSubIds = claim.rows.map((r) => r.subscriber_id as string);
    if (claimedSubIds.length === 0) {
      await client.query("ROLLBACK");
      return;
    }
    // Bump status='attempting' on the locked rows so other workers + the
    // orphan-recovery sweep treat them as in-flight.
    await client.query(
      `UPDATE campaign_sends SET status = 'attempting'
       WHERE campaign_id = $1 AND subscriber_id = ANY($2::text[]) AND status = 'pending'`,
      [campaignId, claimedSubIds],
    );
    await client.query("COMMIT");
  } catch (err: any) {
    try { await client.query("ROLLBACK"); } catch {}
    logger.error(`[PRESSURE_GUARD_WORKER] claim failed: ${err?.message || err}`);
    return;
  } finally {
    client.release();
  }

  // Run the global pressure CAS on subscribers.last_sent_at to honour the
  // 6h gap across all campaigns. Winners get last_sent_at = NOW().
  const casRes = await db.execute(sql`
    UPDATE subscribers s
    SET last_sent_at = NOW()
    WHERE s.id = ANY(${toPgTextArray(claimedSubIds)}::text[])
      AND (s.last_sent_at IS NULL OR s.last_sent_at + (${PRESSURE_WINDOW_HOURS}::numeric || ' hours')::interval <= NOW())
    RETURNING s.id, s.last_sent_at
  `);
  const winnerIds = new Set(casRes.rows.map((r) => (r as any).id as string));
  const losers = claimedSubIds.filter((id) => !winnerIds.has(id));

  // Losers: bump eligible_at forward and revert status back to pending.
  // Wrap the campaign_sends update + deferred_count bump in a single txn so
  // the audit counter never drifts from the row state, even on crash. We
  // intentionally do NOT touch pending_count (see pressureGuardReserveSendSlots).
  // R4: increment deferred_count by the number of rows ACTUALLY mutated
  // (RETURNING) — never by losers.length — so re-runs of a partially-applied
  // batch (transient DB errors, retries) don't double-count.
  if (losers.length > 0) {
    await db.transaction(async (tx) => {
      const upd = await tx.execute(sql`
        UPDATE campaign_sends cs
        SET status = 'pending',
            eligible_at = COALESCE(s.last_sent_at, NOW()) + (${PRESSURE_WINDOW_HOURS}::numeric || ' hours')::interval
        FROM subscribers s
        WHERE cs.campaign_id = ${campaignId}
          AND cs.subscriber_id = ANY(${toPgTextArray(losers)}::text[])
          AND s.id = cs.subscriber_id
          AND cs.status = 'attempting'
        RETURNING cs.subscriber_id
      `);
      const mutated = upd.rows.length;
      if (mutated > 0) {
        await tx.execute(sql`
          UPDATE campaigns SET deferred_count = deferred_count + ${mutated} WHERE id = ${campaignId}
        `);
      }
    });
  }

  if (winnerIds.size === 0) return;

  // Re-check unsubscribe / suppression / bounce flags for winners.
  const subs = await db.execute(sql`
    SELECT id, email, tags, refs, ip_address, import_date, suppressed_until, last_engaged_at, last_sent_at
    FROM subscribers WHERE id = ANY(${toPgTextArray(Array.from(winnerIds))}::text[])
  `);
  const eligibleSubs: Subscriber[] = [];
  const dropIds: string[] = [];
  const unsubTag = (campaign as any).unsubscribeTag as string | null;
  for (const r of subs.rows) {
    const row = r as any;
    const tags: string[] = Array.isArray(row.tags) ? row.tags : [];
    const suppressed = row.suppressed_until && new Date(row.suppressed_until) > new Date();
    const bounced = tags.includes("BCK");
    const unsubbed = unsubTag ? tags.includes(unsubTag) : false;
    if (suppressed || bounced || unsubbed) {
      dropIds.push(row.id);
    } else {
      eligibleSubs.push({
        id: row.id,
        email: row.email,
        tags,
        refs: Array.isArray(row.refs) ? row.refs : [],
        ipAddress: row.ip_address,
        importDate: row.import_date,
        suppressedUntil: row.suppressed_until,
        lastEngagedAt: row.last_engaged_at,
        lastSentAt: row.last_sent_at,
      } as Subscriber);
    }
  }

  if (dropIds.length > 0) {
    await db.execute(sql`
      UPDATE campaign_sends SET status = 'failed', eligible_at = NULL
      WHERE campaign_id = ${campaignId} AND subscriber_id = ANY(${toPgTextArray(dropIds)}::text[]) AND status = 'attempting'
    `);
    await db.execute(sql`
      UPDATE campaigns
      SET failed_count = failed_count + ${dropIds.length},
          pending_count = GREATEST(pending_count - ${dropIds.length}, 0)
      WHERE id = ${campaignId}
    `);
    logger.info(`[PRESSURE_GUARD_WORKER] Campaign ${campaignId}: dropped ${dropIds.length} unsub/suppressed at dispatch`);
  }

  if (eligibleSubs.length === 0) return;

  // Send. Tracking tokens use HMAC fallback (no batch token cache here — the
  // deferred path is intentionally simpler than the bulk sender hot-path).
  const trackingOpts = {
    trackOpens: campaign.trackOpens,
    trackClicks: campaign.trackClicks,
    linkMap: new Map<string, string>(),
  } as any;
  const customHeadersMap = new Map<string, string>();

  // Task #154: bounded-parallel SMTP fan-out. Replaces the strict for-await
  // loop that capped per-campaign throughput at ~1/SMTP_RTT sends/sec.
  // N workers pull from a shared queue; SMTP I/O is interleaved while
  // Node's single-threaded event loop keeps successIds/failedIds.push race-
  // free between awaits. Default SMTP_CONCURRENCY=20 — see env var comment.
  const successIds: string[] = [];
  const failedIds: string[] = [];
  const sendQueue = [...eligibleSubs];
  const workers = Array.from({ length: Math.min(SMTP_CONCURRENCY, eligibleSubs.length) }, async () => {
    while (sendQueue.length > 0) {
      const sub = sendQueue.shift();
      if (!sub) return;
      try {
        const result = await sendEmailWithNullsink(mta as any, sub, campaign, trackingOpts, customHeadersMap);
        if (result.success) successIds.push(sub.id);
        else failedIds.push(sub.id);
      } catch (err: any) {
        logger.warn(`[PRESSURE_GUARD_WORKER] send failed for ${sub.email}: ${err?.message || err}`);
        failedIds.push(sub.id);
      }
    }
  });
  await Promise.all(workers);

  // Finalize: status attempting → sent/failed + clear eligible_at.
  await db.transaction(async (tx) => {
    if (successIds.length > 0) {
      await tx.execute(sql`
        UPDATE campaign_sends SET status = 'sent', eligible_at = NULL, sent_at = NOW()
        WHERE campaign_id = ${campaignId} AND subscriber_id = ANY(${toPgTextArray(successIds)}::text[]) AND status = 'attempting'
      `);
    }
    if (failedIds.length > 0) {
      await tx.execute(sql`
        UPDATE campaign_sends SET status = 'failed', eligible_at = NULL
        WHERE campaign_id = ${campaignId} AND subscriber_id = ANY(${toPgTextArray(failedIds)}::text[]) AND status = 'attempting'
      `);
    }
    await tx.execute(sql`
      UPDATE campaigns SET
        sent_count = sent_count + ${successIds.length},
        failed_count = failed_count + ${failedIds.length},
        pending_count = GREATEST(pending_count - ${successIds.length + failedIds.length}, 0)
      WHERE id = ${campaignId}
    `);
  });

  if (successIds.length > 0) {
    try { pressureGuardSentAfterDeferTotal.inc({ campaign_id: campaignId }, successIds.length); } catch {}
  }
  logger.info(`[PRESSURE_GUARD_WORKER] Campaign ${campaignId} drained: sent=${successIds.length}, failed=${failedIds.length}, deferred=${losers.length}, dropped=${dropIds.length}`);

  // Post-drain completion check (Task #144): the campaign-sender held the
  // status at 'sending' while deferred rows were outstanding. Once the
  // pressure-guard worker drains the last deferred row, flip the campaign
  // to 'completed' here so downstream workflows (follow-up scheduling,
  // dashboards, jobEvents listeners) advance correctly.
  try {
    const remaining = await db.execute(sql`
      SELECT COUNT(*)::int AS n FROM campaign_sends
      WHERE campaign_id = ${campaignId}
        AND status IN ('pending', 'attempting')
    `);
    const n = Number((remaining.rows[0] as { n?: number } | undefined)?.n ?? 0);
    if (n === 0) {
      const flipped = await storage.updateCampaignStatusAtomic(campaignId, "completed", "sending");
      if (flipped) {
        await storage.updateCampaign(campaignId, { completedAt: new Date(), pendingCount: 0 });
        logger.info(`[PRESSURE_GUARD_WORKER] Campaign ${campaignId} marked completed (deferred queue drained)`);
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`[PRESSURE_GUARD_WORKER] post-drain completion check failed for ${campaignId}: ${msg}`);
  }
}
