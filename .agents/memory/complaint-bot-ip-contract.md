---
name: Complaint-bot IP counting-only contract
description: Opens from complaint-bot IPs are stored as type='complaint'; downstream consumers of type='open' rows must account for it.
---
Opens from complaint-bot IPs (195.154.17.225) are recorded in campaign_stats as type='complaint' (counting-only: unsubscribeTag null, no suppression, no tags — subscriber untouched).

**Why:** operator request; the old version unsubscribed real subscribers. Regression tests lock this in (tests/complaint-ip-counting.test.ts).

**How to apply:** any query that counts "opens by IP" (e.g. the bot-opener DEL marker) must also count bot-IP complaint rows, or it goes blind on that IP. FBL webhook complaints keep their tag behavior and must stay excluded via the IP filter.
