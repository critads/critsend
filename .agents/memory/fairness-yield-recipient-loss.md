---
name: Fairness-yield drops un-enumerated segment tail
description: Why a campaign can be marked "completed" after reaching only a fraction of its segment, and the invariant that prevents it
---
# A campaign must be fully enrolled before it can complete

**Failure signature:** a campaign shows status `completed` but `sent + failed`
is far below the segment size (observed ~50K of 80K–155K). The missing
recipients all sit *beyond* the segment keyset cursor's stopping point and all
existed at send time. `campaign_sends.eligible_at` looks NULL everywhere (as if
nothing was ever deferred) yet `campaigns.deferred_count` is large and the
campaign accumulated many `campaign_jobs` rows (re-trigger churn). The NULL
`eligible_at` is a red herring — the drain clears it on dispatch.

**Root cause (two parts that must be reasoned about together):**
1. The sender released its job slot mid-enumeration whenever its own queue had
   0 ready sends and only pressure-guard *deferred* rows remained, assuming the
   drain would finish. It fired *before the segment cursor was exhausted*.
2. The pressure-guard drain's completion gate only checks that the
   already-reserved queue is empty (no pending/attempting). It has no signal for
   "the segment finished enumerating." So once the reserved/deferred subset
   drained, it completed the campaign and the un-enumerated tail was dropped.

**The invariant (do not violate):** a campaign may not be handed to the drain or
transitioned to `completed` until its segment cursor is fully enumerated and
every member is enrolled into `campaign_sends`. Full enrollment first, then
drain/complete. The sender enforces this by only releasing the slot *after* the
enumeration loop breaks on an empty batch.

**Known residual gap (pre-existing, low probability):** a hard crash
mid-enumeration leaves a partially-enrolled `sending` campaign. It is mitigated
because deferred rows keep `status='pending'` with a future `eligible_at`, so the
drain can't empty the queue before the stuck-job guardian requeues the sender —
but a crash with zero deferred rows could still let the drain complete early. The
robust fix is an explicit enumeration-complete marker required by *both*
completion paths. Not yet implemented.

**Safe requeue of an affected campaign:** re-opening (status→sending + enqueue
job) re-enrolls only the missing tail with no double-sends, because the reserve
dedups against rows already in the campaign and only stamps new dispatches — but
only AFTER the enrollment invariant is enforced, else the tail drops again.

**Audit note:** production is the Neon URL, not the dev DB the executeSql tool
hits; query prod via a node pg client. Prove the audience pre-existed by checking
that the missing members were imported before the campaign started, and
cross-check a sibling campaign on the *same* segment that delivered the full count.

**Cheap pre-filter when scanning for affected campaigns:** only campaigns with
`deferred_count > 0` can be victims — the slot-release fires only when the sender's
ready queue is 0 *and* held(deferred) > 0, so `deferred_count = 0` is structurally
immune. Filter to those first, then run the expensive segment-membership scan
(compile the segment with the app's real `compileSegmentRules` + `normalizeRules`,
count members with NO `campaign_sends` row AND `import_date < started_at`). A
truncated campaign also enrolls a tell-tale round number (~50K = 5×10K SMTP batch)
because the yield fired at a batch-5 boundary.
