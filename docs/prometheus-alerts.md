# Critsend — Prometheus alert rules

These are the recommended alerts for the database-pool safety net introduced in Task #49 (and a few related ones). Drop them into your Prometheus rules file (or Alertmanager-compatible equivalent) and tune thresholds for your environment.

```yaml
groups:
  - name: critsend-db-pool
    interval: 30s
    rules:
      # Pool is acquiring no fresh connections — usually means Neon is unreachable.
      - alert: CritsendDbPoolDown
        expr: critsend_db_pool_total == 0
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "Critsend main DB pool has zero connections"
          runbook: "Check Neon dashboard, verify NEON_DATABASE_URL, restart critsend-web."

      # Sustained waiters → user-facing requests are queueing on pool checkout.
      - alert: CritsendDbPoolWaiting
        expr: max_over_time(critsend_db_pool_waiting[2m]) > 0
        for: 2m
        labels:
          severity: warning
        annotations:
          summary: "Critsend main DB pool has waiters for 2+ min"
          runbook: "Check critsend_db_pool_load_shed_total — if rising, the safety net is working but root cause needs investigation. Inspect campaign concurrency and worker pool size."

      # Saturation rate trending up — pool sizing is too small for the workload.
      - alert: CritsendDbPoolSaturationRising
        expr: rate(critsend_db_pool_saturation_total[5m]) > 1
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "Critsend DB pool saturated > 1×/sec for 10 min"
          runbook: "Consider raising WORKER_PG_POOL_MAX or reducing MAX_CONCURRENT_CAMPAIGNS."

      # The 503 safety net is firing in volume — capacity needs review.
      - alert: CritsendLoadShedActive
        expr: rate(critsend_db_pool_load_shed_total[5m]) > 0.5
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Load-shedding > 0.5 req/s sustained for 5 min"
          runbook: "Pool is saturated and shedding non-critical requests. Investigate concurrent campaign count, bounce/tracking volume."

      # Checkout timeouts that bubbled out of route handlers (caught by pool error handler).
      - alert: CritsendDbCheckoutTimeouts
        expr: rate(critsend_db_pool_checkout_timeout_total[5m]) > 0.1
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "DB pool checkout timeouts > 0.1/s for 5 min"
          runbook: "Saturation lasted long enough to exhaust the 2s connectionTimeoutMillis. See CritsendLoadShedActive runbook."

  - name: critsend-buffers
    interval: 30s
    rules:
      # Tracking buffer dropping events → flush is too slow / queue too small.
      - alert: CritsendTrackingBufferDropping
        expr: rate(critsend_tracking_buffer_dropped_total[5m]) > 1
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Tracking buffer dropping > 1 event/s for 5 min"
          runbook: "Raise TRACKING_BUFFER_MAX or lower TRACKING_FLUSH_INTERVAL_MS, or scale the tracking pool."

      - alert: CritsendBounceBufferDropping
        expr: rate(critsend_bounce_buffer_dropped_total[5m]) > 0.1
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Bounce buffer dropping events"
          runbook: "Bounce traffic exceeded buffer capacity. Raise BOUNCE_BUFFER_MAX or tune flush interval."

      # Buffer queue keeps growing → flush is not keeping up.
      - alert: CritsendBounceBufferBacklog
        expr: critsend_bounce_buffer_queue_depth > 10000
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Bounce buffer backlog > 10k for 5 min"
          runbook: "Tracking pool may be undersized. Check critsend_tracking_pool_in_use."
```

## Acceptance test (manual)

After deploying, run `scripts/load-test-pool-saturation.sh` and confirm:

- Zero `500/502/504` responses
- `503` responses (if any) carry `Retry-After: 1`
- `critsend_db_pool_load_shed_total` increases monotonically (proves the shed is firing)
- `critsend_bounce_buffer_enqueued_total` ≈ inbound bounce rate × duration
- `/api/health` p99 < 200 ms throughout the test
