#!/usr/bin/env bash
#
# Critsend DB server — Step 6: create the application role + database
# ----------------------------------------------------------------------------
# This is a SAFE, no-downtime, idempotent prep step. It does NOT touch the
# running production app or Neon. It only provisions an empty target on the new
# server so Step 7 (the maintenance-window dump/restore from Neon) has somewhere
# to land.
#
# Design decisions (see replit.md):
#   - The app issues its own DDL at runtime: CREATE EXTENSION IF NOT EXISTS
#     pg_trgm (campaign/subscriber/mta repos), CREATE INDEX CONCURRENTLY for the
#     GIN trigram indexes, bootstrap migrations, and `drizzle-kit push` on deploy.
#     => the app role MUST OWN the database (and thus every object it creates).
#   - It does NOT need to be a superuser: pg_trgm is a TRUSTED extension, which
#     any role with CREATE on the database may install. The only NON-trusted
#     piece is pg_stat_statements, which we pre-create here as `postgres`.
#   - public-schema ownership is handed to the app role so the restore (run AS
#     the app role in Step 7) can create objects in public on PG15+.
#
# Names are overridable via env, but the defaults match what the app will use:
#   APP_DB_ROLE (default: critsend)   APP_DB_NAME (default: critsend)
#
# Run as root (sudo -i). Idempotent — safe to re-run.
#   chmod +x 06-create-app-role-and-db.sh && ./06-create-app-role-and-db.sh
# ----------------------------------------------------------------------------
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "ERROR: run as root (sudo -i)." >&2
  exit 1
fi

APP_DB_ROLE="${APP_DB_ROLE:-critsend}"
APP_DB_NAME="${APP_DB_NAME:-critsend}"
APP_PW_FILE="/root/.critsend_db_password"   # app-role password (root-only)

# Reject anything that isn't a plain identifier (defence-in-depth: these values
# are interpolated into SQL/DDL that can't be parameterised).
if [[ ! "${APP_DB_ROLE}" =~ ^[a-z_][a-z0-9_]*$ ]]; then
  echo "ERROR: invalid APP_DB_ROLE '${APP_DB_ROLE}' (use lower_snake_case)." >&2
  exit 1
fi
if [[ ! "${APP_DB_NAME}" =~ ^[a-z_][a-z0-9_]*$ ]]; then
  echo "ERROR: invalid APP_DB_NAME '${APP_DB_NAME}' (use lower_snake_case)." >&2
  exit 1
fi

# psql as the postgres superuser over the local peer socket.
psql_super() { runuser -u postgres -- psql -v ON_ERROR_STOP=1 "$@"; }

# ----------------------------------------------------------------------------
# 1. App-role password: reuse if present, else generate (root-only file).
# ----------------------------------------------------------------------------
if [[ -s "${APP_PW_FILE}" ]]; then
  APP_PW="$(cat "${APP_PW_FILE}")"
  echo "==> Reusing existing app-role password (${APP_PW_FILE})."
else
  APP_PW="$(openssl rand -base64 33 | tr -d '/+=' | cut -c1-32)"
  umask 077; printf '%s' "${APP_PW}" > "${APP_PW_FILE}"
  echo "==> Generated app-role password -> ${APP_PW_FILE} (root-only)."
fi

# ----------------------------------------------------------------------------
# 2. Create/refresh the login role (NOT a superuser).
# ----------------------------------------------------------------------------
echo "==> Creating/refreshing role '${APP_DB_ROLE}'..."
psql_super -d postgres <<SQL
DO \$\$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_DB_ROLE}') THEN
    ALTER ROLE ${APP_DB_ROLE} WITH LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB PASSWORD '${APP_PW}';
  ELSE
    CREATE ROLE ${APP_DB_ROLE} WITH LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB PASSWORD '${APP_PW}';
  END IF;
END
\$\$;
SQL

# ----------------------------------------------------------------------------
# 3. Create the database owned by the app role (CREATE DATABASE can't run in a
#    DO block, so guard it from the shell).
# ----------------------------------------------------------------------------
if [[ "$(psql_super -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '${APP_DB_NAME}'")" == "1" ]]; then
  echo "==> Database '${APP_DB_NAME}' already exists; ensuring owner is '${APP_DB_ROLE}'."
  psql_super -d postgres -c "ALTER DATABASE ${APP_DB_NAME} OWNER TO ${APP_DB_ROLE};"
else
  echo "==> Creating database '${APP_DB_NAME}' owned by '${APP_DB_ROLE}'..."
  runuser -u postgres -- createdb -O "${APP_DB_ROLE}" "${APP_DB_NAME}"
fi

# ----------------------------------------------------------------------------
# 4. In the new database: hand public schema to the app role + pre-create the
#    extensions. pg_stat_statements is NON-trusted (needs superuser, done here);
#    pg_trgm is created now too so the restore never has to.
# ----------------------------------------------------------------------------
echo "==> Configuring public schema + extensions in '${APP_DB_NAME}'..."
psql_super -d "${APP_DB_NAME}" <<SQL
ALTER SCHEMA public OWNER TO ${APP_DB_ROLE};
GRANT ALL ON SCHEMA public TO ${APP_DB_ROLE};
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
SQL

# ----------------------------------------------------------------------------
# 5. Verification — prove the app role can reach the new DB THROUGH PgBouncer
#    (validates SCRAM pass-through for the new role) and can run DDL.
# ----------------------------------------------------------------------------
echo
echo "Step 6 complete. Verification:"
echo "  role / database      : ${APP_DB_ROLE} / ${APP_DB_NAME}"
echo -n "  owner check          : "
psql_super -d postgres -tAc \
  "SELECT 'db owner = ' || pg_catalog.pg_get_userbyid(datdba) FROM pg_database WHERE datname='${APP_DB_NAME}'"
echo -n "  extensions present   : "
psql_super -d "${APP_DB_NAME}" -tAc \
  "SELECT string_agg(extname, ', ' ORDER BY extname) FROM pg_extension WHERE extname IN ('pg_trgm','pg_stat_statements')"

echo "  login via PgBouncer  :"
APP_URI="host=127.0.0.1 port=6432 dbname=${APP_DB_NAME} user=${APP_DB_ROLE} password=${APP_PW} sslmode=require"
if runuser -u postgres -- psql "${APP_URI}" -v ON_ERROR_STOP=1 -tAc \
     "SELECT '    ok: ' || current_user || '@' || current_database()" 2>/dev/null; then
  echo "  DDL permission check :"
  runuser -u postgres -- psql "${APP_URI}" -v ON_ERROR_STOP=1 -qc \
    "CREATE TABLE _migration_perm_check(x int); DROP TABLE _migration_perm_check;" \
    && echo "    ok: app role can CREATE/DROP in public"
else
  echo "    FAILED to log in through PgBouncer (:6432) as ${APP_DB_ROLE}." >&2
  echo "    Check: PgBouncer running (Step 5), pg_hba allows the role, password file." >&2
  exit 1
fi

echo
echo "  App connection strings to use at cutover (Step 8):"
echo "    Pooled (transaction mode, most of the app):"
echo "      postgresql://${APP_DB_ROLE}:<pw>@157.180.98.150:6432/${APP_DB_NAME}?sslmode=require"
echo "    Direct (:5432 — LISTEN/NOTIFY, session store, import pool):"
echo "      postgresql://${APP_DB_ROLE}:<pw>@157.180.98.150:5432/${APP_DB_NAME}?sslmode=require"
echo "    Password is in ${APP_PW_FILE} (cat it when wiring env vars)."
echo
echo "  Next: 07 — maintenance-window dump/restore from Neon into '${APP_DB_NAME}'."
