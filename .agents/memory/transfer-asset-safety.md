---
name: Transfer asset safety
description: Why uncertain database publication must preserve prepared campaign assets.
---

Treat a lost COMMIT acknowledgement as uncertain publication, not proof of rollback. Preserve prepared campaign assets until a later reconciliation proves they are unreferenced.

**Why:** Deleting on a network exception can break the campaign that successfully committed just before the connection failed. An orphan is safer than missing images in a scheduled email.

**How to apply:** Clean only after a positively known rollback or preparation failure; wait for every image worker to settle before cleanup. Never automatically retry an uncertain publication without reloading campaign state.