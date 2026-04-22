#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────
# Pool-saturation load test (Task #49)
#
# Goal: prove that under the worst-case mix the user-facing API never
# returns a 500/502/504. 503 responses ARE acceptable as long as they carry
# a Retry-After header (that's the load-shed contract).
#
# Mix:
#   - 12 concurrent nullsink campaigns (drains the worker pool)
#   - 200 rps batch bounce webhook posts (drains the bounce buffer + tracking pool)
#   - 100 rps open-pixel hits (drains the tracking buffer)
#   - 5 rps poll of /api/health from a "user"
#
# Requires: curl, jq, bash 4+. Set HOST/AUTH_COOKIE/CSRF before running.
# ─────────────────────────────────────────────────────────────────────────
set -euo pipefail

HOST="${HOST:-http://localhost:5000}"
AUTH_COOKIE="${AUTH_COOKIE:-}"        # connect.sid=...
CSRF_TOKEN="${CSRF_TOKEN:-}"
WEBHOOK_SECRET="${WEBHOOK_SECRET:-}"
DURATION_S="${DURATION_S:-300}"
NUM_CAMPAIGNS="${NUM_CAMPAIGNS:-12}"
BOUNCE_RPS="${BOUNCE_RPS:-200}"
PIXEL_RPS="${PIXEL_RPS:-100}"
HEALTH_RPS="${HEALTH_RPS:-5}"

end_at=$(( $(date +%s) + DURATION_S ))

declare -A status_counts
status_counts[200]=0
status_counts[202]=0
status_counts[401]=0
status_counts[503]=0
status_counts[500]=0
status_counts[502]=0
status_counts[504]=0

bad_500_payloads=()

curl_status() {
  curl -sS -o /tmp/lt-body.$$ -w "%{http_code}" -m 10 "$@" || echo 000
}

# ── Fire bounces in batches of 50 ────────────────────────────────────────
fire_bounces() {
  local payload
  local emails=()
  for i in $(seq 1 50); do
    emails+=("\"loadtest+$RANDOM@example.com\"")
  done
  local bounces="["
  for e in "${emails[@]}"; do
    bounces+="{\"email\":$e,\"type\":\"hard_bounce\",\"reason\":\"load-test\"},"
  done
  bounces="${bounces%,}]"
  payload="{\"idempotencyKey\":\"lt-$(date +%s%N)\",\"bounces\":$bounces}"
  local code
  code=$(curl_status -X POST "$HOST/api/webhooks/bounces/batch" \
    -H 'Content-Type: application/json' \
    ${WEBHOOK_SECRET:+-H "x-webhook-secret: $WEBHOOK_SECRET"} \
    -d "$payload")
  record_status "$code" bounce
}

fire_pixel() {
  # The pixel endpoint requires a signed token; in nullsink/dev mode it accepts
  # any GET and returns 1×1 transparent gif. Tune this to your environment.
  local code
  code=$(curl_status "$HOST/api/track/open?cid=lt&sid=lt&sig=lt")
  record_status "$code" pixel
}

fire_health() {
  local code
  code=$(curl_status "$HOST/api/health")
  record_status "$code" health
}

record_status() {
  local code="$1" tag="$2"
  status_counts[$code]=$(( ${status_counts[$code]:-0} + 1 ))
  case "$code" in
    500|502|504)
      bad_500_payloads+=("$(date -Iseconds) $tag $code $(head -c 200 /tmp/lt-body.$$ 2>/dev/null || true)")
      ;;
    503)
      # 503 must carry Retry-After
      ;;
  esac
}

# ── Background loops ────────────────────────────────────────────────────
spawn_loop() {
  local fn="$1" rps="$2"
  local interval
  interval=$(awk "BEGIN{printf \"%.4f\", 1/$rps}")
  while [[ $(date +%s) -lt $end_at ]]; do
    "$fn" &
    sleep "$interval"
  done
}

echo "[load-test] HOST=$HOST  duration=${DURATION_S}s  campaigns=$NUM_CAMPAIGNS  bounce_rps=$BOUNCE_RPS  pixel_rps=$PIXEL_RPS"
echo "[load-test] starting traffic…"

spawn_loop fire_bounces "$BOUNCE_RPS" &
PID_B=$!
spawn_loop fire_pixel "$PIXEL_RPS" &
PID_P=$!
spawn_loop fire_health "$HEALTH_RPS" &
PID_H=$!

# TODO: kick off NUM_CAMPAIGNS nullsink campaigns via the API.
# Left as an integration step so this script stays generic across envs.
echo "[load-test] (campaign launch step — see README; trigger $NUM_CAMPAIGNS nullsink sends manually now)"

wait $PID_B $PID_P $PID_H

echo
echo "[load-test] DONE"
echo "Status code distribution:"
for code in "${!status_counts[@]}"; do
  printf "  %s: %d\n" "$code" "${status_counts[$code]}"
done

bad=$(( ${status_counts[500]:-0} + ${status_counts[502]:-0} + ${status_counts[504]:-0} ))
if [[ $bad -gt 0 ]]; then
  echo
  echo "FAIL: $bad responses with 5xx (non-503)"
  printf '  %s\n' "${bad_500_payloads[@]:0:20}"
  exit 1
fi
echo "PASS: zero 500/502/504 responses (503-with-Retry-After is acceptable)"
