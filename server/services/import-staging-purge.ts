/**
 * Core logic for the nightly import_staging TRUNCATE purge.
 *
 * Extracted into its own module so the check→lock→verify→TRUNCATE sequence
 * can be unit-tested with a mock client without a live database.
 *
 * Lock protocol (see server/lib/import-staging-lock.ts for the full spec):
 *   Writers (admission routes, worker COPY, phase-2 confirmation):
 *     pg_advisory_xact_lock_shared(KEY)  — shared, multiple writers coexist
 *   Purge (this function, called from runDailyImportStagingPurge in workers.ts):
 *     pg_try_advisory_xact_lock(KEY)     — exclusive, non-blocking
 *     Returns false immediately if ANY shared holder exists → caller skips.
 *
 * The caller is responsible for opening the transaction, calling this function,
 * and committing/rolling back.
 */

import { IMPORT_STAGING_PURGE_LOCK_KEY } from "../lib/import-staging-lock";

export { IMPORT_STAGING_PURGE_LOCK_KEY };

/** Outcome discriminant returned by truncateIfSafe. */
export type TruncateOutcome =
  | "truncated"             // table was empty+idle; TRUNCATE executed
  | "skipped_lock"          // exclusive lock not available (a writer holds shared)
  | "skipped_active_import" // lock acquired but an active import was detected
  | "skipped_nonempty";     // lock acquired but rows visible inside the transaction

/**
 * Minimal db-client interface — enough for unit tests to inject a mock.
 * pg.PoolClient satisfies this interface at runtime.
 */
export interface PurgeClient {
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
}

/**
 * Attempt to safely TRUNCATE import_staging within an already-open transaction.
 *
 * Steps (all inside the caller's transaction, fully atomic):
 *   1. pg_try_advisory_xact_lock(KEY) — exclusive, non-blocking.
 *      Returns 'skipped_lock' if any writer currently holds a shared lock on KEY.
 *   2. Re-verify COUNT(*) = 0 — catches rows committed by a writer between the
 *      preliminary reltuples-estimate check (outside this transaction) and now.
 *   3. Re-check active imports via the canonical sweepOrphanedImportStaging
 *      predicate (import_jobs status IN pending/processing/awaiting_confirmation
 *      UNION import_job_queue status IN pending/processing).
 *   4. TRUNCATE import_staging — reclaims all index bloat instantly.
 *
 * Writers take pg_advisory_xact_lock_shared(KEY) for the duration of any
 * transaction that writes to import_staging or inserts into import_job_queue,
 * making steps 1–4 mutually exclusive with every write path.
 */
export async function truncateIfSafe(
  client: PurgeClient,
): Promise<TruncateOutcome> {
  // Step 1: try to acquire the advisory lock (non-blocking).
  // If an import-admission transaction holds the lock, skip tonight's run.
  const lockRes = await client.query(
    `SELECT pg_try_advisory_xact_lock($1) AS acquired`,
    [IMPORT_STAGING_PURGE_LOCK_KEY],
  );
  if (!lockRes.rows[0]?.acquired) {
    return "skipped_lock";
  }

  // Step 2: re-verify empty inside the transaction.
  // Under READ COMMITTED, committed rows inserted by a just-committed
  // admission transaction are now visible — catch them here.
  const countRes = await client.query(
    `SELECT COUNT(*)::bigint AS cnt FROM import_staging`,
  );
  const liveRows = Number(countRes.rows[0]?.cnt ?? 0);
  if (liveRows > 0) {
    return "skipped_nonempty";
  }

  // Step 3: check active imports (mirrors sweepOrphanedImportStaging exactly).
  // import_jobs pending/processing/awaiting_confirmation, OR
  // import_job_queue pending/processing.
  const activeRes = await client.query(
    `SELECT 1 AS found
     FROM import_jobs
     WHERE status IN ('pending', 'processing', 'awaiting_confirmation')
     UNION ALL
     SELECT 1
     FROM import_job_queue
     WHERE status IN ('pending', 'processing')
     LIMIT 1`,
  );
  if ((activeRes.rowCount ?? 0) > 0) {
    return "skipped_active_import";
  }

  // Step 4: all clear — TRUNCATE reclaims index bloat instantly.
  await client.query(`TRUNCATE import_staging`);
  return "truncated";
}
