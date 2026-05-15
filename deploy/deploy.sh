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

# ─── Pre-flight: import upload dir must exist AND be writable by this user ──
# Hard gate: if the upload dir is broken, fail BEFORE pm2 reload so we don't
# flip prod to a 502 Bad Gateway. The app degrades gracefully (returns 503
# from /api/import) but we'd rather catch this at deploy-time than discover
# it post-reload. See task #141 for the post-mortem.
_import_upload_dir=$(grep -E "^IMPORT_UPLOAD_DIR=" .env 2>/dev/null | head -1 | cut -d'=' -f2- | tr -d '"' | tr -d "'")
_import_upload_dir="${_import_upload_dir:-/var/lib/critsend/uploads/imports}"
_import_chunks_dir=$(grep -E "^IMPORT_CHUNKS_DIR=" .env 2>/dev/null | head -1 | cut -d'=' -f2- | tr -d '"' | tr -d "'")
_import_chunks_dir="${_import_chunks_dir:-$(dirname "$_import_upload_dir")/chunks}"
_data_root="$(dirname "$(dirname "$_import_upload_dir")")"  # e.g. /var/lib/critsend
_app_user="$(id -un)"

_check_writable() {
    local d="$1"
    [[ -d "$d" ]] || return 1
    local probe="$d/.deploy-write-probe-$$"
    ( : > "$probe" ) 2>/dev/null || return 1
    rm -f "$probe"
    return 0
}

# SAFETY: only allow recursive sudo chown/chmod on paths under known data
# roots. Without this, a typo'd or malicious IMPORT_UPLOAD_DIR (e.g.
# `/imports` whose dirname-of-dirname is `/`) would cause `sudo chown -R`
# to retake ownership of the entire filesystem. We refuse to auto-repair
# anything outside this allowlist and tell the operator what to run by hand.
_safe_repair_root() {
    local root="$1"
    case "$root" in
        /var/lib/critsend|/var/lib/critsend/*) return 0 ;;
        /opt/critsend|/opt/critsend/*)        return 0 ;;
        /home/*/critsend-data|/home/*/critsend-data/*) return 0 ;;
        *) return 1 ;;
    esac
}

# Track per-dir failures separately so a successful auto-repair on one dir
# never masks an unresolved failure on the other.
_uploads_ok=1
_chunks_ok=1
for d in "$_import_upload_dir" "$_import_chunks_dir"; do
    if _check_writable "$d"; then continue; fi

    if [[ "$d" == "$_import_upload_dir" ]]; then _uploads_ok=0; else _chunks_ok=0; fi
    echo "[deploy] ⚠ Import dir not writable by $_app_user: $d"

    # Try a passwordless sudo recovery before giving up — but ONLY if the
    # data root is in our allowlist. Recursive chown/chmod on an unbounded
    # path is a footgun that has wrecked production hosts before.
    if ! command -v sudo &>/dev/null || ! sudo -n true 2>/dev/null; then
        echo "[deploy]   (passwordless sudo not available — skipping auto-repair)"
        continue
    fi
    if ! _safe_repair_root "$_data_root"; then
        echo "[deploy]   ✗ REFUSING auto-repair: data root '$_data_root' is outside the allowlist."
        echo "[deploy]     Allowed roots: /var/lib/critsend, /opt/critsend, /home/*/critsend-data"
        echo "[deploy]     Fix .env so IMPORT_UPLOAD_DIR sits under one of those, or run the chown by hand."
        continue
    fi

    echo "[deploy]   Attempting auto-repair: sudo mkdir -p $d && sudo chown -R $_app_user:$_app_user $_data_root"
    sudo mkdir -p "$d" 2>/dev/null || true
    sudo chown -R "$_app_user:$_app_user" "$_data_root" 2>/dev/null || true
    sudo chmod -R u+rwX "$_data_root" 2>/dev/null || true
    if _check_writable "$d"; then
        ok "Auto-repaired upload dir: $d"
        if [[ "$d" == "$_import_upload_dir" ]]; then _uploads_ok=1; else _chunks_ok=1; fi
    fi
done

if [[ "$_uploads_ok" != "1" || "$_chunks_ok" != "1" ]]; then
    echo ""
    echo "[deploy] ─────────────────────────────────────────────────────────────"
    echo "[deploy]   Aborting BEFORE pm2 reload to avoid a 502 outage."
    echo "[deploy]   Run on the server, then re-run this deploy:"
    echo "[deploy]     sudo mkdir -p $_import_upload_dir $_import_chunks_dir"
    echo "[deploy]     sudo chown -R $_app_user:$_app_user $_data_root"
    echo "[deploy]     sudo chmod -R u+rwX $_data_root"
    echo "[deploy]   Or full re-provision:  sudo bash deploy/setup.sh"
    echo "[deploy] ─────────────────────────────────────────────────────────────"
    fail "Import upload dirs not writable — refusing to reload pm2"
fi
ok "Import upload dirs writable: $_import_upload_dir, $_import_chunks_dir"

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
step "Reloading PM2 processes (zero-downtime when possible)..."
if pm2 list | grep -q "critsend-web"; then
    # Task #160 (post-incident hardening): detect apps whose set of
    # env_production keys has CHANGED since the last start (e.g. a new
    # var was added to ecosystem.config.cjs in this commit). For those,
    # `pm2 reload --update-env` is insufficient — PM2 merges the saved
    # dump.pm2 env with what it re-parses and routinely drops freshly-
    # added keys (constated 2026-05-15: DRAIN_PROCESS_DEDICATED defined
    # in env_production was simply absent from `pm2 env <id>` after a
    # reload). The only reliable fix is `pm2 delete <app> && pm2 start
    # ecosystem --only <app>`, which costs ~5s downtime per affected
    # app but guarantees the new env is fully applied. Apps whose env
    # keys are unchanged stay on a zero-downtime soft reload.
    _need_recreate="$(node -e '
      const path = require("path");
      const fs = require("fs");
      const cfgPath = path.resolve("deploy/ecosystem.config.cjs");
      const cfg = require(cfgPath);
      const apps = (cfg.apps || []).filter(a => /^critsend-/.test(a.name));
      const jlistRaw = fs.readFileSync(0, "utf8");
      let jlist = [];
      try { jlist = JSON.parse(jlistRaw); } catch { jlist = []; }
      const out = [];
      for (const app of apps) {
        const expected = new Set(Object.keys(app.env_production || {}));
        const running = jlist.find(p => p.name === app.name);
        if (!running) { out.push(app.name); continue; } // not running yet
        const actual = new Set(Object.keys(running.pm2_env || {}));
        const missing = [...expected].filter(k => !actual.has(k));
        if (missing.length > 0) out.push(app.name);
      }
      process.stdout.write(out.join(" "));
    ' < <(pm2 jlist 2>/dev/null) 2>/dev/null || echo '')"

    if [[ -n "${_need_recreate// }" ]]; then
        echo "[deploy]   Detected new/changed env vars on: $_need_recreate"
        echo "[deploy]   → forcing pm2 delete + start (≈5s downtime per app to inject fresh env)"
        for app in $_need_recreate; do
            pm2 delete "$app" 2>/dev/null || true
            pm2 start deploy/ecosystem.config.cjs --env production --only "$app"
        done
    else
        echo "[deploy]   No env_production key changes detected — using zero-downtime reload."
    fi

    # Soft-reload everything else (still re-parses the ecosystem to pick
    # up changes to existing env values, e.g. tuning knobs).
    pm2 reload deploy/ecosystem.config.cjs --env production --update-env
    # Catch a brand-new app entry the daemon doesn't yet know about
    # (only relevant on the first deploy that introduces a new app).
    # Without the existence check, this would issue a redundant restart
    # on every deploy — constated 2026-05-15: drainer was SIGINT'd
    # twice per deploy because `pm2 start --only` on an existing app
    # triggers a restart instead of being a no-op.
    if ! pm2 list | grep -q "critsend-drainer"; then
        echo "[deploy]   critsend-drainer not yet in PM2 — starting it."
        pm2 start deploy/ecosystem.config.cjs --env production --update-env --only critsend-drainer
    fi
    pm2 save
    ok "PM2 processes reloaded"
else
    echo "[deploy]   First deploy detected — starting PM2 processes..."
    pm2 start deploy/ecosystem.config.cjs --env production
    pm2 save
    ok "PM2 processes started and saved"
fi

# ─── Step 7b: Verify each PM2 process actually came up ───────────────────────
# Task #160: a `pm2 reload` reports success even if a process crashes
# in its first second (the daemon will keep restarting it). Without this
# verification, a deploy that breaks `dist/drainer-main.cjs` would silently
# leave the drain dead until the next manual `pm2 logs` inspection.
# We grep the recent logs for the canonical "Starting" line each process
# emits at boot — its presence is proof the entrypoint executed past env
# parsing, DB pool init, and the bootstrap call.
step "Verifying PM2 processes started successfully..."
sleep 15  # give every process time to finish a graceful restart + emit its Starting line
# We search the on-disk log files directly (they retain history across
# reloads/restarts) and retry up to 3 times with a small backoff to
# absorb slow-booting processes (the drainer in particular runs the
# pressure-guard bootstrap which can take up to ~2 min on a busy DB).
# Patterns are matched as plain literals (fgrep) to avoid regex-escape
# pitfalls.
declare -A _expected=(
    ["critsend-web"]="serving on port"
    ["critsend-worker"]="[WORKER] Worker process starting"
    ["critsend-drainer"]="[DRAINER] Drainer process starting"
)
declare -A _logfile=(
    ["critsend-web"]="/var/log/critsend/web-out.log"
    ["critsend-worker"]="/var/log/critsend/worker-out.log"
    ["critsend-drainer"]="/var/log/critsend/drainer-out.log"
)
_verify_failed=0
for proc in "${!_expected[@]}"; do
    pattern="${_expected[$proc]}"
    log="${_logfile[$proc]}"
    found=0
    # 3 attempts × 10 s = up to 30 s extra grace period for slow boots.
    for _try in 1 2 3; do
        if [[ -r "$log" ]] && grep -F -q "$pattern" "$log"; then
            found=1
            break
        fi
        # Fallback to pm2 logs (covers the case where logrotate moved the file).
        if pm2 logs "$proc" --lines 500 --nostream --raw 2>/dev/null | grep -F -q "$pattern"; then
            found=1
            break
        fi
        sleep 10
    done
    if [[ "$found" == "1" ]]; then
        ok "$proc: boot line present"
    else
        echo "[deploy] ⚠ $proc: boot line '$pattern' not found in $log after 45 s"
        echo "[deploy]   Last 30 lines from $proc:"
        tail -n 30 "$log" 2>/dev/null | sed 's/^/[deploy]     /' || true
        _verify_failed=1
    fi
done
if [[ "$_verify_failed" == "1" ]]; then
    fail "One or more PM2 processes did not emit their boot line — investigate above logs."
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
