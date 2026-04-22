#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────
# Pool-saturation load test (Task #49)
#
# Asserts the pool-safety SLOs under the worst-case mix:
#   - 12 concurrent nullsink campaigns (drains the worker pool)
#   - $BOUNCE_RPS batch bounce webhook posts (drains bounce buffer)
#   - $PIXEL_RPS open-pixel hits (drains tracking buffer)
#   - $HEALTH_RPS /api/health polls (the "user is watching" probe)
#
# SLOs (script exits non-zero if any fail):
#   - ZERO 500 / 502 / 504 responses anywhere
#   - Every 503 carries a Retry-After header
#   - p99 of /api/health < 500ms
#   - critsend_db_pool_load_shed_total only ever increases (proves shed fired)
#
# Usage:
#   HOST=https://app.example.com \
#   AUTH_COOKIE='connect.sid=…' \
#   CSRF_TOKEN='…' \
#   WEBHOOK_SECRET='…' \
#   MTA_ID='nullsink-mta-id' \
#   SUBSCRIBER_REF='loadtest' \
#   ./scripts/load-test-pool-saturation.sh
# ─────────────────────────────────────────────────────────────────────────
set -euo pipefail

HOST="${HOST:-http://localhost:5000}"
AUTH_COOKIE="${AUTH_COOKIE:-}"
CSRF_TOKEN="${CSRF_TOKEN:-}"
WEBHOOK_SECRET="${WEBHOOK_SECRET:-}"
MTA_ID="${MTA_ID:-}"
SUBSCRIBER_REF="${SUBSCRIBER_REF:-loadtest}"
DURATION_S="${DURATION_S:-300}"
NUM_CAMPAIGNS="${NUM_CAMPAIGNS:-12}"
BOUNCE_RPS="${BOUNCE_RPS:-200}"
PIXEL_RPS="${PIXEL_RPS:-100}"
HEALTH_RPS="${HEALTH_RPS:-5}"
HEALTH_P99_MS_LIMIT="${HEALTH_P99_MS_LIMIT:-500}"
# Hard SLO thresholds for the safety net itself.
POOL_WAITING_PEAK_LIMIT="${POOL_WAITING_PEAK_LIMIT:-2}"
SHED_RATE_LIMIT_PER_SEC="${SHED_RATE_LIMIT_PER_SEC:-50}"
METRIC_SCRAPE_INTERVAL_S="${METRIC_SCRAPE_INTERVAL_S:-2}"

end_at=$(( $(date +%s) + DURATION_S ))
TMPDIR_RUN=$(mktemp -d)
trap 'rm -rf "$TMPDIR_RUN"' EXIT

declare -A status_counts
for code in 200 202 401 500 502 503 504; do status_counts[$code]=0; done

bad_5xx_payloads=()
bad_503_no_retry=()
health_latencies_file="$TMPDIR_RUN/health_ms.txt"
pool_waiting_file="$TMPDIR_RUN/pool_waiting.txt"
: > "$health_latencies_file"
: > "$pool_waiting_file"

# ── Metric helpers (read /metrics, sum by metric name) ───────────────────
sum_metric() {
  local name="$1"
  curl -sS -m 5 "$HOST/metrics" 2>/dev/null \
    | awk -v m="^${name}(\\\\{|[[:space:]])" '$0 ~ m && $0 !~ /^#/ {sum += $NF} END {printf "%.0f", sum+0}'
}
read_gauge() {
  local name="$1"
  curl -sS -m 5 "$HOST/metrics" 2>/dev/null \
    | awk -v m="^${name}(\\\\{|[[:space:]])" '$0 ~ m && $0 !~ /^#/ {print $NF; exit}'
}

scrape_metrics_loop() {
  while [[ $(date +%s) -lt $end_at ]]; do
    local w
    w=$(read_gauge critsend_db_pool_waiting || echo 0)
    [[ -n "$w" ]] && echo "$w" >> "$pool_waiting_file"
    sleep "$METRIC_SCRAPE_INTERVAL_S"
  done
}

# ── Auth headers ─────────────────────────────────────────────────────────
auth_headers=()
[[ -n "$AUTH_COOKIE" ]]  && auth_headers+=(-H "Cookie: $AUTH_COOKIE")
[[ -n "$CSRF_TOKEN" ]]   && auth_headers+=(-H "X-CSRF-Token: $CSRF_TOKEN")

webhook_headers=()
[[ -n "$WEBHOOK_SECRET" ]] && webhook_headers+=(-H "x-webhook-secret: $WEBHOOK_SECRET")

# ── Helpers ──────────────────────────────────────────────────────────────
record_status() {
  local code="$1" tag="$2" body_file="$3" headers_file="$4"
  status_counts[$code]=$(( ${status_counts[$code]:-0} + 1 ))
  case "$code" in
    500|502|504)
      bad_5xx_payloads+=("$(date -Iseconds) $tag $code $(head -c 200 "$body_file" 2>/dev/null || true)")
      ;;
    503)
      if ! grep -qi '^retry-after:' "$headers_file" 2>/dev/null; then
        bad_503_no_retry+=("$(date -Iseconds) $tag MISSING Retry-After")
      fi
      ;;
  esac
}

curl_call() {
  local tag="$1"; shift
  local body_file="$TMPDIR_RUN/body.$$.$RANDOM"
  local headers_file="$TMPDIR_RUN/hdr.$$.$RANDOM"
  local code
  code=$(curl -sS -o "$body_file" -D "$headers_file" -w "%{http_code}" -m 10 "$@" || echo 000)
  record_status "$code" "$tag" "$body_file" "$headers_file"
  rm -f "$body_file" "$headers_file"
  echo "$code"
}

# ── Workload: bounces (batches of 50) ────────────────────────────────────
fire_bounces() {
  local bounces="["
  for i in $(seq 1 50); do
    bounces+="{\"email\":\"loadtest+$RANDOM@example.com\",\"type\":\"hard_bounce\",\"reason\":\"lt\",\"messageId\":\"lt-$RANDOM-$i\"},"
  done
  bounces="${bounces%,}]"
  local payload="{\"idempotencyKey\":\"lt-$(date +%s%N)\",\"bounces\":$bounces}"
  curl_call bounce -X POST "$HOST/api/webhooks/bounces/batch" \
    -H 'Content-Type: application/json' "${webhook_headers[@]}" -d "$payload" >/dev/null
}

fire_pixel() {
  curl_call pixel "$HOST/api/track/open?cid=lt&sid=lt&sig=lt" >/dev/null
}

fire_health() {
  local body_file="$TMPDIR_RUN/h.$$.$RANDOM"
  local headers_file="$TMPDIR_RUN/hh.$$.$RANDOM"
  local t0=$(date +%s%N)
  local code
  code=$(curl -sS -o "$body_file" -D "$headers_file" -w "%{http_code}" -m 5 "$HOST/api/health" || echo 000)
  local t1=$(date +%s%N)
  local ms=$(( (t1 - t0) / 1000000 ))
  echo "$ms" >> "$health_latencies_file"
  record_status "$code" health "$body_file" "$headers_file"
  rm -f "$body_file" "$headers_file"
}

# ── Campaign launch (12 nullsink campaigns) ──────────────────────────────
launch_campaigns() {
  if [[ -z "$MTA_ID" || ${#auth_headers[@]} -eq 0 ]]; then
    echo "[load-test] ⚠  MTA_ID or AUTH_COOKIE missing — skipping automated campaign launch."
    echo "[load-test]    Set MTA_ID + AUTH_COOKIE + CSRF_TOKEN to enable the full test, or"
    echo "[load-test]    trigger $NUM_CAMPAIGNS nullsink campaigns manually from the UI now."
    return
  fi
  for i in $(seq 1 "$NUM_CAMPAIGNS"); do
    local payload
    payload=$(cat <<JSON
{
  "name": "load-test-$(date +%s)-$i",
  "subject": "Load test $i",
  "fromEmail": "loadtest@example.com",
  "fromName": "Load Test",
  "html": "<p>load test</p>",
  "mtaId": "$MTA_ID",
  "targetRefs": ["$SUBSCRIBER_REF"],
  "sendImmediately": true,
  "isNullsink": true
}
JSON
)
    curl_call campaign-create -X POST "$HOST/api/campaigns" \
      -H 'Content-Type: application/json' "${auth_headers[@]}" \
      -d "$payload" >/dev/null &
  done
  wait
  echo "[load-test] launched $NUM_CAMPAIGNS nullsink campaigns"
}

# ── Background workload loops ────────────────────────────────────────────
spawn_loop() {
  local fn="$1" rps="$2"
  local interval
  interval=$(awk "BEGIN{printf \"%.4f\", 1/$rps}")
  while [[ $(date +%s) -lt $end_at ]]; do
    "$fn" &
    sleep "$interval"
  done
  wait
}

echo "[load-test] HOST=$HOST  duration=${DURATION_S}s  campaigns=$NUM_CAMPAIGNS  bounce_rps=$BOUNCE_RPS  pixel_rps=$PIXEL_RPS"

shed_before=$(sum_metric critsend_db_pool_load_shed_total || echo 0)
[[ -z "$shed_before" ]] && shed_before=0
echo "[load-test] critsend_db_pool_load_shed_total (pre) = $shed_before"

echo "[load-test] launching campaigns…"
launch_campaigns
echo "[load-test] starting traffic + metric scraper…"

spawn_loop fire_bounces "$BOUNCE_RPS" & PID_B=$!
spawn_loop fire_pixel   "$PIXEL_RPS"  & PID_P=$!
spawn_loop fire_health  "$HEALTH_RPS" & PID_H=$!
scrape_metrics_loop                    & PID_M=$!

wait $PID_B $PID_P $PID_H $PID_M

echo
echo "[load-test] DONE — analyzing results"

# ── SLO assertions ───────────────────────────────────────────────────────
echo "Status code distribution:"
for code in "${!status_counts[@]}"; do
  printf "  %s: %d\n" "$code" "${status_counts[$code]}"
done

bad_5xx=$(( ${status_counts[500]:-0} + ${status_counts[502]:-0} + ${status_counts[504]:-0} ))
bad_503=${#bad_503_no_retry[@]}

# p99 of /api/health
p99=0
total_health=$(wc -l < "$health_latencies_file" | tr -d ' ')
if [[ "$total_health" -gt 0 ]]; then
  idx=$(( total_health * 99 / 100 ))
  [[ $idx -lt 1 ]] && idx=1
  p99=$(sort -n "$health_latencies_file" | sed -n "${idx}p")
fi
echo "Health probes: total=$total_health  p99=${p99}ms  (limit=${HEALTH_P99_MS_LIMIT}ms)"

# Pool waiting peak (sampled every $METRIC_SCRAPE_INTERVAL_S during the run)
pool_waiting_peak=0
if [[ -s "$pool_waiting_file" ]]; then
  pool_waiting_peak=$(sort -n "$pool_waiting_file" | tail -1)
fi
echo "critsend_db_pool_waiting peak = $pool_waiting_peak (limit=$POOL_WAITING_PEAK_LIMIT)"

# Load-shed delta + rate-per-second over the test window
shed_after=$(sum_metric critsend_db_pool_load_shed_total || echo 0)
[[ -z "$shed_after" ]] && shed_after=0
shed_delta=$(( shed_after - shed_before ))
shed_rate=$(awk "BEGIN{printf \"%.2f\", $shed_delta / $DURATION_S}")
echo "critsend_db_pool_load_shed_total: $shed_before → $shed_after  (Δ=$shed_delta, ${shed_rate}/sec, limit=${SHED_RATE_LIMIT_PER_SEC}/sec)"

failures=()
[[ $bad_5xx -gt 0 ]]                                && failures+=("$bad_5xx 5xx (500/502/504) responses")
[[ $bad_503 -gt 0 ]]                                && failures+=("$bad_503 503 responses missing Retry-After header")
[[ $p99 -gt $HEALTH_P99_MS_LIMIT ]]                 && failures+=("/api/health p99=${p99}ms exceeds ${HEALTH_P99_MS_LIMIT}ms")
[[ $pool_waiting_peak -gt $POOL_WAITING_PEAK_LIMIT ]] && failures+=("pool waiting peak=$pool_waiting_peak exceeds $POOL_WAITING_PEAK_LIMIT (load-shed not engaging fast enough)")
if awk "BEGIN{exit !($shed_rate > $SHED_RATE_LIMIT_PER_SEC)}"; then
  failures+=("load-shed rate ${shed_rate}/sec exceeds ${SHED_RATE_LIMIT_PER_SEC}/sec — pool too small or workload too heavy")
fi

if [[ ${#failures[@]} -gt 0 ]]; then
  echo
  echo "FAIL:"
  for f in "${failures[@]}"; do echo "  - $f"; done
  [[ $bad_5xx -gt 0 ]]  && printf '  sample 5xx:\n'        && printf '    %s\n' "${bad_5xx_payloads[@]:0:10}"
  [[ $bad_503 -gt 0 ]]  && printf '  sample bad 503s:\n'   && printf '    %s\n' "${bad_503_no_retry[@]:0:10}"
  exit 1
fi

echo "PASS: zero 5xx, all 503s carry Retry-After, /api/health p99 within budget."
