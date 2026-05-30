---
name: Fairness-yield drops un-enumerated segment tail
description: Why campaigns can mark themselves "completed" after sending to only a fraction of the segment
---
# Fairness-yield can complete a campaign before the segment is fully enumerated

**Symptom:** a campaign marked `completed` but sent to far fewer recipients than its
segment contains (observed: ~50K sent out of 78K–155K). Missing recipients all sit
*beyond* the keyset cursor's stopping point and all existed at send time. `eligible_at`
is NULL on every row (looks like "no deferrals") yet `campaigns.deferred_count` is large
and the campaign has many `campaign_jobs` rows (re-trigger churn).

**Root cause (two interacting parts):**
1. `campaign-sender.ts` fairness-yield (fires every `FAIRNESS_YIELD_CHECK_EVERY_BATCHES`,
   default 5 → ~50K rows for SMTP batch 10K) releases the job slot when
   `ready===0 && held>0`, *before the segment cursor is exhausted*. Its comment claims a
   delayed re-trigger covers "segment not yet fully enrolled" — it does not.
2. The pressure-guard drain worker's post-drain completion gate only checks
   `COUNT(*) WHERE status IN ('pending','attempting') == 0` for the **already-reserved**
   rows. It never checks that the segment cursor finished enumerating. So once the
   reserved/deferred subset drains, it flips the campaign to `completed` and the
   un-enumerated tail (everyone past the cursor) is silently dropped. The drain clears
   `eligible_at` on send, which is why post-hoc the rows look like they were never deferred.

**Why the re-trigger doesn't save it:** on a fresh re-run the cursor restarts at the
beginning; batches 1..5 are already-reserved (skipped, but `batchNumber` still
increments), so the fairness check fires again at batch 5 with held>0 before enumeration
reaches new territory — a livelock — until the drain marks it `completed` first.

**Invariant to preserve:** a campaign must NOT be completable (and must not yield to the
drain) until its segment cursor is fully enumerated and every member is enrolled into
`campaign_sends`. Full enrollment first, then drain/complete.

**Safe requeue:** `pressureGuardReserveSendSlots` dedups via the `already_in_campaign`
CTE and only stamps `last_sent_at` for genuinely-new rows, so re-opening a `completed`
campaign (status→sending + enqueue job) re-enrolls only the missing tail with no
double-sends — but only AFTER the code fix, or it will drop the tail again.

**Audit approach:** prod is `NEON_DATABASE_URL` (not the executeSql dev DB); query via
node pg Pool. Compare a segment's current member count + `NOT EXISTS campaign_sends`
missing set against `import_date < campaign.started_at` to prove the audience pre-existed.
Cross-check a sibling send on the *same* `segment_id` that delivered the full count.
