---
name: Campaign badge counter backfills
description: Performance invariant for Orange/Wanadoo complaint badges on campaign lists.
---

Never reconstruct historical Orange/Wanadoo counters synchronously from sends and subscribers while serving campaign list or search requests. A stored value of zero is valid and must not be treated as evidence that a backfill is required.

**Why:** Request-time reconstruction made every new list/search cache key scan large send histories and could repeat forever for campaigns with genuinely zero matching sends, causing severe user-visible latency.

**How to apply:** Keep list/search reads limited to persisted counters. Maintain or initialize those counters through send-time updates, background reconciliation, or an explicit one-off job with a durable initialization marker.