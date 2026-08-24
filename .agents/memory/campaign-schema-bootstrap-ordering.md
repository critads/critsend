---
name: Campaign schema bootstrap ordering
description: Operational lock-ordering rule for adding campaign columns used immediately by application code.
---

Provision a new `campaigns` column before any reader, worker, or index builder can reference it. Sequence its index only after the column DDL and give independent indexes independent advisory-lock keys.

**Why:** PostgreSQL queues an `ALTER TABLE` needing `AccessExclusiveLock` behind a long cache-warming read. Once queued, later reads can also wait behind the ALTER, while application code compiled against the new column fails until the migration succeeds. An interrupted concurrent index build may additionally leave an INVALID index.

**How to apply:** Put essential column DDL in the earliest awaited schema bootstrap, keep non-critical cache warming out of its way, sequence dependent backfills/indexes afterward, and make a new index bootstrap repair an INVALID first build safely.