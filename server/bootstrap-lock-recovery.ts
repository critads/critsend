/**
 * Task #152: Auto-recovery for leaked session-level advisory bootstrap locks.
 *
 * Background
 * ──────────
 * `withAdvisoryLock` (server/bootstrap-lock.ts) historically used
 * `pg_try_advisory_lock(<objid>)` (session-level) on the main pool. The main
 * pool routes through Neon's PgBouncer transaction-pooled endpoint, so each
 * `client.query` may land on a different physical backend. When the Node
 * process exits (e.g. `pm2 reload`), PgBouncer keeps the original Postgres
 * backend alive (idle, application_name='pgbouncer') and the session-level
 * advisory lock leaks indefinitely on that backend. The next process boot
 * tries `pg_try_advisory_lock` on a different backend, gets `acquired=false`,
 * logs "Another process is running bootstrap — skipping", and bails — so the
 * bootstrap DDL never runs on first boot of the new code.
 *
 * Task #149 fixed the *runtime* hot-path locks (PRESSURE_DRAIN/MAINTENANCE/
 * AUDIT_TTL → 900014/900015/900016) by switching them to a lease-table.
 * Task #152 covers the remaining *bootstrap* locks (900001-900013) without
 * rewriting the entire `withAdvisoryLock` machinery: at process startup we
 * preemptively terminate any idle PgBouncer-labelled backend still holding
 * one of our well-known objids. This is the same SQL as
 * /api/admin/pressure-guard/release-stuck-locks but generalised to the full
 * bootstrap range and called automatically on every web/worker boot.
 *
 * Safety
 * ──────
 * The query *only* targets backends that satisfy ALL of:
 *   - hold an advisory lock with classid=0 and objid IN our reserved range,
 *   - state IN ('idle', 'idle in transaction', 'idle in transaction
 *     (aborted)') — never 'active' (i.e. never mid-real-work),
 *   - application_name = 'pgbouncer' (so we never terminate our own app's
 *     direct connections, only the PgBouncer-side leak).
 *
 * We never throw — failures are best-effort; the worst case is the original
 * symptom (bootstrap skipped → retry every 15s) which is what we already
 * tolerate.
 */
import { pool } from "./db";
import { logger } from "./logger";

const BOOTSTRAP_LOCK_OBJID_MIN = 900001;
const BOOTSTRAP_LOCK_OBJID_MAX = 900020;

export type LockRecoveryResult = {
  targeted: number;
  terminated: number;
  failures: number;
  byObjid: Record<number, number>;
};

const EMPTY_RESULT: LockRecoveryResult = {
  targeted: 0,
  terminated: 0,
  failures: 0,
  byObjid: {},
};

export async function releaseStuckBootstrapLocks(
  context: string = "boot",
): Promise<LockRecoveryResult> {
  let client;
  try {
    client = await pool.connect();
  } catch (err: any) {
    logger.warn(
      `[LOCK_RECOVERY] (${context}) failed to acquire client (non-fatal): ${err?.message || err}`,
    );
    return EMPTY_RESULT;
  }
  try {
    await client.query(`SET LOCAL statement_timeout = '5s'`).catch(() => {});

    const locks = await client.query<{
      pid: number;
      objid: number;
      state: string | null;
      application_name: string | null;
    }>(
      `SELECT l.pid, l.objid, a.state, a.application_name
       FROM pg_locks l
       JOIN pg_stat_activity a ON a.pid = l.pid
       WHERE l.locktype = 'advisory'
         AND l.classid = 0
         AND l.objid BETWEEN $1 AND $2
         AND l.granted = true
         AND a.state IN ('idle', 'idle in transaction', 'idle in transaction (aborted)')
         AND a.application_name = 'pgbouncer'`,
      [BOOTSTRAP_LOCK_OBJID_MIN, BOOTSTRAP_LOCK_OBJID_MAX],
    );

    if (locks.rows.length === 0) {
      logger.info(
        `[LOCK_RECOVERY] (${context}) no leaked bootstrap locks found in range ` +
          `${BOOTSTRAP_LOCK_OBJID_MIN}-${BOOTSTRAP_LOCK_OBJID_MAX}`,
      );
      return EMPTY_RESULT;
    }

    const byObjid: Record<number, number> = {};
    let terminated = 0;
    let failures = 0;
    for (const row of locks.rows) {
      try {
        const r = await client.query<{ ok: boolean }>(
          `SELECT pg_terminate_backend($1) AS ok`,
          [row.pid],
        );
        if (r.rows[0]?.ok === true) {
          terminated += 1;
          byObjid[row.objid] = (byObjid[row.objid] ?? 0) + 1;
        } else {
          failures += 1;
        }
      } catch (err: any) {
        failures += 1;
        logger.warn(
          `[LOCK_RECOVERY] (${context}) terminate pid=${row.pid} objid=${row.objid} failed: ${err?.message || err}`,
        );
      }
    }

    logger.warn(
      `[LOCK_RECOVERY] (${context}) terminated ${terminated} leaked PgBouncer backends ` +
        `holding bootstrap advisory locks (failures=${failures}, by_objid=${JSON.stringify(byObjid)}). ` +
        `This is the Task #152 self-heal at startup; rerun is idempotent.`,
    );

    return {
      targeted: locks.rows.length,
      terminated,
      failures,
      byObjid,
    };
  } catch (err: any) {
    logger.warn(
      `[LOCK_RECOVERY] (${context}) probe failed (non-fatal): ${err?.message || err}`,
    );
    return EMPTY_RESULT;
  } finally {
    try {
      client.release();
    } catch {
      /* ignore */
    }
  }
}
