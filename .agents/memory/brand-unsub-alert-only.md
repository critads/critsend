---
name: Brand unsubscribe thresholds are alert-only
description: Operator decision (2026-09-29) that per-brand unsubscribe thresholds inform but never block or auto-pause, and the bootstrap-gated index trap behind the old guard.
---

**Rule:** the brand-unsubscribe thresholds (`BRAND_UNSUB_*`) are informational only. No activation route may answer 4xx for the brand count, the sender must never pause a campaign for it, and both wizards (new + edit) must always let the operator continue — an unavailable check is shown, not enforced. Env var names stay frozen because the production `.env` pins them.

**Why:** the operator explicitly took the decision back ("alerte seule, pas de blocage ni de pause auto"). Also, the brand anchor lookup throws until the `f_unaccent` trigram index bootstrap has marked itself ready, so an activation route that awaited the raw evaluator turned a fresh deploy / slow bootstrap into 500s on resume/send.

**How to apply:** when adding brand information to campaign actions (badges, e-mails, list columns), read the count through the non-throwing notice helper or a cached value; never gate an action on it and never let its failure fail the action. The alert-only guarantee has a dedicated enforcement test — do not loosen it to make a new refusal pass.
