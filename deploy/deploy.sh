#!/usr/bin/env bash
# deploy/deploy.sh — Critsend deploy script
#
# Runs the full update sequence on the server:
#   1. git pull       — pull latest code
#   2. npm ci         — install/update dependencies
#   3. npm run build  — build Vite frontend + esbuild server bundles
#   4. drizzle-kit push — apply pending schema changes
#   5. mkdir -p       — ensure required directories exist (images, uploads/imports)
#   6. nginx update   — apply nginx.conf from repo; rolls back automatically on failure
#   7. pm2 reload     — zero-downtime process reload
#
# Usage (on the server, from the repo root):
#   bash deploy/deploy.sh
#
# Or trigger remotely via SSH (GitHub Actions uses this pattern):
#   ssh user@host "cd /home/user/critsend && bash deploy/deploy.sh"
#
# Requirements:
#   - .env file present in repo root with all required variables
#   - PM2 running the ecosystem config (critsend-web + critsend-worker)
#   - nvm + Node.js 20 installed for the current user

set -euo pipefail

# ─── NVM setup ────────────────────────────────────────────────────────────────
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# shellcheck disable=SC1090
[[ -s "$NVM_DIR/nvm.sh" ]] && source "$NVM_DIR/nvm.sh"

# Verify we have the right Node version
NODE_CURRENT=$(node --version 2>/dev/null || echo "none")
if [[ ! "$NODE_CURRENT" =~ ^v20 ]]; then
    echo "[deploy] Switching to Node.js 20..."
    nvm use 20
fi

# ─── Helpers ──────────────────────────────────────────────────────────────────
step() { echo ""; echo "[deploy] ▶ $*"; }
ok()   { echo "[deploy] ✓ $*"; }
fail() { echo "[deploy] ✗ $*" >&2; exit 1; }

# Make sure we're in the repo root
[[ -f "package.json" ]] || fail "Run this script from the repository root directory"

# ─── Step 1: git pull ─────────────────────────────────────────────────────────
step "Pulling latest code from git..."
git pull --ff-only
ok "Code updated: $(git log -1 --oneline)"

# ─── Step 2: npm ci ───────────────────────────────────────────────────────────
step "Installing dependencies (npm ci)..."
# Run in a subshell with NODE_ENV unset so npm does not skip devDependencies.
# devDependencies (vite, esbuild, @vitejs/plugin-react, etc.) are required at
# build time even though the runtime is production.
(unset NODE_ENV; npm ci --prefer-offline)
ok "Dependencies installed"

# ─── Step 3: Build ────────────────────────────────────────────────────────────
step "Building frontend and server bundles (npm run build)..."
npm run build
ok "Build complete"

if [[ "${SKIP_SCHEMA_PUSH:-0}" == "1" ]]; then
    step "Skipping database schema push (SKIP_SCHEMA_PUSH=1)"
    ok "Schema push skipped"
else
    step "Pushing database schema changes (drizzle-kit push)..."
    if [[ -f ".env" ]]; then
        _db_url=$(grep -E "^NEON_DATABASE_URL=" .env | head -1 | cut -d'=' -f2- | tr -d '"' | tr -d "'")
        if [[ -n "$_db_url" ]]; then
            export NEON_DATABASE_URL="$_db_url"
        fi
    fi
    npx drizzle-kit push --force
    ok "Database schema up to date"
fi

# ─── Step 5: Ensure directories exist with correct permissions ───────────────
# NOTE: import upload directories are NOT created here on purpose — they live
# OUTSIDE the app dir (see IMPORT_UPLOAD_DIR in deploy/ecosystem.config.cjs)
# and are provisioned once by deploy/setup.sh. Creating them inside the repo
# would re-introduce the bug where deploys wipe queued CSV imports.
step "Ensuring required directories exist..."
mkdir -p images
chmod 755 images
ok "Directories ready (images)"

# Surface the resolved import upload dir so operators can spot misconfig at a glance.
_import_upload_dir=$(grep -E "^IMPORT_UPLOAD_DIR=" .env 2>/dev/null | head -1 | cut -d'=' -f2- | tr -d '"' | tr -d "'")
_import_upload_dir="${_import_upload_dir:-/var/lib/critsend/uploads/imports}"
if [[ -d "$_import_upload_dir" ]]; then
    ok "Import upload dir present: $_import_upload_dir"
else
    echo "[deploy] ⚠ Import upload dir missing: $_import_upload_dir"
    echo "[deploy]   Run: sudo bash deploy/setup.sh   (provisions /var/lib/critsend/uploads/{imports,chunks})"
fi

# ─── Step 6: Update Nginx config (safe — rolls back on failure) ───────────────
step "Updating Nginx configuration..."
NGINX_LIVE="/etc/nginx/sites-available/critsend"
NGINX_BACKUP="${NGINX_LIVE}.bak.$(date +%s)"

if command -v sudo &>/dev/null && sudo -n nginx -v &>/dev/null 2>&1; then
    # Back up current live config
    sudo cp "$NGINX_LIVE" "$NGINX_BACKUP" 2>/dev/null || true
    # Apply updated config from repo
    sudo cp deploy/nginx.conf "$NGINX_LIVE"
    # Test — if it fails, restore backup and abort
    if sudo nginx -t 2>/dev/null; then
        sudo systemctl reload nginx
        # Remove backup once we know the new config is good
        sudo rm -f "$NGINX_BACKUP"
        ok "Nginx config updated and reloaded"
    else
        echo "[deploy]   Nginx config test failed — restoring backup..."
        [[ -f "$NGINX_BACKUP" ]] && sudo cp "$NGINX_BACKUP" "$NGINX_LIVE"
        sudo systemctl reload nginx
        fail "Nginx config rejected — rolled back to previous version. Fix deploy/nginx.conf and redeploy."
    fi
else
    echo "[deploy]   Skipping Nginx update (sudo not available or passwordless sudo not configured)"
    echo "[deploy]   Run manually: sudo cp deploy/nginx.conf $NGINX_LIVE && sudo nginx -t && sudo systemctl reload nginx"
fi

# ─── Step 7: PM2 reload ───────────────────────────────────────────────────────
step "Reloading PM2 processes (zero-downtime)..."
if pm2 list | grep -q "critsend-web"; then
    pm2 reload deploy/ecosystem.config.cjs --env production
    ok "PM2 processes reloaded"
else
    echo "[deploy]   First deploy detected — starting PM2 processes..."
    pm2 start deploy/ecosystem.config.cjs --env production
    pm2 save
    ok "PM2 processes started and saved"
fi

# ─── Step 8: Health check ────────────────────────────────────────────────────
step "Waiting for app to become healthy..."
HEALTH_OK=false
for i in $(seq 1 20); do
    sleep 3
    HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://localhost:5000/api/health/startup 2>/dev/null || echo "000")
    echo "[deploy]   Health check attempt $i/20: HTTP $HTTP_CODE"
    if [ "$HTTP_CODE" = "200" ]; then
        HEALTH_OK=true
        break
    fi
done

if [ "$HEALTH_OK" = "true" ]; then
    ok "App is healthy"
else
    echo "[deploy] ⚠ Health endpoint did not respond within 60s"
    echo "[deploy]   This is normal during heavy campaign sending or long bootstrap migrations."
    echo "[deploy]   Checking PM2 process status instead..."
    PM2_STATUS=$(pm2 jlist 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(next((p['pm2_env']['status'] for p in d if p['name']=='critsend-web'), 'missing'))" 2>/dev/null || echo "unknown")
    if [ "$PM2_STATUS" = "online" ]; then
        ok "PM2 process is online — app will become fully healthy once bootstrap completes"
    else
        echo "[deploy]   PM2 status: $PM2_STATUS"
        echo "[deploy]   Last 20 lines of web error log:"
        tail -20 /var/log/critsend/web-err.log 2>/dev/null || echo "(no error log found)"
        echo ""
        echo "[deploy]   Last 10 lines of web out log:"
        tail -10 /var/log/critsend/web-out.log 2>/dev/null || echo "(no out log found)"
        fail "App process is not online (status: $PM2_STATUS). Check logs above."
    fi
fi

# ─── Done ─────────────────────────────────────────────────────────────────────
echo ""
echo "[deploy] ✓ Deploy complete!"
echo "[deploy]   Logs:   pm2 logs critsend-web"
echo "[deploy]   Health: curl http://localhost:5000/api/health"
echo ""
