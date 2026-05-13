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
