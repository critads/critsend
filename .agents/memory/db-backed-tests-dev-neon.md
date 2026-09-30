---
name: DB-backed tests against the dev (Neon) database
description: Constraints for Vitest suites that hit NEON_DATABASE_URL — pooler semantics, latency, and why table-wide queries must run in a throwaway schema.
---

## The dev URL is a PgBouncer pooler
The workspace `NEON_DATABASE_URL` is Neon's `-pooler` endpoint (transaction
pooling). A session-level `SET` (search_path, timeouts) is not guaranteed to
follow the client to the next statement, even though it usually appears to.
**How to apply:** isolate with fully-qualified names on a throwaway schema, or
keep a `SET LOCAL` and the statements that depend on it inside one explicit
transaction (a single multi-statement simple query works for DDL). Do not
build isolation on `SET search_path` alone.

## ~150 ms per statement
Round trip from the sandbox is about 150 ms; a per-call BEGIN/SET/COMMIT
wrapper triples it. Batch fixtures (multi-row INSERT … RETURNING, Promise.all
on independent store calls) and expect a 100-statement suite to take ~15 s.

## Table-wide queries never run against public tables
The dev app, when running, executes the same sweep queries (Orange checker
every 15 s: claim / expire / release-stale) on the public tables. Running a
store's table-wide method against public rows with a fake clock would close
or reschedule real rows and race the live checker.
**How to apply:** private `<suite>_<epoch>_<rand>` schema built from the
migration file verbatim, a query adapter that schema-qualifies the table name
and throws on any unqualified reference, DROP SCHEMA CASCADE in afterAll plus
a sweep of leftovers older than ~2 h at startup (see
tests/orange-test-jobs-postgres.test.ts for the pattern).

## pg driver details that bit
- `array_agg(name_column)` comes back as a string (`name[]` has no parser);
  cast to `text[]`.
- `pool.query`'s callback path goes through `pool.connect(cb)`; a `vi.spyOn`
  on `connect` that ignores the callback argument would hang `pool.query`.
  Only spy while the code under test uses the promise form.
- Nullsink-MTA tests share port 2525 and the server starts lazily on the
  first send, rejecting concurrent starts ("start already in progress"):
  drive drains with `PRESSURE_GUARD_SMTP_CONCURRENCY=1` set before import,
  stop the server in afterAll, and expect clashes when two nullsink files
  run in the same vitest invocation.
