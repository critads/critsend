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

| Secret | Value |
|--------|-------|
| `SSH_HOST` | Your server's public IP or hostname |
| `SSH_USER` | `ubuntu` (or your login user) |
| `SSH_KEY`  | Contents of `~/.ssh/critsend_deploy` (the **private** key) |

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
NEON_DATABASE_URL=postgres://user:password@host/dbname?sslmode=require
REDIS_URL=rediss://default:password@host.upstash.io:6379
SESSION_SECRET=<64-char hex>
TRACKING_SECRET=<64-char hex>
MTA_ENCRYPTION_KEY=<64-char hex>
NODE_ENV=production
STORAGE_BACKEND=local
```

---

## 6. Configure Nginx

```bash
# Copy and customize the Nginx config
sudo cp ~/critsend/deploy/nginx.conf /etc/nginx/sites-available/critsend

# Replace the placeholder domain
sudo sed -i 's/yourdomain.com/YOUR_ACTUAL_DOMAIN/g' /etc/nginx/sites-available/critsend

# Enable the site
sudo ln -sf /etc/nginx/sites-available/critsend /etc/nginx/sites-enabled/critsend
sudo rm -f /etc/nginx/sites-enabled/default

# Test and reload
sudo nginx -t && sudo systemctl reload nginx
```

---

## 7. Obtain an SSL certificate

Make sure your domain's DNS A record points to the server's IP, then:

```bash
sudo certbot --nginx -d yourdomain.com
```

Certbot automatically updates the Nginx config with the certificate paths and sets up auto-renewal.

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
