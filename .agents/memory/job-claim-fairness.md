---
name: Campaign sender job-claim fairness (aged-job promotion)
description: Why claimNextJob must promote long-waiting jobs ahead of strict campaign-created FIFO, and how that differs from the pressure-guard drain FIFO
---
# claimNextJob must promote aged jobs, not just FIFO by campaign launch date

**Rule:** `claimNextJob` (server/repositories/job-repository.ts) dequeues
campaign **sender** jobs. Its primary ORDER BY key promotes any job pending
longer than `JOB_FAIRNESS_PROMOTE_MIN` minutes (env, default 15) ahead of the
`campaigns.created_at ASC, campaign_jobs.created_at ASC` FIFO.

**Why:** strict FIFO purely by `campaigns.created_at` lets an *old* campaign that
keeps re-enqueuing (large backlog + pressure-guard churn) mint a fresh job every
cycle whose old `created_at` always sorts to the front. With only ~MAX_CONCURRENT_CAMPAIGNS
(default 8) × N-worker slots, this perpetually starves requeued/younger campaigns.
Observed in prod: tail-recovery requeues sat unclaimed >20h at queue positions
#12–#26 behind ~11 older campaigns continuously holding every slot. A freshly
re-enqueued job from an old campaign is NOT aged, so it can no longer preempt a
job that has already waited.

**How to apply:**
- This fairness key lives ONLY in the sender claim (`claimNextJob`). Do not
  confuse it with the pressure-guard **drain** worker
  (server/workers/pressure-guard-worker.ts), which has its own volume+fairness
  ordering over `campaign_sends` and relies on `campaigns.created_at` FIFO for the
  deferred-subscriber serialization contract. The two queues are independent.
- NEVER mutate `campaigns.created_at` to reprioritize a campaign — it is the
  immutable launch-ancestry key both the sender FIFO and the drain depend on;
  bumping it corrupts deferred serialization.
- Postgres ORDER BY boolean trick: `(cond) DESC` puts `true` first (false < true).
- **Within the aged bucket, order by JOB wait-time (`cj.created_at ASC`), NOT
  campaign age (`c.created_at`).** Ordering aged jobs by campaign age sorts the
  *newest* campaign last every rotation; under heavy oversubscription (observed:
  ~46 campaigns each with 1 pending job, ~53 in `sending`, only ~10 slots) almost
  every job is "aged" because cycle time exceeds the promote threshold, so the
  newest campaigns are *permanently* last and never claimed at all (today's
  campaigns stuck at sent=0). Wait-time ordering gives true round-robin: a campaign
  that just got a slice re-enqueues a fresh job → drops to the back → every other
  starved campaign is served before it again. Non-aged jobs still use campaign-FIFO
  for ordinary unstarved operation. SQL: a `CASE WHEN aged THEN cj.created_at END
  ASC NULLS LAST` key between the aged-bucket key and the `c.created_at` key.
- **The ghost-sweep false positive defeats this fairness** if not also fixed: see
  [ghost-sweep-false-positive](ghost-sweep-false-positive.md). A starved
  never-claimed pending job kept getting killed+recreated every 10min, resetting
  its age to 0 so it never reached the 15min promote threshold.
