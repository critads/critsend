#!/usr/bin/env bash
#
# Critsend DB server — Step 1: OS preparation & kernel tuning
# ----------------------------------------------------------------------------
# Target host : Hetzner AX162-R (AMD EPYC 9454P, 48c/96t, 256GB DDR5 ECC, NVMe Gen4)
# OS          : Ubuntu 24.04 LTS
# Run as      : root  (sudo -i)   — idempotent, safe to re-run
#
#   chmod +x 01-os-prep.sh && ./01-os-prep.sh
#
# What it does:
#   - installs base ops/monitoring packages + time sync (chrony)
#   - applies kernel/VM sysctl tuning for a dedicated PostgreSQL host
#   - disables Transparent Huge Pages (THP) via a systemd unit
#
# NOTE: explicit huge pages (for shared_buffers) are configured LATER, in the
# PostgreSQL tuning step, because their size depends on the final shared_buffers
# value. This step only disables THP, which PostgreSQL recommends.
# ----------------------------------------------------------------------------
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "ERROR: run as root (sudo -i)." >&2
  exit 1
fi

echo "==> Installing base packages..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y --no-install-recommends \
  ca-certificates curl gnupg lsb-release \
  chrony ufw fail2ban \
  numactl htop sysstat iotop nvme-cli ncdu

echo "==> Enabling time synchronization (chrony)..."
systemctl enable --now chrony

echo "==> Applying kernel / VM sysctl tuning..."
cat >/etc/sysctl.d/30-postgresql.conf <<'EOF'
# ---- Memory / paging: keep the DB resident, avoid swapping hot pages ----
vm.swappiness = 1
# Prevent the OOM-killer from killing postgres: account committed memory
# strictly. Pair with a modest swap (8-16GB) so allocation spikes never fail.
vm.overcommit_memory = 2
vm.overcommit_ratio = 80

# ---- Dirty page writeback: flush early/often on fast NVMe to smooth
#      checkpoints and avoid a big fsync stall at checkpoint time ----
vm.dirty_background_bytes = 67108864    # 64MB
vm.dirty_bytes = 536870912              # 512MB

# ---- Shared memory ceilings (generous headroom; Postgres mmaps most of it) ----
kernel.shmmax = 140737488355328
kernel.shmall = 34359738368

# ---- Network: high concurrent client connections ----
net.core.somaxconn = 4096
net.ipv4.tcp_max_syn_backlog = 4096
net.core.netdev_max_backlog = 5000
net.ipv4.tcp_keepalive_time = 120
net.ipv4.tcp_keepalive_intvl = 30
net.ipv4.tcp_keepalive_probes = 6
EOF
sysctl --system >/dev/null

echo "==> Disabling Transparent Huge Pages (THP)..."
cat >/etc/systemd/system/disable-thp.service <<'EOF'
[Unit]
Description=Disable Transparent Huge Pages (THP) for PostgreSQL
DefaultDependencies=no
After=sysinit.target local-fs.target
Before=postgresql.service

[Service]
Type=oneshot
ExecStart=/bin/sh -c 'echo never > /sys/kernel/mm/transparent_hugepage/enabled'
ExecStart=/bin/sh -c 'echo never > /sys/kernel/mm/transparent_hugepage/defrag'
RemainAfterExit=yes

[Install]
WantedBy=basic.target
EOF
systemctl daemon-reload
systemctl enable --now disable-thp.service

echo
echo "Step 1 complete."
echo "  THP enabled flag : $(cat /sys/kernel/mm/transparent_hugepage/enabled)"
echo "  swappiness       : $(cat /proc/sys/vm/swappiness)"
echo "  Next: review/adjust swap (recommend 8-16GB), then run 02-security.sh"
