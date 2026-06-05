---
name: Hetzner self-hosted DB resilience gaps
description: critsend-db (157.180.98.150, PG17) downtime/data-loss vectors found in the 2026-06 resilience audit
---

The dedicated Hetzner Postgres box (`critsend-db`) was migrated to as primary but shipped WITHOUT standard durability/availability guards. Verify these before trusting any self-hosted PG as primary:

- **No database backups.** Only `dpkg-db-backup.timer` (apt metadata) existed; `/var/backups` held no PG data; no pgBackRest/barman/pg_dump cron. A disk loss = total loss of subscribers + campaign data.
- **`archive_mode=off`** → no WAL archiving → no point-in-time recovery even once backups exist.
- **`unattended-upgrades` active with an EMPTY Package-Blacklist** → postgresql packages could auto-upgrade/restart mid-day; a library upgrade + needrestart auto-restart was the cause of the 2026-06-05 ~06:15 outage. Fix: blacklist postgresql* + set needrestart to list-mode ('l').
- **systemd `Restart=no`** on `postgresql@17-main` → PG never auto-recovers from a crash or failed start (stayed down ~25 min during the outage). Fix: drop-in `Restart=on-failure` + `RestartSec=5s`.
- **0 replicas / 0 replication slots** → single point of failure; true HA needs a hot standby + failover.
- **`idle_in_transaction_session_timeout=0`** → leaked transactions pin a connection + hold locks forever; recommend 300s.

**Why:** the migration focused on cutover correctness (connection budget, SSL, partitioning) and skipped operational hardening; these only bite at restart/failure time, not during normal running.

**Already GOOD (do not re-flag):** memory tuning (shared_buffers 64GB, effective_cache 192GB), data_checksums=on, synchronous_commit=on, restart_after_crash=on, healthy autovacuum, sane TCP keepalives. App connection budget peaks ~90-100 conns (web 6+10+4 ×2 cluster + worker 18+4 + drainer 6+10) vs max_connections=300 — overload is NOT a risk; PG_CONNECTION_LIMIT=250 is only a validation ceiling, NOT a per-process allocation.

**Access:** psql/libpq to this box needs `?sslmode=require` — the app's node-pg `sslmode=no-verify` is node-pg-only and invalid in libpq. Firewall was temporarily opened 0.0.0.0/0 for the audit (must be re-locked); the DB password was exposed in chat and should be rotated.
