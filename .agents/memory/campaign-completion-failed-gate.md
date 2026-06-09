---
name: Campaign completion failed-gate (dual-path race)
description: A campaign can be completed by two independent paths; both must atomically refuse to complete while retryable failed sends remain.
---

A campaign is flipped to `completed` by TWO independent finalization paths (the campaign sender's finalize step and the pressure-guard drain worker's post-drain step). Both must decide "complete vs auto-requeue failed sends" from AUTHORITATIVE DB state, and the completion itself must be ATOMIC — a single guarded UPDATE, never a check-then-act.

**Why:** Deciding from an in-memory failed counter let one path complete a campaign off a stale count while the other held the only DB-authoritative gate — they raced and stranded a large batch of un-retried `failed` sends after a transient MTA outage. Even a DB count-read followed by a separate completion CAS is unsafe: the other path can requeue (failed→pending) in the gap, and the CAS then completes a campaign with live pending retries (a requeued job aborts once status ≠ `sending`).

**How to apply:** Any new path that completes a campaign must use the atomic completion primitive that flips `sending`→`completed` ONLY when, inside one UPDATE's WHERE, there are no `pending`/`attempting` rows AND no `failed` rows while auto-retry budget remains (`auto_retry_count < MAX`). Termination is guaranteed because auto-requeue raises `auto_retry_count` monotonically; once budget is exhausted the failed guard goes false and completion proceeds. To resend already-stranded failures WITHOUT a deploy, mirror the retry-failed flow (reset failed→pending, status→sending, reset retry budget, enqueue a deduped job, notify) — only `failed` rows are touched, `sent` rows are never re-contacted, and the pressure guard re-defers contacts emailed recently by other campaigns (expected, not loss).
