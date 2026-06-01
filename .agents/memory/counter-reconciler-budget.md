---
name: counter-reconciler lifecycle stage budget
description: Why the campaigns pending/deferred/failed reconciler must gate off the campaigns table and use per-campaign LATERAL index access, not an IN-list aggregate.
---

# Counter-reconciler lifecycle stage: never aggregate campaign_sends by an IN-list

The reconciler stage that fixes `campaigns.{pending_count, deferred_count, failed_count}`
must compute per-campaign counts via a **`CROSS JOIN LATERAL` correlated on a single
campaign id** using `campaign_sends_campaign_status_idx (campaign_id, status)`, gating
the campaign set off the tiny `campaigns` table (sending/paused or recently
started/completed).

**Why:** The natural-looking form — `SELECT campaign_id, COUNT(...) FROM campaign_sends
WHERE campaign_id IN (recent_campaigns) GROUP BY campaign_id` — makes Postgres choose a
**parallel seq scan of the whole campaign_sends table** (tens of millions of rows) the
moment the IN-list grows past a few dozen campaigns (and `recent_campaigns` balloons to
~100k when derived from `campaign_stats` activity). That single scan blows the per-tick
budget (statement_timeout ≈ 5s, wall guard 5s), so the stage aborts on **every** tick and
the counters drift unbounded (observed ~30× on deferred_count). Driving the loop from the
small table forces nested-loop index access per campaign — measured ~3.2s for ~80 active
campaigns vs a 6s+ seq scan.

**How to apply:**
- Keep this stage FIRST in the reconciler — it auto-commits before later (genuinely
  expensive) stages can exhaust the budget. sent_count (counts ~all `sent` rows, the bulk
  of the table) and the `campaign_stats` engagement stages are inherently heavy and may
  still abort each tick; that is tolerated, not a regression.
- `deferred_count` truth = `status='pending' AND eligible_at IS NOT NULL` ("held"), NOT
  `eligible_at > NOW()`. The live counter increments when a send is deferred and decrements
  only when the row is actually drained/sent — it does not tick down the instant
  `eligible_at` passes — so IS NOT NULL is the faithful match. `> NOW()` under-counts the
  drainable backlog.
- Compute pending + held in ONE scan of the campaign's pending rows (a filtered COUNT);
  count failed separately. Don't scan held as its own pass — held ⊆ pending.
- When changing the reconcile query, EXPLAIN it against prod first and confirm there is NO
  `Seq Scan on campaign_sends`. A seq scan there = the bug is back.
