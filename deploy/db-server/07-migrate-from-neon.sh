#!/usr/bin/env bash
#
# Critsend DB server — Step 7: maintenance-window dump/restore from Neon
# ----------------------------------------------------------------------------
# THIS IS THE DOWNTIME STEP. Before running it you MUST stop the app on the app
# server (37.27.117.222) so no new writes land on Neon while we copy:
#
#     pm2 stop all          # run on the APP server, NOT here
#
# Then run THIS script on the DB SERVER, inside tmux/screen (it is long-running
# and must survive an SSH disconnect):
#
#     tmux new -s migrate
#     cd /opt/critsend/deploy/db-server && ./07-migrate-from-neon.sh
#
# What it does:
#   1. Pre-flight: checks tool versions, source (Neon) + target (local) reachability,
#      and that the target `critsend` DB is still empty.
#   2. Applies temporary "bulk load" tuning to the LOCAL server (reverted on exit
#      via a trap, even if the script fails).
#   3. Parallel directory-format dump from Neon's DIRECT endpoint.
#   4. Parallel restore into `critsend`, run AS the `critsend` role so it owns
#      every object. EXTENSION entries are filtered out (pre-created in Step 6).
#   5. Reverts tuning, runs ANALYZE, and prints a per-table row-count comparison
#      (source vs target) so you can confirm the copy is complete.
#
# Idempotent-ish: to re-run after a failure, set RESET_TARGET=yes to wipe and
# recreate the (empty) schema first.
#
# Tunables (env): DUMP_JOBS (4), RESTORE_JOBS (8), MIGRATION_DIR
#                 (/var/lib/critsend-migration), SKIP_VERIFY (no), RESET_TARGET (no)
#
# Run as root (sudo -i).
# ----------------------------------------------------------------------------
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "ERROR: run as root (sudo -i)." >&2
  exit 1
fi

APP_DB_ROLE="${APP_DB_ROLE:-critsend}"
APP_DB_NAME="${APP_DB_NAME:-critsend}"
APP_PW_FILE="/root/.critsend_db_password"
DUMP_JOBS="${DUMP_JOBS:-4}"          # parallel connections to Neon (keep modest)
RESTORE_JOBS="${RESTORE_JOBS:-8}"    # parallel restore workers (local, 48 cores)
MIGRATION_DIR="${MIGRATION_DIR:-/var/lib/critsend-migration}"
DUMP_DIR="${MIGRATION_DIR}/dump"
LOG_DIR="${MIGRATION_DIR}/logs"
SKIP_VERIFY="${SKIP_VERIFY:-no}"
RESET_TARGET="${RESET_TARGET:-no}"

if [[ ! -s "${APP_PW_FILE}" ]]; then
  echo "ERROR: ${APP_PW_FILE} missing — run 06-create-app-role-and-db.sh first." >&2
  exit 1
fi
APP_PW="$(cat "${APP_PW_FILE}")"

# Local connection AS the app role over loopback (no TLS needed on loopback).
TARGET_CONN="host=127.0.0.1 port=5432 dbname=${APP_DB_NAME} user=${APP_DB_ROLE} sslmode=disable"
psql_super() { runuser -u postgres -- psql -v ON_ERROR_STOP=1 "$@"; }
psql_app()   { PGPASSWORD="${APP_PW}" psql -v ON_ERROR_STOP=1 "${TARGET_CONN}" "$@"; }

# ----------------------------------------------------------------------------
# 0. Get the Neon DIRECT connection string (never the -pooler host).
# ----------------------------------------------------------------------------
if [[ -z "${NEON_URL:-}" ]]; then
  echo "Paste the Neon DIRECT (non-pooled) connection string."
  echo "  -> It must contain the plain host, NOT the '-pooler' host, and sslmode=require."
  read -rsp "Neon URL: " NEON_URL; echo
fi
if [[ -z "${NEON_URL}" ]]; then echo "ERROR: empty Neon URL." >&2; exit 1; fi
if [[ "${NEON_URL}" == *"-pooler"* ]]; then
  echo "ERROR: that is the POOLED endpoint (-pooler). pg_dump needs the DIRECT host." >&2
  exit 1
fi
if [[ "${NEON_URL}" != *"sslmode="* ]]; then
  echo "WARNING: no sslmode= in the URL; Neon requires SSL. Appending sslmode=require."
  case "${NEON_URL}" in *\?*) NEON_URL="${NEON_URL}&sslmode=require";; *) NEON_URL="${NEON_URL}?sslmode=require";; esac
fi

# ----------------------------------------------------------------------------
# 1. Pre-flight checks (fail fast, BEFORE the long copy).
# ----------------------------------------------------------------------------
echo "==> Pre-flight checks..."
echo -n "    pg_dump version     : "; pg_dump --version
echo -n "    source (Neon)       : "; psql "${NEON_URL}" -tAc "select 'OK ' || version()" | cut -c1-60
echo -n "    target (local)      : "; psql_app -tAc "select 'OK ' || current_user || '@' || current_database()"

# Count USER objects in public (relations of every kind + routines), EXCLUDING
# the objects the extensions created in Step 6 (pg_depend deptype 'e'). A leftover
# from a half-finished restore would otherwise collide silently.
EMPTY_CHECK_SQL="SELECT
  (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S','f')
     AND NOT EXISTS (SELECT 1 FROM pg_depend d
        WHERE d.classid='pg_class'::regclass AND d.objid=c.oid AND d.deptype='e'))
+ (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public'
     AND NOT EXISTS (SELECT 1 FROM pg_depend d
        WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e'))"
EXISTING_OBJS="$(psql_app -tAc "${EMPTY_CHECK_SQL}")"
if [[ "${EXISTING_OBJS}" != "0" ]]; then
  if [[ "${RESET_TARGET}" == "yes" ]]; then
    echo "==> RESET_TARGET=yes -> wiping ${EXISTING_OBJS} existing user object(s) in public..."
    psql_super -d "${APP_DB_NAME}" <<SQL
DROP SCHEMA public CASCADE;
CREATE SCHEMA public;
ALTER SCHEMA public OWNER TO ${APP_DB_ROLE};
GRANT ALL ON SCHEMA public TO ${APP_DB_ROLE};
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
SQL
  else
    echo "ERROR: target public schema is NOT empty (${EXISTING_OBJS} user object(s))." >&2
    echo "       Re-run with RESET_TARGET=yes to wipe and retry." >&2
    exit 1
  fi
fi

# ----------------------------------------------------------------------------
# 2. Temporary bulk-load tuning on the LOCAL server. Reverted on exit by trap
#    so a crash can never leave production with autovacuum/synchronous_commit off.
# ----------------------------------------------------------------------------
TUNING_APPLIED=0
# Returns 0 only if the production-critical settings (autovacuum, synchronous_commit)
# are verified back ON. On any doubt it shouts loudly and returns non-zero so the
# caller can hard-stop — leaving prod with autovacuum/synchronous_commit off would
# be far worse than aborting the migration.
revert_tuning() {
  [[ "${TUNING_APPLIED}" == "1" ]] || return 0
  echo "==> Reverting bulk-load tuning..."
  psql_super -d postgres >/dev/null <<'SQL' || true
ALTER SYSTEM RESET maintenance_work_mem;
ALTER SYSTEM RESET max_wal_size;
ALTER SYSTEM RESET checkpoint_timeout;
ALTER SYSTEM RESET synchronous_commit;
ALTER SYSTEM RESET autovacuum;
SELECT pg_reload_conf();
SQL
  local av sc
  av="$(psql_super -d postgres -tAc 'SHOW autovacuum' 2>/dev/null || echo unknown)"
  sc="$(psql_super -d postgres -tAc 'SHOW synchronous_commit' 2>/dev/null || echo unknown)"
  if [[ "${av}" != "on" || "${sc}" == "off" || "${sc}" == "unknown" ]]; then
    echo "*** CRITICAL: tuning revert did NOT take effect (autovacuum=${av}, synchronous_commit=${sc})." >&2
    echo "*** Production is in an UNSAFE state. Fix immediately as the postgres user:" >&2
    echo "***   ALTER SYSTEM RESET autovacuum; ALTER SYSTEM RESET synchronous_commit; SELECT pg_reload_conf();" >&2
    return 1
  fi
  TUNING_APPLIED=0
  echo "    tuning reverted (autovacuum=${av}, synchronous_commit=${sc})."
}
# Safety net for crash paths; the main flow reverts explicitly and hard-gates on it.
trap 'revert_tuning || true' EXIT

echo "==> Applying bulk-load tuning (reload only, no restart)..."
psql_super -d postgres >/dev/null <<'SQL'
ALTER SYSTEM SET maintenance_work_mem = '4GB';
ALTER SYSTEM SET max_wal_size = '32GB';
ALTER SYSTEM SET checkpoint_timeout = '30min';
ALTER SYSTEM SET synchronous_commit = 'off';
ALTER SYSTEM SET autovacuum = 'off';
SELECT pg_reload_conf();
SQL
TUNING_APPLIED=1

# ----------------------------------------------------------------------------
# 3. Parallel dump from Neon (directory format).
# ----------------------------------------------------------------------------
mkdir -p "${LOG_DIR}"
rm -rf "${DUMP_DIR}"
echo "==> Dumping from Neon -> ${DUMP_DIR} (jobs=${DUMP_JOBS}); this is the long part..."
date +"    start: %F %T"
pg_dump -d "${NEON_URL}" \
  --format=directory --jobs="${DUMP_JOBS}" \
  --no-owner --no-privileges \
  --verbose \
  --file="${DUMP_DIR}" 2> "${LOG_DIR}/dump.log"
date +"    done : %F %T"
echo "    dump size: $(du -sh "${DUMP_DIR}" | cut -f1)   (log: ${LOG_DIR}/dump.log)"

# ----------------------------------------------------------------------------
# 4. Restore into critsend AS the app role, filtering EXTENSION entries.
# ----------------------------------------------------------------------------
echo "==> Building restore list (excluding EXTENSION entries — pre-created in Step 6)..."
pg_restore -l "${DUMP_DIR}" > "${MIGRATION_DIR}/toc.full"
grep -vE '(EXTENSION -|COMMENT - EXTENSION)' "${MIGRATION_DIR}/toc.full" > "${MIGRATION_DIR}/toc.restore"

echo "==> Restoring into ${APP_DB_NAME} (jobs=${RESTORE_JOBS})..."
date +"    start: %F %T"
set +e
PGPASSWORD="${APP_PW}" pg_restore \
  --dbname="${TARGET_CONN}" \
  --format=directory --jobs="${RESTORE_JOBS}" \
  --no-owner \
  --use-list="${MIGRATION_DIR}/toc.restore" \
  --verbose \
  "${DUMP_DIR}" 2> "${LOG_DIR}/restore.log"
RESTORE_RC=$?
set -e
date +"    done : %F %T"

# pg_restore exits non-zero on ANY error; surface a summary.
RESTORE_ERRORS="$(grep -cE '^pg_restore: error:' "${LOG_DIR}/restore.log" || true)"
echo "    restore exit code: ${RESTORE_RC}   errors logged: ${RESTORE_ERRORS}   (log: ${LOG_DIR}/restore.log)"
if [[ "${RESTORE_ERRORS}" != "0" ]]; then
  echo "    --- first errors ---"
  grep -E '^pg_restore: error:' "${LOG_DIR}/restore.log" | head -10
  echo "    Review ${LOG_DIR}/restore.log before cutover." >&2
fi

# ----------------------------------------------------------------------------
# 5. Revert tuning (HARD gate), then hard-stop if the restore had ANY error
#    before doing anything that might look like success.
# ----------------------------------------------------------------------------
if ! revert_tuning; then
  echo "*** Aborting: production tuning could not be safely reverted (see above). ***" >&2
  exit 1
fi
if [[ "${RESTORE_RC}" != "0" || "${RESTORE_ERRORS}" != "0" ]]; then
  echo "*** RESTORE FAILED (exit=${RESTORE_RC}, errors=${RESTORE_ERRORS}). DO NOT CUT OVER. ***" >&2
  echo "    Inspect ${LOG_DIR}/restore.log, then retry with: RESET_TARGET=yes ./07-migrate-from-neon.sh" >&2
  exit 1
fi

echo "==> Running ANALYZE (analyze-in-stages, jobs=${RESTORE_JOBS})..."
runuser -u postgres -- vacuumdb --analyze-in-stages -j "${RESTORE_JOBS}" -d "${APP_DB_NAME}" >/dev/null 2>&1 || \
  echo "    (vacuumdb reported issues — non-fatal; autovacuum is back on)"

# ----------------------------------------------------------------------------
# 6. Verification — per-table row counts, source vs target.
# ----------------------------------------------------------------------------
if [[ "${SKIP_VERIFY}" == "yes" ]]; then
  echo "==> SKIP_VERIFY=yes — skipping row-count comparison."
else
  echo "==> Verifying row counts (parent partitioned tables counted once)..."
  # Ordinary tables + partitioned parents, excluding partition children.
  LIST_SQL="SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname='public' AND c.relkind IN ('r','p')
            AND NOT EXISTS (SELECT 1 FROM pg_inherits i WHERE i.inhrelid=c.oid)
            ORDER BY c.relname"
  mapfile -t TABLES < <(psql "${NEON_URL}" -tAc "${LIST_SQL}")
  printf "    %-32s %15s %15s  %s\n" "table" "source" "target" "status"
  printf "    %-32s %15s %15s  %s\n" "--------------------------------" "---------------" "---------------" "------"
  MISMATCH=0
  for t in "${TABLES[@]}"; do
    [[ -z "${t}" ]] && continue
    SRC="$(psql "${NEON_URL}" -tAc "SELECT count(*) FROM public.\"${t}\"")"
    TGT="$(psql_app -tAc "SELECT count(*) FROM public.\"${t}\"")"
    if [[ "${SRC}" == "${TGT}" ]]; then STATUS="ok"; else STATUS="MISMATCH"; MISMATCH=$((MISMATCH+1)); fi
    printf "    %-32s %15s %15s  %s\n" "${t}" "${SRC}" "${TGT}" "${STATUS}"
  done
  echo
  if [[ "${MISMATCH}" != "0" ]]; then
    echo "  *** ${MISMATCH} table(s) MISMATCH — DO NOT CUT OVER. Check ${LOG_DIR}/restore.log. ***" >&2
    echo "  *** Retry with: RESET_TARGET=yes ./07-migrate-from-neon.sh ***" >&2
    exit 1
  fi
  echo "  All tables match. Migration verified complete."
fi

echo
echo "Step 7 finished successfully."
echo "  Dump kept at ${DUMP_DIR} (remove with: rm -rf ${MIGRATION_DIR} once cutover is verified)."
echo "  Next: Step 8 — point the app's env at the new server and restart:"
echo "    Pooled : postgresql://${APP_DB_ROLE}:<pw>@157.180.98.150:6432/${APP_DB_NAME}?sslmode=require"
echo "    Direct : postgresql://${APP_DB_ROLE}:<pw>@157.180.98.150:5432/${APP_DB_NAME}?sslmode=require"
echo "    (password: cat ${APP_PW_FILE})"
