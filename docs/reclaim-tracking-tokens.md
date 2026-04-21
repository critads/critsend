# Reclaiming disk space after the tracking_tokens purge

The new tracking_tokens retention rule (see `server/workers.ts`) deletes old
rows in batches but does **not** return space to the filesystem — Postgres
just leaves the dead tuples in the heap, where they will only be reused
slowly as new rows are inserted. To actually shrink the database (smaller
backups, faster restores, lower disk cost) the table must be rewritten
**once**, after the initial purge backlog has finished draining.

This is a one-shot operator step, not something the workers do on their own.

## When to do it

Run it after **all** of the following are true:

1. The tracking_tokens retention rule has had time to run repeatedly and
   `last_rows_deleted` on the `db_maintenance_rules` row for `tracking_tokens`
   has dropped to a small steady-state number (i.e. the backlog is gone).
2. The dead-row count is large compared to live rows. Use the `--check`
   command below to inspect.
3. You have a maintenance window if you intend to use CLUSTER or VACUUM FULL
   (they hold ACCESS EXCLUSIVE on the table). Or pg_repack is available, in
   which case no real downtime is needed.

## Check current size and bloat

Safe to run any time. Connects with the app's normal pool.

```bash
tsx scripts/reclaim-tracking-tokens.ts --check
```

Output reports `pg_total_relation_size('tracking_tokens')`, heap size, and
live / dead row counts. Record these numbers — you'll compare against them
afterwards.

You can also pull the same numbers from the maintenance dashboard's table
stats panel, which calls `getTableStats()` in
`server/repositories/system-repository.ts`.

## Pick a method

### Preferred: `pg_repack` (online, no long lock)

`pg_repack` rewrites the table on a side copy and only takes a brief
ACCESS EXCLUSIVE lock at the very start and the very end. Use this on the
live cluster whenever it's available.

Requirements:

- `pg_repack` binary installed on a host that can reach the database.
- `CREATE EXTENSION pg_repack;` already run in the target database.

Get the exact command tailored to the configured `DATABASE_URL`:

```bash
tsx scripts/reclaim-tracking-tokens.ts --method=pg-repack
```

Then run the printed `pg_repack --table=public.tracking_tokens ...` command
from a shell on the chosen host. When it finishes, re-run `--check` to
confirm the size dropped.

### Fallback A: `CLUSTER` on `tracking_tokens_created_at_idx`

Use this when pg_repack isn't an option but you can take a maintenance
window. CLUSTER rewrites the table in physical order of the new
`tracking_tokens_created_at_idx`, which also makes future
`created_at < cutoff` deletions cheaper.

```bash
tsx scripts/reclaim-tracking-tokens.ts --method=cluster --confirm
```

The script disables `statement_timeout` and `lock_timeout` for the session
running the CLUSTER (the pool defaults — 120s / 30s — are far too short for
a multi-GB rewrite) and runs `ANALYZE tracking_tokens` afterwards. Plan for
the table to be unavailable for writes and reads for the duration.

### Fallback B: `VACUUM FULL`

Same lock profile as CLUSTER, no preferred ordering. Use when CLUSTER is
unsuitable.

```bash
tsx scripts/reclaim-tracking-tokens.ts --method=vacuum-full --confirm
```

## Verify

After whichever method completes, re-run:

```bash
tsx scripts/reclaim-tracking-tokens.ts --check
```

`pg_total_relation_size('tracking_tokens')` should now be a steady-state
value proportional to recent send volume — typically a small fraction of
the pre-purge ~65 GB. Dead rows should be near zero. Record the new size
alongside the old one to confirm reclamation succeeded.
