---
name: Campaign claim starvation after redeploy
description: How to tell whether the aged-job fairness promotion is actually live in prod, and why the newest campaigns can stay at sent=0 after a deploy.
---

# Symptom
After a Hetzner redeploy, most campaigns send fine (high throughput) but the **newest** few campaigns sit at `sent_count=0, started_at IS NULL` indefinitely, each holding a single clean `pending` campaign_jobs row (`retry_count=0`, `next_retry_at` null, no failed jobs).

# Why it happens
`claimNextJob` (server/repositories/job-repository.ts) is campaign-FIFO by `campaigns.created_at ASC`, with an aged-job promotion: any pending job older than `JOB_FAIRNESS_PROMOTE_MIN` (default 15) is lifted to the front, ordered oldest-job-first. The worker loop (server/workers.ts) runs `while (activeCampaigns.size < MAX_CONCURRENT_CAMPAIGNS)` (default 8 per process). Old campaigns with huge backlogs finish a chunk every ~2 min, re-enqueue a *young* job, and immediately re-claim the freed slot. The newest campaigns are last in FIFO, so they only get a slot via the aged promotion.

If the newest campaigns meet EVERY promotion precondition (aged well past the threshold, claimable, the only aged pending jobs in the queue) yet are still not claimed for far longer than the threshold, the running worker is **not executing the fairness ordering**.

# Most likely root causes (in order)
1. The redeploy did not reload ALL PM2 processes. Ghost-sweep stopping (its churn errors cease) only proves the process that runs the sweep reloaded — the worker/drainer claim loop may still run old code. Fix: `pm2 restart all` (or reload worker + drainer) on the VM.
2. `JOB_FAIRNESS_PROMOTE_MIN` is configured in prod env above the actual wait time, so the newest jobs never count as "aged". Fix: lower it (e.g. 5) and reload.

# How to diagnose (prod is read-only from Replit; query Neon via `npx tsx` importing server/db)
- Confirm churn stopped: no `campaign_jobs.status='failed'` with "Ghost campaign self-heal" for the stuck campaigns since the deploy timestamp.
- Confirm jobs are claimable: `next_retry_at IS NULL OR <= NOW()`, `retry_count=0`.
- Confirm they are the oldest/only aged pending jobs, yet `started_at` stays null and `sent_count=0` while slots churn (`processing` rows show `started_at` age 0-2 min) — proves the promotion is not lifting them.

# Manual unblock options (ask user first — prod writes)
- Reload all PM2 processes / lower the threshold env.
- Bump the stuck pending jobs' `created_at` back a few hours so they jump the aged queue.
- Briefly pause 2-3 of the oldest huge campaigns to free `MAX_CONCURRENT_CAMPAIGNS` slots.
