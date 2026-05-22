import client from "prom-client";
import { type Request, type Response, type NextFunction } from "express";
import { pool } from "./db";
import { logger } from "./logger";
import { campaignQueue, importQueue, flushQueue } from "./queues";

const register = new client.Registry();

client.collectDefaultMetrics({ register, prefix: 'critsend_' });

export const emailsSentTotal = new client.Counter({
  name: 'critsend_emails_sent_total',
  help: 'Total emails sent',
  labelNames: ['status', 'mta_id'] as const,
  registers: [register],
});

export const emailSendDuration = new client.Histogram({
  name: 'critsend_email_send_duration_seconds',
  help: 'Email send duration in seconds',
  labelNames: ['status'] as const,
  buckets: [0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

export const queueDepth = new client.Gauge({
  name: 'critsend_queue_depth',
  help: 'Current queue depth',
  labelNames: ['queue_name'] as const,
  registers: [register],
});

export const jobsProcessedTotal = new client.Counter({
  name: 'critsend_jobs_processed_total',
  help: 'Total jobs processed',
  labelNames: ['queue_name', 'status'] as const,
  registers: [register],
});

export const jobProcessingDuration = new client.Histogram({
  name: 'critsend_job_processing_duration_seconds',
  help: 'Job processing duration',
  labelNames: ['queue_name'] as const,
  buckets: [1, 5, 15, 30, 60, 120, 300, 600],
  registers: [register],
});

// Bootstrap-time detection of INVALID indexes (see indexExistsAndValid in
// bootstrap-lock.ts). Set to 1 when the bootstrap probe encounters an
// index in INVALID state on the campaign_sends table (or any other table)
// instead of auto-dropping it. Operator must manually REINDEX CONCURRENTLY
// off-hours; this gauge stays at 1 until the next bootstrap probe finds
// it VALID (the gauge is not auto-reset — a manual /metrics scrape after
// REINDEX + restart is the source of truth).
export const invalidIndexesGauge = new client.Gauge({
  name: 'critsend_invalid_indexes',
  help: 'Indexes detected in INVALID state at bootstrap; 1 = invalid, requires operator REINDEX CONCURRENTLY',
  labelNames: ['index_name'] as const,
  registers: [register],
});

export const activeCampaigns = new client.Gauge({
  name: 'critsend_active_campaigns',
  help: 'Number of currently sending campaigns',
  registers: [register],
});

export const campaignSendRate = new client.Gauge({
  name: 'critsend_campaign_send_rate',
  help: 'Current email send rate per minute',
  registers: [register],
});

// ── Marketing Pressure Guard (Task #144) ─────────────────────────────
// Metric names + label sets pinned by the task contract — do not rename
// without coordinating with deliverability dashboards.
export const pressureGuardDeferredTotal = new client.Counter({
  name: 'critsend_pressure_deferred_total',
  help: 'Total send attempts deferred by the 6h pressure guard',
  labelNames: ['campaign_id'] as const,
  registers: [register],
});

export const pressureGuardSentAfterDeferTotal = new client.Counter({
  name: 'critsend_pressure_sent_after_defer_total',
  help: 'Total deferred sends successfully drained by the pressure-guard worker',
  labelNames: ['campaign_id'] as const,
  registers: [register],
});

export const pressureGuardPendingDeferred = new client.Gauge({
  name: 'critsend_pressure_currently_deferred',
  help: 'Currently-pending deferred campaign_sends rows (status=pending AND eligible_at IS NOT NULL), per campaign',
  labelNames: ['campaign_id'] as const,
  registers: [register],
});

export const pressureGuardFlushedTotal = new client.Counter({
  name: 'critsend_pressure_flushed_total',
  help: 'Total deferred sends manually reprogrammed via the queue UI (eligible_at advanced to NOW())',
  labelNames: ['campaign_id'] as const,
  registers: [register],
});

// ── Pressure Guard hardening (Task #145) ──────────────────────────────
// R10: per-campaign counter incremented every time the CAS sees an older
// campaign already holding the slot for at least one input subscriber.
export const pressureGuardBlockedByOlderTotal = new client.Counter({
  name: 'critsend_pressure_blocked_by_older_total',
  help: 'Total subscribers blocked by an older campaign during pressure CAS',
  labelNames: ['campaign_id'] as const,
  registers: [register],
});

// R12: backfill observability — counters for chunk progress and a gauge
// that reflects the in-progress state on the current node.
export const pressureGuardBackfillRowsTotal = new client.Counter({
  name: 'critsend_pressure_backfill_rows_total',
  help: 'Cumulative rows backfilled into subscribers.last_sent_at',
  registers: [register],
});

export const pressureGuardBackfillInProgress = new client.Gauge({
  name: 'critsend_pressure_backfill_in_progress',
  help: '1 while the historical last_sent_at backfill is running, 0 otherwise',
  registers: [register],
});

// R3: index bloat observability — refreshed by the maintenance worker.
export const pressureGuardDeferredIndexSizeBytes = new client.Gauge({
  name: 'critsend_pressure_deferred_index_size_bytes',
  help: 'pg_relation_size of campaign_sends_pressure_deferred_idx in bytes',
  registers: [register],
});

// ── Aging cap (Task #169) ─────────────────────────────────────────────
// Cumulative counter of deferred sends that the drain force-dispatched
// because their first_deferred_at had aged past PRESSURE_MAX_DEFER_HOURS.
// Intentionally NOT labelled by campaign_id (would explode cardinality
// once aging hits steady-state across hundreds of campaigns); per-
// campaign tally lives on campaigns.aged_forced_count.
export const pressureGuardAgedForceSendsTotal = new client.Counter({
  name: 'critsend_pressure_guard_aged_force_sends_total',
  help: 'Total deferred sends force-dispatched after aging past PRESSURE_MAX_DEFER_HOURS',
  registers: [register],
});

// Gauge of currently-pending deferred rows whose first_deferred_at is
// older than PRESSURE_NEAR_AGING_HOURS (default = max-defer minus 24h).
// Refreshed by the drain poll inner. An operator alert on this gauge >0
// for sustained periods means the drain is failing to keep up and
// aged-forced dispatches will start firing.
export const pressureGuardNearAgingPending = new client.Gauge({
  name: 'critsend_pressure_guard_near_aging_pending',
  help: 'Currently-pending deferred rows older than PRESSURE_NEAR_AGING_HOURS (about to be force-dispatched)',
  registers: [register],
});

// Task #173: campaigns the drain considers "winding down" (small pending
// tail + small ready-to-drain count, observed continuously for >= 24h).
// These campaigns are back-pressured to 1 tick out of every 4 so they
// can't permanently squat MAX_CAMPAIGNS slots while younger campaigns
// with large drainable backlogs starve.
export const pressureGuardWindingDownCampaigns = new client.Gauge({
  name: 'critsend_pressure_guard_winding_down_campaigns',
  help: 'Number of campaigns currently in winding-down state (back-pressured to 1 drain tick out of 4)',
  registers: [register],
});

// Task #173: how many campaigns were skipped on the last drain tick due
// to the winding-down back-pressure schedule. Sustained non-zero values
// mean fairness ordering is actively unblocking younger campaigns.
export const pressureGuardBackPressuredLastTick = new client.Gauge({
  name: 'critsend_pressure_guard_back_pressured_last_tick',
  help: 'Campaigns skipped on the most recent drain tick by the winding-down back-pressure schedule',
  registers: [register],
});

// ── Snowball Auto-Throttle (Task #154) ────────────────────────────────
// When too many campaigns target overlapping audiences, the main sender
// keeps reserving fresh sends that get deferred behind the 6h pressure
// window faster than the drain worker can evacuate them. The auto-throttle
// in server/services/campaign-sender.ts pauses a campaign's sender loop
// when its `currently-deferred / processed` ratio crosses a threshold,
// letting the drain catch up before the backlog grows further.
export const pressureGuardSenderDeferredRatio = new client.Gauge({
  name: 'critsend_pressure_sender_deferred_ratio',
  help: 'Per-campaign ratio currently-deferred / (currently-deferred + sent + failed); throttle triggers when above PRESSURE_RATIO_THROTTLE_THRESHOLD',
  labelNames: ['campaign_id'] as const,
  registers: [register],
});

export const pressureGuardSenderThrottledTotal = new client.Counter({
  name: 'critsend_pressure_sender_throttled_total',
  help: 'Total number of times the sender auto-throttled a campaign because deferred/processed ratio exceeded the snowball threshold',
  labelNames: ['campaign_id'] as const,
  registers: [register],
});

// ── Bulletproof drain & deploy (Task #160) ───────────────────────────
// Last-tick-age gauge: scraped by Prometheus to alert when the drain
// loop has gone silent (no successful tick in N seconds). Labelled by
// `name` so we can track the drain, the maintenance loop, and the audit
// TTL loop independently.
export const safeIntervalLastTickAgeSeconds = new client.Gauge({
  name: 'critsend_safe_interval_last_tick_age_seconds',
  help: 'Seconds since the last successful tick of a named safeInterval loop',
  labelNames: ['name'] as const,
  registers: [register],
});

// Tick errors counter: incremented each time a safeInterval-wrapped
// callback throws. A sustained increase indicates the loop is degraded
// even if it has not stopped firing.
export const safeIntervalTickErrorsTotal = new client.Counter({
  name: 'critsend_safe_interval_tick_errors_total',
  help: 'Total caught exceptions raised by safeInterval-wrapped tick callbacks',
  labelNames: ['name'] as const,
  registers: [register],
});

// Task #160 contract metric: dedicated drain-tick-age gauge that
// alerting/dashboards can target directly without parsing the generic
// `safe_interval` labelled gauge above. Exported in addition to (not
// instead of) the labelled gauge so generic safeInterval observability
// stays available for the maintenance + audit loops.
export const pressureDrainLastTickAgeSeconds = new client.Gauge({
  name: 'critsend_pressure_drain_last_tick_age_seconds',
  help: 'Seconds since the pressure-guard drain last completed a tick (single source of truth for alerting)',
  registers: [register],
});

// Task #160 contract metric: rolling 5-minute counters for the drain.
// Read directly from the leader-lease + heartbeat history, exported so
// /api/admin/pressure-drain/health and Prometheus rules see the same
// numbers.
export const pressureDrainCalls5m = new client.Gauge({
  name: 'critsend_pressure_drain_calls_5m',
  help: 'Total drainCampaign() calls observed in the last 5 minutes (rolling)',
  registers: [register],
});
export const pressureDrainErrors5m = new client.Gauge({
  name: 'critsend_pressure_drain_errors_5m',
  help: 'Total drain tick errors observed in the last 5 minutes (rolling)',
  registers: [register],
});

// Orphaned-sends reconciler (Task #160): rows force-failed because they
// were stuck in pending/attempting on a finished campaign.
export const orphanedSendsReconciledTotal = new client.Counter({
  name: 'critsend_orphaned_sends_reconciled_total',
  help: 'Total campaign_sends rows force-failed by the orphaned-sends reconciler',
  registers: [register],
});

export const httpRequestsTotal = new client.Counter({
  name: 'critsend_http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'route', 'status_code'] as const,
  registers: [register],
});

export const httpRequestDuration = new client.Histogram({
  name: 'critsend_http_request_duration_seconds',
  help: 'HTTP request duration',
  labelNames: ['method', 'route'] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [register],
});

export const dbPoolTotal = new client.Gauge({
  name: 'critsend_db_pool_total',
  help: 'Total database pool connections',
  registers: [register],
});

export const dbPoolIdle = new client.Gauge({
  name: 'critsend_db_pool_idle',
  help: 'Idle database pool connections',
  registers: [register],
});

export const dbPoolWaiting = new client.Gauge({
  name: 'critsend_db_pool_waiting',
  help: 'Waiting database pool connections',
  registers: [register],
});

export const dbQueryDuration = new client.Histogram({
  name: 'critsend_db_query_duration_seconds',
  help: 'Database query duration',
  labelNames: ['operation'] as const,
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
  registers: [register],
});

export const subscriberCount = new client.Gauge({
  name: 'critsend_subscriber_count',
  help: 'Total subscriber count',
  registers: [register],
});

export const importJobsActive = new client.Gauge({
  name: 'critsend_import_jobs_active',
  help: 'Active import jobs',
  registers: [register],
});

export const memoryUsage = new client.Gauge({
  name: 'critsend_memory_usage_bytes',
  help: 'Process memory usage in bytes',
  labelNames: ['type'] as const,
  registers: [register],
});

export const errorRate = new client.Counter({
  name: 'critsend_errors_total',
  help: 'Total errors',
  labelNames: ['type'] as const,
  registers: [register],
});

export const automationEnrollmentsActive = new client.Gauge({
  name: 'critsend_automation_enrollments_active',
  help: 'Active automation enrollments',
  registers: [register],
});

export const warmupEmailsSent = new client.Counter({
  name: 'critsend_warmup_emails_sent_total',
  help: 'Emails sent during warmup',
  labelNames: ['mta_id'] as const,
  registers: [register],
});

export const jobOldestAgeSeconds = new client.Gauge({
  name: 'critsend_job_oldest_age_seconds',
  help: 'Age in seconds of the oldest pending/processing job',
  labelNames: ['queue_name'] as const,
  registers: [register],
});

export const workerRestartsTotal = new client.Counter({
  name: 'critsend_worker_restarts_total',
  help: 'Total worker process restarts',
  labelNames: ['worker_type'] as const,
  registers: [register],
});

export const bouncesTotal = new client.Counter({
  name: 'critsend_bounces_total',
  help: 'Total bounce/complaint events received via webhooks',
  labelNames: ['type'] as const,
  registers: [register],
});

export const campaignReconciliationDiscrepancy = new client.Gauge({
  name: 'critsend_campaign_reconciliation_discrepancy_pct',
  help: 'Percentage discrepancy between expected and actual campaign sends',
  labelNames: ['campaign_id'] as const,
  registers: [register],
});

export const flushJobsTotal = new client.Counter({
  name: 'critsend_flush_jobs_total',
  help: 'Total flush jobs processed',
  labelNames: ['status'] as const,
  registers: [register],
});

export const dbPoolSaturationTotal = new client.Counter({
  name: 'critsend_db_pool_saturation_total',
  help: 'Number of times the DB pool was found saturated (waiting > 0)',
  registers: [register],
});

export const bullmqWaiting = new client.Gauge({
  name: 'critsend_bullmq_waiting',
  help: 'BullMQ jobs waiting to be processed',
  labelNames: ['queue'] as const,
  registers: [register],
});

export const bullmqActive = new client.Gauge({
  name: 'critsend_bullmq_active',
  help: 'BullMQ jobs currently being processed',
  labelNames: ['queue'] as const,
  registers: [register],
});

export const bullmqFailed = new client.Gauge({
  name: 'critsend_bullmq_failed',
  help: 'BullMQ jobs that have failed',
  labelNames: ['queue'] as const,
  registers: [register],
});

export const bullmqDelayed = new client.Gauge({
  name: 'critsend_bullmq_delayed',
  help: 'BullMQ jobs that are delayed',
  labelNames: ['queue'] as const,
  registers: [register],
});

// ─── Tracking buffer (open / click / unsubscribe / complaint) ──────────────
export const trackingBufferEnqueued = new client.Counter({
  name: 'critsend_tracking_buffer_enqueued_total',
  help: 'Tracking events accepted into the in-memory buffer',
  labelNames: ['type'] as const,
  registers: [register],
});

export const trackingBufferFlushed = new client.Counter({
  name: 'critsend_tracking_buffer_flushed_total',
  help: 'Tracking events written to the database in batched flushes',
  labelNames: ['type'] as const,
  registers: [register],
});

export const trackingBufferDropped = new client.Counter({
  name: 'critsend_tracking_buffer_dropped_total',
  help: 'Tracking events dropped because the buffer was full or write failed',
  labelNames: ['reason'] as const,
  registers: [register],
});

export const trackingBufferDeduped = new client.Counter({
  name: 'critsend_tracking_buffer_deduped_total',
  help: 'Tracking events suppressed by the (campaign,subscriber,type) dedupe window',
  labelNames: ['type'] as const,
  registers: [register],
});

export const trackingBufferQueueDepth = new client.Gauge({
  name: 'critsend_tracking_buffer_queue_depth',
  help: 'Current number of buffered tracking events awaiting flush',
  registers: [register],
});

export const trackingPoolInUse = new client.Gauge({
  name: 'critsend_tracking_pool_in_use',
  help: 'Tracking-pool connections currently checked out',
  registers: [register],
});

// ── Counter-drift reconciliation ──────────────────────────────────────────
// Number of rows the periodic reconciler had to fix because a derived
// counter (campaigns.sent_count, campaign_sends.first_open_at, etc.) had
// drifted from its source-of-truth table. A non-zero value points to a
// bug in the live counter-write path. Should be ~0 in steady state.
export const counterDriftFixedTotal = new client.Counter({
  name: 'critsend_counter_drift_fixed_total',
  help: 'Rows fixed by the counter-drift reconciler, by counter name',
  labelNames: ['counter'] as const,
  registers: [register],
});

export const counterDriftRunDurationMs = new client.Gauge({
  name: 'critsend_counter_drift_run_duration_ms',
  help: 'Duration of the most recent counter-drift reconciler run, in ms',
  registers: [register],
});

export const counterDriftLastRunAt = new client.Gauge({
  name: 'critsend_counter_drift_last_run_timestamp_seconds',
  help: 'Unix timestamp of the most recent successful counter-drift reconciler run',
  registers: [register],
});

export const trackingLinkCacheHits = new client.Counter({
  name: 'critsend_tracking_link_cache_hits_total',
  help: 'getCampaignLinkDestination LRU cache outcomes',
  labelNames: ['result'] as const,
  registers: [register],
});

export const trackingTokenCacheTotal = new client.Counter({
  name: 'critsend_tracking_token_cache_total',
  help: 'resolveTrackingToken LRU cache outcomes',
  labelNames: ['result'] as const,
  registers: [register],
});

// ─── Bounce-webhook buffer (mirror of tracking buffer) ─────────────────────
export const bounceBufferEnqueued = new client.Counter({
  name: 'critsend_bounce_buffer_enqueued_total',
  help: 'Bounce events accepted into the in-memory buffer',
  labelNames: ['type'] as const,
  registers: [register],
});

export const bounceBufferFlushed = new client.Counter({
  name: 'critsend_bounce_buffer_flushed_total',
  help: 'Bounce events written to the database in batched flushes',
  labelNames: ['type'] as const,
  registers: [register],
});

export const bounceBufferDropped = new client.Counter({
  name: 'critsend_bounce_buffer_dropped_total',
  help: 'Bounce events dropped because the buffer was full or write failed',
  labelNames: ['reason'] as const,
  registers: [register],
});

export const bounceBufferDeduped = new client.Counter({
  name: 'critsend_bounce_buffer_deduped_total',
  help: 'Bounce events suppressed by the (email,type) dedupe window',
  labelNames: ['type'] as const,
  registers: [register],
});

export const bounceBufferQueueDepth = new client.Gauge({
  name: 'critsend_bounce_buffer_queue_depth',
  help: 'Current number of buffered bounce events awaiting flush',
  registers: [register],
});

export const bounceBufferFlushPartialFailure = new client.Counter({
  name: 'critsend_bounce_buffer_flush_partial_failure_total',
  help: 'Sub-operations that failed inside an otherwise-successful bounce flush (e.g. error_logs INSERT failed while tag updates succeeded). Alert on rate>0.',
  labelNames: ['op'] as const,
  registers: [register],
});

// ─── Campaign finalize fallback observability ──────────────────────────────
export const finalizeBatchRetryTotal = new client.Counter({
  name: 'critsend_campaign_finalize_batch_retry_total',
  help: 'Number of times bulk finalize retried with a smaller batch size',
  labelNames: ['level'] as const,
  registers: [register],
});

export const finalizeFallbackTotal = new client.Counter({
  name: 'critsend_campaign_finalize_fallback_total',
  help: 'Number of times bulk finalize fell back to individual writes',
  registers: [register],
});

export const finalizeFallbackRowsTotal = new client.Counter({
  name: 'critsend_campaign_finalize_fallback_rows_total',
  help: 'Total rows finalized via individual-write fallback path',
  labelNames: ['outcome'] as const,
  registers: [register],
});

// ─── Health endpoint latency ───────────────────────────────────────────────
export const healthCheckDuration = new client.Histogram({
  name: 'critsend_health_check_duration_seconds',
  help: 'Health endpoint response time in seconds',
  labelNames: ['endpoint'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [register],
});

// ─── Pool safety / load-shed observability ─────────────────────────────────
export const poolLoadShedTotal = new client.Counter({
  name: 'critsend_db_pool_load_shed_total',
  help: 'Requests rejected with 503 by the load-shedding middleware',
  labelNames: ['reason', 'route'] as const,
  registers: [register],
});

export const poolCheckoutTimeoutTotal = new client.Counter({
  name: 'critsend_db_pool_checkout_timeout_total',
  help: 'Requests that bubbled a pg pool checkout timeout error',
  registers: [register],
});

// Per-request DB connection lease — see server/middleware/request-lease.ts
export const poolRequestHolding = new client.Gauge({
  name: 'critsend_db_pool_request_holding',
  help: 'Number of DB connections currently held by an in-flight request, by route',
  labelNames: ['route'] as const,
  registers: [register],
});

export const poolRequestLeaseExceededTotal = new client.Counter({
  name: 'critsend_db_pool_request_lease_exceeded_total',
  help: 'Requests that exceeded MAX_CONNECTIONS_PER_REQUEST cap',
  labelNames: ['route'] as const,
  registers: [register],
});

// ─── 503 attribution (Task #148) ──────────────────────────────────────────
// Cross-cutting meta-counter incremented EXACTLY once per 503 emitted by
// the unified service-busy helper. Use this when you want the total 503
// rate or the per-(source,route) breakdown without summing five different
// per-source counters that have heterogeneous label sets.
export const serviceBusy503Total = new client.Counter({
  name: 'critsend_service_busy_503_total',
  help: 'Total 503 service_busy responses emitted via emitServiceBusy(), labelled by source and route bucket',
  labelNames: ['source', 'route'] as const,
  registers: [register],
});

// 503s emitted by route-handler local catch blocks for transient DB errors
// (statement_timeout, connection lost, disk_full). Distinct from the pool
// safety-net counters because these are application-level decisions made
// AFTER a query was attempted.
export const campaignsListTransient503Total = new client.Counter({
  name: 'critsend_handler_transient_503_total',
  help: 'Route-handler 503 responses caused by a transient DB error (timeout, connection, disk_full)',
  labelNames: ['kind', 'route'] as const,
  registers: [register],
});

// 503s emitted because the in-process memory monitor flagged isMemoryPressure.
// Until Task #148 these were counted nowhere — we now want every emission
// attributable so operators can correlate with the heap-utilisation gauge.
export const memoryPressure503Total = new client.Counter({
  name: 'critsend_memory_pressure_503_total',
  help: 'Requests rejected with 503 because the memory monitor flagged isMemoryPressure',
  labelNames: ['route'] as const,
  registers: [register],
});

export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();
  res.on('finish', () => {
    const duration = (Date.now() - start) / 1000;
    const route = normalizeRoute(req.route?.path || req.path);
    httpRequestsTotal.inc({ method: req.method, route, status_code: res.statusCode.toString() });
    httpRequestDuration.observe({ method: req.method, route }, duration);
  });
  next();
}

function normalizeRoute(path: string): string {
  return path
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/:id')
    .replace(/\/\d+/g, '/:id');
}

let metricsCollectorInterval: NodeJS.Timeout | null = null;

let metricsStartupTimeout: NodeJS.Timeout | null = null;

export function startMetricsCollector(): void {
  async function collect() {
    try {
      dbPoolTotal.set(pool.totalCount);
      dbPoolIdle.set(pool.idleCount);
      dbPoolWaiting.set(pool.waitingCount);

      const mem = process.memoryUsage();
      memoryUsage.set({ type: 'heapUsed' }, mem.heapUsed);
      memoryUsage.set({ type: 'heapTotal' }, mem.heapTotal);
      memoryUsage.set({ type: 'rss' }, mem.rss);
      memoryUsage.set({ type: 'external' }, mem.external);

      const result = await pool.query(`
        SELECT 
          (SELECT COUNT(*) FROM campaign_jobs WHERE status IN ('pending', 'processing')) as campaign_queue,
          (SELECT COUNT(*) FROM import_job_queue WHERE status IN ('pending', 'processing')) as import_queue,
          (SELECT COUNT(*) FROM pending_tag_operations WHERE status = 'pending') as tag_queue,
          (SELECT reltuples::bigint FROM pg_class WHERE relname = 'subscribers') as total_subscribers,
          (SELECT COUNT(*) FROM campaigns WHERE status = 'sending') as sending_campaigns,
          (SELECT EXTRACT(EPOCH FROM (NOW() - MIN(created_at))) FROM campaign_jobs WHERE status IN ('pending', 'processing')) as campaign_oldest_age,
          (SELECT EXTRACT(EPOCH FROM (NOW() - MIN(created_at))) FROM import_job_queue WHERE status IN ('pending', 'processing')) as import_oldest_age
      `);
      
      const row = result.rows[0];
      queueDepth.set({ queue_name: 'campaign' }, parseInt(row.campaign_queue) || 0);
      queueDepth.set({ queue_name: 'import' }, parseInt(row.import_queue) || 0);
      queueDepth.set({ queue_name: 'tag' }, parseInt(row.tag_queue) || 0);
      subscriberCount.set(parseInt(row.total_subscribers) || 0);
      activeCampaigns.set(parseInt(row.sending_campaigns) || 0);

      jobOldestAgeSeconds.set({ queue_name: 'campaign' }, parseFloat(row.campaign_oldest_age) || 0);
      jobOldestAgeSeconds.set({ queue_name: 'import' }, parseFloat(row.import_oldest_age) || 0);

      if (pool.waitingCount > 0) {
        dbPoolSaturationTotal.inc();
      }

      if (campaignQueue && importQueue && flushQueue) {
        try {
          const [cCounts, iCounts, fCounts] = await Promise.all([
            campaignQueue.getJobCounts(),
            importQueue.getJobCounts(),
            flushQueue.getJobCounts(),
          ]);
          bullmqWaiting.set({ queue: 'campaigns' }, cCounts.waiting ?? 0);
          bullmqActive.set({ queue: 'campaigns' }, cCounts.active ?? 0);
          bullmqFailed.set({ queue: 'campaigns' }, cCounts.failed ?? 0);
          bullmqDelayed.set({ queue: 'campaigns' }, cCounts.delayed ?? 0);

          bullmqWaiting.set({ queue: 'imports' }, iCounts.waiting ?? 0);
          bullmqActive.set({ queue: 'imports' }, iCounts.active ?? 0);
          bullmqFailed.set({ queue: 'imports' }, iCounts.failed ?? 0);
          bullmqDelayed.set({ queue: 'imports' }, iCounts.delayed ?? 0);

          bullmqWaiting.set({ queue: 'flushes' }, fCounts.waiting ?? 0);
          bullmqActive.set({ queue: 'flushes' }, fCounts.active ?? 0);
          bullmqFailed.set({ queue: 'flushes' }, fCounts.failed ?? 0);
          bullmqDelayed.set({ queue: 'flushes' }, fCounts.delayed ?? 0);
        } catch (bullErr) {
          logger.warn('BullMQ metrics collection error', { error: String(bullErr) });
        }
      }
    } catch (err) {
      logger.error('Metrics collection error', { error: String(err) });
    }
  }
  
  const METRICS_INITIAL_DELAY_MS = Number(process.env.METRICS_INITIAL_DELAY_MS || 90_000);
  logger.info(`[METRICS] Collector starting: first collection in ${METRICS_INITIAL_DELAY_MS}ms, then every 15s`);
  metricsStartupTimeout = setTimeout(() => {
    metricsStartupTimeout = null;
    collect();
    metricsCollectorInterval = setInterval(collect, 15000);
  }, METRICS_INITIAL_DELAY_MS);
}

export function stopMetricsCollector(): void {
  if (metricsStartupTimeout) {
    clearTimeout(metricsStartupTimeout);
    metricsStartupTimeout = null;
  }
  if (metricsCollectorInterval) {
    clearInterval(metricsCollectorInterval);
    metricsCollectorInterval = null;
  }
}

export function registerMetricsRoute(app: any): void {
  app.get('/metrics', async (_req: Request, res: Response) => {
    try {
      res.set('Content-Type', register.contentType);
      const metrics = await register.metrics();
      res.end(metrics);
    } catch (err) {
      logger.error('Metrics endpoint error', { error: String(err) });
      res.status(500).end();
    }
  });
}

export { register };
