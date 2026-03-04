#!/bin/bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:5000}"
USERNAME="${TEST_USERNAME:-admin}"
PASSWORD="${TEST_PASSWORD:-admin123}"
CSV_ROWS="${CSV_ROWS:-100000}"
SEND_RECIPIENTS="${SEND_RECIPIENTS:-1000}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info()  { echo -e "${BLUE}[INFO]${NC} $*"; }
log_ok()    { echo -e "${GREEN}[OK]${NC} $*"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
log_fail()  { echo -e "${RED}[FAIL]${NC} $*"; }

COOKIE_JAR=$(mktemp)
CSRF_TOKEN=""
trap "rm -f $COOKIE_JAR /tmp/test_import_*.csv" EXIT

api_get() {
  curl -s -b "$COOKIE_JAR" -H "X-CSRF-Token: $CSRF_TOKEN" "$BASE_URL$1"
}

api_post() {
  curl -s -b "$COOKIE_JAR" -H "X-CSRF-Token: $CSRF_TOKEN" -H "Content-Type: application/json" -d "$2" "$BASE_URL$1"
}

api_delete() {
  curl -s -b "$COOKIE_JAR" -H "X-CSRF-Token: $CSRF_TOKEN" -X DELETE "$BASE_URL$1"
}

authenticate() {
  log_info "Authenticating as '$USERNAME'..."

  local login_resp
  login_resp=$(curl -s -c "$COOKIE_JAR" -b "$COOKIE_JAR" \
    -H "Content-Type: application/json" \
    -d "{\"username\":\"$USERNAME\",\"password\":\"$PASSWORD\"}" \
    "$BASE_URL/api/auth/login")

  if echo "$login_resp" | grep -q '"error"'; then
    log_warn "Login failed, attempting registration..."
    curl -s -c "$COOKIE_JAR" -b "$COOKIE_JAR" \
      -H "Content-Type: application/json" \
      -d "{\"username\":\"$USERNAME\",\"password\":\"$PASSWORD\"}" \
      "$BASE_URL/api/auth/register" > /dev/null

    login_resp=$(curl -s -c "$COOKIE_JAR" -b "$COOKIE_JAR" \
      -H "Content-Type: application/json" \
      -d "{\"username\":\"$USERNAME\",\"password\":\"$PASSWORD\"}" \
      "$BASE_URL/api/auth/login")
  fi

  CSRF_TOKEN=$(echo "$login_resp" | grep -o '"csrfToken":"[^"]*"' | cut -d'"' -f4)
  if [ -z "$CSRF_TOKEN" ]; then
    log_fail "Authentication failed"
    echo "$login_resp"
    exit 1
  fi
  log_ok "Authenticated (CSRF token obtained)"
}

generate_csv() {
  local rows=$1
  local output=$2
  log_info "Generating CSV with $rows rows -> $output"

  echo "email;tags;refs;ip_address" > "$output"

  local i=0
  local dupes=0
  local target_dupes=$((rows / 5))

  while [ $i -lt $rows ]; do
    if [ $dupes -lt $target_dupes ] && [ $((RANDOM % 5)) -eq 0 ]; then
      local orig=$((RANDOM % (i + 1)))
      echo "loadtest_${orig}@example.com;TAG_A,TAG_B;REF_001;192.168.1.$((RANDOM % 256))" >> "$output"
      dupes=$((dupes + 1))
    else
      echo "loadtest_${i}@example.com;TAG_A,TAG_B;REF_001;192.168.1.$((RANDOM % 256))" >> "$output"
    fi
    i=$((i + 1))
  done

  local size=$(wc -c < "$output")
  log_ok "CSV generated: $rows rows, $(echo "scale=2; $size/1048576" | bc 2>/dev/null || echo "$size bytes")"
}

test_health() {
  echo ""
  echo "============================================"
  echo "  TEST: Health Check"
  echo "============================================"

  local health
  health=$(curl -s "$BASE_URL/api/health")

  if echo "$health" | grep -q '"status"'; then
    log_ok "Health check passed"
    echo "$health" | head -c 200
    echo ""
  else
    log_fail "Health check failed"
    exit 1
  fi
}

test_metrics() {
  echo ""
  echo "============================================"
  echo "  TEST: Prometheus Metrics"
  echo "============================================"

  local metrics
  metrics=$(curl -s "$BASE_URL/metrics")
  local metric_count=$(echo "$metrics" | grep -c "^critsend_" || true)

  if [ "$metric_count" -gt 10 ]; then
    log_ok "Metrics endpoint returned $metric_count critsend_ metrics"

    echo "  Key metrics:"
    echo "$metrics" | grep "critsend_db_pool_total " | head -1 || true
    echo "$metrics" | grep "critsend_db_pool_idle " | head -1 || true
    echo "$metrics" | grep "critsend_db_pool_waiting " | head -1 || true
    echo "$metrics" | grep "critsend_subscriber_count " | head -1 || true
    echo "$metrics" | grep "critsend_queue_depth" | head -5 || true
  else
    log_fail "Metrics endpoint returned only $metric_count metrics"
  fi
}

test_pool_under_load() {
  echo ""
  echo "============================================"
  echo "  TEST: DB Pool Under Concurrent Load"
  echo "============================================"

  log_info "Firing 50 concurrent API requests..."

  local start_time=$(date +%s%N)
  local pids=""
  local success=0
  local failure=0

  for i in $(seq 1 50); do
    (
      local resp
      resp=$(api_get "/api/subscribers?page=1&limit=1" 2>/dev/null)
      if echo "$resp" | grep -q '"subscribers"'; then
        exit 0
      else
        exit 1
      fi
    ) &
    pids="$pids $!"
  done

  for pid in $pids; do
    if wait $pid 2>/dev/null; then
      success=$((success + 1))
    else
      failure=$((failure + 1))
    fi
  done

  local end_time=$(date +%s%N)
  local duration_ms=$(( (end_time - start_time) / 1000000 ))

  if [ $failure -eq 0 ]; then
    log_ok "All 50 concurrent requests succeeded in ${duration_ms}ms"
  elif [ $failure -lt 5 ]; then
    log_warn "$failure/50 requests failed in ${duration_ms}ms (acceptable under load)"
  else
    log_fail "$failure/50 requests failed in ${duration_ms}ms"
  fi
}

test_import() {
  echo ""
  echo "============================================"
  echo "  TEST: Import $CSV_ROWS Row CSV"
  echo "============================================"

  local csv_file="/tmp/test_import_$$.csv"
  generate_csv "$CSV_ROWS" "$csv_file"

  log_info "Starting import..."
  local start_time=$(date +%s)

  local import_resp
  import_resp=$(curl -s -b "$COOKIE_JAR" \
    -H "X-CSRF-Token: $CSRF_TOKEN" \
    -F "file=@$csv_file" \
    -F "tagMode=merge" \
    "$BASE_URL/api/import")

  if echo "$import_resp" | grep -q '"error"'; then
    log_fail "Import initiation failed: $import_resp"
    return 1
  fi

  local job_id
  job_id=$(echo "$import_resp" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

  if [ -z "$job_id" ]; then
    log_fail "Could not extract import job ID"
    echo "$import_resp" | head -c 500
    return 1
  fi

  log_info "Import job started: $job_id"

  local timeout=600
  local elapsed=0
  while [ $elapsed -lt $timeout ]; do
    sleep 5
    elapsed=$((elapsed + 5))

    local status_resp
    status_resp=$(api_get "/api/import/jobs/$job_id")
    local status
    status=$(echo "$status_resp" | grep -o '"status":"[^"]*"' | head -1 | cut -d'"' -f4)

    if [ "$status" = "completed" ]; then
      local end_time=$(date +%s)
      local duration=$((end_time - start_time))

      local new_count=$(echo "$status_resp" | grep -o '"newSubscribers":[0-9]*' | cut -d: -f2)
      local updated_count=$(echo "$status_resp" | grep -o '"updatedSubscribers":[0-9]*' | cut -d: -f2)
      local dup_count=$(echo "$status_resp" | grep -o '"duplicatesInFile":[0-9]*' | cut -d: -f2)
      local failed_count=$(echo "$status_resp" | grep -o '"failedRows":[0-9]*' | cut -d: -f2)

      log_ok "Import completed in ${duration}s"
      echo "  New: ${new_count:-?}, Updated: ${updated_count:-?}, Duplicates: ${dup_count:-?}, Failed: ${failed_count:-?}"
      echo "  Rate: $(echo "scale=0; $CSV_ROWS / $duration" | bc 2>/dev/null || echo "?") rows/sec"

      local total_accounted=$(( ${new_count:-0} + ${updated_count:-0} + ${dup_count:-0} + ${failed_count:-0} ))
      if [ $total_accounted -ne $CSV_ROWS ]; then
        log_warn "Count integrity: accounted=$total_accounted vs total=$CSV_ROWS (diff=$((CSV_ROWS - total_accounted)))"
      else
        log_ok "Count integrity verified: $total_accounted = $CSV_ROWS"
      fi

      rm -f "$csv_file"
      return 0
    elif [ "$status" = "failed" ]; then
      log_fail "Import failed"
      echo "$status_resp" | head -c 500
      rm -f "$csv_file"
      return 1
    fi

    log_info "  Import status: $status (${elapsed}s elapsed)"
  done

  log_fail "Import timed out after ${timeout}s"
  rm -f "$csv_file"
  return 1
}

test_campaign_send() {
  echo ""
  echo "============================================"
  echo "  TEST: Campaign Send ($SEND_RECIPIENTS recipients)"
  echo "============================================"

  local segments_resp
  segments_resp=$(api_get "/api/segments")
  local segment_id
  segment_id=$(echo "$segments_resp" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

  if [ -z "$segment_id" ]; then
    log_info "Creating test segment..."
    local seg_resp
    seg_resp=$(api_post "/api/segments" '{"name":"Load Test Segment","rules":{"combinator":"and","rules":[{"field":"tags","operator":"contains","value":"TAG_A"}]}}')
    segment_id=$(echo "$seg_resp" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
  fi

  if [ -z "$segment_id" ]; then
    log_warn "Could not create segment, skipping campaign test"
    return 0
  fi

  local mtas_resp
  mtas_resp=$(api_get "/api/mtas")
  local mta_id
  mta_id=$(echo "$mtas_resp" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

  if [ -z "$mta_id" ]; then
    log_info "Creating nullsink MTA for testing..."
    local mta_resp
    mta_resp=$(api_post "/api/mtas" '{"name":"Load Test MTA","host":"nullsink","port":2525,"username":"test","password":"test","fromEmail":"test@example.com","fromName":"Load Test","mode":"nullsink"}')
    mta_id=$(echo "$mta_resp" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
  fi

  if [ -z "$mta_id" ]; then
    log_warn "Could not get/create MTA, skipping campaign test"
    return 0
  fi

  log_info "Creating test campaign (segment=$segment_id, mta=$mta_id)..."
  local campaign_resp
  campaign_resp=$(api_post "/api/campaigns" "{\"name\":\"Load Test Campaign $(date +%H:%M:%S)\",\"subject\":\"Load Test\",\"htmlContent\":\"<p>Load test email body</p>\",\"segmentId\":\"$segment_id\",\"mtaId\":\"$mta_id\",\"sendingSpeed\":\"godzilla\"}")
  local campaign_id
  campaign_id=$(echo "$campaign_resp" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

  if [ -z "$campaign_id" ]; then
    log_warn "Could not create campaign"
    echo "$campaign_resp" | head -c 300
    return 0
  fi

  log_info "Starting campaign send: $campaign_id"
  local start_time=$(date +%s)
  api_post "/api/campaigns/$campaign_id/send" '{}' > /dev/null

  local timeout=300
  local elapsed=0
  while [ $elapsed -lt $timeout ]; do
    sleep 5
    elapsed=$((elapsed + 5))

    local status_resp
    status_resp=$(api_get "/api/campaigns/$campaign_id")
    local status
    status=$(echo "$status_resp" | grep -o '"status":"[^"]*"' | head -1 | cut -d'"' -f4)

    if [ "$status" = "completed" ]; then
      local end_time=$(date +%s)
      local duration=$((end_time - start_time))
      local sent=$(echo "$status_resp" | grep -o '"sentCount":[0-9]*' | cut -d: -f2)
      local failed=$(echo "$status_resp" | grep -o '"failedCount":[0-9]*' | cut -d: -f2)

      log_ok "Campaign completed in ${duration}s"
      echo "  Sent: ${sent:-?}, Failed: ${failed:-?}"
      if [ "${duration:-1}" -gt 0 ]; then
        echo "  Rate: $(echo "scale=0; ${sent:-0} / $duration * 60" | bc 2>/dev/null || echo "?") emails/min"
      fi
      return 0
    elif [ "$status" = "failed" ] || [ "$status" = "paused" ]; then
      log_fail "Campaign ended with status: $status"
      return 1
    fi

    local sent=$(echo "$status_resp" | grep -o '"sentCount":[0-9]*' | cut -d: -f2)
    log_info "  Campaign status: $status, sent: ${sent:-0} (${elapsed}s elapsed)"
  done

  log_fail "Campaign timed out after ${timeout}s"
  return 1
}

test_flush_recovery() {
  echo ""
  echo "============================================"
  echo "  TEST: Flush (Delete All Subscribers)"
  echo "============================================"

  local count_resp
  count_resp=$(api_get "/api/subscribers?page=1&limit=1")
  local total
  total=$(echo "$count_resp" | grep -o '"total":[0-9]*' | cut -d: -f2)

  if [ "${total:-0}" -eq 0 ]; then
    log_warn "No subscribers to flush, skipping"
    return 0
  fi

  log_info "Flushing $total subscribers..."
  local start_time=$(date +%s)

  local flush_resp
  flush_resp=$(api_post "/api/subscribers/flush" '{}')
  local job_id
  job_id=$(echo "$flush_resp" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

  if [ -z "$job_id" ]; then
    flush_resp=$(api_post "/api/subscribers/flush" '{"confirm":true}')
    job_id=$(echo "$flush_resp" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
  fi

  if [ -z "$job_id" ]; then
    log_warn "Could not start flush job"
    echo "$flush_resp" | head -c 300
    return 0
  fi

  local timeout=120
  local elapsed=0
  while [ $elapsed -lt $timeout ]; do
    sleep 3
    elapsed=$((elapsed + 3))

    local status_resp
    status_resp=$(api_get "/api/subscribers/flush/$job_id" 2>/dev/null || api_get "/api/subscribers/flush-status" 2>/dev/null || echo '{}')
    local status
    status=$(echo "$status_resp" | grep -o '"status":"[^"]*"' | head -1 | cut -d'"' -f4)

    if [ "$status" = "completed" ]; then
      local end_time=$(date +%s)
      local duration=$((end_time - start_time))

      local remaining_resp
      remaining_resp=$(api_get "/api/subscribers?page=1&limit=1")
      local remaining
      remaining=$(echo "$remaining_resp" | grep -o '"total":[0-9]*' | cut -d: -f2)

      if [ "${remaining:-0}" -eq 0 ]; then
        log_ok "Flush completed in ${duration}s — 0 subscribers remaining"
      else
        log_fail "Flush completed but $remaining subscribers remain!"
      fi
      return 0
    elif [ "$status" = "failed" ]; then
      log_fail "Flush failed"
      return 1
    fi
  done

  log_fail "Flush timed out after ${timeout}s"
  return 1
}

check_db_pool() {
  echo ""
  echo "============================================"
  echo "  TEST: Post-Test DB Pool Health"
  echo "============================================"

  local metrics
  metrics=$(curl -s "$BASE_URL/metrics")

  local pool_total=$(echo "$metrics" | grep "^critsend_db_pool_total " | awk '{print $2}')
  local pool_idle=$(echo "$metrics" | grep "^critsend_db_pool_idle " | awk '{print $2}')
  local pool_waiting=$(echo "$metrics" | grep "^critsend_db_pool_waiting " | awk '{print $2}')

  echo "  Pool total: ${pool_total:-?}"
  echo "  Pool idle:  ${pool_idle:-?}"
  echo "  Pool waiting: ${pool_waiting:-?}"

  if [ "${pool_waiting:-0}" = "0" ]; then
    log_ok "No connections waiting — pool is healthy"
  else
    log_warn "Pool has ${pool_waiting} waiting connections"
  fi
}

show_usage() {
  echo "Critsend Load Test Suite"
  echo ""
  echo "Usage: $0 [COMMAND]"
  echo ""
  echo "Commands:"
  echo "  all          Run all tests sequentially"
  echo "  health       Health check and metrics validation"
  echo "  pool         DB pool concurrency stress test"
  echo "  import       Import CSV test (CSV_ROWS=$CSV_ROWS)"
  echo "  send         Campaign send test"
  echo "  flush        Flush all subscribers test"
  echo "  full-cycle   Import → Send → Flush (end-to-end)"
  echo ""
  echo "Environment Variables:"
  echo "  BASE_URL         Server URL (default: http://localhost:5000)"
  echo "  TEST_USERNAME    Auth username (default: admin)"
  echo "  TEST_PASSWORD    Auth password (default: admin123)"
  echo "  CSV_ROWS         Rows to generate for import test (default: 100000)"
  echo "  SEND_RECIPIENTS  Expected recipients for send test (default: 1000)"
}

case "${1:-all}" in
  health)
    test_health
    test_metrics
    ;;
  pool)
    authenticate
    test_pool_under_load
    check_db_pool
    ;;
  import)
    authenticate
    test_import
    check_db_pool
    ;;
  send)
    authenticate
    test_campaign_send
    check_db_pool
    ;;
  flush)
    authenticate
    test_flush_recovery
    check_db_pool
    ;;
  full-cycle)
    echo "============================================"
    echo "  FULL CYCLE: Import → Send → Flush"
    echo "============================================"
    authenticate
    test_health
    test_metrics
    test_import
    test_campaign_send
    test_flush_recovery
    check_db_pool
    echo ""
    log_ok "Full cycle complete"
    ;;
  all)
    echo "============================================"
    echo "  CRITSEND LOAD TEST SUITE"
    echo "  $(date)"
    echo "============================================"
    authenticate
    test_health
    test_metrics
    test_pool_under_load
    test_import
    test_campaign_send
    test_flush_recovery
    check_db_pool
    echo ""
    echo "============================================"
    echo "  ALL TESTS COMPLETE"
    echo "============================================"
    ;;
  help|--help|-h)
    show_usage
    ;;
  *)
    echo "Unknown command: $1"
    show_usage
    exit 1
    ;;
esac
