---
name: Guardian retry-budget diagnosis = latest job of any status
description: Why the campaign guardian's retry_budget_exceeded branch must judge the newest campaign_jobs row regardless of status, and how the false positive presented as a "dead Resume button".
---

**Rule:** any guardian/diagnosis branch that decides "this campaign's retry chain is exhausted" must look at the campaign's **latest job of any status**, never at the latest *failed* job. `campaign_jobs` keeps every historical failed row forever (retry_count 30+ after an incident), so "newest failed job has retry_count ≥ max and no pending/processing successor" is also true for a campaign whose next job **succeeded** and is legitimately sitting in `sending` with no job (deferred drain hold, failed-gate hold).

**Why:** 2026-10-07 — after the `smtp_outcome_class` schema repair, the 24 affected campaigns' next retry job succeeded, the sender held them in `sending` for the pressure-guard drain, and the guardian paused them with `retry_budget_exceeded` within a tick. Every manual Resume produced a job that completed and held again → re-paused ≤60 s later. Operators saw "Resume does nothing"; the real cause was the diagnosis query, not the resume route.

**How to apply:** when adding stuck/pause heuristics, seed a test with "old failed job (retry_count ≥ max) + newer completed job" and assert it is NOT paused. Remember branch order matters (specific branches run before the generic `sending_no_active_job` re-enqueue and steal campaigns via the `seen` set), so a false positive in a specific branch silently replaces a re-enqueue with a pause.
