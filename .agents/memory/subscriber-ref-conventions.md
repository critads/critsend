---
name: Subscriber ref/tag conventions and in-flight campaign counters
description: Data-provider code conventions on subscribers.refs/tags and how to read campaign_sends vs campaigns counters for a campaign still delivering.
---

**Ref/tag conventions (observed on the live DB, Sept 2026 — not documented in code):**
- `refs` come from the data provider's CSV imports = brands the contact once clicked. First character is the vertical: `1` fashion, `2` home, `3` beauty, `4` travel/leisure (~43 brands: 4BE Air France, 4CB Transavia, 4CM Club Med, 4DC Ovoyage…), `5` retail/electronics, `6` jewelry/energy. Brands table stores refs lowercase; subscriber refs are uppercase (exact-case matching).
- `US<ref>` (e.g. `US4CB`) = same brand but from the Microsoft/Yahoo ("US") files; those subscribers never carry the plain `4CB`-style refs. `E<ref>` (e.g. `E4CM`) = openers extension for the brand. Tag `U<ref>` = unsubscribed from that brand; tags starting `C4…` = click tags (polluted by bot clicks — tag-based "clicker" lists produced 1.3–1.9 % complaint rates).
- Segments named `FR - …` target French ISPs (kammaspeed MTA); `US - …` target Microsoft/Yahoo via other MTAs. The two families are separate campaigns, never mixed.

**Why:** ref-based targeting (co-occurrence similarity) delivered ~0.5 % human CTR for the extension cohort, while recent human click activity (60 d, bot-detected excluded) delivered 1–3.3 % and travel-vertical openers ~0.5–0.6 %. Knowing the code families lets an analysis build vertical pools without hand-listing brands.

**How to apply:** for propensity work, split by prior human clicks (0 / 1 / 2–3 / 4+ campaigns in 60 d) and exclude complaint-IP-detected subscribers; use `refs LIKE '4%'` style vertical pools rather than similarity lift alone.

**In-flight campaign counters:** `campaign_sends.status='sent'` and `sent_at` are stamped at outer-batch *reservation* (tens of thousands of rows within minutes), while `campaigns.sent_count`/`last_send_at` advance at real MTA pace (~250/min on kammaspeed). For a campaign still delivering, per-cohort CTRs computed from `campaign_sends` rows are meaningless until `sent_count` reaches the row count — check that equality before interpreting a send.
