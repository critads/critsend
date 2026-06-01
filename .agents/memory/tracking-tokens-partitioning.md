---
name: tracking_tokens partitioning
description: Durable decisions/constraints for the daily RANGE-partitioned tracking_tokens table and its one-time migration.
---

# tracking_tokens partitioning

`tracking_tokens` is a **daily RANGE-partitioned table on `created_at`** (partitions `tracking_tokens_pYYYYMMDD`, UTC). Retention = **DROP whole day-partitions** older than `TRACKING_TOKEN_RETENTION_DAYS` (prod 14), run by the 01:00 Europe/Paris job in `server/workers.ts`. This replaced a multi-hour DELETE that never returned disk on Neon.

## Composite PK / token uniqueness
- PK is `(token, created_at)` — Postgres requires the partition key in every unique constraint, so a token-only unique index is impossible on the partitioned table.
- **Token uniqueness is intentionally NOT enforced.** Accepted as noise (~hundreds of random collisions per 14-day window out of ~300M).
- **Why it's safe:** all token-resolution reads use `ORDER BY created_at DESC LIMIT 1` so the rare collision resolves deterministically to the most recent emission. That query is a backward PK index scan (verified via EXPLAIN) — zero added cost on the hot path.
- **How to apply:** any NEW code that reads a token from `tracking_tokens` (or `tracking_tokens_legacy`) MUST keep the `ORDER BY created_at DESC LIMIT 1`; never assume one row per token.

## drizzle-kit push MUST skip this table
- `drizzle.config.ts` has `tablesFilter: ["!tracking_tokens", "!tracking_tokens_*"]`. The partitioned layout is raw-SQL managed by the bootstrap DDL in `campaign-repository.ts` (`buildPartitionedTableDDL`), NOT by Drizzle migrations.
- **Why:** `deploy/deploy.sh` runs `npx drizzle-kit push --force` on every deploy; without the filter it would try to "reconcile" the partitioned table back to a plain table and destroy it.
- **How to apply:** never remove that filter; never add `tracking_tokens*` to Drizzle-managed migrations.

## One-time migration (single → partitioned)
- Tool: `scripts/migrate-tracking-tokens-partitioning.ts` — subcommands `status | prepare | swap[--yes] | copy | verify | drop-legacy[--yes]`.
- Flow: build empty partitioned `tracking_tokens_new` → transactional rename old→`tracking_tokens_legacy`, new→`tracking_tokens` → copy last N days (keyset on `(created_at, token)`, targetless `ON CONFLICT DO NOTHING`) → verify → drop legacy.
- **Zero tracking loss during the swap→drop window** comes from a dual-read fallback: token resolution falls back to `tracking_tokens_legacy` on a miss and self-disables on `42P01` once legacy is dropped (60s existence-cache TTL + gone-latch).
- **Critical:** partitions built on `tracking_tokens_new` before the swap MUST use the canonical `tracking_tokens_pYYYYMMDD` names (the helpers take a `parentTable` arg but always name children canonically) so that after the rename `listTrackingTokenPartitions`/retention recognize them and `ensure` doesn't create range-overlapping duplicates.
- **Swap re-ensures partition coverage** immediately before the rename — `prepare` may have run days earlier, leaving a stale forward buffer; without the re-ensure a live insert right after the rename could hit "no partition found for row" and drop an event.

## Running the heavy `copy` step on Neon (hard-won, 2026-06-01)
The bulk `copy` (INSERT..SELECT of ~13–14 days from legacy) repeatedly hung/died until ALL of these were fixed together. Do NOT run it over the app's shared pool or a plain `nohup`.
- **Use a DEDICATED DIRECT (unpooled) connection**, not `server/db`'s `pool`. The app pool uses Neon's PgBouncer pooled endpoint (transaction pooling): a long-held `INSERT..SELECT` either gets capped by the connect-time `statement_timeout` (which `SET`/`SET LOCAL` can't reliably override under tx pooling) or starves waiting for a PgBouncer server-backend slot under live send load — with NO client-visible error, so Node awaits forever. The direct host = pooled host with `-pooler.` removed; on it `statement_timeout=0` sticks. (`createCopyPool()` in the migration script.)
- **keepAlive: true on the copy pool.** During a multi-minute chunk the client socket sits idle awaiting the result; without TCP keepalive a NAT/Neon-proxy idle-timeout silently drops it (server keeps running, client hangs). Short chunks (<~75s) finished before the drop, which is why it "worked then hung."
- **connectionTimeoutMillis on the copy pool.** `pool.connect()` is OUTSIDE the per-query watchdog; without a connect timeout a hung reconnect (Neon cold-start/network) awaits forever. Fail fast → retry loop reconnects.
- **Per-chunk watchdog + retry + ON CONFLICT DO NOTHING.** Each chunk is a fresh connection, autocommit single statement, raced against an 8-min watchdog (chunks observed ≤~75s for ~750k rows); on timeout/error destroy the client (don't return to pool) and retry with backoff. Idempotent, so resumable after any partial failure.
- **Launch with `setsid … </dev/null &`, NOT just `nohup`.** Under the agent's bash tool, a plain backgrounded job is reaped (silent SIGKILL, no stack trace, no "COPY done") when the launching shell exits. `setsid` puts it in its own session so it survives across turns. Append `; echo "EXIT=$?"` to the log to capture the real exit code (137=OOM, 143=SIGTERM, 124=timeout).
- The copy **re-scans from the cutoff on every run**; already-copied chunks return `n=0` fast (ON CONFLICT) before it surges into fresh data — expected, not a hang. Watch `/tmp/mig_copy.log` chunk lines + a heartbeat every 36 chunks.
