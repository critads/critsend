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

## Bulk-requeuing historical failures (one-off backfill)
To re-send already-abandoned `failed` rows on `completed` campaigns: failed->pending
(`retry_count+1`, `sent_at=NOW`), flip campaign status='sending' + reset
`failed_count/auto_retry_count/retry_until/urgent_*`, then insert ONE deduped
`campaign_jobs` row. **Two gotchas hit during the 2026-06-02 backfill:**
1. A single `UPDATE ... WHERE status='failed'` over a ~100k-row campaign exceeds the
   prod `statement_timeout` (57014) and rolls back the whole tx. Either chunk it
   (`LIMIT N` CTE loop, each its own autocommit stmt) OR — simplest and what worked —
   run **one transaction per campaign** via `psql` with `BEGIN; SET LOCAL
   statement_timeout = 0; <update> <flip> <job insert>; COMMIT;`. `SET LOCAL` only
   sticks inside an explicit tx under Neon PgBouncer transaction pooling, so it MUST
   be the same single-tx `-c` call.
2. **Background detachment dies in the agent sandbox** — `nohup ... &` and even
   `setsid` only survived ~one campaign before being killed when the tool call
   returned. Don't rely on a long-running detached `tsx` script; drive prod directly
   with bounded foreground `psql` calls (a few campaigns per call, under the 2-min
   tool cap). The operation is idempotent (only touches still-`failed` rows), so
   re-running after a kill resumes cleanly.
