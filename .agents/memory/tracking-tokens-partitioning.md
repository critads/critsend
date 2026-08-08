---
name: tracking_tokens partitioning
description: Durable decisions/constraints for the daily RANGE-partitioned tracking_tokens table and its one-time migration.
---

# tracking_tokens partitioning

`tracking_tokens` is a **daily RANGE-partitioned table on `created_at`** (partitions `tracking_tokens_pYYYYMMDD`, UTC). Retention = **DROP whole day-partitions** older than `TRACKING_TOKEN_RETENTION_DAYS` (prod 14 since 2026-08-08 via prod `.env`; code default also 14 now), run by the 01:00 Europe/Paris job in `server/workers.ts`. **Beware:** `db_maintenance_rules.retention_days` for tracking_tokens (seeded 90) is display-only — the drop job reads ONLY the env var; the misleading 90 derailed a real investigation. Volume: ~7 GB/day per partition on Hetzner (≈100 GB at 14d; disk 1.8 TB so fine). Consequence: /u/ unsubscribe and /c/ click short-links die when their day-partition drops — "dead unsubscribe link" reports trace to this window, not a bug. This replaced a multi-hour DELETE that never returned disk on Neon.

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

## Prod cutover decision: WAIT-AND-DROP, no bulk copy (2026-06-01)
The bulk `copy` of the recent window from legacy could NOT be completed from the agent environment, and we chose NOT to need it. Two hard constraints made the agent-driven copy infeasible, and the user accepted keeping only 7 days:
- **Agent bash freezes background jobs between tool calls.** A process backgrounded in one tool call only runs while THAT call is active; once the call returns it is suspended/permanently frozen (verified with a 5s-tick probe: stuck at tick 1 across the inter-call gap AND during a later unrelated 64s call). So a multi-hour copy cannot run in `setsid`/`nohup` across turns — earlier "surges" were just progress made during a single long `sleep` inside one active call.
- **No SSH/deploy creds to the prod VM** in the agent env (only `NEON_DATABASE_URL`/`REDIS_URL`), so the copy couldn't be launched on the VM where it would survive.
- **7-day legacy window is large** (indexed `count(*)` didn't finish in 115s → tens of millions of rows; ~1-2h continuous copy).

**Chosen plan (user-approved):** since `swap` already happened, all NEW tokens land natively in the partitioned table and the dual-read fallback serves pre-swap tokens from `tracking_tokens_legacy` (zero tracking loss). So we **do not copy**: just wait until the partitioned table has accumulated a full 7 days of native data (i.e. ~7+ days after the swap date), at which point `tracking_tokens_legacy` holds only >7-day-old (flushable) tokens, then run `drop-legacy --yes` to reclaim ~240 GB. Retention set to **7 days** (`TRACKING_TOKEN_RETENTION_DAYS=7` in `deploy/ecosystem.config.cjs`; needs a deploy to take effect, but nothing drops for ~7 days so timing is flexible).
**Why safe:** dual-read = zero loss while legacy exists; user OK'd flushing >7-day tokens. **Drop-legacy gate (invariant):** measured from the ACTUAL swap timestamp (not loose calendar days), `count(*) FROM tracking_tokens_legacy WHERE created_at >= now() - interval '7 days'` must be `0` (or the remainder explicitly accepted) before running `drop-legacy --yes`; dropping earlier loses recent pre-swap opens/clicks.
**Lesson for future heavy maintenance here:** don't attempt multi-hour DB jobs from the agent bash env — they freeze between turns and there's no VM SSH. Either run them on the VM (have the user launch in tmux) or design a zero-copy/wait strategy that rides on existing fallbacks.
