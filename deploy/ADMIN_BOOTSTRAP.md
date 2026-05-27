# Promoting the first admin user

Critsend's admin gate (Task #145, R13) is DB-first: routes that require admin
privileges check `users.is_admin = true` first, then fall back to the
`ADMIN_USER_IDS` env-var allowlist for first-deployment ergonomics.

In production with `NODE_ENV=production` and **no** `ADMIN_USER_IDS` configured
**and** no `users.is_admin = true` row, every admin route fails closed (403).
That means a brand-new install needs to mint its first admin manually.

## Option A — Promote an existing user via SQL (recommended)

Connect to the production database (psql / Neon SQL editor) and run:

```sql
-- Replace the username (or email) match with your own.
UPDATE users SET is_admin = true WHERE username = 'alice';

-- Verify
SELECT id, username, is_admin FROM users WHERE is_admin = true;
```

After the row exists, every subsequent admin API call from that session is
authorised without any env-var changes. Restarting the app is **not**
required — `isAdminUser()` reads the column on every request.

## Option B — Bootstrap via `ADMIN_USER_IDS`

If you do not yet have a database row to promote (e.g. provisioning a fresh
deployment from CI), set the env var on the host (PM2 `ecosystem.config.cjs`,
container env, etc.) to a comma-separated list of `users.id` values:

```bash
export ADMIN_USER_IDS="user_abc123,user_def456"
```

Restart the app. Any session whose `userId` is in the list is treated as an
admin until you remove the env var.

> Best practice: use option B only to seed the very first admin, then run the
> SQL in option A and unset `ADMIN_USER_IDS`.

## Revoking admin

```sql
UPDATE users SET is_admin = false WHERE username = 'alice';
```

## CSV import storage backend

By default uploaded CSVs go to local disk (`IMPORT_UPLOAD_DIR`, default
`/var/lib/critsend/uploads/imports`). This loses files if PM2 restarts
between the upload and the worker pickup. To activate Hetzner Object Storage
(S3-compatible, recommended for prod), see **[HETZNER_S3_SETUP.md](HETZNER_S3_SETUP.md)**.

## Drain healthcheck (Task #160)

Once an admin exists, you can verify the dedicated `critsend-drainer`
process is alive end-to-end via:

```bash
curl -s -b "connect.sid=<your-session-cookie>" \
  http://localhost:5000/api/admin/pressure-drain/health | jq
```

A healthy response looks like:

```json
{
  "healthy": true,
  "last_tick_age_s": 4.2,
  "leader_holder_id": "12345-abcd1234",
  "leader_expires_in_s": 53.1,
  "last_tick_drained": 12,
  "last_tick_errors": 0,
  "last_tick_eligible": 3,
  "deferred_pending_total": 1240,
  "deferred_due_total": 0,
  "sends_5m": 8421,
  "max_age_seconds": 60,
  "reasons": { "lease_alive": true, "tick_fresh": true, "has_lease_row": true }
}
```

`healthy=false` means either the leader lease has expired (no process is
draining at all) or the last tick is older than `?maxAge=60` seconds
(drain is stuck). Both are alertable conditions: check
`pm2 logs critsend-drainer` first, then the embedded fallbacks in
`pm2 logs critsend-web` / `pm2 logs critsend-worker` (only relevant if
`DRAIN_PROCESS_DEDICATED=false` is set in `.env`).
