/**
 * Shared advisory-lock key for the import_staging nightly-purge ↔ writer mutex.
 *
 * Protocol — shared/exclusive advisory lock pair (transaction-level, auto-released):
 *
 *   WRITERS (import admission, worker COPY, phase-2 confirmation):
 *     SELECT pg_advisory_xact_lock_shared($KEY)
 *     Multiple writers can hold the shared lock concurrently.  The lock is held
 *     for the duration of the enclosing transaction so it covers the full COPY
 *     or INSERT window.
 *
 *   PURGE (runDailyImportStagingPurge / truncateIfSafe):
 *     SELECT pg_try_advisory_xact_lock($KEY)           ← exclusive, non-blocking
 *     Returns false immediately if ANY shared holder exists → purge defers to the
 *     next nightly window.  If it returns true, no writer is active and the purge
 *     owns the key exclusively: re-verify COUNT=0 + no active imports, then TRUNCATE.
 *
 * Why shared for writers / exclusive for the purge?
 *   Concurrent imports are normal; blocking them against each other would
 *   serialise all admission transactions needlessly.  The purge is a once-nightly
 *   batch that must see a fully quiescent state, so exclusive is correct there.
 *
 * Transaction-level (xact) locks auto-release on commit/rollback — safe on
 * PgBouncer transaction-pooled endpoints, and they never leak on a crash.
 *
 * The value is arbitrary but must be stable and globally unique within the
 * application's advisory-lock namespace.
 */
export const IMPORT_STAGING_PURGE_LOCK_KEY = 1_984_031_800;
