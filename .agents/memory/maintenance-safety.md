---
name: Maintenance coordination safety
description: Coordination constraints for retention jobs and ambiguous historical tag work.
---

Do not coordinate multi-batch cleanup by keeping an idle transaction open on a separate connection.

**Why:** The application's zombie-session killer terminates long idle transactions. This silently releases transaction advisory locks while other connections continue deleting, defeating exclusivity.

**How to apply:** Keep advisory locks and bounded deletes in the same short transaction, and yield connections between batches. Preserve startup grace and pool-pressure deferral. A process-local interval alone cannot guarantee cadence across restarts; audit timestamps and scheduling state must remain consistent.

Never replay historical processing tag operations solely because the tag mutation is idempotent.

**Why:** Tag processing also dispatches automation triggers; a crash can leave their delivery outcome unknown even if the tag is present.

**How to apply:** Treat legacy processing rows without claim/heartbeat or delivery evidence as requiring review, not automatically retryable work.