/**
 * db-zombie-killer.ts — campaign-job stall RCA (2026-05-19) safety net.
 *
 * Background:
 *   On 2026-05-19, all 7 production campaigns stalled for ~2h after the
 *   campaign-sender worker crashed mid-`pressureGuardReserveSendSlots`.
 *   The crash left Neon backends in `state='idle in transaction'`
 *   holding 1000+ advisory locks and row locks each. Until Neon's
 *   `idle_in_transaction_session_timeout` fired (5 min default), every
 *   new reservation attempt on the same subscriber hashes blocked,
 *   triggering the 30-min job-level timeout — which respawned a new job
 *   that re-blocked on the same locks. Tight crash loop, zero outbound
 *   traffic.
 *
 * Layered defense (in priority order):
 *   1. PgBouncer-safe backend options in `server/db.ts` cut the server-
 *      side idle_in_transaction_session_timeout from 5min → 60s.
 *   2. `SET LOCAL lock_timeout = '10s'` inside the critical transaction
 *      in `server/services/pressure-guard.ts` makes contention surface
 *      as a fast retryable error.
 *   3. This module: on worker boot + every 60s, terminate any backends
 *      owned by our role that have been idle-in-transaction longer than
 *      30s. This is the last-resort guard for the worst-case combo
 *      (option (1) silently rejected by a future Neon proxy upgrade,
 *      option (2) bypassed by a non-pressure-guard query path).
 *
 * Safety:
 *   - Filters on `usename = current_user`: only kills our own role's
 *     zombies, never another tenant's connections (Neon hard-isolates
 *     by database anyway, but defense in depth).
 *   - 30s minimum age: a healthy `pressureGuardReserveSendSlots` chunk
 *     completes in 150-300ms; even a slow snowball-ratio query is
 *     bounded by `statement_timeout=120s`. Anything >30s in
 *     `idle in transaction` is unambiguously a stranded backend.
 *   - `pid <> pg_backend_pid()`: never terminate ourselves.
 *   - Wrapped in try/catch with logged warnings, never throws — the
 *     worker continues even if cleanup fails.
 */

import { pool, isExternalDb } from "./db";
import { logger } from "./logger";

const ZOMBIE_MIN_AGE_SECONDS = Number(
  process.env.DB_ZOMBIE_MIN_AGE_SECONDS || 30,
);
const ZOMBIE_SWEEP_INTERVAL_MS = Number(
  process.env.DB_ZOMBIE_SWEEP_INTERVAL_MS || 60_000,
);

let sweepTimer: NodeJS.Timeout | null = null;

/**
 * Identify and terminate idle-in-transaction backends owned by our role
 * that have been stranded longer than `ZOMBIE_MIN_AGE_SECONDS`.
 *
 * Returns the number of backends terminated (0 in the steady state).
 * Never throws.
 */
export async function cleanupZombieConnections(): Promise<number> {
  if (!isExternalDb) return 0; // No-op on local Postgres — purely a PgBouncer hazard.
  try {
    const r = await pool.query<{ pid: number; idle_sec: number; q: string }>(
      `SELECT pg_terminate_backend(pid) AS killed,
              pid,
              EXTRACT(EPOCH FROM (NOW() - state_change))::int AS idle_sec,
              LEFT(query, 80) AS q
       FROM pg_stat_activity
       WHERE state = 'idle in transaction'
         AND usename = current_user
         AND pid <> pg_backend_pid()
         AND state_change < NOW() - ($1 || ' seconds')::interval`,
      [ZOMBIE_MIN_AGE_SECONDS],
    );
    const killed = r.rowCount || 0;
    if (killed > 0) {
      logger.warn(
        `[DB_ZOMBIE] Terminated ${killed} stranded idle-in-transaction backend(s) (>${ZOMBIE_MIN_AGE_SECONDS}s old). ` +
          `These were holding advisory/row locks from a prior crashed worker and would have blocked new reservations.`,
        {
          pids: r.rows.map((row) => row.pid),
          oldestIdleSec: r.rows[0]?.idle_sec,
          sampleQuery: r.rows[0]?.q,
        },
      );
    }
    return killed;
  } catch (err: any) {
    // Log + swallow. Cleanup is best-effort; the worker must keep running.
    logger.warn(
      `[DB_ZOMBIE] Sweep failed (non-fatal): ${err?.message || err}`,
    );
    return 0;
  }
}

/**
 * Start the periodic zombie-cleanup sweep. Idempotent — calling twice
 * is a no-op. Runs an initial sweep immediately, then every
 * ZOMBIE_SWEEP_INTERVAL_MS (default 60s).
 *
 * The timer is `unref()`-ed so it never blocks process shutdown.
 */
export function startZombieCleanup(): void {
  if (sweepTimer) return;
  if (!isExternalDb) {
    logger.info("[DB_ZOMBIE] Skipping zombie sweeper (local Postgres, not affected by PgBouncer transaction pooling)");
    return;
  }
  logger.info(
    `[DB_ZOMBIE] Starting periodic idle-in-transaction sweep (min_age=${ZOMBIE_MIN_AGE_SECONDS}s, interval=${ZOMBIE_SWEEP_INTERVAL_MS}ms)`,
  );
  // Initial sweep at boot — clears any zombies left by a previous PM2 crash.
  void cleanupZombieConnections();
  sweepTimer = setInterval(() => {
    void cleanupZombieConnections();
  }, ZOMBIE_SWEEP_INTERVAL_MS);
  sweepTimer.unref();
}

export function stopZombieCleanup(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
    logger.info("[DB_ZOMBIE] Periodic sweep stopped");
  }
}
