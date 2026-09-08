---
name: Sender restart reservations
description: Restart and DB-error invariants for immediate pending campaign rows
---

**Rule:** while a campaign is active, an immediate `pending` send row is resumable work, not an orphan. Never convert such rows to `failed` merely because they are old. Only an explicit retry marker may identify a pending row as retry carry-over after audience enumeration.

**Why:** the pressure gate reserves an outer audience batch before individual SMTP dispatch. A DB outage or worker restart can leave most of that batch legitimately pending. Age-based startup cleanup turns the unsent remainder into thousands of false failures.

**How to apply:** let the conservative audience cursor re-fetch pending reservations. Keep deferred rows under the drainer and ambiguous in-flight attempts terminal. When classifying database failures, inspect wrapped causes as well as the outer query error so transient pool/network outages use bounded retry and job backoff.