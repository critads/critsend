---
name: Import DB connection-acquire retry
description: Why CSV imports must retry transient pool connection acquisitions, and which paths are intentionally NOT auto-retried.
---

# Import DB connection-acquire retry

The CSV import pool is dedicated and small. Batch concurrency once equalled the
pool size (`MAX_INFLIGHT === IMPORT_POOL_MAX`), so N concurrent COPY/INSERT
batches held all N connections with zero headroom. Each batch wave bursts N
`pool.connect()`s at Neon's PgBouncer pooled endpoint; under pooler load /
compute cold start a fresh accept can exceed `connectionTimeoutMillis` and pg
throws **"timeout exceeded when trying to connect"**.

**Rule:** every import-pool acquisition (both `pool.connect()` and `pool.query()`)
must go through the bounded-retry wrappers (`server/services/conn-retry.ts`).
Keep ≥1 connection of headroom (`MAX_INFLIGHT = max(1, CONCURRENCY-1)`).

**Why:** without retry, a single transient connect blip on a batch fails the
ENTIRE import (sets `batchError`); on a per-row fallback (`singleUpsert`) it
permanently marks rows `failed`. Both were seen in prod: an 80k-row CSV failed
twice with the connect-timeout, then "completed" with ~2,700 false-failed rows.

**How to apply:** when adding any new import DB call, wrap it. Retry is only safe
because every wrapped statement is idempotent (counts, `ON CONFLICT` upserts,
set-difference updates, LIMIT-loop deletes). Only retry connection-class errors,
never SQL/data errors.

**Intentionally NOT auto-retried:** drizzle `db.execute()` paths. Most important,
`safeDropGinIndexes` runs `CREATE INDEX CONCURRENTLY`, which is NOT safely
retryable — a mid-flight reset leaves an invalid index and a blind retry
collides. These whole-phase failures are recovered by `recoverStuckImportJobs`
instead. Review per-statement idempotency before wrapping any of them.
