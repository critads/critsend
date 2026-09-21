---
name: Naive timestamp parse shift in raw queries
description: Raw db.execute rows on the prod app server return `timestamp` (without time zone) columns shifted by the server's UTC offset; Drizzle-typed selects do not.
---

All naive `timestamp` columns in the critsend DB hold UTC (DB server/session TimeZone = UTC, app writes UTC). But rows coming back from raw `db.execute(sql...)` are parsed by node-pg as *local* time of the app process, and the production app process does not run in UTC (observed 2026-09-21: `campaigns.first_send_at` = 08:45:38 UTC in the DB surfaced as `06:45:38Z` inside the smart-segment evidence JSON, i.e. a −2 h CEST shift). Drizzle-typed `timestamp()` columns append `+0000` when mapping and are correct.

**Why:** node-pg's default parser for OID 1114 uses `new Date(text)` semantics in the process timezone; only the Drizzle column mapper treats the text as UTC.

**How to apply:** in raw SQL that feeds JS logic or JSON evidence, select naive timestamps as `col AT TIME ZONE 'UTC'` (→ timestamptz) or as text, never as bare `timestamp`. When comparing an app-produced ISO instant against a DB naive value, expect a whole-hour offset before suspecting a real time discrepancy. Verified impact so far is cosmetic (calibration send dates in smart-segment evidence).
