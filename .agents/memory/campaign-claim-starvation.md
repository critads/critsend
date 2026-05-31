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

# CRITICAL TRIAGE FIRST — "sent=0" is ambiguous, do NOT assume claim-starvation
Before nudging anything, query each stuck campaign's `deferred_count` and its latest `campaign_jobs.status` + `error_message`. There are THREE distinct causes that look identical from `sent_count=0` alone, and only one is claim-starvation:
1. **Pressure-guard deferred (NOT stuck):** huge `deferred_count` (e.g. 100k–1.4M) with `sent=0` means the campaign enumerated and every recipient lost the pressure-window CAS → all enqueued as deferred sends. It is waiting on the **drain worker**, not a sender slot. Nudging `created_at` does nothing. Leave it (or check drain throughput).
2. **Slot saturation (claim order ≠ preemption):** if `campaign_jobs` shows `processing` count == `MAX_CONCURRENT_CAMPAIGNS` (default 8/worker; prod ran ~10) and dozens `pending`, the aged-fairness ordering only decides WHO claims the NEXT freed slot — it cannot preempt a running mega-campaign. **Bumping `created_at` puts them first in line but does NOT free a slot**, so they stay pending until a running job finishes. Real fixes: raise `MAX_CONCURRENT_CAMPAIGNS` (bounded by `WORKER_PG_POOL_MAX` — pool saturation risk) or pause the oldest mega-campaigns.
3. **Crashed enumeration (ghost):** latest job `status='failed'` with `error_message` "Ghost campaign self-heal: orphan job from crashed enumeration" → the ghost sweep failed an orphan job. Needs a clean **relaunch**, not a nudge.

**Lesson learned the hard way:** bumping `created_at` back 6h on the stuck jobs aged them to 362 min but they stayed `pending` (worker=null) — proving the bottleneck was saturation/deferral/ghost, not FIFO ordering. Always triage by `deferred_count` + job error BEFORE choosing a remedy.

# THE REAL ROOT CAUSE (2026-05-31 incident) — stale compiled worker bundle
The decisive test: bump a stuck pending job's `campaign_jobs.created_at` to **a month in the past** and wait ~70s while the worker is provably claiming (other jobs go pending→processing every few seconds). If that month-old, unlocked, `next_retry_at IS NULL` pending job is STILL not claimed, the running worker is NOT executing the current `claimNextJob`.
**Why it happens:** `critsend-worker`/`critsend-drainer` run the **compiled `dist/worker-main.cjs` / `dist/drainer-main.cjs`** (see deploy/ecosystem.config.cjs), NOT tsx source. A `git pull` + `pm2 reload` WITHOUT `npm run build` leaves them on the OLD bundle. The pre-fairness bundle's `claimNextJob` orders by **`campaigns.created_at`** (campaign-FIFO), so bumping `campaign_jobs.created_at` (`cj.created_at`) has **ZERO effect** — only the post-fix bundle orders the aged bucket by `cj.created_at`. Result: newer campaigns starve forever behind older cycling mega-campaigns, and every DB nudge to `cj.created_at` looks ignored.
**Do NOT** "fix" this by bumping `campaigns.created_at` — it is the immutable launch-ancestry key the pressure-guard drain serialization depends on.
**The fix (on the VM):** `git pull && npm run build && pm2 restart critsend-worker critsend-drainer && pm2 save`. Build is mandatory; restart (not just reload) guarantees the fresh bundle. Once new code runs, any already-bumped aged jobs claim within seconds. A `failed` job (ghost self-heal) still needs a relaunch — it's not `pending`, so claim never sees it.

# Leaked in-memory active-set → "Duplicate job for already-active campaign" (permanent until restart)
Symptom: ONE campaign won't start (sent=0, def=0, started_at NULL) while others send fine; its `campaign_jobs` history shows repeated `failed` rows alternating with "Stale heartbeat self-heal" and **"Duplicate job for already-active campaign"**.
Mechanism (server/workers.ts ~635/841-851): the poll loop keeps an in-memory `activeCampaigns` Set; a claimed job whose campaign is already in the Set is failed immediately as "Duplicate job for already-active campaign". The Set entry is only removed in the job's own completion path (~813). If a campaign's enumeration **hangs** and the job is killed by the EXTERNAL stale-heartbeat reaper (a DB UPDATE, not the worker's finally), the in-memory Set entry **leaks** — the worker still thinks it's processing that campaign. Every subsequent claim then fails instantly as "duplicate", forever, until the **worker process is restarted** (clears the Set).
Recovery: `pm2 restart critsend-worker` to clear the leaked flag, then relaunch the campaign from the UI for a fresh job. Best done when no enumeration burst is competing (several huge campaigns enumerating at once can starve a heartbeat and trigger the original hang).
Code gap worth fixing: when the stale-heartbeat reaper fails a processing job, the owning worker's `activeCampaigns` entry is never cleared, so the campaign is wedged until restart.
