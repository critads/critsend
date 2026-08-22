---
name: Campaign bulk deletion
description: Why campaign bulk deletion must remain independently bounded and visibly progressive.
---

Delete selected campaigns through independently bounded requests with limited concurrency and visible per-campaign progress. Do not collapse the UI flow back into one long bulk HTTP request.

**Why:** Real campaigns can own several hundred thousand send and statistics rows. Even when each SQL statement has a timeout, one aggregate request can process multiple waves of large cascades and leave the interface apparently spinning forever.

**How to apply:** Keep a hard timeout around each campaign request, limit simultaneous cascades, continue past individual failures, and retain failed campaigns in the selection for retry.