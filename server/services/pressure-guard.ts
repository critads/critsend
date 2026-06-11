/**
 * Marketing Pressure Guard — Task #144
 *
 * Enforces a hard 4h gap (was 6h until 2026-05-23) between any two emails
 * to the same contact across ALL campaigns. Implementation contract:
 *
 *   1. Atomic CAS (`pressureGuardReserveSendSlots`):
 *      Single SQL statement that updates `subscribers.last_sent_at = NOW()`
 *      for every `id` in the batch *iff* the contact is currently eligible
 *      (`last_sent_at IS NULL OR last_sent_at + 4h <= NOW()`). Returns the
 *      winners. Losers are written into `campaign_sends` with
 *      `status='pending'` and `eligible_at = last_sent_at + 4h` so the
 *      deferred-drain worker can retry them later. Cumulative
 *      `campaigns.deferred_count` is bumped per defer event.
 *
 *   2. Bootstrap (`runPressureGuardBootstrap`):
 *      Adds the new columns + audit table + indexes under an advisory lock.
 *      Idempotent: every statement is `IF NOT EXISTS`. Indexes use
 *      `CREATE INDEX CONCURRENTLY` so we never block live sends.
 *
 *   3. Window override (`PRESSURE_WINDOW_HOURS` env, default 4):
 *      Used ONLY for the nullsink concurrency test (set to 0 / very large)
 *      and ops drills. Production code paths must always use the default.
 *      In-prod retroactive change 6h→4h on 2026-05-23 also shifted the
 *      ~2.3M existing deferred rows back by 2h via:
 *        UPDATE campaign_sends SET eligible_at = eligible_at - INTERVAL '2 hours'
 *         WHERE status='pending' AND eligible_at > NOW();
 */

import { pool, db } from "../db";
import { sql } from "drizzle-orm";
import { toPgTextArray } from "../utils/pg-array";
import { logger } from "../logger";
import { withAdvisoryLock, LOCK_KEYS, indexExistsAndValid, runIndexDdlNoTimeout } from "../bootstrap-lock";
import {
  pressureGuardDeferredTotal,
  pressureGuardBlockedByOlderTotal,
  pressureGuardBackfillRowsTotal,
  pressureGuardBackfillInProgress,
} from "../metrics";

// Production hard-locks the window to 4h per task contract (was 6h
// until 2026-05-23 — business decision to tighten delivery cadence
// while keeping deliverability safe). The `PRESSURE_WINDOW_HOURS`
// env override is honoured ONLY in non-prod environments
// (development/test) where the nullsink suite needs to validate
// guard mechanics over a much shorter window.
//
// Task #145 R14: strict bounds [5min, 7d]. Out-of-range values cause
// the module to throw at import time so misconfiguration cannot reach
// the running guard. Production ignores the env entirely.
// We compare in MINUTES (rounded) so the documented short-form value
// "0.0833" (the conventional decimal for 5 minutes) is accepted even
// though it is numerically a hair under 5/60 hours.
const PRESSURE_WINDOW_MIN_MINUTES = 5;
const PRESSURE_WINDOW_MAX_MINUTES = 168 * 60; // 7 days
export const PRESSURE_WINDOW_HOURS = (() => {
  if (process.env.NODE_ENV === "production") return 4;
  const raw = process.env.PRESSURE_WINDOW_HOURS;
  if (!raw) return 4;
  const parsed = Number(raw);
  const minutes = Math.round(parsed * 60);
  if (!Number.isFinite(parsed) || minutes < PRESSURE_WINDOW_MIN_MINUTES || minutes > PRESSURE_WINDOW_MAX_MINUTES) {
    throw new Error(
      `[PRESSURE_GUARD] PRESSURE_WINDOW_HOURS=${raw} is invalid; ` +
      `must be a finite number in [${PRESSURE_WINDOW_MIN_MINUTES}min, ${PRESSURE_WINDOW_MAX_MINUTES}min]`,
    );
  }
  return parsed;
})();

// Task #169 — Aging cap. Unlike PRESSURE_WINDOW_HOURS the operator is
// allowed to tune this in PRODUCTION because the cap is purely defensive:
// it bounds the worst-case "stuck deferred" latency without ever
// shortening the 6h gap (the per-recipient last_sent_at is still
// stamped to NOW() when we force-dispatch, so the 6h guard re-engages
// forward in time). Default 52h, range 6h..30d. Out-of-range or non-
// finite values cause the module to throw at import time so a typo
// can't reach the running guard.
const PRESSURE_MAX_DEFER_MIN_HOURS = 6;
const PRESSURE_MAX_DEFER_MAX_HOURS = 720;
export const PRESSURE_MAX_DEFER_HOURS = (() => {
  const raw = process.env.PRESSURE_MAX_DEFER_HOURS;
  if (!raw) return 52;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < PRESSURE_MAX_DEFER_MIN_HOURS || parsed > PRESSURE_MAX_DEFER_MAX_HOURS) {
    throw new Error(
      `[PRESSURE_GUARD] PRESSURE_MAX_DEFER_HOURS=${raw} is invalid; ` +
      `must be a finite number in [${PRESSURE_MAX_DEFER_MIN_HOURS}h, ${PRESSURE_MAX_DEFER_MAX_HOURS}h]`,
    );
  }
  return parsed;
})();

// Task #169 — Near-aging gauge threshold (rows in the "about to be
// force-dispatched" window). Default = max-defer minus 24h, clamped to
// at least 1h before max-defer so the gauge is always meaningful.
export const PRESSURE_NEAR_AGING_HOURS = (() => {
  const raw = process.env.PRESSURE_NEAR_AGING_HOURS;
  const fallback = Math.max(1, PRESSURE_MAX_DEFER_HOURS - 24);
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed >= PRESSURE_MAX_DEFER_HOURS) {
    throw new Error(
      `[PRESSURE_GUARD] PRESSURE_NEAR_AGING_HOURS=${raw} is invalid; ` +
      `must be a finite number in [1h, ${PRESSURE_MAX_DEFER_HOURS}h) (strictly less than PRESSURE_MAX_DEFER_HOURS)`,
    );
  }
  return parsed;
})();

let bootstrapState: "pending" | "ready" | "deferred" = "pending";
export function getPressureGuardBootstrapState() {
  return bootstrapState;
}

async function verifyPressureSchemaReady(): Promise<boolean> {
  // Sender start-up gate (Task #144): only flip bootstrapState='ready'
  // after every required schema artefact is observably present. Catches
  // the case where withAdvisoryLock() returns 'skipped' (another node
  // is mid-bootstrap) or 'error' (lock acquisition failed) — neither
  // implies the columns/indexes/audit table actually exist on this DB.
  try {
    const r = await pool.query(`
      SELECT
        EXISTS(SELECT 1 FROM information_schema.columns
               WHERE table_name='subscribers' AND column_name='last_sent_at') AS has_last_sent_at,
        EXISTS(SELECT 1 FROM information_schema.columns
               WHERE table_name='campaigns' AND column_name='deferred_count') AS has_deferred_count,
        EXISTS(SELECT 1 FROM information_schema.columns
               WHERE table_name='campaign_sends' AND column_name='eligible_at') AS has_eligible_at,
        EXISTS(SELECT 1 FROM information_schema.tables
               WHERE table_name='pressure_flush_audit') AS has_audit,
        -- Task #145 hardening artefacts:
        EXISTS(SELECT 1 FROM information_schema.columns
               WHERE table_name='users' AND column_name='is_admin') AS has_is_admin,
        EXISTS(SELECT 1 FROM information_schema.tables
               WHERE table_name='pressure_maintenance_state') AS has_maint_state,
        -- Task #149: lease-table for leader election (replaces session-level
        -- pg_try_advisory_lock which leaks on PgBouncer transaction-pooled endpoints).
        EXISTS(SELECT 1 FROM information_schema.tables
               WHERE table_name='pressure_guard_leader') AS has_leader_table,
        -- Task #169: aging cap artefacts.
        EXISTS(SELECT 1 FROM information_schema.columns
               WHERE table_name='campaign_sends' AND column_name='first_deferred_at') AS has_first_deferred_at,
        EXISTS(SELECT 1 FROM information_schema.columns
               WHERE table_name='campaigns' AND column_name='aged_forced_count') AS has_aged_forced_count
    `);
    const row = r.rows[0] as Record<string, boolean>;
    return Boolean(
      row?.has_last_sent_at && row?.has_deferred_count && row?.has_eligible_at &&
      row?.has_audit && row?.has_is_admin && row?.has_maint_state &&
      row?.has_leader_table &&
      row?.has_first_deferred_at && row?.has_aged_forced_count,
    );
  } catch {
    return false;
  }
}

export async function runPressureGuardBootstrap(): Promise<"ready" | "deferred"> {
  // Fast-path (Task #145 hotfix): if every required schema artefact is
  // already present from a prior boot, flip the sender gate to 'ready'
  // immediately. The heavy maintenance below (DDL, CREATE INDEX
  // CONCURRENTLY on multi-million-row partials, last_sent_at backfill)
  // is fully idempotent and can run in the background — it must NOT
  // block the gate, otherwise legitimate sending stalls for many minutes
  // on every restart while indexes/backfill churn. Without this fast-
  // path the sender wraps "Pressure-guard bootstrap not ready
  // (state=pending)" as a non-transient error, the campaign_job is
  // marked failed, and auto-resume re-creates a fresh pending job that
  // hits the same wall — a tight crash loop with zero outbound traffic.
  if (await verifyPressureSchemaReady()) {
    if (bootstrapState !== "ready") {
      bootstrapState = "ready";
      stopBootstrapRetry();
      logger.info(
        `[PRESSURE_GUARD] Bootstrap fast-path: schema already verified, gate opened immediately (window=${PRESSURE_WINDOW_HOURS}h, max_defer=${PRESSURE_MAX_DEFER_HOURS}h, near_aging=${PRESSURE_NEAR_AGING_HOURS}h) — heavy maintenance will run in background`,
      );
    }
    // Background heavy maintenance — failures are non-fatal and the next
    // boot retries from where we left off. We intentionally do not await.
    void runPressureGuardHeavyMaintenance().catch((err: any) => {
      logger.warn(
        `[PRESSURE_GUARD] Background heavy maintenance failed (non-fatal, will retry next boot): ${err?.message || err}`,
      );
    });
    return "ready";
  }
  // Slow path: schema is not present yet, must complete DDL synchronously
  // before allowing sends.
  return await runPressureGuardHeavyMaintenance();
}

/**
 * Idempotent essential-schema DDL for pressure-guard. Every statement is
 * `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE … ADD COLUMN IF NOT EXISTS`
 * / `INSERT … ON CONFLICT DO NOTHING` / `CREATE INDEX IF NOT EXISTS`, so
 * concurrent boots from multiple processes are safe — PG serialises at
 * the catalog level and the second runner is a no-op on every line.
 *
 * Historical bug (production incident 2026-05-22): this block used to
 * live inside `withAdvisoryLock(LOCK_KEYS.PRESSURE_GUARD, …)` which uses
 * `pg_try_advisory_lock` (session-level). On Neon's PgBouncer
 * transaction-pooled URL each statement on a `pool.connect()` client is
 * routed to a *different* PG backend, so:
 *   1. The lock is acquired on backend A but never released by it (the
 *      `pg_advisory_unlock` runs on backend Z → returns false → backend
 *      A leaks the lock until that physical connection dies).
 *   2. Every subsequent boot grabs a different backend B/C/D from the
 *      PgBouncer pool. If it happens to land on backend A (or any other
 *      leaked-lock holder), `pg_try_advisory_lock` returns false and we
 *      silently bail with "Another process is running bootstrap" — the
 *      DDL never executes, the tables are never created, and the worker
 *      drainer fails to acquire its leader-lease on every tick (drain
 *      goes to zero with no obvious error).
 *
 * Fix: run the essential DDL directly via `pool.query()` (one connection
 * per statement; idempotency from PG catalog serialisation is enough).
 * The advisory lock is preserved for the HEAVY work below (CREATE INDEX
 * CONCURRENTLY + backfills) where serialising concurrent runners still
 * matters, but the DDL section that gates the entire drain path now
 * runs unconditionally on every boot.
 */
export async function ensurePressureGuardEssentialSchema(): Promise<void> {
  const stmts: Array<{ sql: string; label: string }> = [
    { label: "subscribers.last_sent_at", sql: `ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS last_sent_at timestamp` },
    { label: "campaigns.deferred_count", sql: `ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS deferred_count integer NOT NULL DEFAULT 0` },
    // Cached MAX(campaign_sends.sent_at) per campaign — replaces the
    // catastrophic correlated subquery that scanned the 67M-row
    // campaign_sends table once per active campaign on every dashboard /
    // ghost-sweep call. Maintained live by bulkFinalizeSends /
    // finalizeSend in campaign-repository.ts.
    { label: "campaigns.last_send_at", sql: `ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS last_send_at timestamp` },
    // R3: tiny single-row state table so cluster-wide once/day
    // maintenance is idempotent across multiple worker processes.
    { label: "pressure_maintenance_state", sql: `
        CREATE TABLE IF NOT EXISTS pressure_maintenance_state (
          id boolean PRIMARY KEY DEFAULT true,
          last_heavy_run_date date,
          CONSTRAINT pressure_maintenance_state_singleton CHECK (id = true)
        )` },
    { label: "pressure_maintenance_state seed", sql: `INSERT INTO pressure_maintenance_state (id) VALUES (true) ON CONFLICT (id) DO NOTHING` },
    // Task #149: lease-table for cross-cluster leader election.
    // Replaces `pg_try_advisory_lock` (session-level) which leaks
    // indefinitely on Neon PgBouncer transaction-pooled endpoints.
    // Each row is acquired/refreshed/released by atomic single-statement
    // ops, so it is fully compatible with transaction pooling and
    // self-recovers after a node crash via the TTL on `expires_at`.
    { label: "pressure_guard_leader", sql: `
        CREATE TABLE IF NOT EXISTS pressure_guard_leader (
          lock_key text PRIMARY KEY,
          holder_id text NOT NULL,
          expires_at timestamptz NOT NULL
        )` },
    // Task #160: per-lease last-tick heartbeat — written by the
    // drain loop on every successful (or failed) tick so a remote
    // health endpoint can answer "is the drain still alive?" without
    // relying on in-process state (the drainer runs in its own PM2
    // process and the web cannot inspect its memory).
    { label: "pressure_guard_leader.last_tick_at", sql: `ALTER TABLE pressure_guard_leader ADD COLUMN IF NOT EXISTS last_tick_at timestamptz` },
    { label: "pressure_guard_leader.last_tick_drained", sql: `ALTER TABLE pressure_guard_leader ADD COLUMN IF NOT EXISTS last_tick_drained int NOT NULL DEFAULT 0` },
    { label: "pressure_guard_leader.last_tick_errors", sql: `ALTER TABLE pressure_guard_leader ADD COLUMN IF NOT EXISTS last_tick_errors int NOT NULL DEFAULT 0` },
    { label: "pressure_guard_leader.last_tick_eligible", sql: `ALTER TABLE pressure_guard_leader ADD COLUMN IF NOT EXISTS last_tick_eligible int NOT NULL DEFAULT 0` },
    // Task #160: cross-process drain-tick error log. Each row is one
    // caught exception inside the safeInterval-wrapped drain tick or
    // a per-campaign drainCampaign() call. Read by
    // /api/admin/pressure-drain/health to compute errors_5m WITHOUT
    // depending on in-process counters (the drainer runs in a
    // separate PM2 process whose memory the web cannot inspect).
    // Auto-pruned to 24h via the maintenance tick — see
    // server/workers/pressure-guard-worker.ts runMaintenanceTick.
    { label: "pressure_drain_tick_errors", sql: `
        CREATE TABLE IF NOT EXISTS pressure_drain_tick_errors (
          id bigserial PRIMARY KEY,
          occurred_at timestamptz NOT NULL DEFAULT NOW(),
          holder_id text,
          error_msg text
        )` },
    { label: "pressure_drain_tick_errors idx", sql: `CREATE INDEX IF NOT EXISTS pressure_drain_tick_errors_occurred_at_idx ON pressure_drain_tick_errors (occurred_at DESC)` },
    { label: "campaigns.skipped_pressure_count", sql: `ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS skipped_pressure_count integer NOT NULL DEFAULT 0` },
    { label: "campaign_sends.eligible_at", sql: `ALTER TABLE campaign_sends ADD COLUMN IF NOT EXISTS eligible_at timestamp` },
    // 2026-05-27: campaign_jobs.heartbeat column. Referenced by
    // workers.ts ghost-sweep and stuck-campaign-diagnosis to detect
    // crashed senders. Production was raising "column cj.heartbeat does
    // not exist" because the column was never added by a migration —
    // the Drizzle schema referenced it but no DDL had been deployed.
    { label: "campaign_jobs.heartbeat", sql: `ALTER TABLE campaign_jobs ADD COLUMN IF NOT EXISTS heartbeat timestamp` },
    // Task #169: aging cap columns. ALTER TABLE … ADD COLUMN with
    // NULLable timestamp / integer DEFAULT 0 is a metadata-only
    // operation on PG ≥ 11 (no full table rewrite).
    { label: "campaign_sends.first_deferred_at", sql: `ALTER TABLE campaign_sends ADD COLUMN IF NOT EXISTS first_deferred_at timestamp` },
    { label: "campaigns.aged_forced_count", sql: `ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS aged_forced_count integer NOT NULL DEFAULT 0` },
    // 2026-05-22: Urgent mode bypass column. See `urgentMode` comment in
    // shared/schema.ts. Default false → all existing campaigns continue
    // to honour the 6h pressure window and `blocked_by_older` FIFO.
    { label: "campaigns.urgent_mode", sql: `ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS urgent_mode boolean NOT NULL DEFAULT false` },
    // 2026-05-23: campaigns.user_id owner column. Referenced by
    // `/api/campaigns/:id/urgent` and `/api/campaigns/:id/queue` for
    // the admin-or-owner gate. Nullable on purpose — historical rows
    // pre-date the column and have no recorded owner; the route guards
    // treat NULL as "no enforced owner" (admin still enforced). Added
    // here after a production incident where the route returned 500
    // because Postgres raised `column "user_id" does not exist`.
    { label: "campaigns.user_id", sql: `ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS user_id varchar` },
    // 2026-05-23: pointer from `campaigns` to the most recent
    // urgent-flush job, set by the async POST /api/campaigns/:id/urgent.
    // See `urgentFlushJobId` comment in shared/schema.ts.
    { label: "campaigns.urgent_flush_job_id", sql: `ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS urgent_flush_job_id varchar` },
    // 2026-05-23: async urgent-flush jobs table. Replaces the
    // synchronous 68k-row UPDATE that saturated the Neon pool during
    // the 2026-05-23 incident. The /urgent route enqueues here and
    // returns 202; the urgent-flush worker drains the held queue in
    // 2 000-row batches with sleeps between batches. See
    // server/services/urgent-flush-service.ts.
    { label: "urgent_flush_jobs", sql: `
        CREATE TABLE IF NOT EXISTS urgent_flush_jobs (
          id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
          campaign_id varchar NOT NULL,
          user_id varchar,
          status text NOT NULL DEFAULT 'pending',
          total_held integer NOT NULL DEFAULT 0,
          processed integer NOT NULL DEFAULT 0,
          batch_size integer NOT NULL DEFAULT 2000,
          error text,
          created_at timestamptz NOT NULL DEFAULT NOW(),
          started_at timestamptz,
          completed_at timestamptz,
          heartbeat_at timestamptz
        )` },
    { label: "urgent_flush_jobs_status_created_idx", sql: `CREATE INDEX IF NOT EXISTS urgent_flush_jobs_status_created_idx ON urgent_flush_jobs(status, created_at)` },
    { label: "urgent_flush_jobs_campaign_idx", sql: `CREATE INDEX IF NOT EXISTS urgent_flush_jobs_campaign_idx ON urgent_flush_jobs(campaign_id)` },
    // Task #145 R13: DB-backed admin gate (replaces ADMIN_USER_IDS env-only).
    { label: "users.is_admin", sql: `ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin boolean NOT NULL DEFAULT false` },
    { label: "pressure_flush_audit", sql: `
        CREATE TABLE IF NOT EXISTS pressure_flush_audit (
          id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
          campaign_id varchar,
          user_id varchar,
          scope text NOT NULL,
          count integer NOT NULL DEFAULT 0,
          reason text NOT NULL DEFAULT '',
          created_at timestamp NOT NULL DEFAULT NOW()
        )` },
    { label: "pressure_flush_audit campaign idx", sql: `CREATE INDEX IF NOT EXISTS pressure_flush_audit_campaign_idx ON pressure_flush_audit(campaign_id)` },
    { label: "pressure_flush_audit created idx", sql: `CREATE INDEX IF NOT EXISTS pressure_flush_audit_created_idx ON pressure_flush_audit(created_at)` },
  ];
  for (const { sql, label } of stmts) {
    try {
      await pool.query(sql);
    } catch (err: any) {
      // Surface but don't abort: a single ALTER failing (e.g. permission
      // race on a parent ALTER) must not prevent the remaining DDL from
      // running. The post-DDL `verifyPressureSchemaReady()` check is the
      // authoritative gate.
      logger.error(`[PRESSURE_GUARD] essential DDL failed (${label}): ${err?.message || err}`);
    }
  }
}

async function runPressureGuardHeavyMaintenance(): Promise<"ready" | "deferred"> {
  let outcome: "ready" | "deferred" = "ready";

  // (1) Essential schema first, unconditionally and without any advisory
  // lock — see ensurePressureGuardEssentialSchema's banner comment for
  // why withAdvisoryLock is incompatible with Neon PgBouncer transaction
  // pooling. Idempotent across concurrent boots.
  await ensurePressureGuardEssentialSchema();

  // (2) Heavy maintenance under advisory lock — only the CREATE INDEX
  // CONCURRENTLY and the first_deferred_at backfill below depend on
  // serialisation across processes, and they all live OUTSIDE the
  // withAdvisoryLock client (CONCURRENTLY can't run in a transaction
  // block anyway). The wrapper now only owns the gate: returns "ran" if
  // we won leadership, "skipped" if another node owns it, "error" on
  // pool issues. We don't run any DDL inside it anymore.
  const result = await withAdvisoryLock(
    LOCK_KEYS.PRESSURE_GUARD,
    "PRESSURE_GUARD",
    async (_client) => { /* DDL was hoisted out — see ensurePressureGuardEssentialSchema() */ },
  );

  // Build the partial index outside the advisory lock client (CREATE INDEX
  // CONCURRENTLY can't run in a transaction block). We run on BOTH "ran"
  // and "skipped" (essential schema is already in place from the
  // unconditional ensurePressureGuardEssentialSchema() above, and the
  // CONCURRENTLY builds are themselves idempotent via
  // `IF NOT EXISTS` + `indexExistsAndValid` guard), but skip on "error"
  // to avoid piling expensive CONCURRENTLY work onto a pool that is
  // already failing — the bootstrap-retry timer will re-attempt the
  // whole sequence in 15s.
  if (result !== "error") {
    // Task #145 R6/R7/R8: 3 additional partial indexes that back the
    // per-campaign queue page, the admin /curve sparkline, and the
    // top-20 most-deferred-contacts query. Each is built CONCURRENTLY
    // and IF NOT EXISTS so reboot is a no-op once the index is live.
    const indexes: Array<{ name: string; ddl: string }> = [
      {
        name: "campaign_sends_pressure_deferred_idx",
        ddl: `CREATE INDEX CONCURRENTLY IF NOT EXISTS campaign_sends_pressure_deferred_idx
              ON campaign_sends (eligible_at)
              WHERE status = 'pending' AND eligible_at IS NOT NULL`,
      },
      {
        // R6: per-campaign histogram + queue listing.
        name: "campaign_sends_pressure_campaign_eligible_idx",
        ddl: `CREATE INDEX CONCURRENTLY IF NOT EXISTS campaign_sends_pressure_campaign_eligible_idx
              ON campaign_sends (campaign_id, eligible_at)
              WHERE status = 'pending' AND eligible_at IS NOT NULL`,
      },
      {
        // R7: admin /curve groups by date_trunc('day', sent_at) over
        // rows with eligible_at IS NOT NULL in a 7-day window.
        name: "campaign_sends_pressure_curve_idx",
        ddl: `CREATE INDEX CONCURRENTLY IF NOT EXISTS campaign_sends_pressure_curve_idx
              ON campaign_sends (sent_at)
              WHERE eligible_at IS NOT NULL`,
      },
      {
        // R8: top-20 GROUP BY subscriber_id over deferred rows.
        name: "campaign_sends_pressure_subscriber_idx",
        ddl: `CREATE INDEX CONCURRENTLY IF NOT EXISTS campaign_sends_pressure_subscriber_idx
              ON campaign_sends (subscriber_id)
              WHERE status = 'pending' AND eligible_at IS NOT NULL`,
      },
      {
        // Task #145 hotfix R17: critical hot-path index for the
        // `blocked_by_older` CTE in pressureGuardReserveSendSlots.
        // Without this, every CAS batch triggers a partial-table scan over
        // campaign_sends (27 GB / 54M rows) to find rows where the chunk's
        // subscriber_ids have a pending/attempting row in another campaign.
        // The partial WHERE filter is intentionally NOT keyed on
        // eligible_at IS NOT NULL because `blocked_by_older` matches BOTH
        // active-pending (eligible_at NULL) and deferred-pending
        // (eligible_at NOT NULL) plus 'attempting' rows. Live size is
        // bounded by total in-flight sends across all campaigns —
        // typically <100k rows even at peak — so the index stays small
        // (a few MB) regardless of historical send volume.
        name: "campaign_sends_active_subscriber_idx",
        ddl: `CREATE INDEX CONCURRENTLY IF NOT EXISTS campaign_sends_active_subscriber_idx
              ON campaign_sends (subscriber_id, campaign_id)
              WHERE status IN ('pending', 'attempting')`,
      },
      {
        // Task #169: aging probe. Backs "oldest deferred" admin metric,
        // near-aging gauge, and the per-claim aged vs normal split in
        // drainCampaign. Partial scope = currently-pending deferred rows
        // only, so the index stays small.
        name: "campaign_sends_pressure_aging_idx",
        ddl: `CREATE INDEX CONCURRENTLY IF NOT EXISTS campaign_sends_pressure_aging_idx
              ON campaign_sends (first_deferred_at)
              WHERE status = 'pending' AND eligible_at IS NOT NULL AND first_deferred_at IS NOT NULL`,
      },
    ];
    for (const { name, ddl } of indexes) {
      try {
        const exists = await indexExistsAndValid(name);
        if (!exists) {
          // Task #166: build on a dedicated client with statement_timeout=0.
          // campaign_sends is ~11GB / 60M rows; the global Neon
          // statement_timeout=2min reliably aborts CONCURRENTLY builds
          // mid-flight and leaves them in the INVALID state, which then
          // blocks every subsequent boot.
          await runIndexDdlNoTimeout(ddl, `CREATE ${name}`);
          logger.info(`[PRESSURE_GUARD] Created partial index ${name}`);
        }
      } catch (err: any) {
        logger.warn(`[PRESSURE_GUARD] CONCURRENTLY ${name} build failed (non-fatal): ${err?.message || err}`);
      }
    }

    // Task #145 hotfix R17: the historical backfill of
    // subscribers.last_sent_at has been REMOVED. Rationale:
    //   1. The previous query JOINed subscribers (1.58M) with
    //      campaign_sends (27 GB / 54M rows) GROUP BY subscriber_id —
    //      every chunk timed out against statement_timeout, leaving
    //      `with_last_sent_at = 0/1.58M` after multiple boot attempts
    //      and stalling the bootstrap for many minutes per restart.
    //   2. NULL is semantically correct: the CAS condition at
    //      `pressureGuardReserveSendSlots` is
    //      `(last_sent_at IS NULL OR last_sent_at + 6h <= NOW())` —
    //      a NULL contact wins immediately. The 6h guard auto-engages
    //      from the very first send forward, which is exactly the
    //      desired behaviour going forward.
    //   3. The "deferred queue" semantic is unaffected: deferral is
    //      keyed on the receiving contact's *current* last_sent_at,
    //      stamped by the previous send. Historical sends > 6h ago
    //      never participate in deferral regardless of whether
    //      last_sent_at was backfilled.
    // We still create the sentinel table so any old in-flight code path
    // that checks for it continues to short-circuit cleanly.
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS pressure_guard_backfill_done (id integer PRIMARY KEY)`);
      try { pressureGuardBackfillInProgress.set(0); } catch {}
      logger.info(
        `[PRESSURE_GUARD] Historical last_sent_at backfill skipped by design — guard auto-engages from first send onward (NULL is semantically correct, see comment)`,
      );
    } catch (err: any) {
      logger.warn(`[PRESSURE_GUARD] sentinel create failed (non-fatal): ${err?.message || err}`);
    }

    // Task #169: backfill first_deferred_at for any currently-pending
    // deferred rows that pre-date this column. We default to sent_at —
    // which is the row's insertion timestamp for deferred rows since
    // pressureGuardReserveSendSlots writes sent_at=NOW() at INSERT and
    // the re-defer cascade only touches eligible_at. The UPDATE is
    // scoped by the partial index campaign_sends_pressure_deferred_idx
    // (NULL-only filter is added so it is a no-op after the first run).
    // Non-fatal: a transient failure here just means the next boot
    // retries. Aged sends with NULL first_deferred_at simply won't be
    // flagged as aged until the backfill lands — the guard still works,
    // just without the cap for those rows.
    try {
      const r = await pool.query(`
        UPDATE campaign_sends
        SET first_deferred_at = sent_at
        WHERE status = 'pending'
          AND eligible_at IS NOT NULL
          AND first_deferred_at IS NULL
      `);
      const n = r.rowCount ?? 0;
      if (n > 0) {
        logger.info(`[PRESSURE_GUARD] Task #169: backfilled first_deferred_at on ${n} pending deferred row(s)`);
      }
    } catch (err: any) {
      logger.warn(`[PRESSURE_GUARD] Task #169 first_deferred_at backfill failed (non-fatal, will retry next boot): ${err?.message || err}`);
    }
  }

  // Readiness gate. Now that `ensurePressureGuardEssentialSchema()` runs
  // unconditionally above (no lock, idempotent), the authoritative signal
  // is `schemaOk` from the post-DDL verify. The `result` value is only
  // informational here — it tells us whether THIS process owned the
  // CONCURRENTLY/backfill heavy-section gate, but it does NOT need to be
  // "ran" for readiness because the schema check is what truly matters.
  // This breaks the historical "skipped → not ready" pitfall where a
  // leaked PgBouncer advisory lock would permanently keep the gate shut.
  const schemaOk = await verifyPressureSchemaReady();
  if (outcome === "ready" && schemaOk) {
    bootstrapState = "ready";
    stopBootstrapRetry();
    logger.info(`[PRESSURE_GUARD] Bootstrap ready (window=${PRESSURE_WINDOW_HOURS}h, max_defer=${PRESSURE_MAX_DEFER_HOURS}h, near_aging=${PRESSURE_NEAR_AGING_HOURS}h, lock=${result}, schema_verified=${schemaOk})`);
  } else {
    bootstrapState = "deferred";
    outcome = "deferred";
    logger.warn(`[PRESSURE_GUARD] Bootstrap NOT ready: lock=${result}, schema_verified=${schemaOk}, outcome=${outcome} — will retry every 15s`);
    startBootstrapRetry();
  }
  return outcome;
}

// Self-healing retry. If the first bootstrap call returned 'deferred'
// (lock contention with another booting process, schema not yet visible,
// transient DB error), we re-probe `verifyPressureSchemaReady()` every
// 15s and flip to 'ready' as soon as the artefacts appear. This prevents
// the sender's start-up gate from being permanently stuck and keeps
// multi-process boot races safe.
let retryTimer: NodeJS.Timeout | null = null;
function stopBootstrapRetry() {
  if (retryTimer) { clearInterval(retryTimer); retryTimer = null; }
}
function startBootstrapRetry() {
  if (retryTimer) return;
  retryTimer = setInterval(async () => {
    if (bootstrapState === "ready") { stopBootstrapRetry(); return; }
    const ok = await verifyPressureSchemaReady();
    if (ok) {
      bootstrapState = "ready";
      stopBootstrapRetry();
      logger.info(`[PRESSURE_GUARD] Bootstrap recovered to 'ready' via retry probe`);
    }
  }, 15_000);
  // Don't keep the event loop alive just for this probe.
  if (typeof retryTimer.unref === "function") retryTimer.unref();
}

/**
 * Atomic reserve. Returns the subscriber IDs that won the CAS race AND have
 * been inserted into campaign_sends with status='pending', eligible_at=NULL.
 * Losers are inserted with status='pending' AND eligible_at=last_sent_at+6h
 * for the deferred-drain worker to pick up. Already-existing campaign_sends
 * rows (re-run, retry pass) are returned as winners only when they are
 * currently in 'pending' or 'attempting' status — we do NOT defer them.
 */
export async function pressureGuardReserveSendSlots(
  campaignId: string,
  subscriberIds: string[],
  windowHours: number = PRESSURE_WINDOW_HOURS,
): Promise<string[]> {
  if (subscriberIds.length === 0) return [];

  const CHUNK_SIZE = 1000;
  // Parallel classification (perf optim 2026-05-18): chunks are independent
  // (disjoint subscriber sets, per-subscriber pg_advisory_xact_locks inside
  // each tx, separate `campaign_sends` upserts) so we can fan them out.
  // Bounded to PRESSURE_GUARD_PARALLEL_CHUNKS (default 3) to respect the
  // worker pool budget. Sizing math:
  //   WORKER_PG_POOL_MAX default 18 (see connection-budget.ts)
  //   MAX_CONCURRENT_CAMPAIGNS default 8 (see workers.ts)
  //   Worst-case concurrent reserve txns = 8 × 3 = 24 (slight oversubscription
  //   but chunks are ~150-300ms so pool wait is short; in practice not all 8
  //   senders are in the reserve phase simultaneously — they alternate between
  //   fetch, reserve, SMTP push, snowball check).
  // Operators bumping PARALLEL >3 should also bump WORKER_PG_POOL_MAX so
  // (MAX_CONCURRENT_CAMPAIGNS × PARALLEL) ≤ WORKER_PG_POOL_MAX + ~6 headroom.
  // The pressure semantics (6h window, blocked_by_older, CAS on last_sent_at,
  // per-subscriber advisory locks) are STRICTLY unchanged — we only parallelize
  // the loop. The deferred_count UPDATE is hoisted out of the loop and applied
  // ONCE at the end with the aggregated total (was: 1 UPDATE per chunk).
  const PARALLEL = Math.max(1, Math.min(20,
    Number(process.env.PRESSURE_GUARD_PARALLEL_CHUNKS ?? 3)
  ));
  const winners: string[] = [];
  let totalDeferred = 0;

  const chunks: string[][] = [];
  for (let i = 0; i < subscriberIds.length; i += CHUNK_SIZE) {
    chunks.push(subscriberIds.slice(i, i + CHUNK_SIZE));
  }

  const processChunk = async (chunk: string[]): Promise<{ winChunk: string[]; deferredN: number; blockedN: number }> => {
    // Drizzle expands `${jsArray}` as a row constructor `($1,$2,...)` which
    // is type `record`, not `text[]`. Casting record→text[] fails with
    // 42846 ("cannot cast type record to text[]"). Serialize the array as
    // a single PG array literal string so it binds as ONE param of text[].
    const chunkLiteral = toPgTextArray(chunk);

    // FIFO determinism (Task #144) — two layers:
    //   (a) Per-subscriber advisory transaction locks (acquired in sorted
    //       hashtext order) serialize concurrent reserves on the same
    //       contact across all campaigns. This kills the lock-queue race
    //       so when two senders race the *same* subscriber, only one
    //       executes the CAS at a time.
    //   (b) Inside the CAS, `blocked_by_older` filters subscribers that
    //       already have a pending/attempting row in any older campaign
    //       (smaller `created_at` — Task #153, see claimNextJob comment
    //       in job-repository.ts for why started_at is unsafe across
    //       restarts). Combined with the created_at-ordered
    //       `claimNextJob`, the older campaign always claims the slot
    //       first — newer senders see the existing row under the lock and
    //       get deferred.
    const result = await db.transaction(async (tx) => {
      // campaign-job stall RCA (2026-05-19) — Fast-fail on lock contention. SET LOCAL survives the
      // transaction and is the only timeout-set form that survives Neon
      // PgBouncer transaction pooling on a per-statement basis. Without
      // this, a single zombie backend (from a prior worker crash) holding
      // overlapping advisory locks would block the lock acquisition below
      // for the full statement_timeout (120s), starving 8 concurrent
      // senders and triggering the 30-min job-level "worker may have
      // crashed" timeout cascade observed on 2026-05-19. With lock_timeout
      // at 10s, contention surfaces as a fast retryable error → the
      // sender's per-chunk catch path re-throws, the job is re-queued
      // with exponential backoff, and by then the zombie is gone (the
      // 60s idle_in_transaction_session_timeout injected via DB
      // connection options has fired).
      await tx.execute(sql`SET LOCAL lock_timeout = '10s'`);
      // pg_advisory_xact_lock per subscriber, taken in sorted hash order
      // so concurrent transactions reserving overlapping subscriber sets
      // cannot deadlock on inverse acquisition order. Locks are released
      // automatically when the transaction commits/rolls back.
      await tx.execute(sql`
        SELECT pg_advisory_xact_lock(h)
        FROM (
          SELECT DISTINCT hashtextextended(s, 0)::bigint AS h
          FROM unnest(${chunkLiteral}::text[]) AS s
          ORDER BY h
        ) ordered
      `);
      return await tx.execute(sql`
        WITH input(id) AS (SELECT unnest(${chunkLiteral}::text[])),
        -- pressure-guard gates below can be flipped off for a single
        -- campaign without touching other in-flight sends. Default
        -- false on every existing row, so behaviour is unchanged unless
        -- an operator explicitly toggles it via /api/campaigns/:id/urgent.
        my_meta AS (SELECT created_at, urgent_mode FROM campaigns WHERE id = ${campaignId}),
        blocked_by_older AS (
          -- Empty set when urgent_mode is on → this campaign no longer
          -- yields to older campaigns claiming the same subscriber.
          SELECT DISTINCT cs.subscriber_id
          FROM campaign_sends cs
          JOIN campaigns c ON c.id = cs.campaign_id
          WHERE cs.subscriber_id = ANY(${chunkLiteral}::text[])
            AND cs.campaign_id <> ${campaignId}
            AND cs.status IN ('pending','attempting')
            AND c.created_at IS NOT NULL
            AND c.created_at < (SELECT created_at FROM my_meta)
            AND NOT (SELECT urgent_mode FROM my_meta)
        ),
        already_in_campaign AS (
          SELECT subscriber_id FROM campaign_sends
          WHERE campaign_id = ${campaignId} AND subscriber_id = ANY(${chunkLiteral}::text[])
        ),
        cas AS (
          -- Only stamp last_sent_at for genuinely new dispatches; rows that
          -- already exist for (campaign, subscriber) — re-runs, retries,
          -- resumed campaigns — would otherwise consume a 6h slot they
          -- already claimed, distorting the guard.
          --
          -- 2026-05-22: urgent_mode short-circuits the 6h gap check so the
          -- CAS succeeds for every subscriber regardless of how recently
          -- they were last hit. The stamp last_sent_at = NOW() still
          -- fires, which preserves the guard forward-integrity for
          -- future campaigns (i.e. urgent mode burns through the backlog
          -- now, but the 6h clock restarts immediately after).
          UPDATE subscribers s SET last_sent_at = NOW()
          FROM input i
          WHERE s.id = i.id
            AND i.id NOT IN (SELECT subscriber_id FROM blocked_by_older)
            AND i.id NOT IN (SELECT subscriber_id FROM already_in_campaign)
            AND (
              (SELECT urgent_mode FROM my_meta)
              OR s.last_sent_at IS NULL
              OR s.last_sent_at + (${windowHours}::numeric || ' hours')::interval <= NOW()
            )
          RETURNING s.id
        ),
        existing_winners AS (
          -- Pre-existing pending/attempting rows count as winners without
          -- re-stamping last_sent_at — the slot was claimed already.
          -- Use FOR UPDATE SKIP LOCKED so concurrent reservers do NOT
          -- both inherit the same pre-existing row as a winner; only the
          -- caller that holds the row-lock picks it up. Combined with
          -- per-subscriber pg_advisory_xact_lock above, this guarantees
          -- exactly-one immediate winner per (campaign, subscriber) even
          -- across retries/resumes that race the same chunk.
          SELECT subscriber_id FROM campaign_sends
          WHERE campaign_id = ${campaignId} AND subscriber_id = ANY(${chunkLiteral}::text[])
            AND status IN ('pending','attempting') AND eligible_at IS NULL
          FOR UPDATE SKIP LOCKED
        ),
        reserved AS (
          INSERT INTO campaign_sends (id, campaign_id, subscriber_id, status, sent_at, eligible_at)
          SELECT gen_random_uuid(), ${campaignId}, cas.id, 'pending', NOW(), NULL FROM cas
          ON CONFLICT (campaign_id, subscriber_id) DO NOTHING
          RETURNING subscriber_id
        ),
        losers AS (
          SELECT s.id, s.last_sent_at FROM subscribers s JOIN input i ON i.id = s.id
          WHERE s.id NOT IN (SELECT id FROM cas)
            AND s.id NOT IN (SELECT subscriber_id FROM already_in_campaign)
        ),
        deferred_ins AS (
          -- Task #169: stamp first_deferred_at=NOW() on every fresh defer
          -- insert. The re-defer cascade in the drain worker (UPDATE only,
          -- ON CONFLICT here protects against double-insert) does NOT
          -- touch this column, so it reliably reflects the row's true
          -- age across an unbounded cascade.
          INSERT INTO campaign_sends (id, campaign_id, subscriber_id, status, sent_at, eligible_at, first_deferred_at)
          SELECT gen_random_uuid(), ${campaignId}, l.id, 'pending', NOW(),
            COALESCE(l.last_sent_at, NOW()) + (${windowHours}::numeric || ' hours')::interval,
            NOW()
          FROM losers l
          ON CONFLICT (campaign_id, subscriber_id) DO NOTHING
          RETURNING subscriber_id
        ),
        defer_count AS (SELECT COUNT(*)::int AS n FROM deferred_ins),
        blocked_count AS (SELECT COUNT(*)::int AS n FROM blocked_by_older)
        SELECT
          (SELECT array_agg(subscriber_id) FROM (
            SELECT subscriber_id FROM reserved
            UNION SELECT subscriber_id FROM existing_winners
          ) w) AS winners,
          (SELECT n FROM defer_count) AS deferred_n,
          (SELECT n FROM blocked_count) AS blocked_n
      `);
    });

    const row = result.rows[0] as { winners: string[] | null; deferred_n: number | null; blocked_n: number | null } | undefined;
    const winChunk: string[] = Array.isArray(row?.winners) ? row.winners : [];
    const deferredN = Number(row?.deferred_n ?? 0);
    const blockedN = Number(row?.blocked_n ?? 0);
    return { winChunk, deferredN, blockedN };
  };

  // Bounded-parallelism pool: at most PARALLEL chunks in flight at once.
  // Each chunk holds 1 transaction-pooled backend for ~150-300ms; with
  // PARALLEL=5 and CHUNK_SIZE=1000 this drives ~5000 contacts/200ms ≈
  // 25k contacts/sec classification throughput per sender, vs the previous
  // serial ~5k/sec.
  //
  // Error-handling contract (architect-reviewed):
  //  - Each chunk runs in its own db.transaction → atomic per chunk: either
  //    both the reserved-inserts AND deferred-inserts commit, or neither do.
  //  - We use Promise.allSettled (NOT Promise.all) so a single chunk failure
  //    does NOT discard the deferred-row inserts already committed by sibling
  //    chunks. Without this, the previous per-chunk UPDATE of deferred_count
  //    was the only safety net; with consolidated UPDATE at the end, a
  //    fail-fast Promise.all would leak the counter increment for committed
  //    chunks.
  //  - We always persist `campaigns.deferred_count += sum(successful)` BEFORE
  //    re-throwing the first rejection. Sender's job-level retry will then
  //    re-call us with the same audience batch; ON CONFLICT DO NOTHING
  //    guarantees no double-counting of already-deferred subscriber rows
  //    (the unique (campaign_id, subscriber_id) index dedups), so the
  //    counter stays consistent even across retries.
  let cursor = 0;
  const firstError: { err: unknown } | null = { err: null };
  const runWorker = async (): Promise<void> => {
    while (true) {
      const myIdx = cursor++;
      if (myIdx >= chunks.length) return;
      try {
        const { winChunk, deferredN, blockedN } = await processChunk(chunks[myIdx]);
        if (blockedN > 0) {
          try { pressureGuardBlockedByOlderTotal.inc({ campaign_id: campaignId }, blockedN); } catch {}
        }
        if (winChunk.length) winners.push(...winChunk);
        if (deferredN > 0) {
          totalDeferred += deferredN;
          try { pressureGuardDeferredTotal.inc({ campaign_id: campaignId }, deferredN); } catch {}
        }
      } catch (err) {
        if (firstError.err == null) firstError.err = err;
        // Continue draining the worker so sibling chunks complete and we can
        // persist their committed deferred counts before re-throwing.
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, chunks.length) }, () => runWorker()));

  // Single consolidated UPDATE for the whole call (was: 1 UPDATE per chunk).
  // `campaigns.pending_count` is initialized to the full audience size by the
  // campaign-sender BEFORE the first CAS batch — deferred rows already live
  // inside `pending_count`, so we ONLY bump `deferred_count` here.
  // Persisted EVEN ON partial failure so successful chunks' counters stick.
  if (totalDeferred > 0) {
    try {
      await db.execute(sql`
        UPDATE campaigns
        SET deferred_count = deferred_count + ${totalDeferred}
        WHERE id = ${campaignId}
      `);
    } catch (e: any) {
      logger.warn(`[PRESSURE_GUARD] Campaign ${campaignId}: deferred_count UPDATE failed (non-fatal): ${e?.message || e}`);
    }
    logger.info(`[PRESSURE_GUARD] Campaign ${campaignId}: reserved ${winners.length}, deferred ${totalDeferred}`);
  }
  if (firstError.err != null) throw firstError.err;
  return winners;
}

/**
 * Task #169 — Force-reserve send slots for subscribers whose deferred
 * row has aged past PRESSURE_MAX_DEFER_HOURS. Bypasses the 6h gap check
 * (the row has waited long enough already) but STILL stamps
 * subscribers.last_sent_at = NOW() so the guard re-engages forward in
 * time. Returns the subscriber ids whose last_sent_at was successfully
 * advanced — all input ids in practice, since the row is already locked
 * in 'attempting' status by the drain claim.
 *
 * Hard-stops (BCK, unsubscribe, suppressed_until) are NOT checked here —
 * they are re-checked downstream by the drain worker at dispatch time
 * (the same path normal CAS winners go through), so this function stays
 * narrowly scoped to "force the slot reservation".
 *
 * Takes the same per-subscriber pg_advisory_xact_lock discipline as the
 * normal reservation path (see implementation below for the rationale):
 * even with the drain's SKIP LOCKED claim, two parallel drain processes
 * can surface the same subscriber across different campaigns whose aged
 * sets overlap — without the xact lock both would stamp last_sent_at in
 * the same window.
 */
export async function pressureGuardForceReserveSendSlots(
  subscriberIds: string[],
): Promise<string[]> {
  if (subscriberIds.length === 0) return [];
  const literal = toPgTextArray(subscriberIds);
  // Mirror the normal reservation's per-subscriber pg_advisory_xact_lock
  // discipline (see pressureGuardReserveSendSlots ~L540). Even though the
  // drain claim already pinned these rows in 'attempting', two parallel
  // drain processes (DRAIN_PARALLELISM > 1, or the dedicated drain PM2
  // process plus an embedded fallback) can each surface the same
  // subscriber across *different* campaigns whose aged sets overlap.
  // Without the xact lock, both force-CAS calls would stamp
  // subscribers.last_sent_at = NOW() in the same instant and both bypass
  // the 6h check in the same window — exactly the "double aged force"
  // hazard the code review flagged. The lock is xact-scoped (safe under
  // PgBouncer transaction pooling) and acquired in sorted hash order so
  // overlapping batches cannot deadlock on inverse acquisition order.
  const result = await db.transaction(async (tx) => {
    // campaign-job stall RCA (2026-05-19) — fast-fail on lock contention (see pressureGuardReserveSendSlots).
    await tx.execute(sql`SET LOCAL lock_timeout = '10s'`);
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(h)
      FROM (
        SELECT DISTINCT hashtextextended(s, 0)::bigint AS h
        FROM unnest(${literal}::text[]) AS s
        ORDER BY h
      ) ordered
    `);
    return await tx.execute(sql`
      UPDATE subscribers SET last_sent_at = NOW()
      WHERE id = ANY(${literal}::text[])
      RETURNING id
    `);
  });
  return (result.rows as Array<{ id: string }>).map((r) => r.id);
}

/**
 * Reprogram a set of deferred (status='pending', eligible_at IS NOT NULL)
 * sends so the drain worker picks them up on its next tick. Per the task
 * contract the action is "reprogrammed, NOT skipped": rows stay
 * status='pending' and we simply pull `eligible_at` forward to NOW(). The
 * subscriber's `last_sent_at` 6h gap is still re-checked at dispatch time,
 * so this is safe to call without weakening the guard.
 *
 * Returns the number of rows whose eligible_at was advanced. Per-campaign
 * affected counts are recorded into pressure_flush_audit (one row per
 * campaign) and the Prometheus counter is incremented.
 */
export async function flushDeferredSends(opts: {
  campaignId?: string;
  campaignSendIds?: string[] | "all";
  /** Legacy alias kept for the per-campaign route's current request body. */
  subscriberIds?: string[];
  scope: "selected" | "campaign-all" | "global-all";
  reason: string;
  userId?: string | null;
}): Promise<number> {
  const { campaignId, campaignSendIds, subscriberIds, scope, reason, userId } = opts;

  let conditions = sql`status = 'pending' AND eligible_at IS NOT NULL AND eligible_at > NOW()`;
  if (campaignId) conditions = sql`${conditions} AND campaign_id = ${campaignId}`;

  const isAllSelector = campaignSendIds === "all";
  // See pressureGuardReserveSendSlots: ${jsArray}::text[] compiles to
  // `($1,$2,...)::text[]` (record→text[] cast, 42846). Bind as a single
  // PG array literal string instead.
  if (Array.isArray(campaignSendIds) && campaignSendIds.length > 0) {
    conditions = sql`${conditions} AND id = ANY(${toPgTextArray(campaignSendIds)}::text[])`;
  } else if (subscriberIds && subscriberIds.length > 0) {
    conditions = sql`${conditions} AND subscriber_id = ANY(${toPgTextArray(subscriberIds)}::text[])`;
  } else if (scope === "selected" && !isAllSelector) {
    return 0;
  }

  // Per task contract: 10k cap applies ONLY to selected scopes; "all"
  // scopes (campaign-all, global-all, campaignSendIds === "all") are
  // truly uncapped so an operator can drain an entire backlog in one
  // call. Selected scopes still cap to protect the DB pool.
  const FLUSH_CAP_SELECTED = Number(process.env.PRESSURE_FLUSH_CAP ?? 10_000);
  const isAllScope = scope === "campaign-all" || scope === "global-all" || isAllSelector;
  const limitClause = isAllScope ? sql`` : sql`LIMIT ${FLUSH_CAP_SELECTED}`;

  let totalFlushed = 0;
  const perCampaign = new Map<string, number>();
  await db.transaction(async (tx) => {
    const updated = await tx.execute(sql`
      UPDATE campaign_sends
      SET eligible_at = NOW()
      WHERE id IN (
        SELECT id FROM campaign_sends
        WHERE ${conditions}
        ORDER BY eligible_at ASC
        ${limitClause}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING campaign_id
    `);
    totalFlushed = updated.rows.length;
    if (totalFlushed === 0) return;
    for (const r of updated.rows) {
      const cid = (r as any).campaign_id as string;
      perCampaign.set(cid, (perCampaign.get(cid) ?? 0) + 1);
    }
    for (const [cid, n] of perCampaign) {
      await tx.execute(sql`
        INSERT INTO pressure_flush_audit (campaign_id, user_id, scope, count, reason)
        VALUES (${cid}, ${userId ?? null}, ${scope}, ${n}, ${reason ?? ""})
      `);
    }
  });

  // Prometheus per-campaign counter bump (outside the txn).
  try {
    const { pressureGuardFlushedTotal } = await import("../metrics");
    for (const [cid, n] of perCampaign) {
      pressureGuardFlushedTotal.inc({ campaign_id: cid }, n);
    }
  } catch {}

  logger.info(`[PRESSURE_GUARD] Reprogrammed ${totalFlushed} deferred send(s) (scope=${scope}, campaign=${campaignId ?? "ALL"}, cap=${isAllScope ? "uncapped" : FLUSH_CAP_SELECTED})`);
  return totalFlushed;
}
