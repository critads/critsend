---
name: Smart segment recent send window
description: User-required exclusion window for previous brand campaigns.
---

Exclude recipients of the six most recent brand campaigns within seven days, not thirty days.

**Why:** the user explicitly rejected the thirty-day window and requested seven days.

**How to apply:** preserve the six-campaign cap; when deploying, any explicit `SMART_SEGMENT_RECENT_SEND_DAYS` override must also be set to 7. Changing the default does not override a production environment setting.
