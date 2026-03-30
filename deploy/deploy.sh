#!/usr/bin/env bash
# deploy/deploy.sh — Critsend deploy script
#
# Runs the full update sequence on the server:
#   1. git pull    — pull latest code
#   2. npm ci      — install/update dependencies
#   3. npm run build — build Vite frontend + esbuild server bundles
#   4. drizzle-kit push — apply pending schema changes
#   5. pm2 reload  — zero-downtime process reload
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
npm ci --prefer-offline
ok "Dependencies installed"

# ─── Step 3: Build ────────────────────────────────────────────────────────────
step "Building frontend and server bundles (npm run build)..."
npm run build
ok "Build complete"

# ─── Step 4: Database schema push ─────────────────────────────────────────────
step "Pushing database schema changes (drizzle-kit push)..."
# drizzle.config.ts uses NEON_DATABASE_URL || DATABASE_URL
# Source .env so the variable is available to drizzle-kit
if [[ -f ".env" ]]; then
    # shellcheck disable=SC2046
    env $(grep -v '^#' .env | grep -v '^[[:space:]]*$' | xargs) npx drizzle-kit push --yes
else
    npx drizzle-kit push --yes
fi
ok "Database schema up to date"

# ─── Step 5: PM2 reload ───────────────────────────────────────────────────────
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
echo "[deploy]   App:    https://yourdomain.com"
echo "[deploy]   Health: https://yourdomain.com/api/health"
echo "[deploy]   Logs:   pm2 logs critsend-web"
echo ""
