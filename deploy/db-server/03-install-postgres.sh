#!/usr/bin/env bash
#
# Critsend DB server — Step 3: install PostgreSQL 17 (PGDG) with checksums
# ----------------------------------------------------------------------------
# Target host : Hetzner AX162-R (AMD EPYC 9454, 48c/96t, 256GB ECC, NVMe RAID1)
# OS          : Ubuntu 24.04 LTS (noble)
# Run as      : root  (idempotent, safe to re-run)
#
#   chmod +x 03-install-postgres.sh && ./03-install-postgres.sh
#
# What it does:
#   - adds the official PostgreSQL APT repository (PGDG)
#   - installs PostgreSQL 17 (server + client)
#   - generates the en_US.UTF-8 locale (used for the cluster default collation)
#   - recreates the default 'main' cluster WITH data checksums enabled
#     (checksums can only be turned on at initdb time; they detect silent
#      disk corruption — essential for a production DB)
#
# The data directory stays at the Debian default /var/lib/postgresql/17/main,
# which lives on the md2 RAID1 mirror (the 1.8T ext4 root) — no relocation
# needed. Tuning + TLS are applied next, in 04-configure-postgres.sh.
# ----------------------------------------------------------------------------
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "ERROR: run as root." >&2
  exit 1
fi

PG_MAJOR=17
DATADIR="/var/lib/postgresql/${PG_MAJOR}/main"
CLUSTER_LOCALE="en_US.UTF-8"

echo "==> Adding PostgreSQL APT repository (PGDG)..."
export DEBIAN_FRONTEND=noninteractive
install -d /usr/share/postgresql-common/pgdg
curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
  -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
. /etc/os-release
echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main" \
  > /etc/apt/sources.list.d/pgdg.list

echo "==> Generating ${CLUSTER_LOCALE} locale..."
locale-gen "${CLUSTER_LOCALE}" >/dev/null

echo "==> Installing PostgreSQL ${PG_MAJOR}..."
apt-get update -y
apt-get install -y postgresql-${PG_MAJOR} postgresql-client-${PG_MAJOR}

# ----------------------------------------------------------------------------
# Ensure the 'main' cluster has data checksums enabled.
#
# The package auto-creates 'main' WITHOUT checksums. We can only enable them at
# initdb time, so if checksums are off we drop and recreate the cluster.
#
# SAFETY: this is gated on the checksum flag. A fresh install has checksums OFF
# (so we recreate). Once this script has run, checksums are ON, so re-running is
# a no-op and CANNOT wipe a cluster that already holds restored data.
# ----------------------------------------------------------------------------
checksums_enabled() {
  # pg_controldata prints "Data page checksum version: N" — N>=1 means enabled.
  /usr/lib/postgresql/${PG_MAJOR}/bin/pg_controldata "${DATADIR}" 2>/dev/null \
    | awk -F: '/Data page checksum version/ {gsub(/ /,"",$2); print $2}'
}

if pg_lsclusters -h 2>/dev/null | awk '{print $1, $2}' | grep -q "^${PG_MAJOR} main$"; then
  CSUM="$(checksums_enabled || echo 0)"
  if [[ "${CSUM:-0}" -ge 1 ]]; then
    echo "==> Cluster ${PG_MAJOR}/main already has data checksums — skipping recreation."
  else
    # SAFETY INTERLOCK: only recreate if the cluster holds NO user data.
    # A fresh package-created cluster has just template0/template1/postgres.
    # If it has any user database (e.g. data was already restored), we refuse
    # to drop it — fail closed rather than risk destroying data.
    pg_ctlcluster ${PG_MAJOR} main start 2>/dev/null \
      || systemctl start "postgresql@${PG_MAJOR}-main" 2>/dev/null || true
    USERDBS="$(runuser -u postgres -- psql -tAc \
      "SELECT count(*) FROM pg_database WHERE datistemplate = false AND datname <> 'postgres';" \
      2>/dev/null | tr -d '[:space:]')"
    if [[ "${USERDBS:-0}" != "0" ]]; then
      echo "ERROR: cluster ${PG_MAJOR}/main has ${USERDBS} user database(s) but checksums are OFF." >&2
      echo "       Refusing to drop it — that would destroy data. If you truly intend to" >&2
      echo "       rebuild it with checksums, back up and remove the cluster manually first." >&2
      exit 1
    fi
    echo "==> Recreating cluster ${PG_MAJOR}/main WITH data checksums (fresh cluster, no user data)..."
    pg_dropcluster --stop ${PG_MAJOR} main
    pg_createcluster ${PG_MAJOR} main -- \
      --data-checksums --encoding=UTF8 --locale="${CLUSTER_LOCALE}"
  fi
else
  echo "==> Creating cluster ${PG_MAJOR}/main WITH data checksums..."
  pg_createcluster ${PG_MAJOR} main -- \
    --data-checksums --encoding=UTF8 --locale="${CLUSTER_LOCALE}"
fi

echo "==> Enabling and starting PostgreSQL..."
systemctl enable postgresql >/dev/null 2>&1 || true
pg_ctlcluster ${PG_MAJOR} main start 2>/dev/null || systemctl start "postgresql@${PG_MAJOR}-main"

echo
echo "Step 3 complete."
echo "  Version          : $(runuser -u postgres -- psql -tAc 'SHOW server_version;' 2>/dev/null | tr -d '[:space:]')"
echo "  Data checksums   : $(runuser -u postgres -- psql -tAc 'SHOW data_checksums;' 2>/dev/null | tr -d '[:space:]')"
echo "  Data directory   : ${DATADIR}"
echo "  On filesystem    : $(df -hT --output=source,fstype,size,avail "${DATADIR}" | tail -1)"
echo "  Config directory : /etc/postgresql/${PG_MAJOR}/main"
echo "  Next: run 04-configure-postgres.sh (tuning + TLS + huge pages)."
