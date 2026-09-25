---
name: Production database exploration
description: Safe connection policy for read-only investigation of the live critsend PostgreSQL database.
---

Use the dedicated `CRITSEND_EXPLORER_*` environment settings and password Secret for production investigations. The role is constrained to read-only transactions, SELECT access, no schema creation, and short statement/idle timeouts.

**Why:** The application's normal database credentials are unnecessarily powerful for investigation, while the project's Neon connection is a stale copy and cannot answer live-production questions reliably.

**How to apply:** Construct an ephemeral PostgreSQL connection from the custom explorer environment variables, require TLS using the configured internal-certificate mode, run only read-only queries, and never print the password or a complete connection URL. If connectivity stops, verify the current Replit egress IP against the narrowly scoped host firewall and `pg_hba.conf` rules rather than opening PostgreSQL globally.

**Reconnect triage (Replit egress IP changes on nearly every container restart; 8+ stale IPs had piled up by Sept 2026):**
1. Check the current egress IP first (`curl https://api.ipify.org`); `/tmp` helpers vanish on restart, so recreate the psql wrapper (use `PGSSLMODE=require` env — a trailing `sslmode=require` arg is ignored when `-d` is given).
2. Connection *timeout* = firewall layer (UFW rule ordering — `ufw allow` appends after any deny, use `ufw insert 1`). Confirmed 2026-09-21: UFW is the only layer on critsend-db (no Hetzner Cloud firewall) — the port opened within a minute of the UFW insert. `no pg_hba.conf entry` = the allow-list line is missing from the *active* hba file.
3. Have the owner run `SHOW hba_file;` plus `SELECT … FROM pg_hba_file_rules WHERE user_name @> '{replit_explorer}' OR error IS NOT NULL;` — that view parses the file on disk, so an absent IP means the edit never landed (wrong file/version dir), not a reload problem. An address without `/32` invalidates the whole file on reload.
4. Owner declined a durable 0.0.0.0/0 `hostssl` line for the explorer role so far; keep offering it only with explicit consent.
5. Owner wants stale Replit IPs pruned each time a new one is added (asked 2026-09-21): the reconnect block must remove old `replit_explorer` hba lines and old 5432 UFW rules (delete by number, highest first — comments vary), keeping only the App->Postgres and wg0 gateway rules plus the single current IP.

**Index / plan work (learned 2026-09-25):**
- Validate a candidate index's plan shape with `hypopg` on the Neon copy (extension available there, same PG major) before asking the owner to build anything on prod; the explorer role cannot create indexes.
- Prod DDL blocks for the owner: `psql -f` runs as `postgres`, which cannot read `/root/` — put the SQL file in `/tmp` (chmod 644), run it under `nohup`, `SET statement_timeout = 0` first. The data volume had 1.3 TB free (Sept 2026), so disk is not the constraint; I/O during sends is.
- The explorer sees `pg_stat_progress_create_index` rows but with empty columns (unprivileged); poll `pg_index.indisvalid` + `pg_relation_size` instead. A 5 GB index on the 80 M-row campaign_stats built in ~2 min on that host.