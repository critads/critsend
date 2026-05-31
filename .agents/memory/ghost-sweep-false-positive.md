---
name: Ghost-sweep Branch A false positive (never-claimed pending jobs)
description: Why the campaign ghost-sweep must not treat a starved, never-claimed pending job as a crashed-enumeration ghost
---
# Ghost-sweep must require NO viable in-flight job before "self-healing"

**Rule:** Branch A of `sweepGhostCampaigns` (server/workers.ts) self-heals a
campaign it believes crashed during audience enumeration. Its match pattern
(`status sending/queued` + `started_at IS NULL` + no `campaign_sends` rows +
`created_at` older than `GHOST_SWEEP_MIN_AGE_MIN`, default 10min) MUST also
require that the campaign has **no viable in-flight job** — i.e. no `pending`
job, no `processing` job with a fresh/NULL (just-claimed) heartbeat, and no
just-failed job. Only a stale processing job (dead worker) or no job at all is a
true ghost.

**Why:** `started_at IS NULL` + no `campaign_sends` is ALSO the exact state of a
brand-new campaign whose pending job simply hasn't been claimed yet because every
worker slot is held by older campaigns (heavy oversubscription). Without the
viable-job guard, the sweep misread "waiting in the queue" as "crashed", killed
the never-claimed pending job, reset counters, and re-enqueued a fresh job — every
10min, forever. Symptom: a campaign with `sent=0`, dozens of `failed` jobs all
with error `Ghost campaign self-heal: orphan job from crashed enumeration`, every
job row showing `worker_id=NULL` / `started_at=NULL` (never claimed). Observed
prod incident 2026-05-31: every campaign created that day stuck at sent=0.

**Compounding bug:** the churn also reset the job's `created_at` to NOW() every
cycle, so it never reached the 15min `JOB_FAIRNESS_PROMOTE_MIN` threshold — the
ghost sweep actively defeated the claimNextJob fairness promotion. The two fixes
(viable-job guard here + wait-time aged-bucket ordering in claimNextJob) are
co-dependent; deploying only one does not restore sending. See
[job-claim-fairness](job-claim-fairness.md).

**How to apply:**
- The genuine crash case still works: a worker that claimed a job, began
  enumerating, then died leaves a `processing` job whose heartbeat goes stale (or
  the stuck-job reaper `cleanupStaleJobs` flips it to `failed` after 30min by
  `started_at` age) → no viable job → sweep fires → kills the stale job, resets,
  re-enqueues. NULL heartbeat = just-claimed = treated as viable (matches Branch B).
- Diagnose by checking the killed jobs' `worker_id`/`started_at`: all-NULL means
  "never claimed" (starvation false positive), not a real crash.
