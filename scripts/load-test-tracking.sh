#!/bin/bash
# Tracking-pool isolation load test.
#
# Hammers /api/track/open with N requests/sec for DURATION seconds and
# concurrently polls /api/health, asserting the health p99 stays under
# HEALTH_P99_MAX_MS. Validates that a campaign-blast open firehose can no
# longer drain the main pool (Task #47).
#
# Usage:
#   BASE_URL=http://localhost:5000 RPS=200 DURATION=60 ./scripts/load-test-tracking.sh
#
# Optional env:
#   CAMPAIGN_ID, SUBSCRIBER_ID  — if you have a real signed pixel handy,
#       paste the full URL into PIXEL_URL instead.
#   PIXEL_URL                   — full signed open-pixel URL (skips synthesis).
#   HEALTH_P99_MAX_MS           — fail threshold for /api/health p99 (default 1000).
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:5000}"
RPS="${RPS:-200}"
DURATION="${DURATION:-60}"
HEALTH_P99_MAX_MS="${HEALTH_P99_MAX_MS:-1000}"
PIXEL_URL="${PIXEL_URL:-}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'
log_info()  { echo -e "${BLUE}[INFO]${NC} $*"; }
log_ok()    { echo -e "${GREEN}[OK]${NC} $*"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
log_fail()  { echo -e "${RED}[FAIL]${NC} $*"; }

CAMPAIGN_ID="${CAMPAIGN_ID:-loadtest-campaign}"
SUBSCRIBER_ID="${SUBSCRIBER_ID:-loadtest-subscriber}"
ALLOW_INVALID_SIG="${ALLOW_INVALID_SIG:-0}"

if [ -z "$PIXEL_URL" ]; then
  # Try to synthesize a valid signed URL from TRACKING_SECRET so the buffer
  # actually exercises enqueue + flush + DB INSERT (the real "done looks
  # like" path). Falls back to invalid-sig only if the operator explicitly
  # opts in via ALLOW_INVALID_SIG=1.
  if [ -n "${TRACKING_SECRET:-}" ] && command -v openssl >/dev/null; then
    SIG=$(printf "%s" "${CAMPAIGN_ID}:${SUBSCRIBER_ID}:open" \
      | openssl dgst -sha256 -hmac "$TRACKING_SECRET" -binary \
      | xxd -p -c 256)
    PIXEL_URL="${BASE_URL}/api/track/open/${CAMPAIGN_ID}/${SUBSCRIBER_ID}?sig=${SIG}"
    log_info "Synthesized signed pixel URL for ${CAMPAIGN_ID}/${SUBSCRIBER_ID}"
  elif [ "$ALLOW_INVALID_SIG" = "1" ]; then
    PIXEL_URL="${BASE_URL}/api/track/open/${CAMPAIGN_ID}/${SUBSCRIBER_ID}?sig=invalid-but-uniformly-shaped"
    log_warn "Using invalid-sig URL (ALLOW_INVALID_SIG=1). Buffer enqueue / flush will NOT be exercised."
  else
    log_fail "No PIXEL_URL and no TRACKING_SECRET in env."
    log_fail "Provide one of:"
    log_fail "  PIXEL_URL=<full-signed-url>     (paste a real pixel URL from a sent campaign)"
    log_fail "  TRACKING_SECRET=<secret>        (script will sign \${CAMPAIGN_ID}/\${SUBSCRIBER_ID} for you)"
    log_fail "  ALLOW_INVALID_SIG=1             (pool-only test; skips buffer/DB exercise)"
    exit 2
  fi
fi

if ! command -v curl >/dev/null; then
  log_fail "curl is required"
  exit 1
fi

TOTAL=$((RPS * DURATION))
INTERVAL_NS=$((1000000000 / RPS))
TMP=$(mktemp -d)
trap "rm -rf $TMP" EXIT

log_info "Plan: $TOTAL requests over ${DURATION}s @ ${RPS} rps to $PIXEL_URL"
log_info "Health check threshold: p99 < ${HEALTH_P99_MAX_MS}ms"

# ── Health poller ──────────────────────────────────────────────────────────
HEALTH_LOG="$TMP/health.txt"
( for ((i=0; i<DURATION*5; i++)); do
    t=$(curl -s -o /dev/null -w "%{time_total}\n" --max-time 5 "$BASE_URL/api/health" 2>/dev/null || echo "5.000")
    echo "$t" >> "$HEALTH_LOG"
    sleep 0.2
  done ) &
HEALTH_PID=$!

# ── Pixel firehose ─────────────────────────────────────────────────────────
log_info "Firing pixel requests..."
START_NS=$(date +%s%N)
PARALLEL="${PARALLEL:-50}"
seq 1 "$TOTAL" | xargs -n1 -P"$PARALLEL" -I{} curl -s -o /dev/null -w "%{http_code} %{time_total}\n" --max-time 10 "$PIXEL_URL" >> "$TMP/pixel.txt" 2>&1 || true
END_NS=$(date +%s%N)
ELAPSED_MS=$(( (END_NS - START_NS) / 1000000 ))

wait "$HEALTH_PID" 2>/dev/null || true

# ── Results ────────────────────────────────────────────────────────────────
COMPLETED=$(wc -l < "$TMP/pixel.txt" | tr -d ' ')
ACTUAL_RPS=$(awk -v c="$COMPLETED" -v ms="$ELAPSED_MS" 'BEGIN{ if (ms>0) printf "%.1f", (c*1000)/ms; else print "0"}')
log_info "Pixel: completed=$COMPLETED in ${ELAPSED_MS}ms (~${ACTUAL_RPS} rps)"

if [ -s "$HEALTH_LOG" ]; then
  HEALTH_COUNT=$(wc -l < "$HEALTH_LOG" | tr -d ' ')
  P99_S=$(sort -g "$HEALTH_LOG" | awk -v n="$HEALTH_COUNT" 'BEGIN{p=int(n*0.99)} NR==p{print; exit}')
  P99_MS=$(awk -v t="$P99_S" 'BEGIN{printf "%.0f", t*1000}')
  P50_S=$(sort -g "$HEALTH_LOG" | awk -v n="$HEALTH_COUNT" 'BEGIN{p=int(n*0.50)} NR==p{print; exit}')
  P50_MS=$(awk -v t="$P50_S" 'BEGIN{printf "%.0f", t*1000}')
  log_info "Health: samples=$HEALTH_COUNT  p50=${P50_MS}ms  p99=${P99_MS}ms"
  if [ "$P99_MS" -lt "$HEALTH_P99_MAX_MS" ]; then
    log_ok "Health p99 (${P99_MS}ms) below threshold (${HEALTH_P99_MAX_MS}ms) — main pool stayed responsive"
  else
    log_fail "Health p99 (${P99_MS}ms) exceeded threshold (${HEALTH_P99_MAX_MS}ms) — main pool starved!"
    exit 1
  fi
else
  log_warn "No health samples collected"
fi

# Snapshot tracking metrics
log_info "Tracking buffer metrics:"
curl -s "$BASE_URL/metrics" 2>/dev/null \
  | grep -E '^critsend_tracking_(buffer|pool|link)_' \
  | grep -v '^#' || true
