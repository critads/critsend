---
name: Querying the production Neon DB from this repl
description: How to run ad-hoc queries against PROD (not the dev DB) when debugging Critsend
---
# The executeSql tool hits the DEV database, NOT prod

**Rule:** To inspect or fix production data (Neon, `NEON_DATABASE_URL`), write a
throwaway script under `.local/` and run it with `npx tsx`, importing the app's
own pool: `import { db } from "../server/db"` then `db.execute(sql\`...\`)`. The
app's `server/db` connects to the prod Neon URL. Connection is fast (~2s).

**Why:** the built-in `executeSql` callback targets the local dev database, so it
silently returns wrong/empty results when you think you're looking at prod.

**How to apply / gotchas:**
- `campaigns.id` is VARCHAR (not uuid). Match short ids with `id LIKE 'abcd1234%'`.
  Casting a JS array param as `::text[]` via drizzle's sql template fails
  ("cannot cast record to text[]") — instead build an OR list with
  `sql.join(shorts.map(s => sql\`c.id LIKE ${s+'%'}\`), sql\` OR \`)`.
- Source of truth for counters is `campaign_sends`: `sent_count =
  COUNT(status='sent')`, `failed_count = COUNT(status='failed')`. The 15-min
  counter-reconciler (server/workers/counter-reconciler.ts) fixes drift but
  `sent_count` reconcile is FILL-ONLY (never reduces), so an over-count or a
  corrupt negative `failed_count` must be fixed manually.
