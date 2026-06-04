#!/usr/bin/env bash
#
# Critsend DB server — Step 2: firewall & host security
# ----------------------------------------------------------------------------
# Locks PostgreSQL (5432) and PgBouncer (6432) so they are reachable ONLY from
# the Critsend app server (web/worker/drainer). All other inbound DB traffic is
# denied. The link is over a public IP, so this firewall + TLS (configured in
# the PostgreSQL step) are mandatory, not optional.
#
# Run as root (sudo -i). Idempotent.
#   chmod +x 02-security.sh && ./02-security.sh
# ----------------------------------------------------------------------------
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "ERROR: run as root (sudo -i)." >&2
  exit 1
fi

# Critsend app server (web/worker/drainer) — the ONLY host allowed to reach the DB.
APP_SERVER_IP="37.27.117.222"

echo "==> Configuring UFW firewall (DB reachable only from ${APP_SERVER_IP})..."
ufw --force reset
ufw default deny incoming
ufw default allow outgoing

# Keep SSH reachable. (If you have a fixed admin IP, tighten this to
#   ufw allow from <ADMIN_IP> to any port 22 proto tcp
# instead of the open OpenSSH rule below.)
ufw allow OpenSSH

# PostgreSQL direct (LISTEN/NOTIFY, session connections) — app server only.
ufw allow from "${APP_SERVER_IP}" to any port 5432 proto tcp comment 'PostgreSQL direct - app server only'
# PgBouncer transaction-mode pooler (mirrors Neon's pooled endpoint) — app server only.
ufw allow from "${APP_SERVER_IP}" to any port 6432 proto tcp comment 'PgBouncer pooler - app server only'

ufw --force enable
ufw status verbose

echo "==> Configuring fail2ban (SSH brute-force protection)..."
cat >/etc/fail2ban/jail.local <<'EOF'
[sshd]
enabled  = true
mode     = aggressive
bantime  = 1h
findtime = 10m
maxretry = 5
EOF
systemctl enable --now fail2ban
systemctl restart fail2ban

echo
echo "Step 2 complete. DB ports 5432/6432 reachable only from ${APP_SERVER_IP}."
echo
echo "SSH hardening (do this manually in /etc/ssh/sshd_config, then 'systemctl restart ssh'):"
echo "   PermitRootLogin prohibit-password    # key-only root, or 'no'"
echo "   PasswordAuthentication no            # keys only (ensure your key works first!)"
echo "   Next: paste 'free -h', 'lsblk', 'cat /proc/mdstat' so the DB tuning is sized exactly."
