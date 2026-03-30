#!/usr/bin/env bash
# deploy/setup.sh — One-shot server provisioning for Critsend
#
# Installs: nvm, Node.js 20, PM2, Nginx, Certbot
# Tested on: Ubuntu 22.04 LTS (fresh VPS)
# Idempotent: safe to re-run — skips anything already installed
#
# Usage:
#   chmod +x deploy/setup.sh
#   sudo bash deploy/setup.sh
#
# Run as root or with sudo.

set -euo pipefail

NODE_VERSION="20"
NVM_VERSION="v0.40.1"
APP_USER="${SUDO_USER:-$(logname 2>/dev/null || echo ubuntu)}"
APP_DIR="/var/log/critsend"

info()    { echo "[setup] INFO  : $*"; }
success() { echo "[setup] OK    : $*"; }
warn()    { echo "[setup] WARN  : $*"; }
error()   { echo "[setup] ERROR : $*" >&2; exit 1; }

# ─── Root check ───────────────────────────────────────────────────────────────
[[ $EUID -ne 0 ]] && error "Please run as root: sudo bash deploy/setup.sh"

info "Provisioning server for user: $APP_USER"

# ─── System packages ──────────────────────────────────────────────────────────
info "Updating package index..."
apt-get update -qq

PACKAGES=()
for pkg in curl git nginx certbot python3-certbot-nginx build-essential; do
    if ! dpkg -l "$pkg" &>/dev/null; then
        PACKAGES+=("$pkg")
    fi
done

if [[ ${#PACKAGES[@]} -gt 0 ]]; then
    info "Installing system packages: ${PACKAGES[*]}"
    apt-get install -y -qq "${PACKAGES[@]}"
    success "System packages installed"
else
    success "System packages already installed — skipping"
fi

# ─── NVM + Node.js ────────────────────────────────────────────────────────────
NVM_DIR="/home/$APP_USER/.nvm"

if [[ -s "$NVM_DIR/nvm.sh" ]]; then
    success "nvm already installed at $NVM_DIR — skipping"
else
    info "Installing nvm $NVM_VERSION for user $APP_USER..."
    sudo -u "$APP_USER" bash -c "
        curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/$NVM_VERSION/install.sh | bash
    "
    success "nvm installed"
fi

# Source nvm so we can use it in this script
export NVM_DIR="$NVM_DIR"
# shellcheck disable=SC1090
[[ -s "$NVM_DIR/nvm.sh" ]] && source "$NVM_DIR/nvm.sh"

if node --version 2>/dev/null | grep -q "^v$NODE_VERSION"; then
    success "Node.js $(node --version) already active — skipping"
else
    info "Installing Node.js $NODE_VERSION via nvm..."
    sudo -u "$APP_USER" bash -c "
        export NVM_DIR=\"$NVM_DIR\"
        source \"\$NVM_DIR/nvm.sh\"
        nvm install $NODE_VERSION
        nvm alias default $NODE_VERSION
        nvm use default
    "
    # Re-source to pick up newly installed node
    source "$NVM_DIR/nvm.sh"
    success "Node.js $(node --version) installed"
fi

# ─── PM2 ──────────────────────────────────────────────────────────────────────
if sudo -u "$APP_USER" bash -c "
    export NVM_DIR=\"$NVM_DIR\"
    source \"\$NVM_DIR/nvm.sh\"
    command -v pm2 &>/dev/null
"; then
    PM2_VER=$(sudo -u "$APP_USER" bash -c "
        export NVM_DIR=\"$NVM_DIR\"
        source \"\$NVM_DIR/nvm.sh\"
        pm2 --version
    ")
    success "PM2 $PM2_VER already installed — skipping"
else
    info "Installing PM2 globally..."
    sudo -u "$APP_USER" bash -c "
        export NVM_DIR=\"$NVM_DIR\"
        source \"\$NVM_DIR/nvm.sh\"
        npm install -g pm2
    "
    success "PM2 installed"
fi

# ─── PM2 log directory ────────────────────────────────────────────────────────
if [[ ! -d "$APP_DIR" ]]; then
    mkdir -p "$APP_DIR"
    chown "$APP_USER:$APP_USER" "$APP_DIR"
    success "Created log directory: $APP_DIR"
else
    success "Log directory already exists: $APP_DIR"
fi

# ─── Nginx ────────────────────────────────────────────────────────────────────
if systemctl is-active --quiet nginx; then
    success "Nginx already running — skipping"
else
    info "Enabling and starting Nginx..."
    systemctl enable nginx
    systemctl start nginx
    success "Nginx started"
fi

# Deploy Nginx site config
NGINX_AVAILABLE="/etc/nginx/sites-available/critsend"
NGINX_ENABLED="/etc/nginx/sites-enabled/critsend"

# Remove default site if it exists
[[ -f /etc/nginx/sites-enabled/default ]] && rm -f /etc/nginx/sites-enabled/default && info "Removed default Nginx site"

if [[ ! -f "$NGINX_AVAILABLE" ]]; then
    warn "Nginx site config not yet deployed. After cloning the repo, run:"
    warn "  sudo cp /path/to/repo/deploy/nginx.conf $NGINX_AVAILABLE"
    warn "  sudo sed -i 's/yourdomain.com/YOURDOMAIN/g' $NGINX_AVAILABLE"
    warn "  sudo ln -sf $NGINX_AVAILABLE $NGINX_ENABLED"
    warn "  sudo nginx -t && sudo systemctl reload nginx"
else
    success "Nginx site config already in place"
fi

# ─── Certbot ──────────────────────────────────────────────────────────────────
if command -v certbot &>/dev/null; then
    success "Certbot $(certbot --version 2>&1 | head -1) already installed — skipping"
else
    info "Installing certbot..."
    apt-get install -y -qq certbot python3-certbot-nginx
    success "Certbot installed"
fi

# ─── Firewall (ufw) ───────────────────────────────────────────────────────────
if command -v ufw &>/dev/null; then
    ufw allow 22/tcp  >/dev/null 2>&1 || true
    ufw allow 80/tcp  >/dev/null 2>&1 || true
    ufw allow 443/tcp >/dev/null 2>&1 || true
    ufw --force enable >/dev/null 2>&1 || true
    success "UFW firewall: ports 22, 80, 443 open"
fi

# ─── PM2 startup ──────────────────────────────────────────────────────────────
info "Generating PM2 startup script for $APP_USER..."
PM2_STARTUP=$(sudo -u "$APP_USER" bash -c "
    export NVM_DIR=\"$NVM_DIR\"
    source \"\$NVM_DIR/nvm.sh\"
    pm2 startup systemd -u $APP_USER --hp /home/$APP_USER 2>&1 | tail -1
")
# Run the startup command if it looks like a sudo command
if echo "$PM2_STARTUP" | grep -q "sudo env"; then
    eval "$PM2_STARTUP"
    success "PM2 startup systemd service configured"
else
    success "PM2 startup already configured"
fi

echo ""
echo "============================================================"
echo " Setup complete!"
echo "============================================================"
echo ""
echo " Next steps:"
echo "   1. Clone your repo to /home/$APP_USER/critsend"
echo "   2. Copy .env.example to .env and fill in all values"
echo "   3. Run the deploy script: bash deploy/deploy.sh"
echo "   4. Obtain SSL cert:"
echo "      sudo certbot --nginx -d yourdomain.com"
echo "   5. Save PM2 process list: pm2 save"
echo ""
echo " Docs: see DEPLOY.md in the repository root"
echo ""
