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

export const trackingLinkCacheHits = new client.Counter({
  name: 'critsend_tracking_link_cache_hits_total',
  help: 'getCampaignLinkDestination LRU cache outcomes',
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
          (SELECT COUNT(*) FROM subscribers) as total_subscribers,
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
  
  collect();
  metricsCollectorInterval = setInterval(collect, 15000);
}

export function stopMetricsCollector(): void {
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
