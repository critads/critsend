---
name: Campaign badge counter backfills
description: Performance invariant for Orange/Wanadoo complaint badges on campaign lists.
---

Never reconstruct historical Orange/Wanadoo counters synchronously from sends and subscribers while serving campaign list or search requests. A stored value of zero is valid and must not be treated as evidence that a backfill is required.

**Why:** Request-time reconstruction made every new list/search cache key scan large send histories and could repeat forever for campaigns with genuinely zero matching sends, causing severe user-visible latency.

**How to apply:** Keep list/search reads limited to persisted counters. Maintain or initialize those counters through send-time updates, background reconciliation, or an explicit one-off job with a durable initialization marker.

For a full historical walk, bound work by raw send rows before applying status/provider filters, keep campaign timestamps and cursors inside PostgreSQL to preserve precision, and retry terminal campaigns when cached counters change during accumulation rather than advancing past them.

**Why:** Bounding only matching rows can leave a sparse campaign scanning millions of non-matching rows until every tick times out. Multi-transaction totals can also overwrite a concurrent tracking update unless finalization verifies its starting baseline.

**How to apply:** Persist both the campaign cursor and within-campaign subscriber cursor atomically with partial totals. Reconcile stable terminal campaigns historically; leave active campaigns to the recent reconciler.

Treat retained send rows as a lower bound, never as exact lifetime truth. Orange/Wanadoo sent counters reconstructed from `campaign_sends` must therefore be monotone; complaint-IP counters can be rebuilt independently from retained `campaign_stats`.

**Why:** `campaign_sends` is retention-purged, including partially purged campaigns, while current retention settings and cached timestamps cannot prove that no older rows were already deleted. Direct assignment can silently replace valid lifetime counters with zero or a partial total.

**How to apply:** Never decrease lifetime sent counters from surviving send rows. Paginate complaint detections separately from send rows, deduplicate by subscriber with bounded indexed seeks, and expose a durable preservation metric when surviving total sends are below the persisted lifetime count.