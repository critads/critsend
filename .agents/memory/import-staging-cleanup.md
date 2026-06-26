---
name: Import staging cleanup & completion invariants
description: Why import_staging deletes must be batched, why imports must never complete from row counters, and the startup orphan-recovery race.
---

# CSV import: staging cleanup + completion invariants

Context: an incident where CSV imports reported "completed" while writing zero
subscribers, and `import_staging` bloated to tens of millions of rows.

## 1. `import_staging` deletes MUST be ctid-batched
A single `DELETE FROM import_staging WHERE job_id = ...` over a large per-job set
exceeds the import pool's `statement_timeout` and throws **PG 57014**.
**Why it's a trap:** 57014 is NOT connection-class, so the conn-retry layer does
NOT retry it — it propagates and HARD-FAILS the import *phase before the real
merge runs*. The job writes no subscribers, requeues, and (append-only COPY) its
staging keeps growing each cycle → multi-million-row spiral.
**How to apply:** any bulk delete on `import_staging` (per-job cleanup OR the
orphan sweeper) must loop bounded `ctid IN (SELECT ctid ... LIMIT n)` batches so
every statement stays well under the timeout. Generic loop lives in
`server/services/batch-delete.ts` (`deleteInBatches`, unit-tested).

## 2. Never complete an import from `processed_rows >= total_rows`
Those counters track rows PARSED/STAGED, not subscribers COMMITTED. Any recovery
path that flips a job to `completed` on that proxy will silently "succeed" an
import that wrote nothing.
**How to apply:** a stuck `processing` import must reset→`pending`→retry
(idempotent; bounded by `recoverStuckImportJobs` hard-failing at
`retry_count >= 2`). A genuinely orphaned/CSV-missing job stays `failed` so the
user re-imports. Guard test: `tests/import-recovery-invariants.test.ts`.

## 3. Startup orphan-fail must treat `pending` queue rows as active
`resumeInterruptedCampaigns()` is launched **un-awaited** and resets a crashed
queue row `processing`→`pending` for retry BEFORE it resets the job row. The
startup `orphanResult` (fails `processing` jobs with no active queue row) must
therefore exclude jobs whose queue row is `pending` OR `processing` — not just
`processing` — or it races in and falsely fails a job that is legitimately queued
for retry (then `alreadyFailedResult` closes its pending queue).
**Why:** matches the orphan sweeper's live-job predicate and preserves the
reset→pending→retry path.
