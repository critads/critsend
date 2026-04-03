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

# ─── Step 4: Database schema push ─────────────────────────────────────────────
step "Pushing database schema changes (drizzle-kit push)..."
# drizzle.config.ts uses NEON_DATABASE_URL || DATABASE_URL.
# We extract the value directly rather than sourcing .env, because shell's
# `source` misinterprets `&` in URL query strings as a background-job operator.
if [[ -f ".env" ]]; then
    _db_url=$(grep -E "^NEON_DATABASE_URL=" .env | head -1 | cut -d'=' -f2- | tr -d '"' | tr -d "'")
    if [[ -n "$_db_url" ]]; then
        export NEON_DATABASE_URL="$_db_url"
    fi
fi
npx drizzle-kit push
ok "Database schema up to date"

# ─── Step 5: Ensure directories exist with correct permissions ───────────────
step "Ensuring required directories exist..."
mkdir -p images uploads/imports
chmod 755 images uploads/imports
ok "Directories ready (images, uploads/imports)"

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

# ─── Done ─────────────────────────────────────────────────────────────────────
echo ""
echo "[deploy] ✓ Deploy complete!"
echo "[deploy]   Logs:   pm2 logs critsend-web"
echo "[deploy]   Health: curl http://localhost:5000/api/health"
echo ""
