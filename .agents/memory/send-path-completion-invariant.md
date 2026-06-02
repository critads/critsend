---
name: Send/completion path retry invariant
description: Every campaign send path that can mark sends 'failed' and complete a campaign MUST funnel failures through retry/auto-requeue, like campaign-sender.
---

# Every send+completion path must auto-retry its own failures

There is more than one path that marks `campaign_sends` rows `failed` AND flips a
campaign to `completed`:
- `campaign-sender.ts` (main loop) — has a per-send retry phase + a campaign-level
  auto-requeue (`autoRequeueCampaignFailed`, bounded by `MAX_AUTO_RETRIES`).
- the **pressure-guard drain worker** (`server/workers/pressure-guard-worker.ts`)
  — separate completion path; historically had NEITHER, so any send it marked
  `failed` was abandoned at `retry_count=0` the instant the deferred queue emptied.

**Rule:** any path that can both (a) mark sends `failed` and (b) transition a
campaign to `completed` MUST, before completing, check for remaining `failed` rows
and route them through `autoRequeueCampaignFailed` (or the manual retry-failed
transaction) up to the shared auto-retry budget. Do NOT gate completion only on
`pending`/`attempting`.

**Why:** campaigns on the 4h pressure guard send mostly via the drain, so the drain
being the dominant failure producer meant tens of thousands of un-retried `failed`
sends on campaigns that read as `completed`. Symptom signature: `failed` rows all at
`retry_count=0`, `auto_retry_count` 0/1, `completed_at` far AFTER `retry_until`.

**How to apply:** when adding/auditing any background send or completion path, mirror
the campaign-sender auto-requeue (failed->pending +1 retry, status='sending',
retry_until=NULL, deduped new campaign_job). `MAX_AUTO_RETRIES` is duplicated as a
local const in both the sender and the drain (env `CAMPAIGN_MAX_AUTO_RETRIES`,
default 3) — keep them in sync.
