---
name: Production database exploration
description: Safe connection policy for read-only investigation of the live critsend PostgreSQL database.
---

Use the dedicated `CRITSEND_EXPLORER_*` environment settings and password Secret for production investigations. The role is constrained to read-only transactions, SELECT access, no schema creation, and short statement/idle timeouts.

**Why:** The application's normal database credentials are unnecessarily powerful for investigation, while the project's Neon connection is a stale copy and cannot answer live-production questions reliably.

**How to apply:** Construct an ephemeral PostgreSQL connection from the custom explorer environment variables, require TLS using the configured internal-certificate mode, run only read-only queries, and never print the password or a complete connection URL. If connectivity stops, verify the current Replit egress IP against the narrowly scoped host firewall and `pg_hba.conf` rules rather than opening PostgreSQL globally.

**Reconnect triage (Replit egress IP changes on nearly every container restart; 8+ stale IPs had piled up by Sept 2026):**
1. Check the current egress IP first (`curl https://api.ipify.org`); `/tmp` helpers vanish on restart, so recreate the psql wrapper (use `PGSSLMODE=require` env — a trailing `sslmode=require` arg is ignored when `-d` is given).
2. Connection *timeout* = firewall layer (UFW rule ordering — `ufw allow` appends after any deny, use `ufw insert 1` — or a Hetzner Cloud firewall). `no pg_hba.conf entry` = the allow-list line is missing from the *active* hba file.
3. Have the owner run `SHOW hba_file;` plus `SELECT … FROM pg_hba_file_rules WHERE user_name @> '{replit_explorer}' OR error IS NOT NULL;` — that view parses the file on disk, so an absent IP means the edit never landed (wrong file/version dir), not a reload problem. An address without `/32` invalidates the whole file on reload.
4. Owner declined a durable 0.0.0.0/0 `hostssl` line for the explorer role so far; keep offering it only with explicit consent.