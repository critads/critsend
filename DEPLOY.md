# Deploying Critsend to a Dedicated Server

This guide walks through migrating Critsend from Replit to a self-hosted VPS.
Replit remains the **development environment** — you edit code there, push to GitHub, and the server auto-deploys.

## Overview

```
Replit (dev)  →  GitHub (main)  →  VPS (production)
  Edit code       git push          GitHub Actions SSHes in
                                    and runs deploy.sh
```

**Architecture on the server:**
- **critsend-web** (PM2) — Express HTTP server, SSE, API on port 5000
- **critsend-worker** (PM2) — Background job engine (campaigns, imports)
- **Nginx** — Reverse proxy on port 80/443 → app on port 5000
- **Neon** — PostgreSQL (stays cloud-hosted, nothing to migrate)
- **Upstash** (or any Redis) — Job queues and SSE pub/sub

---

## 1. Buy a VPS

Any Ubuntu 22.04 LTS server works. Recommended minimum specs:

| Resource | Minimum | Recommended |
|----------|---------|-------------|
| CPU      | 1 vCPU  | 2+ vCPUs    |
| RAM      | 1 GB    | 2–4 GB      |
| Disk     | 20 GB   | 40+ GB (CSV imports) |
| OS       | Ubuntu 22.04 LTS | Ubuntu 22.04 LTS |

Popular providers: DigitalOcean, Hetzner, Vultr, Linode.

---

## 2. Connect to the server

```bash
ssh ubuntu@YOUR_SERVER_IP
```

---

## 3. Push your GitHub repo secret for SSH (GitHub Actions setup)

On your **local machine**, generate a deploy key:

```bash
ssh-keygen -t ed25519 -C "github-actions-deploy" -f ~/.ssh/critsend_deploy
```

Copy the **public key** to your server's authorized_keys:

```bash
ssh-copy-id -i ~/.ssh/critsend_deploy.pub ubuntu@YOUR_SERVER_IP
# or manually:
# cat ~/.ssh/critsend_deploy.pub | ssh ubuntu@YOUR_SERVER_IP "cat >> ~/.ssh/authorized_keys"
```

In your GitHub repo, go to **Settings → Secrets → Actions** and add:

| Secret | Required | Value |
|--------|----------|-------|
| `SSH_HOST` | Yes | Your server's public IP or hostname |
| `SSH_USER` | Yes | `ubuntu` (or your login user) |
| `SSH_KEY`  | Yes | Contents of `~/.ssh/critsend_deploy` (the **private** key) |
| `APP_URL`  | Optional | Full HTTPS URL, e.g. `https://yourdomain.com` — enables post-deploy health check |

---

## 4. Run the setup script

On the **server**, clone the repo and run setup:

```bash
# Clone the repo (replace with your GitHub URL)
git clone https://github.com/yourusername/critsend.git ~/critsend
cd ~/critsend

# Run the one-time setup script
sudo bash deploy/setup.sh
```

This installs: nvm, Node.js 20, PM2, Nginx, Certbot.
It is idempotent — safe to re-run.

---

## 5. Create the .env file

```bash
cd ~/critsend
cp .env.example .env
nano .env
```

Fill in every `[REQUIRED]` variable. Generate the secret keys with:

```bash
# SESSION_SECRET, TRACKING_SECRET, MTA_ENCRYPTION_KEY
openssl rand -hex 32
```

Key variables to set:

```dotenv
NEON_DATABASE_URL=postgres://user:password@ep-xyz-123.us-east-2.aws.neon.tech/neondb?sslmode=require
REDIS_URL=rediss://default:password@host.upstash.io:6379
SESSION_SECRET=<64-char hex>
TRACKING_SECRET=<64-char hex>
MTA_ENCRYPTION_KEY=<64-char hex>
NODE_ENV=production
STORAGE_BACKEND=local
```

The tracking pool automatically derives a pooled connection URL from `NEON_DATABASE_URL`
by inserting `-pooler` into the Neon hostname (e.g. `ep-xyz-123-pooler.us-east-2.aws.neon.tech`).
Pooled connections use PgBouncer and do not count against the 50-connection direct limit.
To override the auto-derived URL, set `NEON_TRACKING_DATABASE_URL` explicitly.
To force the tracking pool to use the direct endpoint instead, set `TRACKING_POOL_USE_DIRECT=true`.

---

## 6. Configure Nginx

The config ships with Ubuntu's built-in snakeoil certificate as a bootstrap placeholder for the HTTPS block. This means `nginx -t` passes immediately — even before you have a real TLS cert. Certbot replaces the snakeoil paths with real Let's Encrypt paths in the next step.

```bash
# Copy and customize the Nginx config
sudo cp ~/critsend/deploy/nginx.conf /etc/nginx/sites-available/critsend

# Replace the placeholder domain
sudo sed -i 's/yourdomain.com/YOUR_ACTUAL_DOMAIN/g' /etc/nginx/sites-available/critsend

# Enable the site and remove the default
sudo ln -sf /etc/nginx/sites-available/critsend /etc/nginx/sites-enabled/critsend
sudo rm -f /etc/nginx/sites-enabled/default

# Test config and reload (passes right away — snakeoil cert is already on Ubuntu 22.04)
sudo nginx -t && sudo systemctl reload nginx
```

The app is now proxied on both port 80 and port 443 (with a browser security warning until you get a real cert). Continue to step 7 to replace the snakeoil cert with Let's Encrypt.

---

## 7. Obtain an SSL certificate

Make sure your domain's DNS A record points to the server's IP before running this.

```bash
sudo certbot --nginx -d yourdomain.com
```

Certbot will:
1. Complete the ACME challenge over HTTP (port 80)
2. Rewrite `/etc/nginx/sites-available/critsend` — replacing the snakeoil paths with the real Let's Encrypt cert paths
3. Set up auto-renewal via a systemd timer

Reload Nginx to apply the updated config:

```bash
sudo systemctl reload nginx
```

Verify auto-renewal works:

```bash
sudo certbot renew --dry-run
```

---

## 8. First deploy

```bash
cd ~/critsend
bash deploy/deploy.sh
```

This runs:
1. `git pull` — get latest code
2. `npm ci` — install dependencies
3. `npm run build` — build Vite frontend + server bundles
4. `npx drizzle-kit push` — apply schema changes
5. `pm2 start deploy/ecosystem.config.cjs --env production` — start processes

Save the PM2 process list so it survives reboots:

```bash
pm2 save
```

---

## 9. Validate the deployment

```bash
# Check process status
pm2 status

# Check app health endpoint
curl https://yourdomain.com/api/health

# Tail live logs
pm2 logs critsend-web
pm2 logs critsend-worker
```

Expected `pm2 status` output:

```
┌─────────────────┬──────┬────────┬─────────┬─────────┐
│ name            │ mode │ status │ cpu     │ memory  │
├─────────────────┼──────┼────────┼─────────┼─────────┤
│ critsend-web    │ fork │ online │ 0%      │ ~180MB  │
│ critsend-worker │ fork │ online │ 0%      │ ~120MB  │
└─────────────────┴──────┴────────┴─────────┴─────────┘
```

---

## 10. Ongoing workflow

```
Replit → edit code → git commit → git push origin main
                                         ↓
                              GitHub Actions triggers
                                         ↓
                              SSH into server → deploy.sh
                              (git pull, npm ci, db:push, pm2 reload)
```

The GitHub Actions workflow is in `deploy/github-actions-deploy.yml`.
Copy it to `.github/workflows/deploy.yml` in your repo to activate it:

```bash
mkdir -p .github/workflows
cp deploy/github-actions-deploy.yml .github/workflows/deploy.yml
git add .github/workflows/deploy.yml
git commit -m "ci: add auto-deploy workflow"
git push
```

---

## Troubleshooting

### App won't start

```bash
pm2 logs critsend-web --lines 50
pm2 logs critsend-worker --lines 50
```

Check that all required env vars are set in `.env`.

### 502 Bad Gateway from Nginx

The app process is not running or not listening on port 5000.

```bash
pm2 status
pm2 restart critsend-web
curl -s http://localhost:5000/api/health
```

### Database connection errors

Check `NEON_DATABASE_URL` in `.env`. Verify the connection string includes `?sslmode=require`.

```bash
node -e "
const { Pool } = require('pg');
const p = new Pool({ connectionString: process.env.NEON_DATABASE_URL });
p.query('SELECT 1').then(() => { console.log('DB OK'); p.end(); }).catch(e => console.error(e.message));
" 
```

### Schema out of date

```bash
cd ~/critsend
npx drizzle-kit push --yes
```

### Redis connection errors

Check `REDIS_URL` in `.env`. For Upstash, the URL starts with `rediss://` (note the double `s`).

### SSL certificate renewal failing

```bash
sudo certbot renew --force-renewal
sudo systemctl reload nginx
```

### View Nginx error log

```bash
sudo tail -f /var/log/nginx/error.log
```

### Restart everything cleanly

```bash
pm2 restart all
sudo systemctl reload nginx
```

### Reset a user password

```bash
cd ~/critsend
node -e "
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
// Load .env
require('dotenv').config();
(async () => {
  const pool = new Pool({ connectionString: process.env.NEON_DATABASE_URL });
  const hash = await bcrypt.hash('newpassword123', 12);
  await pool.query('UPDATE users SET password = \$1 WHERE username = \$2', [hash, 'yourusername']);
  console.log('Password updated');
  await pool.end();
})();
"
```

Or use the built-in reset script:

```bash
npx tsx scripts/generate-reset-link.ts yourusername
```

---

## Notes

- **PostgreSQL** stays on Neon (cloud-hosted). No migration needed.
- **Redis** stays on Upstash (or any Redis). Set `REDIS_URL` in `.env`.
- **CSV import files** are stored in `uploads/imports/` on the server disk.
  If you need to move servers, copy that directory.
- **Log files** are written to `/var/log/critsend/` by PM2.
  Consider adding log rotation: `pm2 install pm2-logrotate`
- **SMTP credentials** are AES-256-GCM encrypted at rest.
  The `MTA_ENCRYPTION_KEY` in `.env` is required to decrypt them.
  **Back it up** — losing it means re-entering all MTA passwords.

---

## Tracking-pool isolation (Task #47) — verification runbook

The web process now runs two pg pools: a **main pool** (default 14) for
user-facing traffic and a **dedicated tracking pool** (default 6) for
open/click/unsubscribe traffic. All tracking endpoints respond first and
write asynchronously through `server/tracking-buffer.ts` via the tracking
pool, so a campaign-blast pixel firehose can no longer drain the main
pool and starve login / dashboard / imports.

### Post-deploy verification

1. Confirm pool sizing in the web log on boot:

   ```bash
   pm2 logs critsend-web --lines 200 | grep -E 'TRACKING POOL|CONNECTION BUDGET'
   ```

   Expect: `Main pool: 14 | Tracking pool: 6 | Total allocated: 25`.

2. Run the load test against the live host. Either paste a real signed
   pixel URL from a recent send, or pass `TRACKING_SECRET` so the script
   can sign one for you:

   ```bash
   PIXEL_URL='https://send.example.com/api/track/open/<cid>/<sid>?sig=...' \
     RPS=200 DURATION=60 BASE_URL=https://send.example.com \
     ./scripts/load-test-tracking.sh
   ```

   Acceptance: `[OK] Health p99(...) below threshold (1000ms)`.

3. Snapshot the tracking metrics during the test:

   ```bash
   curl -s https://send.example.com/metrics \
     | grep -E '^critsend_tracking_(buffer|pool|link)_'
   ```

   Expect `critsend_tracking_buffer_enqueued_total` and
   `critsend_tracking_buffer_flushed_total` to climb together,
   `critsend_tracking_buffer_dropped_total{reason="queue_full"}` to
   stay at 0, and `critsend_tracking_pool_in_use` to peak well below 6.

4. Tail for warnings — none should appear under nominal load:

   ```bash
   pm2 logs critsend-web --lines 0 | grep -E 'TRACKING BUFFER|TRACKING POOL'
   ```
