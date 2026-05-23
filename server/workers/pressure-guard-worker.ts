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
import { sendEmailWithNullsink, preregisterCampaignLinks } from "../email-service";
import {
  PRESSURE_WINDOW_HOURS,
  PRESSURE_MAX_DEFER_HOURS,
  PRESSURE_NEAR_AGING_HOURS,
  getPressureGuardBootstrapState,
  pressureGuardForceReserveSendSlots,
} from "../services/pressure-guard";
import {
  pressureGuardSentAfterDeferTotal,
  pressureGuardPendingDeferred,
  pressureGuardDeferredIndexSizeBytes,
  pressureGuardAgedForceSendsTotal,
  pressureGuardNearAgingPending,
  pressureGuardWindingDownCampaigns,
  pressureGuardBackPressuredLastTick,
  safeIntervalLastTickAgeSeconds,
  safeIntervalTickErrorsTotal,
  pressureDrainLastTickAgeSeconds,
} from "../metrics";
import { LOCK_KEYS } from "../bootstrap-lock";
import { publishJobProgress } from "../job-events";
import { safeInterval, getLastTickAt, setSafeIntervalErrorListener } from "../lib/safe-interval";
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
// Task #173: fairness slot ratio. After ordering the eligibility query by
// drainable_count DESC (volume priority), reserve this % of slots for the
// OLDEST campaigns (created_at ASC) regardless of drainable_count. This
// prevents a giant fresh launch from starving a 3-day-old trickle.
// 0 = pure volume priority, 100 = pure FIFO (legacy behavior).
const FAIRNESS_PCT = envInt("PRESSURE_GUARD_FAIRNESS_PCT", 20, 0, 100);
// Task #173: winding-down detection thresholds. A campaign is flagged
// winding_down when its cached pending_count < N AND its ready-to-drain
// row count < M for at least PERSISTENCE_MS continuously. Flagged
// campaigns are drained 1 tick out of every TICKS_GAP so they cannot
// permanently squat MAX_CAMPAIGNS slots with tiny trickles.
const WINDING_DOWN_PENDING_MAX = envInt("PRESSURE_GUARD_WINDING_DOWN_PENDING_MAX", 100, 1, 10_000);
const WINDING_DOWN_DRAINABLE_MAX = envInt("PRESSURE_GUARD_WINDING_DOWN_DRAINABLE_MAX", 50, 1, 10_000);
const WINDING_DOWN_PERSISTENCE_MS = envInt("PRESSURE_GUARD_WINDING_DOWN_PERSISTENCE_MS", 24 * 60 * 60_000, 60_000, 30 * 24 * 60 * 60_000);
const WINDING_DOWN_TICKS_GAP = envInt("PRESSURE_GUARD_WINDING_DOWN_TICKS_GAP", 4, 1, 100);
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

// Task #160: per-tick stats published to the leader-lease row so the
// admin /api/admin/pressure-drain/health endpoint can answer "is the
// drain alive?" cross-process (the dedicated drainer runs in its own
// PM2 process, so the web cannot inspect its in-memory state).
let lastTickStats = { drained: 0, errors: 0, eligible: 0 };

// Task #173 — in-memory state for winding-down back-pressure scheduling.
// `tickCounter` increments once per pollDeferredQueue invocation (whether
// or not we are leader). `windingDownSinceByCampaign` records the
// timestamp at which a campaign FIRST met the winding-down criteria
// continuously — it's cleared the moment the criteria stop being met,
// so a campaign needs PERSISTENCE_MS of uninterrupted "winding down"
// before back-pressure engages. `lastDrainTickByCampaign` tracks the
// tick number on which we last actually picked the campaign for drain;
// winding-down campaigns are skipped if they were picked < TICKS_GAP
// ticks ago. All three maps are bounded by the number of distinct
// campaigns that have ever been drained by this process — a process
// restart resets them harmlessly (next tick re-derives the state).
let tickCounter = 0;
const windingDownSinceByCampaign = new Map<string, number>();
const lastDrainTickByCampaign = new Map<string, number>();

// Three known safeInterval names (used by the health endpoint and by
// the metric labels — keep in sync with the names passed to safeInterval).
const TICK_NAME_DRAIN = "pressure_drain";
const TICK_NAME_MAINT = "pressure_maintenance";
const TICK_NAME_AUDIT = "pressure_audit_ttl";

setSafeIntervalErrorListener((name, err) => {
  try {
    safeIntervalTickErrorsTotal.inc({ name });
  } catch {
    /* metric increment is non-fatal */
  }
  // Task #160: persist drain tick errors cross-process so the health
  // endpoint can compute errors_5m. Best-effort: an INSERT failure here
  // MUST NOT cascade into another tick error.
  if (name === TICK_NAME_DRAIN) {
    const msg = err instanceof Error ? err.message : String(err);
    pool.query(
      `INSERT INTO pressure_drain_tick_errors (occurred_at, holder_id, error_msg) VALUES (NOW(), $1, $2)`,
      [LEADER_HOLDER_ID, msg.slice(0, 500)],
    ).catch(() => { /* best-effort */ });
  }
});

// Refresh the last-tick-age gauge in a separate cheap loop so Prometheus
// scrape gives a continuous "seconds since last successful tick" reading
// even when the drain itself is healthy but quiet (no eligible rows).
let gaugeRefreshInterval: NodeJS.Timeout | null = null;
function refreshTickAgeGauges() {
  for (const name of [TICK_NAME_DRAIN, TICK_NAME_MAINT, TICK_NAME_AUDIT]) {
    const t = getLastTickAt(name);
    if (t == null) continue;
    try {
      const ageS = (Date.now() - t) / 1000;
      safeIntervalLastTickAgeSeconds.set({ name }, ageS);
      // Task #160 contract metric: dedicated drain gauge.
      if (name === TICK_NAME_DRAIN) pressureDrainLastTickAgeSeconds.set(ageS);
    } catch {
      /* metric set is non-fatal */
    }
  }
}

export function startPressureGuardWorker() {
  if (pollInterval) return;
  logger.info(`[PRESSURE_GUARD_WORKER] Starting (poll=${POLL_INTERVAL_MS}ms, batch=${BATCH_PER_CAMPAIGN}, max-campaigns=${MAX_CAMPAIGNS_PER_TICK}, drain-parallelism=${DRAIN_PARALLELISM}, smtp-concurrency=${SMTP_CONCURRENCY}, window=${PRESSURE_WINDOW_HOURS}h, max_defer=${PRESSURE_MAX_DEFER_HOURS}h, near_aging=${PRESSURE_NEAR_AGING_HOURS}h)`);
  // Task #160: safeInterval wraps every tick in a top-level try/catch so
  // a single unhandled DB error inside pollDeferredQueue can no longer
  // silently kill the loop. Re-entrancy is also guarded by safeInterval
  // (independent of the legacy isPolling flag, which is preserved as a
  // defensive belt-and-braces).
  pollInterval = safeInterval(TICK_NAME_DRAIN, pollDeferredQueue, POLL_INTERVAL_MS);
  // Kick off after a short delay to let bootstrap run first.
  setTimeout(pollDeferredQueue, 5_000);
  // R3 + R15 cadenced background jobs (also leader-elected).
  maintenanceInterval = safeInterval(TICK_NAME_MAINT, runMaintenanceTick, MAINTENANCE_INTERVAL_MS);
  auditTtlInterval = safeInterval(TICK_NAME_AUDIT, runAuditTtlTick, AUDIT_TTL_INTERVAL_MS);
  setTimeout(runMaintenanceTick, 30_000);
  setTimeout(runAuditTtlTick, 60_000);
  if (!gaugeRefreshInterval) {
    gaugeRefreshInterval = setInterval(refreshTickAgeGauges, 5_000);
    gaugeRefreshInterval.unref();
  }
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
  if (gaugeRefreshInterval) {
    clearInterval(gaugeRefreshInterval);
    gaugeRefreshInterval = null;
  }
  logger.info("[PRESSURE_GUARD_WORKER] Stopped");
}

/**
 * Task #160: published cross-process via pressure_guard_leader (DB).
 * Read by GET /api/admin/pressure-drain/health.
 */
export function getDrainTickStatsInProcess(): {
  lastTickAt: number | null;
  drained: number;
  errors: number;
  eligible: number;
} {
  return {
    lastTickAt: getLastTickAt(TICK_NAME_DRAIN),
    ...lastTickStats,
  };
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
  // Task #173: per-tick observability for the volume/fairness/back-pressure
  // pipeline. Declared at the outer scope so the finally-block log line can
  // still surface them even when the try block bails early (e.g. eligibility
  // query timeout — winding-down/back-pressure are 0 in that case, which is
  // the correct value to report).
  let backPressuredCount = 0;
  let pickedVolume = 0;
  let pickedFairness = 0;
  let windingDownActive = 0;
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

    // Task #169: refresh the near-aging gauge. Cheap because of the
    // partial index `campaign_sends_pressure_aging_idx` that covers the
    // exact predicate. A non-zero value sustained across ticks is the
    // operator's early-warning signal that aged-forced dispatches are
    // about to fire on the next wave.
    try {
      const nearRes = await pool.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM campaign_sends
         WHERE status = 'pending'
           AND eligible_at IS NOT NULL
           AND first_deferred_at IS NOT NULL
           AND first_deferred_at <= NOW() - ($1::numeric || ' hours')::interval`,
        [PRESSURE_NEAR_AGING_HOURS],
      );
      pressureGuardNearAgingPending.set(Number(nearRes.rows[0]?.n ?? 0));
    } catch (err: any) {
      logger.warn(`[PRESSURE_GUARD_WORKER] near-aging gauge refresh failed (non-fatal): ${err?.message || err}`);
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
      // Task #169 — Aged rows (first_deferred_at > PRESSURE_MAX_DEFER_HOURS)
      // MUST be picked up on the next tick regardless of their future
      // eligible_at, otherwise the cap is silently extended by up to the
      // 6h pressure window when the contact had a recent send. The aged
      // bypass mirrors the per-row claim relaxation in drainCampaign.
      // Task #173 — volume-priority + fairness ordering with per-campaign
      // drainable_count. The legacy `SELECT DISTINCT campaign_id … ORDER BY
      // created_at ASC LIMIT 20` produced head-of-line blocking: with 45+
      // active campaigns each contributing a tiny trickle to the deferred
      // queue, the top-20 FIFO slice in prod held only ~9 ready_now rows
      // (5.8% of the configured 8k/min ceiling) while 200k+ rows on younger
      // campaigns waited behind. Counting drainable rows per campaign and
      // ordering DESC steers the drain to the campaigns where the batched
      // SMTP fan-out (SMTP_CONCURRENCY=20) and the 25s claim+finalize txn
      // actually amortize. The fairness slice (FAIRNESS_PCT, applied in JS
      // post-processing below) keeps oldest-FIFO contributions alive so a
      // giant fresh launch can't starve a 3-day-old trickle.
      //
      // We fetch up to MAX_CAMPAIGNS_PER_TICK * 3 candidates so the JS
      // back-pressure filter (winding_down + recently-drained) can drop
      // a substantial fraction without leaving slots empty. *3 is a
      // pragmatic heuristic — pathological case (most candidates back-
      // pressured) is bounded by the # of distinct campaigns with
      // eligible rows, which in prod is ~45-100 anyway, so the LIMIT
      // essentially never caps the candidate pool. drainable_count is COUNT(*) over
      // the `campaign_sends_pressure_deferred_idx` partial index — cheap
      // because the index covers status='pending' AND eligible_at IS NOT NULL
      // and the eligible_at <= NOW() bound seeks into the leading sorted
      // edge. pending_count is the cached counter on campaigns, used for
      // winding-down detection.
      const r = await eligClient.query<{
        campaign_id: string;
        created_at: Date | null;
        drainable_count: string;
        pending_count: number;
        sent_count: number;
        urgent_mode: boolean;
      }>(
        `WITH per_campaign AS (
           SELECT cs.campaign_id, COUNT(*)::bigint AS drainable_count
           FROM campaign_sends cs
           WHERE cs.status = 'pending'
             AND cs.eligible_at IS NOT NULL
             AND (
               cs.eligible_at <= NOW()
               OR (
                 cs.first_deferred_at IS NOT NULL
                 AND cs.first_deferred_at <= NOW() - ($2::numeric || ' hours')::interval
               )
             )
           GROUP BY cs.campaign_id
         )
         SELECT pc.campaign_id,
                c.created_at,
                pc.drainable_count,
                c.pending_count,
                c.sent_count,
                COALESCE(c.urgent_mode, false) AS urgent_mode
         FROM per_campaign pc
         JOIN campaigns c ON c.id = pc.campaign_id
         WHERE c.status IN ('sending', 'paused')
         ORDER BY pc.drainable_count DESC, c.created_at ASC NULLS FIRST
         LIMIT $1`,
        [MAX_CAMPAIGNS_PER_TICK * 3, PRESSURE_MAX_DEFER_HOURS],
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

    // ── Task #173: winding-down detection + back-pressure scheduling ──
    // The SQL already ordered rows by drainable_count DESC, created_at ASC
    // (volume-priority). Now in JS we:
    //   1. Update per-campaign winding-down state (sticky timestamp; reset
    //      the moment the criteria no longer hold).
    //   2. Skip campaigns whose winding-down state has persisted >= the
    //      configured PERSISTENCE_MS AND that we drained < TICKS_GAP ticks
    //      ago. This means they get drained ~1 tick out of every TICKS_GAP,
    //      freeing slots for younger campaigns with real backlog.
    //   3. Apply a fairness slice: take volume_slots from the front of the
    //      ordered list, then take fairness_slots additional campaigns
    //      re-sorted by created_at ASC (oldest first). This guarantees a
    //      3-day-old trickle gets at least FAIRNESS_PCT of every tick's
    //      slots even when a fresh launch dominates drainable_count.
    tickCounter += 1;
    const nowMs = Date.now();
    type EligRow = (typeof campaignsRes.rows)[number] & {
      drainable_count: string | number;
      pending_count: number;
      created_at: Date | null;
      urgent_mode?: boolean;
    };
    const rows = campaignsRes.rows as EligRow[];

    // (1) winding-down state update for every eligible row this tick.
    for (const row of rows) {
      const drainable = Number(row.drainable_count) || 0;
      const meets = (row.pending_count ?? 0) < WINDING_DOWN_PENDING_MAX
                    && drainable < WINDING_DOWN_DRAINABLE_MAX;
      if (meets) {
        if (!windingDownSinceByCampaign.has(row.campaign_id)) {
          windingDownSinceByCampaign.set(row.campaign_id, nowMs);
        }
      } else {
        windingDownSinceByCampaign.delete(row.campaign_id);
      }
    }

    // (2) back-pressure filter. A campaign is back-pressured ONLY if the
    // winding-down state has been persistent for >= PERSISTENCE_MS AND we
    // drained it in the last (TICKS_GAP - 1) ticks. New winding-down
    // campaigns (just-flagged) still drain normally for the first 24h
    // window so a temporary trickle isn't immediately throttled.
    const eligibleForDrain: EligRow[] = [];
    for (const row of rows) {
      const since = windingDownSinceByCampaign.get(row.campaign_id);
      const isWindingDown = since !== undefined && (nowMs - since) >= WINDING_DOWN_PERSISTENCE_MS;
      const lastTick = lastDrainTickByCampaign.get(row.campaign_id) ?? -Infinity;
      // 2026-05-22: urgent_mode campaigns ALWAYS bypass the winding-down
      // throttle. The operator clicked "Flush held now" specifically to
      // escape every back-pressure mechanism; honouring 1-tick-in-4
      // throttling on a urgent flush would silently extend the flush
      // duration by 4×, defeating the feature.
      const isUrgent = row.urgent_mode === true;
      if (!isUrgent && isWindingDown && (tickCounter - lastTick) < WINDING_DOWN_TICKS_GAP) {
        backPressuredCount += 1;
        continue;
      }
      eligibleForDrain.push(row);
    }

    // (3) volume + fairness split. Volume-picks come from the front of the
    // (already drainable_count DESC, created_at ASC) ordered list. Fairness
    // picks are the OLDEST remaining campaigns by created_at ASC, regardless
    // of drainable_count.
    const fairnessSlots = Math.floor((MAX_CAMPAIGNS_PER_TICK * FAIRNESS_PCT) / 100);
    const volumeSlots = Math.max(0, MAX_CAMPAIGNS_PER_TICK - fairnessSlots);
    const volumePicks = eligibleForDrain.slice(0, volumeSlots);
    const volumePickIds = new Set(volumePicks.map((r) => r.campaign_id));
    const fairnessCandidates = eligibleForDrain
      .filter((r) => !volumePickIds.has(r.campaign_id))
      .sort((a, b) => {
        const ta = a.created_at ? a.created_at.getTime() : 0;
        const tb = b.created_at ? b.created_at.getTime() : 0;
        return ta - tb;
      });
    const fairnessPicks = fairnessCandidates.slice(0, fairnessSlots);
    let finalPicks = [...volumePicks, ...fairnessPicks];

    // 2026-05-23 — urgent-mode slot cap. Previously urgent campaigns
    // ALSO bypassed the slot allocation: a single urgent campaign with
    // 65k+ DUE-NOW rows would land at the top of the (drainable_count
    // DESC) ordering and monopolise EVERY slot of MAX_CAMPAIGNS_PER_TICK,
    // starving all other active campaigns and causing the pool-saturation
    // cascade seen in the 2026-05-23 incident (sends → 0, logout, page
    // crash).
    //
    // We now cap urgent picks at half the per-tick slots (rounded down,
    // minimum 1). Urgent campaigns still go FIRST (drainable_count DESC
    // keeps them at the top), they still bypass winding-down throttling
    // (line ~671), and per-row CAS still ignores the 6h gap — what
    // changes is they cannot consume more than ~50% of the parallelism
    // budget. Non-urgent campaigns get the remaining slots so the rest
    // of the platform keeps progressing.
    const URGENT_CAP = Math.max(1, Math.floor(MAX_CAMPAIGNS_PER_TICK / 2));
    const urgentInPicks = finalPicks.filter((p) => p.urgent_mode === true);
    if (urgentInPicks.length > URGENT_CAP) {
      const keepUrgentIds = new Set(urgentInPicks.slice(0, URGENT_CAP).map((p) => p.campaign_id));
      // Drop excess urgent picks from the final list…
      finalPicks = finalPicks.filter((p) => p.urgent_mode !== true || keepUrgentIds.has(p.campaign_id));
      // …and backfill from the next non-urgent eligible campaigns we hadn't picked.
      const pickedIds = new Set(finalPicks.map((p) => p.campaign_id));
      const backfillPool = eligibleForDrain
        .filter((p) => p.urgent_mode !== true && !pickedIds.has(p.campaign_id));
      const slotsToFill = MAX_CAMPAIGNS_PER_TICK - finalPicks.length;
      if (slotsToFill > 0) {
        finalPicks = [...finalPicks, ...backfillPool.slice(0, slotsToFill)];
      }
    }

    // Record drain ticks for every campaign we actually picked.
    for (const row of finalPicks) {
      lastDrainTickByCampaign.set(row.campaign_id, tickCounter);
    }

    // Refresh winding-down gauges. We count campaigns whose state has been
    // persistent past PERSISTENCE_MS (i.e. that the back-pressure schedule
    // is actually applied to). Assigned to the outer-scope counter so the
    // finally-block tick log line and the heartbeat UPDATE both see it.
    for (const since of windingDownSinceByCampaign.values()) {
      if ((nowMs - since) >= WINDING_DOWN_PERSISTENCE_MS) windingDownActive += 1;
    }
    try {
      pressureGuardWindingDownCampaigns.set(windingDownActive);
      pressureGuardBackPressuredLastTick.set(backPressuredCount);
    } catch {
      /* metric set is non-fatal */
    }

    // Track for the per-tick log + heartbeat publication.
    pickedVolume = volumePicks.length;
    pickedFairness = fairnessPicks.length;

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
    const queue = finalPicks.slice();
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
      `picked=${pickedVolume}+${pickedFairness}, winding_down=${windingDownActive}, ` +
      `back_pressured=${backPressuredCount}, drained_calls=${drainedCalls}, errors=${errorCount}`,
    );
    // Task #160: publish per-tick heartbeat to the leader-lease row so
    // the cross-process /api/admin/pressure-drain/health endpoint can
    // observe drain liveness without inspecting in-memory state of the
    // dedicated drainer process. Best-effort: a failed UPDATE here MUST
    // NOT break the next tick.
    lastTickStats = { drained: drainedCalls, errors: errorCount, eligible: eligibleCampaigns };
    pool.query(
      `UPDATE pressure_guard_leader
         SET last_tick_at = NOW(),
             last_tick_drained = $1,
             last_tick_errors = $2,
             last_tick_eligible = $3
       WHERE lock_key = $4 AND holder_id = $5`,
      [drainedCalls, errorCount, eligibleCampaigns, `pressure_guard:${LOCK_KEYS.PRESSURE_DRAIN}`, LEADER_HOLDER_ID],
    ).catch((err: any) =>
      logger.warn(`[PRESSURE_GUARD_WORKER] heartbeat UPDATE failed (non-fatal): ${err?.message || err}`),
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
    // Task #169 — Aged rows bypass the eligible_at gate so they actually
    // dispatch on the next tick after crossing the cap, even if the
    // contact's 6h window is still pending. ORDER BY first_deferred_at
    // first puts the oldest aged rows at the head of the batch.
    const claim = await client.query(
      `SELECT subscriber_id FROM campaign_sends
       WHERE campaign_id = $1
         AND status = 'pending' AND eligible_at IS NOT NULL
         AND (
           eligible_at <= NOW()
           OR (
             first_deferred_at IS NOT NULL
             AND first_deferred_at <= NOW() - ($3::numeric || ' hours')::interval
           )
         )
       ORDER BY first_deferred_at ASC NULLS LAST, eligible_at ASC
       LIMIT $2
       FOR UPDATE SKIP LOCKED`,
      [campaignId, BATCH_PER_CAMPAIGN, PRESSURE_MAX_DEFER_HOURS],
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

  // Task #165: running deltas + helper so EVERY path that mutates the
  // campaign's cached counters (losers-only wave, drop-only wave, normal
  // send wave, completion flip) publishes a consistent SSE event with
  // the up-to-date sent/failed/pending/deferred. Counters are derived
  // from the entry-fetched `campaign` row + in-memory deltas; no extra
  // SELECT on the `campaigns` table in this hot path. Best-effort:
  // a publish failure NEVER breaks the drain.
  let sentDelta = 0;
  let failedDelta = 0;
  let pendingDelta = 0;
  let deferredDelta = 0;
  const emitProgress = (status: "sending" | "completed"): void => {
    const newSent = (campaign.sentCount ?? 0) + sentDelta;
    const newFailed = (campaign.failedCount ?? 0) + failedDelta;
    const newPending = Math.max(0, (campaign.pendingCount ?? 0) + pendingDelta);
    const newDeferred = (campaign.deferredCount ?? 0) + deferredDelta;
    try {
      publishJobProgress({
        jobType: "campaign",
        jobId: campaignId,
        campaignId,
        status,
        // Campaign schema has no single `total_recipients` field; the
        // client SSE handler ignores totalRows on campaign events (it
        // only diffs sent/failed/pending/deferred), so the value is
        // derived purely to satisfy the JobProgressEvent contract.
        processedRows: newSent + newFailed,
        totalRows: status === "completed" ? newSent + newFailed : newSent + newFailed + newPending,
        sentCount: newSent,
        failedCount: newFailed,
        pendingCount: status === "completed" ? 0 : newPending,
        deferredCount: newDeferred,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[PRESSURE_GUARD_WORKER] SSE publish failed for ${campaignId} (non-fatal): ${msg}`);
    }
  };

  // Task #169 — Aging cap. Partition the claimed batch into:
  //   • aged   = rows whose first_deferred_at has crossed
  //              PRESSURE_MAX_DEFER_HOURS — bypass the 6h gap and
  //              force-dispatch on this tick.
  //   • normal = everything else — go through the standard CAS that
  //              honours the 6h subscribers.last_sent_at gap.
  // The split is computed against the per-campaign 'attempting' rows so
  // a row that lost a previous CAS but was re-claimed retains its
  // original first_deferred_at (the re-defer cascade UPDATE only touches
  // eligible_at — see L755 below).
  let agedIds: string[] = [];
  try {
    const agedRes = await pool.query<{ subscriber_id: string }>(
      `SELECT subscriber_id FROM campaign_sends
       WHERE campaign_id = $1
         AND subscriber_id = ANY($2::text[])
         AND status = 'attempting'
         AND first_deferred_at IS NOT NULL
         AND first_deferred_at <= NOW() - ($3::numeric || ' hours')::interval`,
      [campaignId, claimedSubIds, PRESSURE_MAX_DEFER_HOURS],
    );
    agedIds = agedRes.rows.map((r) => r.subscriber_id);
  } catch (err: any) {
    // Non-fatal: if the aging probe fails (e.g. column missing on a
    // brand-new boot before the bootstrap re-runs), every claimed row
    // falls back to the normal CAS path — the guard still works, just
    // without the cap on this tick.
    logger.warn(`[PRESSURE_GUARD_WORKER] aging probe failed for ${campaignId} (non-fatal, no aged force this tick): ${err?.message || err}`);
  }
  const agedSet = new Set(agedIds);
  const normalIds = claimedSubIds.filter((id) => !agedSet.has(id));

  // 2026-05-22: urgent_mode bypass at dispatch time.
  // The drain runs its OWN CAS at dispatch (the normal-CAS UPDATE below)
  // — completely independent from `pressureGuardReserveSendSlots`. That
  // initial CAS only fires when the sender enqueues NEW rows; once a row
  // is parked in the deferred queue, all subsequent dispatch attempts go
  // through THIS code path. So the urgent flag on the campaign row must
  // ALSO be honoured here, otherwise the held-row flush triggered by
  // POST /api/campaigns/:id/urgent would lose any subscriber whose 6h
  // window was re-armed by a competing campaign in the few seconds
  // between /urgent commit and this drain tick — exactly the race the
  // operator is trying to escape. We route urgent campaigns through the
  // same force-CAS path that aged rows use: unconditional stamp of
  // subscribers.last_sent_at = NOW(), which restores forward integrity
  // of the 6h guard immediately after dispatch.
  const isUrgent = (campaign as any).urgentMode === true;
  let agedWinners: string[];
  let normalWinnerIds: Set<string>;
  if (isUrgent) {
    // Treat every claimed row as if it were aged — force-CAS bypasses
    // the 6h window for ALL of them in a single round-trip. Aged rows
    // (if any) are already in this set; we union them so the force call
    // sees one canonical subscriber list (no double-CAS, no
    // double-stamp).
    const forcedIds = Array.from(new Set<string>([...agedIds, ...normalIds]));
    const forced = forcedIds.length > 0
      ? await pressureGuardForceReserveSendSlots(forcedIds)
      : [];
    const forcedSet = new Set(forced);
    // Distribute winners back across the original aged/normal split so
    // the existing log + metric paths below stay accurate.
    agedWinners = agedIds.filter((id) => forcedSet.has(id));
    normalWinnerIds = new Set(normalIds.filter((id) => forcedSet.has(id)));
  } else {
    // Force-CAS for aged rows: stamps subscribers.last_sent_at = NOW()
    // unconditionally so the 6h guard re-engages forward in time, even
    // though we are bypassing it for this dispatch.
    agedWinners = agedIds.length > 0
      ? await pressureGuardForceReserveSendSlots(agedIds)
      : [];

    // Normal CAS: standard 6h gap check on the remaining claimed rows.
    // Winners get last_sent_at = NOW(); losers stay 'attempting' here and
    // are re-deferred below.
    const casRes: { rows: Array<{ id: string; last_sent_at: Date | null }> } = normalIds.length > 0
      ? await db.execute(sql`
          UPDATE subscribers s
          SET last_sent_at = NOW()
          WHERE s.id = ANY(${toPgTextArray(normalIds)}::text[])
            AND (s.last_sent_at IS NULL OR s.last_sent_at + (${PRESSURE_WINDOW_HOURS}::numeric || ' hours')::interval <= NOW())
          RETURNING s.id, s.last_sent_at
        `) as { rows: Array<{ id: string; last_sent_at: Date | null }> }
      : { rows: [] };
    normalWinnerIds = new Set(casRes.rows.map((r) => r.id));
  }

  // Merged winner set: aged force-wins + normal CAS wins.
  // Losers are ONLY the normal-CAS losers (aged rows are never losers
  // — by definition they bypass the check).
  const winnerIds = new Set<string>([...agedWinners, ...normalWinnerIds]);
  const losers = normalIds.filter((id) => !normalWinnerIds.has(id));

  if (agedIds.length > 0) {
    logger.warn(
      `[PRESSURE_GUARD_WORKER] Campaign ${campaignId}: aging cap engaged — ` +
      `force-dispatched ${agedWinners.length}/${agedIds.length} send(s) ` +
      `aged > ${PRESSURE_MAX_DEFER_HOURS}h`,
    );
  }

  // Losers: bump eligible_at forward and revert status back to pending.
  // Wrap the campaign_sends update + deferred_count bump in a single txn so
  // the audit counter never drifts from the row state, even on crash. We
  // intentionally do NOT touch pending_count (see pressureGuardReserveSendSlots).
  // R4: increment deferred_count by the number of rows ACTUALLY mutated
  // (RETURNING) — never by losers.length — so re-runs of a partially-applied
  // batch (transient DB errors, retries) don't double-count.
  if (losers.length > 0) {
    const mutatedLosers = await db.transaction(async (tx) => {
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
      return mutated;
    });
    // Task #165: deferred-only waves (winnerIds.size === 0) used to be
    // invisible to the SSE stream — the bar stalled until the next 10s
    // poll. Bump the deferred delta and emit unconditionally so even
    // 100%-loser waves move the amber segment in near-real-time.
    deferredDelta += mutatedLosers;
    emitProgress("sending");
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
    // Task #165: drop-only-then-empty waves also mutate counters; emit
    // so the failed/pending segments move even when no actual send fires.
    failedDelta += dropIds.length;
    pendingDelta -= dropIds.length;
    emitProgress("sending");
  }

  if (eligibleSubs.length === 0) return;

  // Task #161: full tracking parity with the bulk sender hot-path.
  // The previous "HMAC fallback" comment was a lie — addTrackingToHtml needs
  // both a populated linkMap AND a non-null trackingDomain (baseUrl) to rewrite
  // hrefs and inject the open pixel. Without them the email goes out as raw
  // HTML with direct redirect.critads.com links → recipient clicks work
  // (client sees traffic) but Critsend records nothing. This broke tracking
  // on every campaign with deferred_count > 0 since pressure-guard rollout
  // (2026-05-14 onward — see commit message + replit.md Task #161 entry).
  const trackingOpts: {
    trackOpens: boolean;
    trackClicks: boolean;
    trackingDomain?: string | null;
    openTrackingDomain?: string | null;
    openTag?: string | null;
    clickTag?: string | null;
    linkMap: Map<string, string>;
    batchClickTokens?: Map<string, Map<string, string>>;
    batchUnsubTokens?: Map<string, string>;
  } = {
    trackOpens: campaign.trackOpens,
    trackClicks: campaign.trackClicks,
    trackingDomain: mta.trackingDomain,
    openTrackingDomain: mta.openTrackingDomain,
    openTag: (campaign as any).openTag ?? null,
    clickTag: (campaign as any).clickTag ?? null,
    linkMap: new Map<string, string>(),
  };

  // Pre-register click links once per drain batch (storage layer dedupes;
  // ~1 INSERT … ON CONFLICT DO NOTHING per unique URL across the campaign).
  if (campaign.trackClicks && mta.trackingDomain && campaign.htmlContent) {
    try {
      trackingOpts.linkMap = await preregisterCampaignLinks(
        campaign.htmlContent,
        campaignId,
        storage.batchGetOrCreateCampaignLinks.bind(storage),
      );
    } catch (err: any) {
      logger.warn(
        `[PRESSURE_GUARD_WORKER] [TRACKING_BREAK] preregisterCampaignLinks failed for ${campaignId}: ${err?.message || err}`,
      );
    }
  }

  // Pre-create short tracking tokens for this drain batch — same pattern as
  // campaign-sender.ts:694-710. Failure here is NOT silent: we log
  // [TRACKING_BREAK] so the bug pattern is grep-able in prod logs.
  if (mta.trackingDomain) {
    const eligibleIds = eligibleSubs.map((s) => s.id);
    const linkIds = [...trackingOpts.linkMap.values()];
    try {
      const [clickTokens, unsubTokens] = await Promise.all([
        linkIds.length > 0 && campaign.trackClicks
          ? storage.batchCreateClickTokens(campaignId, eligibleIds, linkIds)
          : Promise.resolve(new Map<string, Map<string, string>>()),
        storage.batchCreateUnsubscribeTokens(campaignId, eligibleIds),
      ]);
      trackingOpts.batchClickTokens = clickTokens;
      trackingOpts.batchUnsubTokens = unsubTokens;
    } catch (err: any) {
      logger.warn(
        `[PRESSURE_GUARD_WORKER] [TRACKING_BREAK] token generation failed for ${campaignId}: ${err?.message || err}`,
      );
    }
  }

  // Defensive guard: if trackClicks was requested but we end up with an
  // empty linkMap AND no trackingDomain, the email will go out without any
  // tracking at all. Log loudly so this never silently regresses again.
  if (
    campaign.trackClicks &&
    trackingOpts.linkMap.size === 0 &&
    !mta.trackingDomain
  ) {
    logger.warn(
      `[PRESSURE_GUARD_WORKER] [TRACKING_BREAK] Campaign ${campaignId}: ` +
        `trackClicks=true but linkMap empty AND mta.trackingDomain null — ` +
        `emails will be sent without tracking. MTA id=${mta.id} name=${mta.name}`,
    );
  }

  const customHeadersMap: Record<string, string> = {};

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

  // Task #169: tally aged force-dispatches that actually delivered.
  // Computed BEFORE the finalize transaction so the campaign-level
  // counter (aged_forced_count) bumps atomically with sent_count /
  // failed_count / pending_count — no drift possible on crash between
  // writes. successIds ∩ agedSet so hard-stop drops and SMTP failures
  // on aged rows do NOT count.
  const agedDelivered = successIds.reduce((n, id) => n + (agedSet.has(id) ? 1 : 0), 0);

  // Finalize: status attempting → sent/failed + clear eligible_at, and
  // bump all campaign-level counters (sent/failed/pending + aged) in
  // the same transaction.
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
        pending_count = GREATEST(pending_count - ${successIds.length + failedIds.length}, 0),
        aged_forced_count = aged_forced_count + ${agedDelivered}
      WHERE id = ${campaignId}
    `);
  });

  if (successIds.length > 0) {
    try { pressureGuardSentAfterDeferTotal.inc({ campaign_id: campaignId }, successIds.length); } catch {}
  }
  // Prom counter stays best-effort (telemetry, not a persisted business
  // counter); the persisted campaigns.aged_forced_count is now bumped
  // atomically inside the finalize tx above.
  if (agedDelivered > 0) {
    try { pressureGuardAgedForceSendsTotal.inc(agedDelivered); } catch {}
  }

  logger.info(`[PRESSURE_GUARD_WORKER] Campaign ${campaignId} drained: sent=${successIds.length}, failed=${failedIds.length}, deferred=${losers.length}, dropped=${dropIds.length}, aged_force_delivered=${agedDelivered}`);

  // Task #165: push a near-real-time SSE event so the campaigns-list
  // progress bar updates within ~1s of each drain wave instead of having
  // to wait for the next 10s TanStack poll. Bump the running deltas by
  // the finalize-transaction mutations (which match the in-memory id
  // lists) and emit via the shared helper.
  sentDelta += successIds.length;
  failedDelta += failedIds.length;
  pendingDelta -= successIds.length + failedIds.length;
  emitProgress("sending");

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
        // 2026-05-22 urgent-mode audit: clear the flag on natural drain
        // completion (mirrors the two completion sites in campaign-sender).
        // Without this, a campaign that finishes its queue in urgent mode
        // would retain urgent_mode=true post-completion, and any future
        // reopen path that does not explicitly clear (e.g. an internal
        // sender path we haven't audited) would resurrect the bypass.
        await storage.updateCampaign(campaignId, { completedAt: new Date(), pendingCount: 0, urgentMode: false, urgentFlushJobId: null });
        logger.info(`[PRESSURE_GUARD_WORKER] Campaign ${campaignId} marked completed (deferred queue drained)`);
        // Task #165: emit a terminal SSE event so the campaigns-list
        // progress bar (and any open detail page) flips to "completed"
        // immediately instead of waiting for the next 10s poll. Reuses
        // the same in-memory deltas the per-wave emit used — no extra
        // DB read in this hot path. The helper forces pendingCount=0
        // when status="completed".
        emitProgress("completed");
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`[PRESSURE_GUARD_WORKER] post-drain completion check failed for ${campaignId}: ${msg}`);
  }
}
