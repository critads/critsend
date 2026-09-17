---
name: Bot click attribution in segments
description: Why bot clicks are excluded per subscriber (complaint-IP detection), never per click IP, and why the exclusion is a NOT EXISTS anti-join.
---

**Rule:** click-based segment operators ignore clicks by subscribers who have any complaint-IP detection (open/complaint row from the fixed complaint IP). Never try to filter "bot clicks" by the click row's own `ip_address` or by click latency.

**Why:** measured on the live DB (Sept 2026): zero click rows carry the complaint IP — the Orange/Wanadoo scanner only *opens* from it and clicks from ~1,300 rotating cloud IPs (OVH, Azure, Orange mobile) with realistic user agents, 1–24 h after delivery, i.e. indistinguishable from humans per row. At subscriber level the signal is absolute: on one large send, 100% of Orange/Wanadoo clickers were complaint-IP-detected, and ~93K non-detected Orange/Wanadoo recipients opened 22K times and clicked 0 times. ~22% of 60-day clickers and ~45% of "top active" (>3 campaigns) clickers were detected subscribers.

**How to apply:**
- Any new engagement operator built on clicks must reuse the subscriber-level exclusion; a per-row IP predicate would also force heap fetches (the click partial index does not cover `ip_address`).
- Render the complaint IP as a SQL *literal* so PostgreSQL matches the partial-index predicates (`ip_address = '<ip>' AND type IN ('open','complaint')`); if the IP changes, the index predicates in the schema and tracking bootstrap DDL must change in lockstep.
- Prefer `NOT EXISTS` (hash anti-join) over `NOT IN (subquery)` for this exclusion: `NOT IN` is only a hashed SubPlan while the subquery (~230K rows and growing) fits in work_mem, then degrades to a per-row scan. Both planned at ~1 s on the live DB when measured; the anti-join has no cliff.
- Net effect on counts is smaller than the raw share because many detected subscribers are already inside the 15-day complaint cooling-off (`suppressed_until`), so expect roughly −12% on a bare "clicked recently" count, not −22%.
