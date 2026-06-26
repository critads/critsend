/**
 * Generic bounded batched-delete loop, extracted so it can be unit-tested in
 * isolation (no DB / pool import), mirroring server/services/conn-retry.ts.
 *
 * Why this exists: a single `DELETE FROM import_staging WHERE job_id = ...` over
 * a large set (millions of rows accumulated by the append-only COPY across
 * requeues) exceeds the import pool's statement_timeout and throws PG 57014 —
 * which is NOT connection-class, so the conn-retry layer never retries it and the
 * whole import phase HARD-FAILS *before* the real merge runs. Deleting in small
 * batches keeps every statement well under the timeout and always finishes.
 */

export interface BatchDeleteOptions {
  /** Rows to delete per iteration (the LIMIT passed to `runBatch`). */
  batchSize: number;
  /**
   * Max iterations before returning early. `undefined` = loop until the
   * predicate is drained. Use a finite value for a background sweeper so it
   * never hogs the pool / floods WAL in one run.
   */
  maxBatches?: number;
  /** Delay between iterations (throttle). 0 = no delay. */
  sleepMs?: number;
}

/**
 * Loop `runBatch(limit)` — which must delete up to `limit` rows and return the
 * number actually deleted — until a batch deletes fewer than `batchSize` rows
 * (predicate drained) or `maxBatches` is reached. Returns total rows deleted.
 *
 * `sleep` is injectable so tests run with zero real delay.
 */
export async function deleteInBatches(
  runBatch: (limit: number) => Promise<number>,
  options: BatchDeleteOptions,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<number> {
  const { batchSize, maxBatches, sleepMs = 0 } = options;
  let total = 0;
  let batches = 0;
  while (true) {
    const deleted = await runBatch(batchSize);
    total += deleted;
    batches++;
    if (deleted < batchSize) break;
    if (maxBatches !== undefined && batches >= maxBatches) break;
    if (sleepMs > 0) await sleep(sleepMs);
  }
  return total;
}
