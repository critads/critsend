---
name: Hetzner S3 throttle resilience
description: Why CSV import uploads must survive 503 SlowDown, and where that resilience now lives (deferred to worker)
---

# Hetzner Object Storage 503 SlowDown resilience

Hetzner Object Storage throttles under bursts of concurrent multipart PUTs and
returns `503 SlowDown` (and sometimes `503` with an unparsed error name). A storm
can make **every** CSV import fail at once.

## The upload is now DEFERRED to the worker (was synchronous)

Originally the CSV was PUT to object storage *inside the HTTP handler*
(`POST /api/import` + chunked-complete), then HEAD-verified, then committed — so a
503 there failed the import permanently ("Import setup failed" → later "CSV file
not found, re-upload") because the worker's requeue/backoff never covered the
request path.

**Now:** both upload entry points only persist the file to the local staging
volume (multer) and enqueue the queue row pointing at that **local** path, then
return 202. The actual object-storage upload happens as the **first step of the
worker job** (`ensureCsvUploadedToObjectStorage` in `import-processor.ts`):
upload → verify (`objectExists`; a miss throws `ObjectStorageTransientError`) →
atomically rewrite `import_job_queue.csv_file_path` to `/objects/...` → unlink the
local temp. Every dispatch branch then reads the returned `resolvedCsvPath`.

**Idempotency:** the helper is a no-op for the `phase2_merge` sentinel, an
already-`/objects/...` path (requeue/recovery re-entry), and the local-disk
backend (`useObjectStorageForImports()===false`). The local temp is only unlinked
*after* a successful verified upload, so a requeued attempt still finds the file.

## Two-layer resilience

1. **Backend** (`hetzner-s3.ts`) still does `retryMode:"adaptive"` + higher
   `maxAttempts` + a `withTransientRetry` wrapper that retries ONLY
   `ObjectStorageTransientError` (recreating the read stream + `Upload` each round
   — a consumed stream can't replay). NotFound/Access/InvalidPath pass through.
2. **Worker requeue** (`workers.ts` import `.catch`): if the error is
   `ObjectStorageTransientError` and the job is still within a **wall-clock**
   budget (`IMPORT_UPLOAD_MAX_RETRY_MS`, default 2h, measured from
   `queueItem.createdAt`), it calls `requeueImportJobForRetry(queueId, WORKER_ID)`
   and returns instead of failing.

## Hard-won correctness rules (from architect review)

- **Lease-safe requeue:** `requeueImportJobForRetry` binds `WHERE ... AND
  worker_id = $WORKER_ID` and returns a boolean. If the upload stalled >10 min and
  `recoverStuckImportJobs` already reset the row and another worker re-claimed it,
  the update matches 0 rows → return false → the caller must **NOT** mark the job
  failed (another worker owns the active claim).
- **Decouple retry budgets:** the transient-upload retry is **wall-clock age**,
  NOT a counter. Never increment `retry_count` for upload retries — that counter is
  owned by `recoverStuckImportJobs` (hard-fails a stuck `processing` row at
  `retry_count >= 2`). Sharing it caused premature permanent failure during throttle
  storms.
- **Deterministic local-file GC:** on a *terminal* failure (non-transient error, or
  transient past the 2h window) the deferred upload never succeeded, so the staged
  CSV still sits on the persistent volume. The fail branch in `workers.ts` unlinks
  it (skipping `/objects/...` and `phase2_merge`). Residual: no periodic sweeper for
  files orphaned by a crash mid-upload.

## Topology that makes deferred-via-local-file valid

`critsend-web`, `critsend-worker`, `critsend-drainer` are separate PM2 processes on
**one** VM sharing a persistent volume, so `IMPORT_UPLOAD_DIR` survives restarts and
the worker can read a file the web process staged. `import-worker.ts` is dead code;
the active processor is `import-processor.ts` driven by `workers.ts`.

Tunables: `IMPORT_UPLOAD_MAX_RETRY_MS` (worker requeue window),
`HETZNER_S3_{MAX_ATTEMPTS,RETRY_ROUNDS,RETRY_BASE_MS,RETRY_MAX_MS}` (backend).
