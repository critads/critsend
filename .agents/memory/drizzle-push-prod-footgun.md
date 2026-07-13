---
name: drizzle-kit push targets PROD from this workspace
description: NEON_DATABASE_URL is set in the workspace env and drizzle.config.ts prefers it over DATABASE_URL — db:push here hits the production Neon DB, not the local dev DB.
---

# drizzle-kit push targets PROD from this workspace

**Rule:** NEVER run `npm run db:push` (or any drizzle-kit command) in this workspace
without explicitly neutralizing the prod URL: `NEON_DATABASE_URL= npm run db:push`.

**Why:** `drizzle.config.ts` resolves `NEON_DATABASE_URL || DATABASE_URL`, and the
workspace environment carries `NEON_DATABASE_URL` pointing at the production Neon
database (set for prod debugging). On 2026-07-13 a plain `db:push --force` ran
against prod: it created two new indexes non-concurrently and DROPped two
bootstrap-created partial indexes on `campaigns` (restored the same day via
`CREATE INDEX CONCURRENTLY`). Raw-SQL tables (pmta_*, pressure_*, session,
tracking_tokens) survived only because the push aborted early on a 42P07 error.

**How to apply:**
- Local schema validation: `NEON_DATABASE_URL= npm run db:push -- --force` (psql
  `$DATABASE_URL` is the local helium DB).
- Prod schema changes: hand SQL to the user (CREATE INDEX CONCURRENTLY,
  name-matched to schema.ts so the deploy's push no-ops) — never push from here.
- `drizzle-kit push --force` DROPs plain-column indexes on schema-managed tables
  that aren't declared in schema.ts (it spared expression/trgm indexes). Any
  bootstrap-created plain index on a schema-managed table must ALSO be declared
  in schema.ts or push will drop it on every deploy.
- `tablesFilter` in drizzle.config.ts only filters DB introspection, NOT
  schema-side pgTables — a pgTable for an excluded table makes push emit
  CREATE TABLE and abort (42P07). tracking_tokens therefore has NO pgTable,
  only a TS interface.
