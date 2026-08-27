---
name: Concurrent index reaping
description: Prevent the invalid-index cleanup from racing with active concurrent index builds.
---

The proactive INVALID-index cleanup must exclude indexes currently listed in `pg_stat_progress_create_index`.

**Why:** PostgreSQL exposes a new `CREATE INDEX CONCURRENTLY` target as INVALID during normal build phases. Treating that temporary state as stale caused cleanup to race the builder, deadlock it, and drop its index.

**How to apply:** Any future change to invalid-index detection must preserve the active-build exclusion. A genuinely stale INVALID index has no active progress row and remains eligible for cleanup.