---
name: Import DB connection-acquire retry
description: Why CSV imports must retry transient pool connection acquisitions across BOTH the dedicated import pool and the shared main pool, and the one path that must NOT be auto-retried.
---

# Import DB connection-acquire retry

CSV imports intermittently die with **"timeout exceeded when trying to connect"**
(node-postgres Pool connect-timeout). Two distinct sources, both real in prod:

1. **Dedicated import pool** (small, Neon PgBouncer pooler). Batch concurrency
   once equalled pool size (`MAX_INFLIGHT === IMPORT_POOL_MAX`) — N concurrent
   COPY/INSERT batches held all N connections with zero headroom; each batch wave
   bursts N `pool.connect()`s and a fresh accept under pooler load / compute cold
   start exceeds `connectionTimeoutMillis`.
2. **Shared MAIN pool** (worker pool, aggressive ~2s connectionTimeoutMillis in
   `server/db.ts`). The import job's metadata / heartbeat / progress / status /
   finalization writes ALL run on the main pool, NOT the import pool — so a brief
   main-pool checkout-timeout under worker load fails the whole import and a
   *dedicated import pool cannot protect it*. This is why "just add a dedicated
   pool" never fixed it.

**Rule — retry every DB acquisition on the import critical path, on BOTH pools,
retrying ONLY connection-class errors** (timeout-when-connecting, reset sockets,
08xxx/57P01; never SQL/data errors). Core: `server/services/conn-retry.ts`
(`withConnRetry`). Wiring in `server/services/import-processor.ts`:
- import pool: `connectWithRetry` (pool.connect), `queryWithRetry` (pool.query),
  `execWithRetry` (importDb `db.execute`).
- main pool: the module imports `storage as rawStorage` and exposes a retrying
  **Proxy** `storage` — every `storage.*` call auto-retries. `this` is bound to
  rawStorage (internal `this.xxx()` hit raw storage → no recursion / double-retry).
- `server/workers.ts` poller wraps `claimNextImportJob` / `recoverStuckImportJobs`
  / `cleanupStaleImportJobs` (a blip there means a pending import never starts).
Keep ≥1 import-pool connection of headroom (`MAX_INFLIGHT = max(1, CONCURRENCY-1)`).

**Why retry is safe here:** every import write uses ABSOLUTE values (set status,
set committedRows / newSubscribers totals — never increments), reads are pure, and
DML is idempotent (`ON CONFLICT` upserts, set-difference updates, LIMIT-loop
deletes, deterministic queue UPDATEs). So a retry after a mid-flight reset can't
double-apply state. (`logError` is insert-only and left retryable on purpose — a
possible duplicate error row beats losing the error record in a storm.)

**The ONE exclusion — `recreateSubscriberGinIndexes` (`CREATE INDEX
CONCURRENTLY`)** is on `NON_RETRYABLE_STORAGE_METHODS`: a mid-flight reset leaves
an INVALID index and a blind retry collides. It already runs best-effort in its
own try/catch; whole-phase failures are recovered by `recoverStuckImportJobs`.
**How to apply:** any NEW non-idempotent / index-DDL storage method added to the
import path must be added to that denylist; everything else is auto-protected by
the Proxy. Do NOT auto-retry CONCURRENTLY DDL anywhere.
