---
name: Unsubscribe presentation isolation
description: Why optional continue-button state must not gate unsubscribe processing or application startup.
---

Treat the continue button as optional presentation, separate from accepting unsubscribe events. If its persistence is unavailable, hide the button rather than failing the unsubscribe or application startup.

**Why:** A durable once-per-IP display rule introduces a database dependency solely for presentation. Pool checkout and schema locks can otherwise delay or prevent the more important unsubscribe operation.

**How to apply:** Bound the complete presentation lookup including pool checkout, not just SQL execution. Start unsubscribe processing independently of the display claim and keep optional schema bootstrap failures nonfatal.