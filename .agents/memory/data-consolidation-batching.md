---
name: Data consolidation batching traps
description: Planner, precision and data-model pitfalls behind any per-ref batch job on subscribers / campaign_stats (learned while building the manual refs ↔ tags reconciliation).
---

Rule 1: a per-ref batch `SELECT … WHERE tags @> ARRAY[tag] … LIMIT n` must run with `SET LOCAL enable_seqscan = off` in its own short transaction.
**Why:** with a LIMIT the planner may bet on a seq scan "finding n rows early"; on an already-consolidated multi-million-row table (zero matches) that is a full heap scan per ref per batch. SET LOCAL is transaction-scoped, so it is safe on the PgBouncer dev endpoint.
**How to apply:** any GIN containment predicate paired with LIMIT; same wrapper raises `statement_timeout` above the 120 s pool default.

Rule 2: keyset pagination over a naive `timestamp` column must carry the boundary as TEXT, never through a JS Date.
**Why:** node-pg Dates are millisecond precision, PG timestamps microsecond — a truncated boundary re-selects the boundary rows every page and can never advance past a same-millisecond page.
**How to apply:** `campaign_stats` walks; the partial index `(timestamp, subscriber_id)` cannot serve a 3-column row compare, so use `col >= $ts` as the index start plus the row compare as filter.

Rule 3: `subscribers.import_date` is NOT a "tags changed" signal.
**Why:** the tag-import upsert merges tags onto an existing row without touching `import_date` (only the refs-only path bumps it) and bypasses `pending_tag_operations`, so a brand that only appears as a tag on pre-existing rows leaves no dated trace. Cursor-based ref discovery on `import_date` silently misses those brands (caught by code review). A full `DISTINCT substr(tag,2)` scan costs ≈1 s per 1.7 M rows (parallel seq scan) — just rescan.
**How to apply:** any "which brands exist" question → scan tags (or the brands directory), never filter by import_date.

Partial complaint-IP index `(ip_address = '195.154.17.225' AND type IN ('open','complaint'))` is only provable with the IP inlined as a literal — a bind parameter forces a generic plan that cannot use it.

Volume fact (not derivable): the first prod run was expected to fix ≈150 k rows (4.7 % rows with U-tag+ref, 4.5 % with C-tag without ref on the June-2026 copy).
