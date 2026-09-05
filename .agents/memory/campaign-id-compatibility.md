---
name: Campaign ID compatibility
description: Compatibility rule for validating campaign identifiers across historical data.
---

Treat campaign IDs as bounded opaque varchar values, not as UUID-only values.
Allow the project’s safe legacy character set and always pass IDs as SQL
parameters.

**Why:** Historical campaign rows can contain valid non-UUID identifiers even
though the current schema default generates UUIDs. UUID-only validation silently
rejects real campaigns already present in the database.

**How to apply:** Reuse the shared campaign-reference validation when accepting
campaign IDs in new rules or query parameters. Do not cast campaign IDs to
PostgreSQL `uuid`; the referenced columns are varchar.