#!/usr/bin/env bash
#
# Critsend DB server — Step 5: PgBouncer transaction-mode pooler
# ----------------------------------------------------------------------------
# Topology:
#   app (37.27.117.222)  --TLS-->  PgBouncer :6432  --loopback-->  PostgreSQL :5432
#
# - Transaction pooling: many app clients multiplexed onto a small set of real
#   PG connections, leaving headroom under PostgreSQL max_connections=300 for the
#   DIRECT connections the app keeps for LISTEN/NOTIFY and the session store.
# - Auth: scram-sha-256 with SCRAM pass-through via auth_query. A dedicated
#   internal `pgbouncer` lookup role (random password, generated here) reads the
#   stored verifiers through a SECURITY DEFINER function in the `postgres` db, so
#   any app role created LATER (Step 6) works with no PgBouncer config change.
# - TLS: app->PgBouncer crosses the public internet, so client TLS is required
#   (reuses the cert from Step 4). PgBouncer->PG is loopback, no TLS needed.
#
# Run as root (sudo -i). Idempotent.
#   chmod +x 05-install-pgbouncer.sh && ./05-install-pgbouncer.sh
# ----------------------------------------------------------------------------
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "ERROR: run as root (sudo -i)." >&2
  exit 1
fi

PG_MAJOR=17
PG_CONF_DIR="/etc/postgresql/${PG_MAJOR}/main"
TLS_CERT="${PG_CONF_DIR}/server.crt"
TLS_KEY="${PG_CONF_DIR}/server.key"
PGB_DIR="/etc/pgbouncer"
PGB_INI="${PGB_DIR}/pgbouncer.ini"
PGB_USERLIST="${PGB_DIR}/userlist.txt"
PGB_PW_FILE="/root/.pgbouncer_auth_password"   # internal lookup-role password (root-only)

# psql as the postgres superuser over the local peer socket.
psql_super() { runuser -u postgres -- psql -v ON_ERROR_STOP=1 "$@"; }

# ----------------------------------------------------------------------------
# 1. Install PgBouncer (from the PGDG repo added in Step 3 -> recent version
#    with SCRAM pass-through + prepared-statement support in transaction mode).
# ----------------------------------------------------------------------------
echo "==> Installing PgBouncer..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y pgbouncer >/dev/null
echo "    pgbouncer $(pgbouncer --version 2>/dev/null | head -1)"

# Service account PgBouncer runs as (Debian/Ubuntu package default: postgres).
PGB_USER="$(systemctl show -p User --value pgbouncer 2>/dev/null || true)"
PGB_USER="${PGB_USER:-postgres}"

# ----------------------------------------------------------------------------
# 2. Internal lookup role + SECURITY DEFINER auth function (in `postgres` db).
#    The function returns the SCRAM verifier for a given role so PgBouncer can
#    authenticate clients (and pass SCRAM through to the server) without us
#    storing any app password in PgBouncer's config.
# ----------------------------------------------------------------------------
if [[ -s "${PGB_PW_FILE}" ]]; then
  PGB_PW="$(cat "${PGB_PW_FILE}")"
  echo "==> Reusing existing pgbouncer lookup-role password (${PGB_PW_FILE})."
else
  PGB_PW="$(openssl rand -base64 33 | tr -d '/+=' | cut -c1-32)"
  umask 077; printf '%s' "${PGB_PW}" > "${PGB_PW_FILE}"
  echo "==> Generated pgbouncer lookup-role password -> ${PGB_PW_FILE} (root-only)."
fi

echo "==> Creating/refreshing the 'pgbouncer' lookup role and auth function..."
psql_super -d postgres <<SQL
DO \$\$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pgbouncer') THEN
    ALTER ROLE pgbouncer WITH LOGIN PASSWORD '${PGB_PW}';
  ELSE
    CREATE ROLE pgbouncer WITH LOGIN PASSWORD '${PGB_PW}';
  END IF;
END
\$\$;

CREATE OR REPLACE FUNCTION public.pgbouncer_get_auth(p_usename TEXT)
RETURNS TABLE(usename TEXT, passwd TEXT)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog
AS \$\$
  -- Return the SCRAM verifier for a login role. Superusers are excluded so a
  -- compromised lookup role can never fetch a superuser's credentials.
  SELECT usename::text, passwd::text
  FROM pg_shadow
  WHERE usename = p_usename
    AND NOT usesuper;
\$\$;

REVOKE ALL ON FUNCTION public.pgbouncer_get_auth(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pgbouncer_get_auth(TEXT) TO pgbouncer;
SQL

# ----------------------------------------------------------------------------
# 3. userlist.txt — only the lookup role lives here (plaintext, used by
#    PgBouncer to log in to PG as `pgbouncer`). App roles are resolved at
#    runtime via auth_query, so they are NEVER written to disk here.
# ----------------------------------------------------------------------------
echo "==> Writing ${PGB_USERLIST}..."
umask 027
printf '"pgbouncer" "%s"\n' "${PGB_PW}" > "${PGB_USERLIST}"
chown "${PGB_USER}:${PGB_USER}" "${PGB_USERLIST}"
chmod 640 "${PGB_USERLIST}"

# PgBouncer (running as ${PGB_USER}) must be able to read the TLS key.
if [[ -f "${TLS_KEY}" ]]; then
  chgrp "${PGB_USER}" "${TLS_KEY}" 2>/dev/null || true
  chmod 640 "${TLS_KEY}" 2>/dev/null || true
fi

# ----------------------------------------------------------------------------
# 4. pgbouncer.ini
# ----------------------------------------------------------------------------
echo "==> Writing ${PGB_INI}..."
cat > "${PGB_INI}" <<EOF
;; Critsend PgBouncer — managed by 05-install-pgbouncer.sh
[databases]
;; Wildcard: every database name proxies to local PostgreSQL.
* = host=127.0.0.1 port=5432

[pgbouncer]
;; --- Listening (UFW already restricts :6432 to the app server) -------------
listen_addr = *
listen_port = 6432

;; --- Authentication (scram + auth_query pass-through) ----------------------
auth_type = scram-sha-256
auth_file = ${PGB_USERLIST}
auth_user = pgbouncer
auth_dbname = postgres
auth_query = SELECT usename, passwd FROM public.pgbouncer_get_auth(\$1)

;; --- Pooling --------------------------------------------------------------
pool_mode = transaction
max_client_conn = 2000
default_pool_size = 100
;; min_pool_size MUST stay 0 with SCRAM pass-through: pre-warmed server
;; connections are opened before any client handshake, so PgBouncer would have
;; no SCRAM "client key" to authenticate them and every warmup login would fail.
min_pool_size = 0
reserve_pool_size = 25
reserve_pool_timeout = 3
max_db_connections = 250
max_user_connections = 250

;; node-postgres uses unnamed prepared statements; allow named ones too.
max_prepared_statements = 256
ignore_startup_parameters = extra_float_digits

;; --- Connection lifecycle -------------------------------------------------
server_lifetime = 3600
server_idle_timeout = 600
query_wait_timeout = 120
;; Recover quickly after a PostgreSQL restart (default is 15s).
server_login_retry = 2

;; --- TLS: required on the client side (public link); loopback to PG is plain
client_tls_sslmode = require
client_tls_cert_file = ${TLS_CERT}
client_tls_key_file = ${TLS_KEY}
server_tls_sslmode = disable

;; --- Admin console --------------------------------------------------------
admin_users = pgbouncer
stats_users = pgbouncer

logfile = /var/log/pgbouncer/pgbouncer.log
pidfile = /var/run/pgbouncer/pgbouncer.pid
EOF
chown "${PGB_USER}:${PGB_USER}" "${PGB_INI}"
chmod 640 "${PGB_INI}"

mkdir -p /var/log/pgbouncer /var/run/pgbouncer
chown "${PGB_USER}:${PGB_USER}" /var/log/pgbouncer /var/run/pgbouncer

# ----------------------------------------------------------------------------
# 5. Start & enable.
# ----------------------------------------------------------------------------
echo "==> Restarting PgBouncer..."
systemctl enable pgbouncer >/dev/null 2>&1 || true
systemctl restart pgbouncer
sleep 1

# ----------------------------------------------------------------------------
# 6. Verify: admin console (TLS) + end-to-end proxy to the postgres db.
# ----------------------------------------------------------------------------
echo
echo "Step 5 complete. Verification:"
systemctl is-active pgbouncer >/dev/null && echo "  pgbouncer service    : active" \
  || { echo "  pgbouncer service    : NOT active"; journalctl -u pgbouncer --no-pager | tail -15; exit 1; }

echo "  admin console (TLS)  :"
PGPASSWORD="${PGB_PW}" psql "host=127.0.0.1 port=6432 dbname=pgbouncer user=pgbouncer sslmode=require" \
  -tAc "SHOW VERSION;" 2>/dev/null | sed 's/^/    /' || echo "    (admin console check failed)"

echo "  end-to-end proxy     :"
PGPASSWORD="${PGB_PW}" psql "host=127.0.0.1 port=6432 dbname=postgres user=pgbouncer sslmode=require" \
  -tAc "SELECT 'pgbouncer->postgres OK via ' || version();" 2>/dev/null | sed 's/^/    /' \
  || echo "    (proxy check failed)"

echo
echo "  App will connect to:  postgresql://<appuser>@157.180.98.150:6432/<db>?sslmode=require  (pooled, transaction mode)"
echo "  Direct (LISTEN/NOTIFY + session store) stays on :5432."
echo "  Next: 06 — create app role + database, then dump/restore from Neon."
