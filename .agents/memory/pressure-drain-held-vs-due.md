---
name: Pressure-guard "held" vs "due" and aged-force-send priority gap
description: Why deferred (held) rows can linger long even though they look "past the aged window"
---

When investigating why campaigns "still have held rows out of the aged window":

- The UI/`deferred_count` "held" number = ALL rows `status='pending' AND eligible_at IS NOT NULL`. This MIXES future-eligible rows (correctly waiting their pressure window) with due-now rows. Typically ~99% are future-eligible and NOT stuck. Filter `eligible_at <= NOW()` to see what's actually due.
- A held row can be "due since N days ago" yet NOT be "aged": at defer time `eligible_at = last_sent_at + window`, while `first_deferred_at = NOW()`. If the contact's last send (often from ANOTHER campaign) is already older than the window, `eligible_at` lands in the past (immediately due) but `first_deferred_at` is fresh. The 52h "Aged force-sent" cap keys off `first_deferred_at`, so such rows are due-but-not-aged and never trip the cap.
- `first_deferred_at` is PRESERVED across re-defers (cascade only rewrites `eligible_at`). So a row that's genuinely been re-deferring since launch WOULD eventually cross 52h; if `held_aged52=0`, the rows were genuinely first-deferred recently, not perpetually snowballing.

**The real reason a long tail of due rows lingers — volume-priority starvation:**
Drain selects only the top `PRESSURE_GUARD_MAX_CAMPAIGNS` (default 5) campaigns per tick ordered by drainable(due)-count DESC, plus a thin fairness slice (~20%, oldest `created_at`). Small campaigns (~10 due) rank far below big ones (20k+ due) and only ever get the rotating fairness slot, so their handful of due rows drain at a crawl.

**Aged rows now ALWAYS take drain priority (fixed):** the candidate query computes per-campaign `aged_count` and orders `(aged_count>0) DESC, aged_count DESC, drainable_count DESC, created_at ASC`; the JS allocation force-seats aged campaigns at the FRONT of finalPicks before volume+fairness fills the remaining slots, and aged campaigns bypass the winding-down throttle and are exempt from the urgent 50% cap. No starvation of others: aged rows force-CAS (bypass the gap), stamp `last_sent_at=NOW()`, get SENT and leave pending, so aged backlog strictly decreases and cannot re-age.
**Why:** low-volume campaigns whose backlog crossed the cap were starved behind high-volume young campaigns because the old ORDER BY was volume-only — the aged cap merely relaxed the per-row gap AFTER selection, it never guaranteed selection.
