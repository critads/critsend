#!/usr/bin/env bash
#
# Critsend DB server — Step 4: PostgreSQL tuning, TLS, huge pages, pg_hba
# ----------------------------------------------------------------------------
# Sized for: AMD EPYC 9454 (48c/96t) + 256GB ECC RAM + NVMe Gen4 RAID1.
# Replaces the Neon Launch instance; mirrors its transaction-pooled topology
# (PgBouncer is configured separately in the next step).
#
# Run as root (idempotent, safe to re-run).
#   chmod +x 04-configure-postgres.sh && ./04-configure-postgres.sh
#
# What it does:
#   1. generates a self-signed TLS cert (the public-IP link MUST be encrypted)
#   2. writes a tuned drop-in config to conf.d/critsend.conf
#   3. opens pg_hba to the app server over TLS only (scram-sha-256)
#   4. computes + reserves huge pages for the 64GB shared_buffers
#   5. restarts PostgreSQL and verifies
# ----------------------------------------------------------------------------
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "ERROR: run as root." >&2
  exit 1
fi

PG_MAJOR=17
CONF_DIR="/etc/postgresql/${PG_MAJOR}/main"
CONF_MAIN="${CONF_DIR}/postgresql.conf"
CONF_DROPIN_DIR="${CONF_DIR}/conf.d"
CONF_DROPIN="${CONF_DROPIN_DIR}/critsend.conf"
HBA="${CONF_DIR}/pg_hba.conf"
DATADIR="/var/lib/postgresql/${PG_MAJOR}/main"

# Network identity (firewall already restricts inbound to this app server).
APP_SERVER_IP="37.27.117.222"
DB_PUBLIC_IP="157.180.98.150"
DB_HOSTNAME="critsend-db"

CRT="${CONF_DIR}/server.crt"
KEY="${CONF_DIR}/server.key"

# ----------------------------------------------------------------------------
# 1. TLS certificate (self-signed). Generated once; re-runs reuse it.
#    Copy server.crt to the app server as the CA root if you later switch the
#    client to sslmode=verify-full (recommended). sslmode=require works now.
# ----------------------------------------------------------------------------
if [[ -f "${CRT}" && -f "${KEY}" ]]; then
  echo "==> TLS certificate already present — keeping it."
else
  echo "==> Generating self-signed TLS certificate (10y)..."
  openssl req -new -x509 -days 3650 -nodes \
    -out "${CRT}" -keyout "${KEY}" \
    -subj "/CN=${DB_HOSTNAME}" \
    -addext "subjectAltName=IP:${DB_PUBLIC_IP},DNS:${DB_HOSTNAME}"
fi
chown postgres:postgres "${CRT}" "${KEY}"
chmod 600 "${KEY}"
chmod 644 "${CRT}"

# ----------------------------------------------------------------------------
# 2. Tuned drop-in config.
# ----------------------------------------------------------------------------
echo "==> Writing tuned config to ${CONF_DROPIN}..."
mkdir -p "${CONF_DROPIN_DIR}"
cat > "${CONF_DROPIN}" <<EOF
# ============================================================================
# Critsend tuned config — managed by 04-configure-postgres.sh. Do not edit by
# hand; re-run the script to regenerate. Sized for 48c/96t + 256GB + NVMe RAID1.
# ============================================================================

# ---- Connections -----------------------------------------------------------
listen_addresses = '*'              # firewall restricts source to app server
max_connections = 300               # direct path + PgBouncer server conns + headroom
superuser_reserved_connections = 5
password_encryption = scram-sha-256

# keepalives so dead app-side connections over the public link are reaped
tcp_keepalives_idle = 60
tcp_keepalives_interval = 15
tcp_keepalives_count = 4

# ---- Memory ----------------------------------------------------------------
shared_buffers = 64GB               # ~25% RAM; backed by huge pages (below)
effective_cache_size = 192GB        # ~75% RAM; planner hint, not an allocation
maintenance_work_mem = 2GB
autovacuum_work_mem = 1GB
work_mem = 32MB                     # per sort/hash node x backend; conservative
                                    # for 300 conns. Heavy analytics can raise it
                                    # per-session with SET work_mem.
huge_pages = try                    # use reserved huge pages, fall back if short

# ---- Parallelism (48 cores / 96 threads) -----------------------------------
max_worker_processes = 96
max_parallel_workers = 48
max_parallel_workers_per_gather = 4
max_parallel_maintenance_workers = 4

# ---- WAL / checkpoints (COPY-heavy CSV imports) ----------------------------
wal_level = replica                 # supports physical backups / pgBackRest
wal_compression = on
wal_buffers = 64MB
min_wal_size = 2GB
max_wal_size = 32GB                 # fewer checkpoints during big imports
checkpoint_completion_target = 0.9
checkpoint_timeout = 15min

# ---- Planner / IO (NVMe Gen4) ----------------------------------------------
random_page_cost = 1.1
effective_io_concurrency = 200
maintenance_io_concurrency = 200
default_statistics_target = 100

# ---- Autovacuum (aggressive for the ~89M-row campaign_sends) ---------------
autovacuum = on
autovacuum_max_workers = 6
autovacuum_naptime = 10s
autovacuum_vacuum_scale_factor = 0.05
autovacuum_analyze_scale_factor = 0.02
autovacuum_vacuum_cost_limit = 2000
autovacuum_vacuum_cost_delay = 2ms

# ---- TLS -------------------------------------------------------------------
ssl = on
ssl_cert_file = '${CRT}'
ssl_key_file = '${KEY}'
ssl_min_protocol_version = 'TLSv1.2'

# ---- Extensions ------------------------------------------------------------
shared_preload_libraries = 'pg_stat_statements'
pg_stat_statements.max = 10000
pg_stat_statements.track = top

# ---- Logging / observability -----------------------------------------------
logging_collector = on
log_directory = 'log'
log_filename = 'postgresql-%a.log'
log_truncate_on_rotation = on
log_rotation_age = 1d
log_line_prefix = '%m [%p] %q%u@%d '
log_checkpoints = on
log_lock_waits = on
log_temp_files = 0
log_autovacuum_min_duration = 0
log_min_duration_statement = 1000   # log statements slower than 1s
track_io_timing = on

# ---- Time ------------------------------------------------------------------
timezone = 'UTC'
log_timezone = 'UTC'
EOF

# Make sure the drop-in directory is actually included.
mkdir -p "${CONF_DROPIN_DIR}"
if ! grep -qE "^[[:space:]]*include_dir[[:space:]]*=[[:space:]]*'conf.d'" "${CONF_MAIN}"; then
  echo "include_dir = 'conf.d'" >> "${CONF_MAIN}"
fi

# ----------------------------------------------------------------------------
# 3. pg_hba.conf — app server over TLS only + loopback (for PgBouncer).
#    Appended as a marked, idempotent block.
# ----------------------------------------------------------------------------
echo "==> Configuring pg_hba.conf (app server over TLS, scram-sha-256)..."
# Replace (not just append) any prior managed block so re-runs pick up changes
# such as a new APP_SERVER_IP.
sed -i '/# >>> critsend-managed >>>/,/# <<< critsend-managed <<</d' "${HBA}"
# Drop a trailing blank line left by the deletion, then append a fresh block.
sed -i -e :a -e '/^\n*$/{$d;N;ba}' "${HBA}"
cat >> "${HBA}" <<EOF

# >>> critsend-managed >>>
# Critsend app server — TLS required (non-SSL attempts won't match -> denied).
hostssl  all  all  ${APP_SERVER_IP}/32   scram-sha-256
# Loopback — PgBouncer (same host) connects to PostgreSQL here.
host     all  all  127.0.0.1/32          scram-sha-256
host     all  all  ::1/128               scram-sha-256
# <<< critsend-managed <<<
EOF

# ----------------------------------------------------------------------------
# 4. Huge pages: compute the exact requirement for 64GB shared_buffers, reserve
#    them, then restart so PostgreSQL maps shared memory onto huge pages.
# ----------------------------------------------------------------------------
# Allow the postmaster to lock the huge-page-backed shared memory. The default
# systemd LimitMEMLOCK (8MB) is far below the ~64GB needed, so without this PG
# silently falls back to 4KB pages even when huge pages are reserved.
echo "==> Raising LimitMEMLOCK for the PostgreSQL service (huge pages need it)..."
mkdir -p "/etc/systemd/system/postgresql@${PG_MAJOR}-main.service.d"
cat > "/etc/systemd/system/postgresql@${PG_MAJOR}-main.service.d/override.conf" <<EOF
[Service]
LimitMEMLOCK=infinity
EOF
systemctl daemon-reload

echo "==> Applying config (first restart, normal pages)..."
systemctl restart "postgresql@${PG_MAJOR}-main"

NEEDED="$(runuser -u postgres -- psql -tAc 'SHOW shared_memory_size_in_huge_pages;' | tr -d '[:space:]')"
if [[ -n "${NEEDED}" && "${NEEDED}" =~ ^[0-9]+$ ]]; then
  RESERVE=$(( NEEDED + 256 ))     # small margin
  echo "==> Reserving ${RESERVE} huge pages (need ${NEEDED} for 64GB shared_buffers)..."
  cat > /etc/sysctl.d/31-postgresql-hugepages.conf <<EOF
# Huge pages for PostgreSQL shared_buffers (64GB). Managed by 04-configure-postgres.sh.
vm.nr_hugepages = ${RESERVE}
EOF
  sysctl --system >/dev/null
  echo "==> Restarting so PostgreSQL uses huge pages..."
  systemctl restart "postgresql@${PG_MAJOR}-main"
else
  echo "WARN: could not determine huge page requirement (got '${NEEDED}'); leaving huge_pages=try with no reservation." >&2
fi

# ----------------------------------------------------------------------------
# 5. Verify.
# ----------------------------------------------------------------------------
echo
echo "Step 4 complete. Verification:"
echo "  shared_buffers       : $(runuser -u postgres -- psql -tAc 'SHOW shared_buffers;' | tr -d '[:space:]')"
echo "  effective_cache_size : $(runuser -u postgres -- psql -tAc 'SHOW effective_cache_size;' | tr -d '[:space:]')"
echo "  max_connections      : $(runuser -u postgres -- psql -tAc 'SHOW max_connections;' | tr -d '[:space:]')"
echo "  ssl                  : $(runuser -u postgres -- psql -tAc 'SHOW ssl;' | tr -d '[:space:]')"
echo "  huge_pages           : $(runuser -u postgres -- psql -tAc 'SHOW huge_pages;' | tr -d '[:space:]')"
echo "  HugePages (meminfo)  : $(grep -E 'HugePages_Total|HugePages_Free' /proc/meminfo | tr '\n' ' ')"
echo
echo "  If HugePages_Free is much lower than HugePages_Total, huge pages are in use (good)."
echo "  Next: 05 — PgBouncer (transaction pooler on :6432), then roles/db + dump-restore."
