---
name: Import hard-fail — refs-staging death spiral
description: Why refs CSV imports hard-fail with statement_timeout (PG 57014) — append-only Phase 1 staging multiplies on requeue. The invariant that prevents it.
---

# Import hard-fail: the refs-staging death spiral (PG 57014)

**Invariant:** refs-import Phase 1 stages rows with an **append-only `COPY import_staging`**
(no dedup). Phase 1 MUST clear the job's own prior staging rows BEFORE staging
(`cleanupStagingData(jobId)` at the start of `processRefsImportPhase1`), or a requeue
(transient failure → recovery) re-stages the whole CSV on top of the previous copy. Repeated
requeues multiply a job's staged rows without bound; the end-of-phase `detectImportRefs`
(`SELECT DISTINCT unnest(refs) ... WHERE job_id=$1`) then slows until it breaches
`statement_timeout` → 57014 → fail → requeue → worse → permanent. The idempotent pre-clear is
the disease cure; it bounds each attempt to one CSV's worth regardless of retry count.

**Why a pre-clear, not just bigger timeouts:** moving `detectImportRefs` to the 5-min import
pool and wrapping the heavy refs merge in `runHeavyImportQuery` only treat symptoms — a
multiplied job won't fit any timeout, `clean=delete=false` imports never call the wrapped
merge at all, and the table keeps growing each retry. Keep those as defense-in-depth.

**Terminal-failure staging cleanup must be LEASE-BOUND.** When the worker's import `.catch`
deletes a failed job's staging, gate it on still owning the lease
(`EXISTS (SELECT 1 FROM import_job_queue WHERE id=queueId AND worker_id=WORKER_ID AND
status='processing')`) and run it BEFORE flipping the queue row to `failed`. `recoverStuckImportJobs`
can reset a stale `processing` row and let another worker re-claim + re-stage it; an
unguarded delete would clobber the new owner's fresh rows. Same lease discipline as
`requeueImportJobForRetry`.

**Two distinct signatures — don't conflate:**
- `canceling statement due to statement timeout` (57014), stack at `detectImportRefs` → the
  death spiral. NOT a connection error, so `withConnRetry` (connection-class only) never
  catches it.
- `timeout exceeded when trying to connect` → main/worker pool connect saturation under
  campaign-send bursts; handled by the retrying `storage` proxy / `withConnRetry`.

**Graceful vs hard-fail:** the batch upsert path
(`bulkUpsertSubscribers → copyBatchUpsert → insertFallbackUpsert → singleUpsert → failed++`)
degrades to "completed with N failed", never a hard `failed`. A hard `failed` comes only from
an UNCAUGHT statement (e.g. `detectImportRefs`). Any NEW heavy bulk statement on the import
path must use the graceful per-row fallback OR `runHeavyImportQuery`.

**Forensics access:** the user can grant a read-only `psql` string to the live Neon DB; the
Replit "production" replica is a different/stale DB and the workspace dev DB is tiny, so live
root-causing requires that connection. Destructive ops (e.g. `TRUNCATE import_staging` to
reclaim leaked space) only with explicit user approval and after confirming no
`awaiting_confirmation`/`processing`/`pending` job is mid-flight.
