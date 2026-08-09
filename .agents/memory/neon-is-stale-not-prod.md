---
name: NEON_DATABASE_URL is NOT live production
description: The workspace's NEON_DATABASE_URL points at the old Neon DB, stale since the June 2026 Hetzner migration — never verify prod behavior against it.
---

# NEON_DATABASE_URL is NOT live production

**Rule:** For any production verification, query the Hetzner box (`critsend-db`,
157.180.98.150) — e.g. have the operator run `sudo -u postgres psql critsend`
on the server. NEVER draw production conclusions from `psql "$NEON_DATABASE_URL"`.

**Why:** Production migrated from Neon to the self-hosted Hetzner PG17 box in
June 2026. On 2026-08-09 a verification against Neon showed 0 bot-IP activity
since 2026-06-05 and empty bot_opener_marks — the real prod DB showed the bot
active through 2026-08-09, ~14-88 new marks/day, and healthy daily passes.
Neon-based conclusions were completely wrong.

**How to apply:**
- Neon still receives writes (e.g. bot_opener_runs rows appear there — likely
  the dev workspace app, since server/db.ts prefers NEON_DATABASE_URL over
  DATABASE_URL). Fresh-looking rows in Neon do NOT mean it is prod.
- The drizzle-push footgun memory still applies: NEON_DATABASE_URL is still a
  remote DB you must not push schema to accidentally.
- Prod DB access from the workspace: none (firewall locked, no SSH keys). Ask
  the operator to run read-only SQL on the box and paste output.
