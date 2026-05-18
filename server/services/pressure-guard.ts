/**
 * Marketing Pressure Guard — Task #144
 *
 * Enforces a hard 6h gap between any two emails to the same contact across
 * ALL campaigns. Implementation contract:
 *
 *   1. Atomic CAS (`pressureGuardReserveSendSlots`):
 *      Single SQL statement that updates `subscribers.last_sent_at = NOW()`
 *      for every `id` in the batch *iff* the contact is currently eligible
 *      (`last_sent_at IS NULL OR last_sent_at + 6h <= NOW()`). Returns the
 *      winners. Losers are written into `campaign_sends` with
 *      `status='pending'` and `eligible_at = last_sent_at + 6h` so the
 *      deferred-drain worker can retry them later. Cumulative
 *      `campaigns.deferred_count` is bumped per defer event.
 *
 *   2. Bootstrap (`runPressureGuardBootstrap`):
 *      Adds the new columns + audit table + indexes under an advisory lock.
 *      Idempotent: every statement is `IF NOT EXISTS`. Indexes use
 *      `CREATE INDEX CONCURRENTLY` so we never block live sends.
 *
 *   3. Window override (`PRESSURE_WINDOW_HOURS` env, default 6):
 *      Used ONLY for the nullsink concurrency test (set to 0 / very large)
 *      and ops drills. Production code paths must always use the default.
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

// Production hard-locks the window to 6h per task contract. The
// `PRESSURE_WINDOW_HOURS` env override is honoured ONLY in non-prod
// environments (development/test) where the nullsink suite needs to
// validate guard mechanics over a much shorter window.
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
  if (process.env.NODE_ENV === "production") return 6;
  const raw = process.env.PRESSURE_WINDOW_HOURS;
  if (!raw) return 6;
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
               WHERE table_name='pressure_guard_leader') AS has_leader_table
    `);
    const row = r.rows[0] as Record<string, boolean>;
    return Boolean(
      row?.has_last_sent_at && row?.has_deferred_count && row?.has_eligible_at &&
      row?.has_audit && row?.has_is_admin && row?.has_maint_state &&
      row?.has_leader_table,
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
        `[PRESSURE_GUARD] Bootstrap fast-path: schema already verified, gate opened immediately (window=${PRESSURE_WINDOW_HOURS}h) — heavy maintenance will run in background`,
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

async function runPressureGuardHeavyMaintenance(): Promise<"ready" | "deferred"> {
  let outcome: "ready" | "deferred" = "ready";
  const result = await withAdvisoryLock(
    LOCK_KEYS.PRESSURE_GUARD,
    "PRESSURE_GUARD",
    async (client) => {
      try {
        await client.query(`ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS last_sent_at timestamp`);
        await client.query(`ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS deferred_count integer NOT NULL DEFAULT 0`);
        // R3: tiny single-row state table so cluster-wide once/day
        // maintenance is idempotent across multiple worker processes.
        await client.query(`
          CREATE TABLE IF NOT EXISTS pressure_maintenance_state (
            id boolean PRIMARY KEY DEFAULT true,
            last_heavy_run_date date,
            CONSTRAINT pressure_maintenance_state_singleton CHECK (id = true)
          )
        `);
        await client.query(`INSERT INTO pressure_maintenance_state (id) VALUES (true) ON CONFLICT (id) DO NOTHING`);
        // Task #149: lease-table for cross-cluster leader election.
        // Replaces `pg_try_advisory_lock` (session-level) which leaks
        // indefinitely on Neon PgBouncer transaction-pooled endpoints.
        // Each row is acquired/refreshed/released by atomic single-statement
        // ops, so it is fully compatible with transaction pooling and
        // self-recovers after a node crash via the TTL on `expires_at`.
        await client.query(`
          CREATE TABLE IF NOT EXISTS pressure_guard_leader (
            lock_key text PRIMARY KEY,
            holder_id text NOT NULL,
            expires_at timestamptz NOT NULL
          )
        `);
        // Task #160: per-lease last-tick heartbeat — written by the
        // drain loop on every successful (or failed) tick so a remote
        // health endpoint can answer "is the drain still alive?" without
        // relying on in-process state (the drainer runs in its own PM2
        // process and the web cannot inspect its memory).
        await client.query(`ALTER TABLE pressure_guard_leader ADD COLUMN IF NOT EXISTS last_tick_at timestamptz`);
        await client.query(`ALTER TABLE pressure_guard_leader ADD COLUMN IF NOT EXISTS last_tick_drained int NOT NULL DEFAULT 0`);
        await client.query(`ALTER TABLE pressure_guard_leader ADD COLUMN IF NOT EXISTS last_tick_errors int NOT NULL DEFAULT 0`);
        await client.query(`ALTER TABLE pressure_guard_leader ADD COLUMN IF NOT EXISTS last_tick_eligible int NOT NULL DEFAULT 0`);
        // Task #160: cross-process drain-tick error log. Each row is one
        // caught exception inside the safeInterval-wrapped drain tick or
        // a per-campaign drainCampaign() call. Read by
        // /api/admin/pressure-drain/health to compute errors_5m WITHOUT
        // depending on in-process counters (the drainer runs in a
        // separate PM2 process whose memory the web cannot inspect).
        // Auto-pruned to 24h via the maintenance tick — see
        // server/workers/pressure-guard-worker.ts runMaintenanceTick.
        await client.query(`
          CREATE TABLE IF NOT EXISTS pressure_drain_tick_errors (
            id bigserial PRIMARY KEY,
            occurred_at timestamptz NOT NULL DEFAULT NOW(),
            holder_id text,
            error_msg text
          )
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS pressure_drain_tick_errors_occurred_at_idx ON pressure_drain_tick_errors (occurred_at DESC)`);
        await client.query(`ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS skipped_pressure_count integer NOT NULL DEFAULT 0`);
        await client.query(`ALTER TABLE campaign_sends ADD COLUMN IF NOT EXISTS eligible_at timestamp`);
        // Task #145 R13: DB-backed admin gate (replaces ADMIN_USER_IDS env-only).
        await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin boolean NOT NULL DEFAULT false`);
        await client.query(`
          CREATE TABLE IF NOT EXISTS pressure_flush_audit (
            id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
            campaign_id varchar,
            user_id varchar,
            scope text NOT NULL,
            count integer NOT NULL DEFAULT 0,
            reason text NOT NULL DEFAULT '',
            created_at timestamp NOT NULL DEFAULT NOW()
          )
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS pressure_flush_audit_campaign_idx ON pressure_flush_audit(campaign_id)`);
        await client.query(`CREATE INDEX IF NOT EXISTS pressure_flush_audit_created_idx ON pressure_flush_audit(created_at)`);

        // Partial index for the deferred-drain poll. CONCURRENTLY can't run
        // inside the lock client (which is in an implicit txn after errors).
        // We close the txn first via a no-op COMMIT; pg_try_advisory_lock is
        // session-level so the lock is preserved.
      } catch (err: any) {
        logger.error(`[PRESSURE_GUARD] DDL failed: ${err?.message || err}`);
        bootstrapState = "deferred";
        outcome = "deferred";
        return;
      }
    },
  );

  // Build the partial index outside the advisory lock client (CREATE INDEX
  // CONCURRENTLY can't run in a transaction block).
  if (result === "ran" || result === "skipped") {
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
  }

  // Lock-result-aware readiness: 'ran' is only authoritative if the inner
  // DDL didn't trip our `outcome='deferred'` branch. 'skipped' / 'error'
  // mean another node owns the bootstrap (or the lock query failed) — we
  // verify the schema artefacts are observably present before flipping
  // ready, otherwise we leave the state unchanged and a retry timer
  // (started below) will re-probe until ready, so a bootstrap-skip on
  // one node does not permanently block sending.
  const schemaOk = await verifyPressureSchemaReady();
  if (outcome === "ready" && (result === "ran" || schemaOk)) {
    bootstrapState = "ready";
    stopBootstrapRetry();
    logger.info(`[PRESSURE_GUARD] Bootstrap ready (window=${PRESSURE_WINDOW_HOURS}h, lock=${result}, schema_verified=${schemaOk})`);
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
  const winners: string[] = [];
  let totalDeferred = 0;

  for (let i = 0; i < subscriberIds.length; i += CHUNK_SIZE) {
    const chunk = subscriberIds.slice(i, i + CHUNK_SIZE);
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
        my_created AS (SELECT created_at FROM campaigns WHERE id = ${campaignId}),
        blocked_by_older AS (
          SELECT DISTINCT cs.subscriber_id
          FROM campaign_sends cs
          JOIN campaigns c ON c.id = cs.campaign_id
          WHERE cs.subscriber_id = ANY(${chunkLiteral}::text[])
            AND cs.campaign_id <> ${campaignId}
            AND cs.status IN ('pending','attempting')
            AND c.created_at IS NOT NULL
            AND c.created_at < (SELECT created_at FROM my_created)
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
          UPDATE subscribers s SET last_sent_at = NOW()
          FROM input i
          WHERE s.id = i.id
            AND i.id NOT IN (SELECT subscriber_id FROM blocked_by_older)
            AND i.id NOT IN (SELECT subscriber_id FROM already_in_campaign)
            AND (s.last_sent_at IS NULL OR s.last_sent_at + (${windowHours}::numeric || ' hours')::interval <= NOW())
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
          INSERT INTO campaign_sends (id, campaign_id, subscriber_id, status, sent_at, eligible_at)
          SELECT gen_random_uuid(), ${campaignId}, l.id, 'pending', NOW(),
            COALESCE(l.last_sent_at, NOW()) + (${windowHours}::numeric || ' hours')::interval
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
    if (blockedN > 0) {
      try { pressureGuardBlockedByOlderTotal.inc({ campaign_id: campaignId }, blockedN); } catch {}
    }

    if (winChunk.length) winners.push(...winChunk);
    if (deferredN > 0) {
      totalDeferred += deferredN;
      // `campaigns.pending_count` is initialized to the full audience size
      // by the campaign-sender BEFORE the first CAS batch (see
      // server/services/campaign-sender.ts updateCampaign({ pendingCount: total })).
      // Deferred rows therefore already live inside `pending_count` — we MUST NOT
      // re-increment it here or progress bars and "campaign complete" detection
      // will overflow. Only the cumulative audit counter `deferred_count` and
      // the Prometheus gauge are bumped per defer event.
      await db.execute(sql`
        UPDATE campaigns
        SET deferred_count = deferred_count + ${deferredN}
        WHERE id = ${campaignId}
      `);
      try { pressureGuardDeferredTotal.inc({ campaign_id: campaignId }, deferredN); } catch {}
    }
  }

  if (totalDeferred > 0) {
    logger.info(`[PRESSURE_GUARD] Campaign ${campaignId}: reserved ${winners.length}, deferred ${totalDeferred}`);
  }
  return winners;
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
