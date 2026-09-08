---
name: Production database exploration
description: Safe connection policy for read-only investigation of the live critsend PostgreSQL database.
---

Use the dedicated `CRITSEND_EXPLORER_*` environment settings and password Secret for production investigations. The role is constrained to read-only transactions, SELECT access, no schema creation, and short statement/idle timeouts.

**Why:** The application's normal database credentials are unnecessarily powerful for investigation, while the project's Neon connection is a stale copy and cannot answer live-production questions reliably.

**How to apply:** Construct an ephemeral PostgreSQL connection from the custom explorer environment variables, require TLS using the configured internal-certificate mode, run only read-only queries, and never print the password or a complete connection URL. If connectivity stops, verify the current Replit egress IP against the narrowly scoped host firewall and `pg_hba.conf` rules rather than opening PostgreSQL globally.