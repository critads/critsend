import { storage } from "./storage";
import * as fs from "fs";
import { db, pool, isPoolHealthy } from "./db";
import { sql } from "drizzle-orm";
import type { CampaignJob } from "@shared/schema";
import { processCampaignInternal } from "./services/campaign-sender";
import { verifyTransporter, closeNullsinkTransporter, closeAllTransporters } from "./email-service";
import { messageQueue } from "./message-queue";
import { logger } from "./logger";
import { workerRestartsTotal, flushJobsTotal } from "./metrics";
import { type JobProgressEvent, publishJobProgress } from "./job-events";
import { publishCampaignsListInvalidation } from "./repositories/campaigns-list-cache";
import { redisConnection, isRedisConfigured } from "./redis";
import { processImportJob } from "./services/import-processor";
import { ObjectStorageTransientError } from "./storage-backends";
import { classifyDbError } from "./db-errors";
import { processAutomationEnrollments, checkAndEnrollForTrigger, runAutomationBootstrapMigrations } from "./services/automation-engine";
import { startPressureGuardWorker, stopPressureGuardWorker } from "./workers/pressure-guard-worker";
import { runPressureGuardBootstrap } from "./services/pressure-guard";

const WORKER_ID = `worker-${process.pid}-${Date.now()}`;

let tagQueueInterval: NodeJS.Timeout | null = null;
let tagCleanupInterval: NodeJS.Timeout | null = null;
let jobPollingInterval: NodeJS.Timeout | null = null;
let importJobPollingInterval: NodeJS.Timeout | null = null;
let flushJobPollingInterval: NodeJS.Timeout | null = null;
let mtaRecoveryInterval: NodeJS.Timeout | null = null;
let memoryCheckInterval: NodeJS.Timeout | null = null;
let maintenanceInterval: NodeJS.Timeout | null = null;
let trackingTokenDailyTimer: NodeJS.Timeout | null = null;
let scheduledCampaignInterval: NodeJS.Timeout | null = null;
let workerHeartbeatInterval: NodeJS.Timeout | null = null;
let automationPollingInterval: NodeJS.Timeout | null = null;
let ghostCampaignSweepInterval: NodeJS.Timeout | null = null;

const GHOST_SWEEP_INTERVAL_MS = Number(process.env.GHOST_SWEEP_INTERVAL_MS ?? 120_000);
const GHOST_SWEEP_MIN_AGE_MIN = Number(process.env.GHOST_SWEEP_MIN_AGE_MIN ?? 10);

// Redis key used by the web process's /api/health endpoint to discover
// whether the (separate) worker process is alive and which sub-workers
// are running. TTL is set to 30s; the worker republishes every 10s, so
// the key disappears within 30s of the worker dying.
export const WORKER_HEARTBEAT_KEY = "critsend:worker:health";
const WORKER_HEARTBEAT_TTL_SECONDS = 30;
const WORKER_HEARTBEAT_INTERVAL_MS = 10_000;

let isActiveImportJob = false;
let activeFlushJob = false;
let lastRecoveryCheck = 0;

const MEMORY_CHECK_INTERVAL = 60000;
const MEMORY_WARN_THRESHOLD_MB = 2048;
const MEMORY_CRITICAL_THRESHOLD_MB = 4096;
let consecutiveHighMemoryCount = 0;
export let isMemoryPressure = false;

const FLUSH_BATCH_SIZE = 5000;

export function getWorkerId(): string {
  return WORKER_ID;
}

export function getImportJobProcessorRunning(): boolean {
  return !!importJobPollingInterval;
}

export function getWorkerHealth(): { jobProcessor: boolean; importProcessor: boolean; tagQueueWorker: boolean; flushProcessor: boolean; maintenanceWorker: boolean; scheduledCampaignPoller: boolean; automationProcessor: boolean; ghostCampaignSweep: boolean } {
  return {
    jobProcessor: !!jobPollingInterval,
    importProcessor: !!importJobPollingInterval,
    tagQueueWorker: !!tagQueueInterval,
    flushProcessor: !!flushJobPollingInterval,
    maintenanceWorker: !!maintenanceInterval,
    scheduledCampaignPoller: !!scheduledCampaignInterval,
    automationProcessor: !!automationPollingInterval,
    ghostCampaignSweep: !!ghostCampaignSweepInterval,
  };
}

/**
 * Garde-fou A — Ghost campaign self-heal.
 *
 * Detects campaigns left in a half-launched state after a crash mid-enumeration:
 *   - status='sending' (or 'queued')
 *   - started_at IS NULL
 *   - older than GHOST_SWEEP_MIN_AGE_MIN minutes (default 10)
 *   - NO rows in campaign_sends
 *
 * Root cause: the enumeration phase increments `campaigns.deferred_count` in a
 * separate UPDATE before INSERT-ing the per-recipient `campaign_sends` rows.
 * If the worker crashes between the two (e.g. the 2026-05-19 10:56 Neon
 * `options=-c` outage), the counter is committed but the rows are not, leaving
 * the campaign permanently stuck: the single pending job, when (if) it ever
 * gets picked, finds 0 ready sends and exits without doing anything.
 *
 * Self-heal: fail the orphan job, reset stale counters, insert a fresh
 * pending job. We deliberately do NOT bump `campaigns.created_at` — that
 * column is the immutable launch-ancestry key used by both
 * `job-repository.claimNextJob` AND the pressure-guard FIFO drain
 * (see docs/architecture-history.md). Mutating it would corrupt the
 * deferred-subscriber serialization contract.
 *
 * Concurrency: `kill_jobs` uses `FOR UPDATE SKIP LOCKED` on
 * `campaign_jobs` so we never block on a row a worker just claimed.
 * `reset_counters` and the final `INSERT` chain off `kill_jobs` rather
 * than `ghosts` — so if we couldn't kill the orphan job (because a
 * worker held it), we do nothing this cycle and try again later. This
 * prevents creating duplicate pending jobs for the same campaign.
 *
 * Idempotent and safe: only touches campaigns matching the strict
 * pattern. The pattern requires `started_at IS NULL` AND `NOT EXISTS
 * (campaign_sends)` — both invariants are only true between a worker
 * crash during enumeration and the next successful enumeration pass.
 *
 * False-positive guard (production incident 2026-05-31): `started_at
 * IS NULL` + no `campaign_sends` is ALSO true for a brand-new campaign
 * whose pending job simply hasn't been claimed yet (starved behind a
 * backlog of older campaigns filling every worker slot). Without the
 * extra guard below, Branch A misread "waiting in the queue" as
 * "crashed during enumeration", killed the never-claimed pending job,
 * reset the counters, and re-enqueued a fresh job every cycle — an
 * infinite churn that ALSO reset the job's age to 0, defeating the
 * claimNextJob fairness promotion (which needs the job to keep aging).
 * So we now require NO viable in-flight job (same "viable" definition
 * as Branch B): a healthy pending job, or a processing job with a
 * fresh/just-claimed (NULL) heartbeat, or a just-failed job, all mean
 * "not a ghost — leave it alone". Only a stale processing job (dead
 * worker) or no job at all is a true ghost.
 *
 * Trade-off: a self-healed campaign keeps its real `created_at`. Fair
 * scheduling of starved campaigns is handled by the claimNextJob
 * fairness tie-breaker (promote + wait-time order). See production
 * incident notes 2026-05-19 and 2026-05-31.
 */
async function sweepGhostCampaigns(): Promise<void> {
  if (!isPoolHealthy()) return;
  try {
    // Branch A — original ghost case: status='sending'/'queued',
    // started_at IS NULL, no campaign_sends rows. Worker crashed during
    // audience enumeration, before any send was attempted.
    const result = await db.execute(sql`
      WITH ghosts AS (
        SELECT c.id
        FROM campaigns c
        WHERE c.status IN ('sending', 'queued')
          AND c.started_at IS NULL
          AND c.created_at < NOW() - (INTERVAL '1 minute' * ${GHOST_SWEEP_MIN_AGE_MIN})
          AND NOT EXISTS (SELECT 1 FROM campaign_sends WHERE campaign_id = c.id)
          -- False-positive guard (incident 2026-05-31): do NOT treat a
          -- campaign whose pending job is merely waiting in the queue as a
          -- crashed-enumeration ghost. Only fire when there is NO viable
          -- in-flight job — i.e. a stale processing job (dead worker) or no
          -- job at all. A pending job, a freshly-claimed processing job
          -- (NULL heartbeat) or a fresh heartbeat, or a just-failed job all
          -- mean "still in play, leave it alone". Mirrors Branch B.
          AND NOT EXISTS (
            SELECT 1 FROM campaign_jobs cj
            WHERE cj.campaign_id = c.id
              AND (
                cj.status = 'pending'
                OR (cj.status = 'processing' AND (cj.heartbeat IS NULL OR cj.heartbeat > NOW() - (INTERVAL '1 minute' * ${GHOST_SWEEP_MIN_AGE_MIN})))
                OR (cj.status = 'failed' AND cj.completed_at > NOW() - INTERVAL '2 minutes')
              )
          )
        FOR UPDATE OF c SKIP LOCKED
      ),
      lockable_jobs AS (
        SELECT cj.id, cj.campaign_id
        FROM campaign_jobs cj
        WHERE cj.campaign_id IN (SELECT id FROM ghosts)
          AND cj.status IN ('pending', 'processing')
        FOR UPDATE OF cj SKIP LOCKED
      ),
      kill_jobs AS (
        UPDATE campaign_jobs
        SET status = 'failed', completed_at = NOW(),
            error_message = 'Ghost campaign self-heal: orphan job from crashed enumeration'
        WHERE id IN (SELECT id FROM lockable_jobs)
        RETURNING campaign_id
      ),
      reset_counters AS (
        UPDATE campaigns
        SET deferred_count = 0, pending_count = 0, sent_count = 0, failed_count = 0,
            started_at = NULL
        WHERE id IN (SELECT campaign_id FROM kill_jobs)
        RETURNING id
      )
      INSERT INTO campaign_jobs (campaign_id, status, retry_count)
      SELECT id, 'pending', 0 FROM reset_counters
      RETURNING campaign_id
    `);
    if (result.rows.length > 0) {
      const ids = result.rows.map((r: any) => r.campaign_id);
      logger.warn(`[GHOST_SWEEP] Self-healed ${result.rows.length} ghost campaign(s): ${ids.join(', ')}`);
    }

    // Branch B — Task #181 mid-flight crash: started_at NOT NULL, sends
    // exist, but the cached campaign_sends max(sent_at) hasn't moved in
    // GHOST_SWEEP_MIN_AGE_MIN minutes AND no active/recent job is in
    // flight. Branch A would never fire (started_at not null + sends
    // exist), the legacy guardian's no-active-job branch would not fire
    // either (a processing job with a stale heartbeat still satisfies
    // "active"). The expanded campaign-guardian also detects this, but
    // running it here too means the recovery happens on whichever loop
    // fires next — defense in depth for the production incident that
    // motivated this task. We never touch counters or started_at: the
    // mid-flight state may be partly correct and the sender's resume
    // logic will reconcile from where it left off.
    const midFlight = await db.execute(sql`
      WITH stuck AS (
        SELECT c.id
        FROM campaigns c
        WHERE c.status = 'sending'
          AND c.started_at IS NOT NULL
          AND EXISTS (SELECT 1 FROM campaign_sends cs WHERE cs.campaign_id = c.id)
          AND NOT EXISTS (
            SELECT 1 FROM campaign_jobs cj
            WHERE cj.campaign_id = c.id
              AND (
                cj.status = 'pending'
                OR (cj.status = 'processing' AND (cj.heartbeat IS NULL OR cj.heartbeat > NOW() - (INTERVAL '1 minute' * ${GHOST_SWEEP_MIN_AGE_MIN})))
                OR (cj.status = 'failed' AND cj.completed_at > NOW() - INTERVAL '2 minutes')
              )
          )
          AND COALESCE(c.last_send_at, c.started_at)
              < NOW() - (INTERVAL '1 minute' * ${GHOST_SWEEP_MIN_AGE_MIN})
        FOR UPDATE OF c SKIP LOCKED
      ),
      kill_stale AS (
        UPDATE campaign_jobs
        SET status = 'failed', completed_at = NOW(),
            error_message = 'Ghost sweep mid-flight: stale processing job (heartbeat expired)'
        WHERE campaign_id IN (SELECT id FROM stuck)
          AND status = 'processing'
        RETURNING campaign_id
      )
      INSERT INTO campaign_jobs (campaign_id, status, retry_count)
      SELECT id, 'pending', 0 FROM stuck
      RETURNING campaign_id
    `);
    if (midFlight.rows.length > 0) {
      const ids = midFlight.rows.map((r: any) => r.campaign_id);
      logger.warn(`[GHOST_SWEEP] Mid-flight self-healed ${midFlight.rows.length} stuck campaign(s) (no progress, no active job): ${ids.join(', ')}`);
    }
  } catch (err) {
    logger.error('[GHOST_SWEEP] Sweep failed:', err);
  }
}

function startGhostCampaignSweep() {
  if (ghostCampaignSweepInterval) return;
  logger.info(`[GHOST_SWEEP] Starting ghost campaign sweep (${GHOST_SWEEP_INTERVAL_MS / 1000}s interval, min age ${GHOST_SWEEP_MIN_AGE_MIN}min)`);
  ghostCampaignSweepInterval = setInterval(sweepGhostCampaigns, GHOST_SWEEP_INTERVAL_MS);
  void sweepGhostCampaigns();
}

function stopGhostCampaignSweep() {
  if (ghostCampaignSweepInterval) {
    clearInterval(ghostCampaignSweepInterval);
    ghostCampaignSweepInterval = null;
    logger.info('[GHOST_SWEEP] Ghost campaign sweep stopped');
  }
}

// publishJobProgress now lives in ./job-events so workers outside this
// file (e.g. pressure-guard drain worker) can publish through the same
// SSE pipe without duplicating the Redis/EventEmitter routing logic.

async function processTagQueue() {
  if (!isPoolHealthy()) return;
  try {
    const operations = await storage.claimPendingTagOperations(50);

    if (operations.length === 0) {
      return;
    }

    const groups = new Map<string, typeof operations>();
    for (const op of operations) {
      const key = op.tagValue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(op);
    }

    for (const [tagValue, ops] of groups) {
      try {
        const subscriberIds = ops.map(op => op.subscriberId);
        await storage.bulkAddTagToSubscribers(subscriberIds, tagValue);
        for (const op of ops) {
          await storage.completeTagOperation(op.id);
        }
        for (const subId of subscriberIds) {
          checkAndEnrollForTrigger("tag_added", subId, { tagName: tagValue }).catch(() => {});
        }
      } catch (error: any) {
        logger.error(`Failed to bulk process tag operations for tag ${tagValue}:`, error);
        for (const op of ops) {
          await storage.failTagOperation(op.id, error.message || "Unknown error");
        }
      }
    }

    if (operations.length > 0) {
      logger.info(`Processed ${operations.length} tag operations in ${groups.size} bulk groups`);
    }
  } catch (error) {
    logger.error("Error in tag queue processing:", error);
  }
}

export function startTagQueueWorker() {
  if (tagQueueInterval) {
    return;
  }

  logger.info("Starting tag queue worker...");

  processTagQueue();
  tagQueueInterval = setInterval(processTagQueue, 2000);

  tagCleanupInterval = setInterval(async () => {
    try {
      const cleaned = await storage.cleanupCompletedTagOperations(7);
      if (cleaned > 0) {
        logger.info(`Cleaned up ${cleaned} completed tag operations`);
      }
    } catch (error) {
      logger.error("Error cleaning up tag operations:", error);
    }
  }, 60 * 60 * 1000);
}

function stopTagQueueWorker() {
  if (tagQueueInterval) {
    clearInterval(tagQueueInterval);
    tagQueueInterval = null;
  }
  if (tagCleanupInterval) {
    clearInterval(tagCleanupInterval);
    tagCleanupInterval = null;
  }
  logger.info("Tag queue worker stopped");
}

function startMemoryMonitor() {
  if (memoryCheckInterval) return;

  memoryCheckInterval = setInterval(() => {
    const memUsage = process.memoryUsage();
    const heapUsedMB = Math.round(memUsage.heapUsed / 1024 / 1024);
    const heapTotalMB = Math.round(memUsage.heapTotal / 1024 / 1024);
    const rssMB = Math.round(memUsage.rss / 1024 / 1024);

    if (heapUsedMB > MEMORY_CRITICAL_THRESHOLD_MB) {
      consecutiveHighMemoryCount++;
      logger.error('Memory critical', { heapUsedMB, heapTotalMB, rssMB, consecutiveHighMemoryCount });

      if (global.gc) {
        logger.warn('Forcing garbage collection');
        global.gc();
      }

      if (consecutiveHighMemoryCount >= 5) {
        logger.error('Memory critically high for extended period', { consecutiveHighMemoryCount, heapUsedMB, heapTotalMB, rssMB });
      }
      isMemoryPressure = true;
    } else if (heapUsedMB > MEMORY_WARN_THRESHOLD_MB) {
      consecutiveHighMemoryCount = 0;
      isMemoryPressure = false;
      logger.warn('Memory usage warning', { heapUsedMB, heapTotalMB, rssMB });
    } else {
      consecutiveHighMemoryCount = 0;
      isMemoryPressure = false;
    }
  }, MEMORY_CHECK_INTERVAL);
}

function stopMemoryMonitor() {
  if (memoryCheckInterval) {
    clearInterval(memoryCheckInterval);
    memoryCheckInterval = null;
  }
}

function startFlushJobProcessor() {
  if (flushJobPollingInterval) {
    return;
  }
  logger.info(`Starting flush job processor with worker ID: ${WORKER_ID}`);
  flushJobPollingInterval = setInterval(pollForFlushJobs, 5000);
  pollForFlushJobs();
}

function stopFlushJobProcessor() {
  if (flushJobPollingInterval) {
    clearInterval(flushJobPollingInterval);
    flushJobPollingInterval = null;
    logger.info("Flush job processor stopped");
  }
}

export async function triggerFlushJobPoll(): Promise<void> {
  return pollForFlushJobs();
}

async function pollForFlushJobs() {
  if (isMemoryPressure) {
    logger.warn('Skipping flush job poll - memory pressure active');
    return;
  }
  if (!isPoolHealthy()) {
    logger.debug('Skipping flush job poll - pool connections saturated');
    return;
  }
  try {
    const job = await storage.claimFlushJob(WORKER_ID);
    if (!job) {
      return;
    }

    logger.info(`Worker ${WORKER_ID} claimed flush job ${job.id} (${job.totalRows} subscribers)`);
    activeFlushJob = true;

    try {
      const actualProcessed = await processFlushJob(job.id, job.totalRows);
      await storage.completeFlushJob(job.id, "completed", undefined, actualProcessed);
      flushJobsTotal.inc({ status: 'completed' });
      await storage.invalidateSegmentCountCache();
      logger.info(`Flush job ${job.id} completed successfully (${actualProcessed} rows deleted)`);
      publishJobProgress({
        jobType: "flush",
        jobId: job.id,
        status: "completed",
        processedRows: actualProcessed,
        totalRows: actualProcessed,
        phase: "completed",
      });
    } catch (error: any) {
      logger.error(`Error processing flush job ${job.id}:`, error);
      await storage.completeFlushJob(job.id, "failed", error.message || "Unknown error");
      flushJobsTotal.inc({ status: 'failed' });
      publishJobProgress({
        jobType: "flush",
        jobId: job.id,
        status: "failed",
        processedRows: 0,
        totalRows: job.totalRows,
        errorMessage: error.message || "Unknown error",
      });
    } finally {
      activeFlushJob = false;
    }
  } catch (error) {
    logger.error("Error in flush job polling:", error);
  }
}

async function retryOnDeadlock<T>(fn: () => Promise<T>, label: string, maxRetries = 5): Promise<T> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      const msg = (error.message || '').toLowerCase();
      if (msg.includes('deadlock') && attempt < maxRetries) {
        const delay = Math.min(500 * Math.pow(2, attempt - 1), 5000);
        logger.warn(`[FLUSH] Deadlock detected in ${label}, retry ${attempt}/${maxRetries} after ${delay}ms`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      throw error;
    }
  }
  throw new Error(`${label} failed after max retries`);
}

async function processFlushJob(jobId: string, subscriberCount: number): Promise<number> {
  logger.info(`[FLUSH] Job ${jobId}: Counting dependent rows...`);
  const depCount = await storage.countSubscriberDependencies();
  const totalRows = depCount + subscriberCount;
  logger.info(`[FLUSH] Job ${jobId}: ${depCount} dependency rows + ${subscriberCount} subscribers = ${totalRows} total`);

  if (totalRows !== subscriberCount) {
    await storage.updateFlushJobTotalRows(jobId, totalRows);
  }

  let processedRows = 0;

  publishJobProgress({
    jobType: "flush",
    jobId,
    status: "processing",
    processedRows: 0,
    totalRows,
    phase: "clearing_dependencies",
  });

  logger.info(`[FLUSH] Job ${jobId}: Clearing dependent tables first...`);
  await retryOnDeadlock(
    () => storage.clearSubscriberDependencies((deletedInBatch) => {
      processedRows += deletedInBatch;
      storage.updateFlushJobProgress(jobId, processedRows);
      publishJobProgress({
        jobType: "flush",
        jobId,
        status: "processing",
        processedRows,
        totalRows,
        phase: "clearing_dependencies",
      });
    }),
    'clearSubscriberDependencies'
  );
  logger.info(`[FLUSH] Job ${jobId}: Dependent tables cleared (${processedRows} rows). Starting subscriber deletion...`);

  let usedTruncate = false;
  try {
    logger.info(`[FLUSH] Job ${jobId}: Attempting TRUNCATE subscribers CASCADE...`);
    await storage.truncateSubscribers();
    processedRows = totalRows;
    usedTruncate = true;
    logger.info(`[FLUSH] Job ${jobId}: TRUNCATE succeeded — all ${subscriberCount} subscribers deleted instantly`);

    await storage.updateFlushJobProgress(jobId, processedRows);
    publishJobProgress({
      jobType: "flush",
      jobId,
      status: "processing",
      processedRows,
      totalRows,
      phase: "deleting_subscribers",
    });
  } catch (truncateErr: any) {
    logger.warn(`[FLUSH] Job ${jobId}: TRUNCATE failed (${truncateErr.message}), falling back to batched DELETE`);
  }

  if (!usedTruncate) {
    let consecutiveStalls = 0;
    const MAX_CONSECUTIVE_STALLS = 3;

    while (processedRows < totalRows) {
      const job = await storage.getFlushJob(jobId);
      if (!job || job.status === "cancelled") {
        logger.info(`Flush job ${jobId} was cancelled`);
        return;
      }

      const deletedCount = await retryOnDeadlock(
        () => storage.deleteSubscriberBatch(FLUSH_BATCH_SIZE),
        `deleteSubscriberBatch`
      );

      if (deletedCount === 0) {
        const remaining = await storage.countAllSubscribers();
        if (remaining === 0) {
          processedRows = totalRows;
          break;
        }

        let retried = false;
        for (let retry = 0; retry < 5; retry++) {
          logger.warn(`[FLUSH] Job ${jobId}: deleteSubscriberBatch returned 0 but ${remaining} subscribers remain, retry ${retry + 1}/5`);
          await new Promise(resolve => setTimeout(resolve, 1000));

          const retryCount = await retryOnDeadlock(
            () => retry >= 2
              ? storage.deleteSubscriberBatchByCtid(FLUSH_BATCH_SIZE)
              : storage.deleteSubscriberBatch(FLUSH_BATCH_SIZE),
            `deleteSubscriberBatch-retry`
          );
          if (retryCount > 0) {
            processedRows += retryCount;
            await storage.updateFlushJobProgress(jobId, processedRows);
            publishJobProgress({
              jobType: "flush",
              jobId,
              status: "processing",
              processedRows,
              totalRows,
              phase: "deleting_subscribers",
            });
            retried = true;
            consecutiveStalls = 0;
            break;
          }
        }
        if (!retried) {
          consecutiveStalls++;
          if (consecutiveStalls >= MAX_CONSECUTIVE_STALLS) {
            const finalRemaining = await storage.countAllSubscribers();
            if (finalRemaining === 0) {
              processedRows = totalRows;
              logger.info(`[FLUSH] Job ${jobId}: All subscribers deleted (confirmed by count)`);
            } else {
              logger.error(`[FLUSH] Job ${jobId}: Could not delete remaining ${finalRemaining} subscribers after ${MAX_CONSECUTIVE_STALLS} consecutive stalls. Stopping.`);
            }
            break;
          }
          logger.warn(`[FLUSH] Job ${jobId}: Stall ${consecutiveStalls}/${MAX_CONSECUTIVE_STALLS} — re-counting and retrying outer loop`);
          const freshRemaining = await storage.countAllSubscribers();
          if (freshRemaining === 0) {
            processedRows = totalRows;
            break;
          }
          await new Promise(resolve => setTimeout(resolve, 2000));
          continue;
        }
        continue;
      }

      consecutiveStalls = 0;
      processedRows += deletedCount;
      await storage.updateFlushJobProgress(jobId, processedRows);

      publishJobProgress({
        jobType: "flush",
        jobId,
        status: "processing",
        processedRows,
        totalRows,
        phase: "deleting_subscribers",
      });

      logger.info(`[FLUSH] Job ${jobId}: Deleted ${processedRows}/${totalRows} total (${Math.round(processedRows/totalRows*100)}%)`);

      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }

  await storage.updateFlushJobProgress(jobId, processedRows);
  return processedRows;
}

const MAX_CONCURRENT_CAMPAIGNS = Math.max(1, parseInt(process.env.MAX_CONCURRENT_CAMPAIGNS || '8', 10) || 8);
const activeCampaigns = new Set<string>();
let isPolling = false;
let campaignJobWakeup: (() => void) | null = null;

export async function processCampaign(campaignId: string) {
  const existingStatus = await storage.getJobStatus(campaignId);
  if (existingStatus) {
    logger.info(`Campaign ${campaignId} already has a ${existingStatus} job`);
    return;
  }

  await storage.enqueueCampaignJob(campaignId);
  await messageQueue.notify("campaign_jobs", { campaignId });
  logger.info(`Campaign ${campaignId} added to PostgreSQL job queue`);
}

async function handleJobCompletion(job: CampaignJob) {
  try {
    const finalStatus = await storage.getCampaignStatus(job.campaignId);
    if (finalStatus === "paused") {
      await storage.completeJob(job.id, "failed", `Campaign paused - no automatic retry for paused campaigns`);
      logger.info(`[JOB_POLL] Job ${job.id} ended - campaign ${job.campaignId} is paused (skipping retry)`);
    } else if (finalStatus === "failed") {
      const campaignData = await storage.getCampaign(job.campaignId);
      let retryDeadline = campaignData?.retryUntil;
      const jobRetryCount = (job as any).retryCount || 0;

      if (!retryDeadline) {
        retryDeadline = new Date(Date.now() + 12 * 60 * 60 * 1000);
        await storage.updateCampaign(job.campaignId, { retryUntil: retryDeadline });
        logger.info(`[JOB_POLL] Set retry deadline for campaign ${job.campaignId}: ${retryDeadline.toISOString()}`);
      }

      if (Date.now() < retryDeadline.getTime()) {
        const backoffSeconds = Math.min(30 * Math.pow(2, jobRetryCount), 15 * 60);
        await storage.completeJob(job.id, "failed", `Campaign failed - scheduling retry #${jobRetryCount + 1}`);
        await storage.updateCampaign(job.campaignId, { status: "sending", pauseReason: null });
        await storage.enqueueCampaignJobWithRetry(job.campaignId, jobRetryCount + 1, backoffSeconds);
        logger.info(`[JOB_POLL] Campaign ${job.campaignId} failed - retry #${jobRetryCount + 1} scheduled in ${backoffSeconds}s (deadline: ${retryDeadline.toISOString()})`);
      } else {
        await storage.completeJob(job.id, "failed", `Campaign ended in failed state (retry window expired)`);
        logger.info(`[JOB_POLL] Job ${job.id} marked failed (campaign ${job.campaignId} status: failed, no more retries)`);
      }
    } else {
      await storage.completeJob(job.id, "completed");
      logger.info(`[JOB_POLL] Job ${job.id} completed (campaign ${job.campaignId} status: ${finalStatus})`);
      // Sends/opens/clicks for this campaign just changed materially.
      // Invalidate the analytics cache so the next read reflects reality
      // instead of waiting up to 5 minutes for the TTL to expire.
      try {
        // Use the cross-process publisher so the web instance (which serves
        // the analytics endpoints) drops its cache too. In monolith mode
        // both calls collapse onto the same in-memory cache.
        const { publishAnalyticsInvalidation } = await import("./repositories/analytics-ops");
        publishAnalyticsInvalidation();
      } catch (cacheErr) {
        logger.warn(`[JOB_POLL] Failed to invalidate analytics cache: ${(cacheErr as Error).message}`);
      }
    }
  } catch (err) {
    logger.error(`[JOB_POLL] Error in handleJobCompletion for job ${job.id}:`, err);
  }
}

async function handleJobError(job: CampaignJob, error: any) {
  const jobRetryCount = (job as any).retryCount || 0;
  const errMsg = (error?.message || String(error || '')).toString();

  const senderAlreadyRetried = !!(error as any)?.senderRetriesExhausted;
  const classified = senderAlreadyRetried
    ? (error as any).classification
    : classifyDbError(error);
  const isTransientDb = classified.transient;
  const errMeta = `kind=${classified.kind}, code=${classified.code ?? 'n/a'}, transient=${isTransientDb}, senderRetried=${senderAlreadyRetried}`;

  let campaignData: Awaited<ReturnType<typeof storage.getCampaign>> | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      campaignData = await storage.getCampaign(job.campaignId) ?? null;
      break;
    } catch (fetchErr) {
      logger.warn(`[JOB_POLL] getCampaign(${job.campaignId}) failed (attempt ${attempt + 1}/3): ${(fetchErr as Error).message}`);
      if (attempt < 2) await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
    }
  }

  if (!campaignData) {
    const backoffSeconds = Math.min(60 * Math.pow(2, jobRetryCount), 15 * 60);
    logger.warn(`[JOB_POLL] Cannot fetch campaign ${job.campaignId} — DB likely down. Requeuing job in ${backoffSeconds}s (retry #${jobRetryCount + 1}). Original error [${errMeta}]: ${errMsg}`);
    try {
      await storage.completeJob(job.id, "failed", `DB unreachable during error handling — safe requeue (retry #${jobRetryCount + 1})`);
    } catch { /* best-effort */ }
    try {
      await storage.enqueueCampaignJobWithRetry(job.campaignId, jobRetryCount + 1, backoffSeconds);
    } catch (requeueErr) {
      logger.error(`[JOB_POLL] Failed to requeue campaign ${job.campaignId} after DB outage — resumeInterruptedCampaigns will recover it: ${(requeueErr as Error).message}`);
    }
    return;
  }

  const campaignStatus = campaignData.status;

  if (campaignStatus === "paused") {
    try {
      await storage.completeJob(job.id, "failed", `Campaign paused - no automatic retry for paused campaigns`);
      logger.info(`[JOB_POLL] Job ${job.id} error but campaign ${job.campaignId} is paused (skipping retry) [${errMeta}]`);
    } catch (completeErr) {
      logger.error(`[JOB_POLL] Failed to mark job ${job.id} as failed:`, completeErr);
    }
  } else {
    let retryDeadline = campaignData.retryUntil;

    const nowMsErr = Date.now();
    const needsFreshDeadline = !retryDeadline || retryDeadline.getTime() <= nowMsErr;
    if (needsFreshDeadline) {
      retryDeadline = new Date(nowMsErr + 12 * 60 * 60 * 1000);
      await storage.updateCampaign(job.campaignId, { retryUntil: retryDeadline }).catch(() => {});
      logger.info(`[JOB_POLL] Refreshed retry deadline for campaign ${job.campaignId} to ${retryDeadline.toISOString()}`);
    }

    if (isTransientDb) {
      const backoffSeconds = Math.min(30 * Math.pow(2, jobRetryCount), 15 * 60);
      try {
        await storage.completeJob(job.id, "failed", `Transient DB error [${errMeta}]: ${errMsg} - requeuing in ${backoffSeconds}s`);
        await storage.updateCampaign(job.campaignId, { status: "sending", pauseReason: null });
        await storage.enqueueCampaignJobWithRetry(job.campaignId, jobRetryCount + 1, backoffSeconds);
        logger.warn(`[JOB_POLL] Campaign ${job.campaignId} hit transient DB error - requeued in ${backoffSeconds}s (retry #${jobRetryCount + 1}) [${errMeta}]: ${errMsg}`);
        return;
      } catch (transientRetryErr) {
        logger.error(`[JOB_POLL] Failed to requeue after transient DB error for ${job.campaignId}:`, transientRetryErr);
      }
    }

    if (retryDeadline && Date.now() < retryDeadline.getTime()) {
      const backoffSeconds = Math.min(30 * Math.pow(2, jobRetryCount), 15 * 60);
      try {
        await storage.completeJob(job.id, "failed", `Error [${errMeta}]: ${errMsg} - scheduling retry #${jobRetryCount + 1}`);
        await storage.updateCampaign(job.campaignId, { status: "sending", pauseReason: null });
        await storage.enqueueCampaignJobWithRetry(job.campaignId, jobRetryCount + 1, backoffSeconds);
        logger.info(`[JOB_POLL] Campaign ${job.campaignId} error - retry #${jobRetryCount + 1} scheduled in ${backoffSeconds}s [${errMeta}]`);
      } catch (retryErr) {
        logger.error(`[JOB_POLL] Failed to schedule retry for campaign ${job.campaignId}:`, retryErr);
        try {
          await storage.completeJob(job.id, "failed", errMsg || "Unknown error");
        } catch (completeErr) {
          logger.error(`[JOB_POLL] Failed to mark job ${job.id} as failed:`, completeErr);
        }
      }
    } else {
      try {
        await storage.completeJob(job.id, "failed", errMsg || "Unknown error");
      } catch (completeErr) {
        logger.error(`[JOB_POLL] Failed to mark job ${job.id} as failed:`, completeErr);
      }
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await storage.updateCampaignStatusAtomic(job.campaignId, "failed");
          logger.info(`[JOB_POLL] Campaign ${job.campaignId} marked as failed (attempt ${attempt + 1}) [${errMeta}]`);
          break;
        } catch (statusErr) {
          logger.error(`[JOB_POLL] Failed to mark campaign ${job.campaignId} as failed (attempt ${attempt + 1}):`, statusErr);
          if (attempt < 2) await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
        }
      }
    }
  }
}

async function runCampaignJob(job: CampaignJob) {
  logger.info(`[JOB_POLL] Worker ${WORKER_ID} started job ${job.id} for campaign ${job.campaignId} (${activeCampaigns.size}/${MAX_CONCURRENT_CAMPAIGNS} active)`);

  try {
    await processCampaignInternal(job.campaignId, job.id);
    await handleJobCompletion(job);
  } catch (error: any) {
    logger.error(`[JOB_POLL] Error processing job ${job.id} for campaign ${job.campaignId}:`, error);
    await handleJobError(job, error);
  } finally {
    activeCampaigns.delete(job.campaignId);
    logger.info(`[JOB_POLL] Campaign ${job.campaignId} finished (${activeCampaigns.size}/${MAX_CONCURRENT_CAMPAIGNS} active)`);
  }
}

export async function triggerCampaignJobPoll(): Promise<void> {
  return pollForJobs();
}

async function pollForJobs() {
  if (isPolling) return;
  isPolling = true;

  try {
    if (isMemoryPressure) {
      logger.warn('[JOB_POLL] Skipping - memory pressure active');
      return;
    }
    if (!isPoolHealthy()) {
      logger.debug('[JOB_POLL] Skipping - pool connections saturated');
      return;
    }

    const staleCount = await storage.cleanupStaleJobs(30);
    if (staleCount > 0) {
      logger.info(`[JOB_POLL] Cleaned up ${staleCount} stale jobs`);
    }

    while (activeCampaigns.size < MAX_CONCURRENT_CAMPAIGNS) {
      const job = await storage.claimNextJob(WORKER_ID);
      if (!job) break;

      if (activeCampaigns.has(job.campaignId)) {
        await storage.completeJob(job.id, "failed", "Duplicate job for already-active campaign");
        logger.warn(`[JOB_POLL] Skipped duplicate job ${job.id} - campaign ${job.campaignId} already active`);
        continue;
      }

      activeCampaigns.add(job.campaignId);
      runCampaignJob(job);
    }
  } catch (error) {
    logger.error("[JOB_POLL] Error in job polling:", error);
  } finally {
    isPolling = false;
  }
}

async function checkMtaRecovery() {
  try {
    const pausedCampaigns = await storage.getCampaignsByPauseReason("mta_down");

    for (const campaign of pausedCampaigns) {
      if (!campaign.mtaId) continue;

      const mta = await storage.getMta(campaign.mtaId);
      if (!mta) continue;

      const isNullsinkMta = (mta as any).mode === "nullsink";
      if (isNullsinkMta) {
        logger.info(`Nullsink MTA ${mta.name} - auto-resuming campaign ${campaign.id} (no SMTP to verify)`);
        await storage.clearStuckJobsForCampaign(campaign.id);
        await storage.updateCampaign(campaign.id, { status: "sending", pauseReason: null });
        await storage.enqueueCampaignJob(campaign.id);
        continue;
      }

      const verifyResult = await verifyTransporter(mta);

      if (verifyResult.success) {
        logger.info(`MTA ${mta.name} is back online - resuming campaign ${campaign.id} (${campaign.name})`);
        await storage.clearStuckJobsForCampaign(campaign.id);
        await storage.updateCampaign(campaign.id, { status: "sending", pauseReason: null });
        await storage.enqueueCampaignJob(campaign.id);
      }
    }
  } catch (error) {
    logger.error("Error checking MTA recovery:", error);
  }

  try {
    const dbPausedCampaigns = await storage.getCampaignsByPauseReason("db_connection_error");

    for (const campaign of dbPausedCampaigns) {
      try {
        await db.execute(sql`SELECT 1`);
        logger.info(`[DB_RECOVERY] DB connection healthy — auto-resuming campaign ${campaign.id} (${campaign.name})`);
        await storage.clearStuckJobsForCampaign(campaign.id);
        await storage.updateCampaign(campaign.id, { status: "sending", pauseReason: null });
        await storage.enqueueCampaignJob(campaign.id);
      } catch (pingErr) {
        logger.warn(`[DB_RECOVERY] DB still unhealthy for campaign ${campaign.id}: ${(pingErr as Error).message}`);
        break;
      }
    }
  } catch (error) {
    logger.error("[DB_RECOVERY] Error checking DB connection recovery:", error);
  }
}

async function resumeInterruptedCampaigns() {
  try {
    const staleResult = await db.execute(sql`
      UPDATE campaign_jobs
      SET status = 'failed',
          completed_at = NOW(),
          error_message = 'Job abandoned by dead worker'
      WHERE status = 'processing'
        AND worker_id IS NOT NULL
        AND worker_id != ${WORKER_ID}
      RETURNING id, campaign_id
    `);
    if (staleResult.rows.length > 0) {
      logger.info(`[RECOVERY] Cleaned up ${staleResult.rows.length} stale job(s) from dead workers`);
    }

    const result = await db.execute(sql`
      SELECT c.id, c.name FROM campaigns c
      WHERE c.status = 'sending'
      AND NOT EXISTS (
        SELECT 1 FROM campaign_jobs cj 
        WHERE cj.campaign_id = c.id 
        AND (
          cj.status IN ('pending', 'processing')
          OR (cj.status = 'failed' AND cj.completed_at > NOW() - INTERVAL '2 minutes')
        )
      )
    `);

    const stuckCampaigns = result.rows as Array<{ id: string; name: string }>;

    if (stuckCampaigns.length > 0) {
      logger.info(`[RECOVERY] Found ${stuckCampaigns.length} interrupted campaign(s) to resume`);
      for (const campaign of stuckCampaigns) {
        logger.info(`[RECOVERY] Re-enqueuing campaign ${campaign.id} (${campaign.name})`);
        await storage.enqueueCampaignJob(campaign.id);
      }
    }

    const crashedResult = await db.execute(sql`
      SELECT c.id, c.name, c.retry_until FROM campaigns c
      WHERE c.status = 'failed'
        AND EXISTS (
          SELECT 1 FROM campaign_sends cs
          WHERE cs.campaign_id = c.id
            AND cs.status IN ('pending', 'attempting')
        )
        AND EXISTS (
          SELECT 1 FROM campaign_jobs cj
          WHERE cj.campaign_id = c.id
            AND cj.status = 'failed'
            AND cj.error_message LIKE '%abandoned by dead worker%'
            AND cj.completed_at > NOW() - INTERVAL '30 minutes'
        )
        AND NOT EXISTS (
          SELECT 1 FROM campaign_jobs cj
          WHERE cj.campaign_id = c.id
            AND cj.status IN ('pending', 'processing')
        )
    `);

    const crashedCampaigns = crashedResult.rows as Array<{ id: string; name: string; retry_until: Date | null }>;

    if (crashedCampaigns.length > 0) {
      logger.info(`[RECOVERY] Found ${crashedCampaigns.length} crash-failed campaign(s) with unsent subscribers — resuming`);
      for (const campaign of crashedCampaigns) {
        const nowMs = Date.now();
        const existingDeadline = campaign.retry_until;
        const retryDeadline = (existingDeadline && existingDeadline.getTime() > nowMs)
          ? existingDeadline
          : new Date(nowMs + 12 * 60 * 60 * 1000);
        await storage.clearStuckJobsForCampaign(campaign.id);
        await storage.updateCampaign(campaign.id, {
          status: "sending",
          pauseReason: null,
          retryUntil: retryDeadline,
        });
        await storage.enqueueCampaignJob(campaign.id);
        logger.info(`[RECOVERY] Resumed crash-failed campaign ${campaign.id} (${campaign.name}) — retry deadline: ${retryDeadline.toISOString()}`);
      }
    }

    const stuckImportQueue = await db.execute(sql`
      UPDATE import_job_queue q
      SET status = 'pending',
          started_at = NULL,
          heartbeat = NULL,
          worker_id = NULL,
          retry_count = retry_count + 1
      WHERE q.status = 'processing'
        AND NOT EXISTS (
          SELECT 1 FROM import_jobs j
          WHERE j.id = q.import_job_id
          AND j.status IN ('cancelled', 'completed')
        )
      RETURNING q.import_job_id
    `);

    if (stuckImportQueue.rows.length > 0) {
      logger.info(`[RECOVERY] Reset ${stuckImportQueue.rows.length} stuck import queue item(s)`);
    }

    const completedImports = await db.execute(sql`
      UPDATE import_jobs SET status = 'completed',
        error_message = NULL,
        completed_at = COALESCE(completed_at, NOW())
      WHERE status = 'processing'
        AND COALESCE(total_rows, 0) > 0
        AND COALESCE(processed_rows, 0) >= COALESCE(total_rows, 0)
      RETURNING id, filename
    `);

    if (completedImports.rows.length > 0) {
      logger.info(`[RECOVERY] Marked ${completedImports.rows.length} interrupted import(s) as completed (all rows processed)`);
    }

    const stuckImports = await db.execute(sql`
      UPDATE import_jobs SET status = 'pending', error_message = 'Interrupted by server restart - will retry'
      WHERE status = 'processing'
      RETURNING id, filename
    `);

    if (stuckImports.rows.length > 0) {
      logger.info(`[RECOVERY] Reset ${stuckImports.rows.length} stuck import job(s)`);
    }

    const stuckFlushJobs = await db.execute(sql`
      UPDATE flush_jobs SET status = 'pending', error_message = 'Interrupted by server restart - will retry'
      WHERE status = 'processing'
      RETURNING id
    `);

    if (stuckFlushJobs.rows.length > 0) {
      logger.info(`[RECOVERY] Reset ${stuckFlushJobs.rows.length} stuck flush job(s)`);
    }
  } catch (error) {
    logger.error('[RECOVERY] Error resuming interrupted campaigns:', error);
  }
}

async function pollScheduledCampaigns() {
  if (!isPoolHealthy()) return;
  try {
    // Step 1: terminate due follow-up children with zero opener audience
    // immediately as 'completed' (count 0) so they never enter the send
    // loop. This honors the spec's "if zero recipients, mark completed
    // immediately" requirement at promotion time, while still allowing
    // late opens to accumulate during the entire delay window.
    const dueFollowUps = await db.execute(sql`
      SELECT id, name, parent_campaign_id
      FROM campaigns
      WHERE status = 'scheduled'
        AND scheduled_at <= NOW()
        AND parent_campaign_id IS NOT NULL
    `);
    for (const row of (dueFollowUps.rows as Array<{ id: string; name: string; parent_campaign_id: string }>)) {
      const openerCount = await storage.countOpenersForParentCampaign(row.parent_campaign_id);
      if (openerCount === 0) {
        await db.execute(sql`
          UPDATE campaigns
          SET status = 'completed', completed_at = NOW(), pending_count = 0
          WHERE id = ${row.id} AND status = 'scheduled'
        `);
        // Task #199: status transition in the worker — fan out cache invalidation.
        publishCampaignsListInvalidation();
        logger.info(`[SCHEDULE_POLL] Follow-up ${row.id} (${row.name}) had 0 openers at promotion time — marked completed without sending`);
      }
    }

    // Step 2: promote remaining due 'scheduled' campaigns to 'sending'.
    const result = await db.execute(sql`
      WITH promoted AS (
        UPDATE campaigns
        SET status = 'sending'
        WHERE status = 'scheduled'
          AND scheduled_at <= NOW()
        RETURNING id, name
      )
      INSERT INTO campaign_jobs (campaign_id, status)
      SELECT id, 'pending' FROM promoted
      WHERE NOT EXISTS (
        SELECT 1 FROM campaign_jobs cj
        WHERE cj.campaign_id = promoted.id
          AND cj.status IN ('pending', 'processing')
      )
      RETURNING campaign_id, (SELECT name FROM promoted WHERE promoted.id = campaign_id) AS name
    `);
    const launched = result.rows as Array<{ campaign_id: string; name: string }>;
    // Task #199: scheduled → sending transition in the worker — fan out cache invalidation.
    if (launched.length > 0) publishCampaignsListInvalidation();
    for (const row of launched) {
      await messageQueue.notify("campaign_jobs", { campaignId: row.campaign_id }).catch(() => {});
      logger.info(`[SCHEDULE_POLL] Campaign ${row.campaign_id} (${row.name}) scheduled time reached — transitioned to sending`);
    }
  } catch (error) {
    logger.error("[SCHEDULE_POLL] Error polling scheduled campaigns:", error);
  }
}

function startScheduledCampaignPoller() {
  if (scheduledCampaignInterval) return;
  logger.info("[SCHEDULE_POLL] Starting scheduled campaign poller (30s interval)");
  scheduledCampaignInterval = setInterval(pollScheduledCampaigns, 30000);
  pollScheduledCampaigns();
}

function stopScheduledCampaignPoller() {
  if (scheduledCampaignInterval) {
    clearInterval(scheduledCampaignInterval);
    scheduledCampaignInterval = null;
    logger.info("[SCHEDULE_POLL] Scheduled campaign poller stopped");
  }
}

// ─── Auto-resend follow-up spawner (Task #56) ────────────────────────────
// Polls campaigns with follow_up_enabled=true and follow_up_scheduled_at<=NOW()
// (capped via the partial index) and spawns the child draft, atomically
// linking parent→child. The child is immediately promoted to 'sending' and a
// campaign_jobs row is created so the existing worker pipeline picks it up
// — exactly the same path as a scheduled campaign reaching its time.
//
// Worker-only: gated by the same DISABLE_WORKERS / PROCESS_TYPE check as
// startScheduledCampaignPoller (called from startJobProcessor below). Safe to
// run on every worker because spawnFollowUpCampaign uses an INSERT against a
// partial-unique index, so race losers no-op.
const FOLLOWUP_POLL_INTERVAL_MS = Number(process.env.FOLLOWUP_POLL_INTERVAL_MS ?? 60_000);
let followUpInterval: NodeJS.Timeout | null = null;

async function pollFollowUpCampaigns() {
  if (!isPoolHealthy()) return;
  try {
    const candidates = await storage.findFollowUpCandidates(25);
    if (candidates.length === 0) return;
    logger.info(`[FOLLOWUP_POLL] Found ${candidates.length} parent campaign(s) ready for follow-up`);
    for (const parent of candidates) {
      try {
        const child = await storage.spawnFollowUpCampaign(parent);
        if (!child) continue; // race loser; another worker handled it
        logger.info(`[FOLLOWUP_POLL] Spawned follow-up child=${child.id} for parent=${parent.id} (${parent.name}) — sends at ${child.scheduledAt?.toISOString()}`);
      } catch (err: any) {
        logger.error(`[FOLLOWUP_POLL] Failed to spawn follow-up for parent=${parent.id}: ${err?.message || err}`);
      }
    }
  } catch (error) {
    logger.error("[FOLLOWUP_POLL] Error polling follow-up candidates:", error);
  }
}

function startFollowUpSpawner() {
  if (followUpInterval) return;
  logger.info(`[FOLLOWUP_POLL] Starting follow-up spawner (${FOLLOWUP_POLL_INTERVAL_MS}ms interval)`);
  followUpInterval = setInterval(pollFollowUpCampaigns, FOLLOWUP_POLL_INTERVAL_MS);
  pollFollowUpCampaigns();
}

function stopFollowUpSpawner() {
  if (followUpInterval) {
    clearInterval(followUpInterval);
    followUpInterval = null;
    logger.info("[FOLLOWUP_POLL] Follow-up spawner stopped");
  }
}

// ─── Automation workflow processor ────────────────────────────────────────
const AUTOMATION_POLL_INTERVAL_MS = Number(process.env.AUTOMATION_POLL_INTERVAL_MS ?? 15_000);

function startAutomationProcessor() {
  if (automationPollingInterval) return;
  logger.info(`[AUTOMATION] Starting automation processor (${AUTOMATION_POLL_INTERVAL_MS}ms interval)`);
  // Wait for the automation bootstrap (mta_id column) to complete before the
  // first poll touches automation_workflows. Mirrors the import bootstrap call.
  runAutomationBootstrapMigrations()
    .catch((err: any) => logger.error(`[AUTOMATION] Bootstrap (worker) failed (non-fatal): ${err?.message || err}`))
    .finally(() => {
      automationPollingInterval = setInterval(pollAutomationEnrollments, AUTOMATION_POLL_INTERVAL_MS);
      pollAutomationEnrollments();
    });
}

function stopAutomationProcessor() {
  if (automationPollingInterval) {
    clearInterval(automationPollingInterval);
    automationPollingInterval = null;
    logger.info("[AUTOMATION] Automation processor stopped");
  }
}

export async function triggerAutomationPoll(): Promise<void> {
  return pollAutomationEnrollments();
}

async function pollAutomationEnrollments() {
  if (isMemoryPressure) return;
  if (!isPoolHealthy()) return;
  try {
    const processed = await processAutomationEnrollments();
    if (processed > 0) {
      logger.info(`[AUTOMATION] Processed ${processed} enrollment(s)`);
    }
  } catch (err: any) {
    logger.error(`[AUTOMATION] Error in automation polling: ${err.message}`);
  }
}

async function startJobProcessor() {
  if (jobPollingInterval) {
    return;
  }

  logger.info(`[JOB_POLL] Starting job processor with worker ID: ${WORKER_ID}, max concurrent campaigns: ${MAX_CONCURRENT_CAMPAIGNS}`);

  // campaign-job stall RCA (2026-05-19) — Boot-time + periodic cleanup of stranded
  // idle-in-transaction backends from a prior crashed worker. Without
  // this, the first poll cycle blocks on advisory/row locks held by
  // dead backends until Neon's idle_in_transaction_session_timeout
  // fires (now 60s via injected backend options, was 5min). See
  // db-zombie-killer.ts for the full RCA from the 2026-05-19 outage.
  try {
    const { startZombieCleanup } = await import("./db-zombie-killer");
    startZombieCleanup();
  } catch (err: any) {
    logger.warn(`[JOB_POLL] Failed to start DB zombie cleanup (non-fatal): ${err?.message || err}`);
  }

  jobPollingInterval = setInterval(pollForJobs, 10000);

  messageQueue.onMessage("campaign_jobs", (payload) => {
    logger.info(`[JOB_POLL] NOTIFY received for campaign_jobs, triggering immediate poll`);
    pollForJobs();
  });

  const startupStaleCount = await storage.cleanupStaleJobs(0);
  if (startupStaleCount > 0) {
    logger.info(`[JOB_POLL] Startup: cleaned up ${startupStaleCount} orphaned processing jobs`);
  }

  db.execute(sql`
    UPDATE campaign_sends
    SET status = 'failed'
    WHERE status = 'attempting'
      AND sent_at < NOW() - INTERVAL '1 hour'
  `).then((r: any) => {
    const count = Number(r.rowCount ?? 0);
    if (count > 0) {
      logger.warn(`[JOB_POLL] Startup: marked ${count} stale 'attempting' campaign_sends as 'failed' (process crash during send)`);
    }
  }).catch((err: any) => {
    logger.error(`[JOB_POLL] Startup: failed to clean up stale attempting sends: ${err.message}`);
  });

  pollForJobs();

  resumeInterruptedCampaigns();

  startImportJobProcessor();

  startFlushJobProcessor();

  if (!mtaRecoveryInterval) {
    mtaRecoveryInterval = setInterval(checkMtaRecovery, 30000);
    logger.info("MTA recovery checker started (30s interval)");
  }

  setInterval(() => {
    resumeInterruptedCampaigns();
  }, 60000);
  logger.info("Stuck campaign recovery checker started (60s interval)");

  startMemoryMonitor();
}

function stopJobProcessor() {
  stopMemoryMonitor();
  if (jobPollingInterval) {
    clearInterval(jobPollingInterval);
    jobPollingInterval = null;
    logger.info("Job processor stopped");
  }
  if (mtaRecoveryInterval) {
    clearInterval(mtaRecoveryInterval);
    mtaRecoveryInterval = null;
    logger.info("MTA recovery checker stopped");
  }
  stopImportJobProcessor();
  stopFlushJobProcessor();
}

function startImportJobProcessor() {
  if (importJobPollingInterval) {
    return;
  }

  logger.info(`Starting import job processor with worker ID: ${WORKER_ID}`);

  db.execute(sql`
    DELETE FROM import_staging s
    WHERE NOT EXISTS (
      SELECT 1 FROM import_jobs j 
      WHERE j.id = s.job_id 
      AND j.status = 'processing'
    )
  `)
    .then(() => logger.info('[IMPORT] Cleaned up orphaned import_staging data on startup (excluding active jobs)'))
    .catch((err: any) => logger.error('[IMPORT] Failed to clean up import_staging on startup:', err.message));

  storage.areGinIndexesPresent().then(async (present) => {
    if (!present) {
      logger.warn('[IMPORT] GIN indexes missing on startup! Likely from a crash during large import. Recreating...');
      try {
        await storage.recreateSubscriberGinIndexes();
        logger.info('[IMPORT] GIN indexes recovered successfully');
      } catch (err: any) {
        logger.error('[IMPORT] Failed to recover GIN indexes on startup:', err.message);
      }
    } else {
      logger.info('[IMPORT] GIN indexes integrity check passed');
    }
  }).catch((err: any) => {
    logger.error('[IMPORT] GIN index integrity check failed:', err.message);
  });

  storage.ensureTrigramIndex()
    .then(() => logger.info('[IMPORT] Email trigram index verified'))
    .catch((err: any) => logger.error('[IMPORT] Failed to create email trigram index:', err.message));

  storage.ensureSegmentNameTrigramIndex()
    .catch((err: any) => logger.error('[IMPORT] Failed to create segment name trigram index:', err.message));

  storage.ensureCampaignNameTrigramIndex()
    .catch((err: any) => logger.error('[IMPORT] Failed to create campaign name trigram index:', err.message));
  storage.ensureCampaignSubjectTrigramIndex()
    .catch((err: any) => logger.error('[IMPORT] Failed to create campaign subject trigram index:', err.message));

  storage.ensureMtaNameTrigramIndex()
    .catch((err: any) => logger.error('[IMPORT] Failed to create MTA name trigram index:', err.message));
  storage.ensureMtaHostnameTrigramIndex()
    .catch((err: any) => logger.error('[IMPORT] Failed to create MTA hostname trigram index:', err.message));

  storage.ensureSegmentNameLowerIndex()
    .catch((err: any) => logger.error('[IMPORT] Failed to create segment name lower index:', err.message));

  (async () => {
    try {
      const recoveredCount = await storage.recoverStuckImportJobs();
      if (recoveredCount > 0) {
        logger.info(`[IMPORT] Startup recovery: recovered ${recoveredCount} stuck import jobs back to pending`);
      }
      const staleCount = await storage.cleanupStaleImportJobs(30);
      if (staleCount > 0) {
        logger.info(`[IMPORT] Startup recovery: cleaned up ${staleCount} stale import jobs`);
      }
      const orphanCompletedResult = await db.execute(sql`
        UPDATE import_jobs
        SET status = 'completed',
            error_message = NULL,
            completed_at = COALESCE(completed_at, NOW())
        WHERE status = 'processing'
          AND COALESCE(total_rows, 0) > 0
          AND COALESCE(processed_rows, 0) >= COALESCE(total_rows, 0)
          AND id NOT IN (
            SELECT import_job_id FROM import_job_queue
            WHERE status = 'processing'
          )
        RETURNING id
      `);
      if (orphanCompletedResult.rows.length > 0) {
        logger.info(`[IMPORT] Startup recovery: completed ${orphanCompletedResult.rows.length} orphaned import_jobs (all rows were processed)`);
      }
      const orphanResult = await db.execute(sql`
        UPDATE import_jobs
        SET status = 'failed',
            error_message = 'Server restarted while import was processing',
            completed_at = NOW()
        WHERE status = 'processing'
          AND id NOT IN (
            SELECT import_job_id FROM import_job_queue
            WHERE status = 'processing'
          )
        RETURNING id
      `);
      if (orphanResult.rows.length > 0) {
        logger.info(`[IMPORT] Startup recovery: failed ${orphanResult.rows.length} orphaned import_jobs with no active queue item`);
      }

      const csvMissingFixResult = await db.execute(sql`
        UPDATE import_jobs
        SET status = 'completed',
            error_message = NULL,
            completed_at = COALESCE(completed_at, NOW())
        WHERE status = 'failed'
          AND error_message LIKE '%CSV file not found%'
          AND COALESCE(total_rows, 0) > 0
          AND COALESCE(processed_rows, 0) >= COALESCE(total_rows, 0)
        RETURNING id
      `);
      if (csvMissingFixResult.rows.length > 0) {
        logger.info(`[IMPORT] Startup recovery: fixed ${csvMissingFixResult.rows.length} import(s) wrongly marked failed (all rows were actually imported)`);
      }

      // Close queue items whose import_job is already 'completed' — these were orphaned
      // by recoverStuckImportJobs resetting the queue row during GIN index recreation.
      const alreadyCompletedResult = await db.execute(sql`
        UPDATE import_job_queue
        SET status = 'completed', completed_at = NOW()
        WHERE status IN ('pending', 'processing')
          AND import_job_id IN (
            SELECT id FROM import_jobs WHERE status = 'completed'
          )
        RETURNING import_job_id
      `);
      if (alreadyCompletedResult.rows.length > 0) {
        logger.info(`[IMPORT] Startup recovery: closed ${alreadyCompletedResult.rows.length} queue items whose import_jobs were already completed`);
      }
      // Likewise for failed import_jobs — close stray queue items as failed so they are not retried.
      const alreadyFailedResult = await db.execute(sql`
        UPDATE import_job_queue
        SET status = 'failed', completed_at = NOW(),
            error_message = 'Import job already failed before this queue item was processed'
        WHERE status IN ('pending', 'processing')
          AND import_job_id IN (
            SELECT id FROM import_jobs WHERE status = 'failed'
          )
        RETURNING import_job_id
      `);
      if (alreadyFailedResult.rows.length > 0) {
        logger.info(`[IMPORT] Startup recovery: closed ${alreadyFailedResult.rows.length} queue items whose import_jobs were already failed`);
      }
    } catch (err: any) {
      logger.error('[IMPORT] Startup recovery failed:', err.message);
    }
  })();

  importJobPollingInterval = setInterval(pollForImportJobs, 5000);

  pollForImportJobs();
}

function stopImportJobProcessor() {
  if (importJobPollingInterval) {
    clearInterval(importJobPollingInterval);
    importJobPollingInterval = null;
    logger.info("Import job processor stopped");
  }
  if (isActiveImportJob) {
    logger.info("[IMPORT] Active in-process import job will complete naturally during shutdown");
  }
}

export async function triggerImportJobPoll(): Promise<void> {
  return pollForImportJobs();
}

async function pollForImportJobs() {
  if (isActiveImportJob) {
    return;
  }
  if (activeFlushJob) {
    return;
  }
  if (!isPoolHealthy()) {
    logger.debug('[IMPORT] Skipping poll - pool connections saturated');
    return;
  }
  try {
    const now = Date.now();
    if (now - lastRecoveryCheck > 5 * 60 * 1000) {
      lastRecoveryCheck = now;

      const recoveredCount = await storage.recoverStuckImportJobs();
      if (recoveredCount > 0) {
        logger.info(`Recovered ${recoveredCount} stuck import jobs back to pending`);
      }

      const staleCount = await storage.cleanupStaleImportJobs(30);
      if (staleCount > 0) {
        logger.info(`Cleaned up ${staleCount} stale import jobs`);
      }
    }

    const queueItem = await storage.claimNextImportJob(WORKER_ID);

    if (!queueItem) {
      return;
    }

    const queueId = queueItem.id;
    const importJobId = queueItem.importJobId;

    logger.info(`Worker ${WORKER_ID} claimed import job queue item ${queueId} for import ${importJobId} - running in-process`);
    workerRestartsTotal.inc({ worker_type: 'import' });

    isActiveImportJob = true;
    let lastProgressStatus = "processing";

    processImportJob(queueId, importJobId, (progress) => {
      if (progress.status) lastProgressStatus = progress.status;
      publishJobProgress({
        jobType: "import",
        jobId: importJobId,
        status: (progress.status as JobProgressEvent["status"]) || "processing",
        processedRows: progress.processedRows ?? 0,
        totalRows: progress.totalRows ?? 0,
        newSubscribers: progress.newSubscribers ?? 0,
        updatedSubscribers: progress.updatedSubscribers ?? 0,
        failedRows: progress.failedRows ?? 0,
        duplicatesInFile: progress.duplicatesInFile ?? 0,
        errorMessage: progress.errorMessage,
      });
    })
      .then(async () => {
        if (lastProgressStatus === "awaiting_confirmation") {
          logger.info(`[IMPORT] Queue item ${queueId} completed (phase 1 staging done, awaiting confirmation)`);
          await storage.completeImportQueueJob(queueId, "completed")
            .catch((err: any) => logger.error(`[IMPORT] Failed to complete phase-1 queue item: ${err.message}`));
        } else {
          const finalJob = await storage.getImportJob(importJobId).catch(() => null);
          if (finalJob?.status === "cancelled") {
            logger.info(`[IMPORT] Job ${importJobId} was cancelled during processing`);
            await storage.completeImportQueueJob(queueId, "failed", "Job cancelled")
              .catch(() => {});
          } else {
            await storage.completeImportQueueJob(queueId, "completed")
              .catch((err: any) => logger.error(`[IMPORT] Failed to complete queue item: ${err.message}`));
            // Safety net: if the in-processor final DB write failed (all 3 retries), import_jobs.status
            // may still be 'processing'. Fix it here so the UI reflects the actual outcome.
            if (finalJob && finalJob.status !== "completed") {
              logger.warn(`[IMPORT] Job ${importJobId} resolved but status is '${finalJob.status}' — forcing to 'completed'`);
              await storage.updateImportJob(importJobId, { status: "completed", completedAt: new Date() })
                .catch((err: any) => logger.error(`[IMPORT] Safety-net status update failed: ${err.message}`));
            }
            await storage.invalidateSegmentCountCache();
            logger.info(`[IMPORT] Job ${importJobId} completed successfully (status: ${lastProgressStatus})`);
          }
        }
      })
      .catch(async (err: any) => {
        // Deferred-upload transient failure: a Hetzner 503 SlowDown / 5xx while
        // the worker uploads the staged CSV should REQUEUE the job (the
        // backend's own adaptive+transient backoff has already been spent),
        // not permanently fail it. The retry budget is WALL-CLOCK based (job age)
        // rather than a counter, so it stays fully decoupled from retry_count /
        // recoverStuckImportJobs — a transient throttle storm can rage for the
        // whole window without burning the recovery budget. A genuinely broken
        // bucket/credentials surfaces immediately as a non-transient error
        // (ObjectStorageAccessError), which is NOT caught here and fails fast.
        const MAX_UPLOAD_RETRY_MS = Number(process.env.IMPORT_UPLOAD_MAX_RETRY_MS || 2 * 60 * 60 * 1000);
        const jobAgeMs = Date.now() - new Date(queueItem.createdAt).getTime();
        if (err instanceof ObjectStorageTransientError && jobAgeMs < MAX_UPLOAD_RETRY_MS) {
          // LEASE-SAFE requeue: only resets the row if THIS worker still owns it.
          // If the upload stalled long enough for recoverStuckImportJobs to reset
          // it and another worker re-claimed, requeue returns false and we must
          // NOT mark the job failed (the other worker owns the active claim).
          const requeued = await storage.requeueImportJobForRetry(queueId, WORKER_ID).catch((requeueErr: any) => {
            logger.error(`[IMPORT] Failed to requeue throttled job ${importJobId}: ${requeueErr.message}`);
            return false;
          });
          if (requeued) {
            logger.warn(`[IMPORT] Job ${importJobId} upload throttled (transient), requeued for retry (job age ${Math.round(jobAgeMs / 1000)}s / cap ${Math.round(MAX_UPLOAD_RETRY_MS / 1000)}s): ${err.message}`);
          } else {
            logger.warn(`[IMPORT] Job ${importJobId} upload throttled but lease no longer held (re-claimed by another worker) — not failing.`);
          }
          return; // either re-claimed by us, or owned by another worker; do not fail
        }
        logger.error(`[IMPORT] In-process job ${importJobId} failed: ${err.message}`, { stack: err.stack });
        // Deterministic local-file GC: on a TERMINAL failure (non-transient
        // error, or transient past the retry window) the deferred upload never
        // succeeded, so the staged CSV still sits on the persistent volume and
        // would otherwise leak forever (the upload step only unlinks on success,
        // and processImport's cleanup only runs once the path is /objects/...).
        // Skip the /objects/ (already uploaded) and phase2_merge sentinel cases.
        const staged = queueItem.csvFilePath;
        if (staged && !staged.startsWith("/objects/") && staged !== "phase2_merge") {
          try {
            if (fs.existsSync(staged)) {
              fs.unlinkSync(staged);
              logger.info(`[IMPORT] Cleaned up orphaned staged CSV for failed job ${importJobId}: ${staged}`);
            }
          } catch (cleanupErr: any) {
            logger.warn(`[IMPORT] Failed to clean up staged CSV ${staged}: ${cleanupErr.message}`);
          }
        }
        try {
          const jobAfterError = await storage.getImportJob(importJobId).catch(() => null);
          if (jobAfterError?.status === "cancelled") {
            logger.info(`[IMPORT] Job ${importJobId} was cancelled, marking queue item failed`);
            await storage.completeImportQueueJob(queueId, "failed", "Job cancelled").catch(() => {});
          } else if (jobAfterError?.status === "completed") {
            logger.info(`[IMPORT] Job ${importJobId} already completed — not overwriting to failed (queue re-process after file cleanup). Error was: ${err.message}`);
            await storage.completeImportQueueJob(queueId, "completed").catch(() => {});
          } else {
            await storage.completeImportQueueJob(queueId, "failed", err.message || "Unknown error").catch(() => {});
            await storage.updateImportJob(importJobId, {
              status: "failed",
              errorMessage: err.message || "Unknown error",
            }).catch(() => {});
            await storage.logError({
              type: "import_failed",
              severity: "error",
              message: `Import job failed: ${err.message || "Unknown error"}`,
              importJobId,
              details: err.stack || String(err.message),
            }).catch(() => {});
            publishJobProgress({
              jobType: "import",
              jobId: importJobId,
              status: "failed",
              processedRows: 0,
              totalRows: 0,
              errorMessage: err.message || "Unknown error",
            });
          }
        } catch (finalizeErr: any) {
          logger.error(`[IMPORT] Failed to finalize failed import job ${importJobId}: ${finalizeErr.message}`);
        }
      })
      .finally(() => {
        isActiveImportJob = false;
      });

  } catch (error: any) {
    logger.error(`Error in import job polling: ${error?.message || String(error)}`, { stack: error?.stack });
    isActiveImportJob = false;
  }
}

// ═══════════════════════════════════════════════════════════════
// IMPORT GUARDIAN — web-process fallback processor
// ═══════════════════════════════════════════════════════════════

let importGuardianInterval: NodeJS.Timeout | null = null;

/**
 * One shot guardian poll: claims and processes a single pending import job
 * that has been waiting for more than 60 seconds (i.e., the real worker
 * did not pick it up). Uses the same SKIP LOCKED claim so there is no
 * double-processing risk when the real worker is alive.
 */
async function runGuardianPoll(): Promise<void> {
  if (isActiveImportJob) return;
  if (activeFlushJob) return;
  if (!isPoolHealthy()) {
    logger.debug('[IMPORT_GUARDIAN] Skipping — pool saturated');
    return;
  }
  try {
    const rescuedStale = await db.execute(sql`
      UPDATE import_job_queue
      SET status = 'pending',
          started_at = NULL,
          heartbeat = NULL,
          worker_id = NULL,
          retry_count = retry_count + 1
      WHERE status = 'processing'
        AND heartbeat < NOW() - INTERVAL '5 minutes'
        AND NOT EXISTS (
          SELECT 1 FROM import_jobs j
          WHERE j.id = import_job_queue.import_job_id
          AND j.status = 'cancelled'
        )
      RETURNING import_job_id
    `);
    if (rescuedStale.rows.length > 0) {
      logger.warn(`[IMPORT_GUARDIAN] Rescued ${rescuedStale.rows.length} orphaned processing import(s) with stale heartbeat (>5 min) — reset to pending`);
    }

    const staleCheck = await db.execute(sql`
      SELECT 1 FROM import_job_queue
      WHERE status = 'pending'
        AND created_at < NOW() - INTERVAL '60 seconds'
      LIMIT 1
    `);
    if (staleCheck.rows.length === 0) return;

    logger.warn('[IMPORT_GUARDIAN] Stale pending import found (>60 s without a worker claim) — taking over as fallback processor');
    await pollForImportJobs();
  } catch (err: any) {
    logger.error('[IMPORT_GUARDIAN] Error in guardian poll:', err?.message);
  }
}

/**
 * Start the fallback import guardian in the web process.
 * Safe to call even when the real worker is alive — SKIP LOCKED prevents races.
 * The guardian only activates when a job has been pending for > 60 seconds.
 */
export function startImportGuardian(): void {
  if (importGuardianInterval) return;
  logger.info('[IMPORT_GUARDIAN] Fallback import guardian started (polls every 30 s for stale pending jobs)');
  importGuardianInterval = setInterval(runGuardianPoll, 30000);
}

export function stopImportGuardian(): void {
  if (importGuardianInterval) {
    clearInterval(importGuardianInterval);
    importGuardianInterval = null;
    logger.info('[IMPORT_GUARDIAN] Fallback import guardian stopped');
  }
}

/**
 * Trigger a one-shot guardian poll immediately (e.g. after a Requeue NOTIFY).
 */
export async function triggerGuardianPoll(): Promise<void> {
  return runGuardianPoll();
}

// ═══════════════════════════════════════════════════════════════
//  CAMPAIGN GUARDIAN — rescue stuck campaigns in the web process
// ═══════════════════════════════════════════════════════════════

let campaignGuardianInterval: NodeJS.Timeout | null = null;

async function runCampaignGuardianPoll(): Promise<void> {
  try {
    // Task #181: full-spectrum stuck-campaign self-heal. The legacy
    // implementation only caught `status='sending'` with no active job.
    // Production showed at least four other ways a campaign could
    // silently stall (see docs/architecture-history.md Task #181) — all
    // of them now live in `diagnoseStuckCampaigns`. We act on every
    // detected pattern here and also refresh the per-reason Prometheus
    // gauge so dashboards see the same picture as the admin endpoint.
    const { diagnoseStuckCampaigns, countByReason } = await import("./services/stuck-campaign-diagnosis");
    const { campaignsStuckTotal } = await import("./metrics");

    const stuck = await diagnoseStuckCampaigns();

    // Refresh the gauge unconditionally — labels missing from this tick
    // must drop back to 0, not retain the previous tick's value.
    const counts = countByReason(stuck);
    for (const [reason, n] of Object.entries(counts)) {
      campaignsStuckTotal.set({ reason }, n);
    }

    if (stuck.length === 0) return;

    logger.warn(`[CAMPAIGN_GUARDIAN] Diagnosed ${stuck.length} stuck campaign(s): ${
      Object.entries(counts).filter(([, n]) => n > 0).map(([r, n]) => `${r}=${n}`).join(", ")
    }`);

    for (const c of stuck) {
      try {
        switch (c.action) {
          case "reenqueue": {
            // Covers: scheduled_past_due_no_job, sending_no_active_job,
            // mid_flight_crash. Promote scheduled→sending if needed so
            // the worker actually picks the job up.
            if (c.status === "scheduled") {
              await storage.updateCampaign(c.id, { status: "sending", pauseReason: null });
            }
            await storage.enqueueCampaignJob(c.id);
            await messageQueue.notify("campaign_jobs", { campaignId: c.id });
            logger.info(`[CAMPAIGN_GUARDIAN] Re-enqueued ${c.id} (${c.name}) [reason=${c.reason}]`);
            break;
          }
          case "fail_job_and_reenqueue": {
            // Stale heartbeat: the previous worker is dead. Mark the
            // stuck job failed (with the diagnosis as the error message
            // so it shows up in error logs) and queue a successor with
            // bumped retry_count + short backoff.
            if (c.jobId) {
              await storage.completeJob(c.jobId, "failed",
                `Stale heartbeat self-heal (${c.detail})`).catch((e) => {
                  logger.warn(`[CAMPAIGN_GUARDIAN] completeJob(${c.jobId}) failed: ${e?.message}`);
                });
            }
            const nextRetry = (c.retryCount ?? 0) + 1;
            await storage.enqueueCampaignJobWithRetry(c.id, nextRetry, 5);
            await messageQueue.notify("campaign_jobs", { campaignId: c.id });
            logger.warn(`[CAMPAIGN_GUARDIAN] Failed stale job ${c.jobId} and re-enqueued ${c.id} (retry #${nextRetry}) [reason=${c.reason}]`);
            break;
          }
          case "pause_retry_budget_exceeded": {
            // Stop auto-retrying and surface the diagnosis to the
            // operator. Manual resume re-enters the normal sender path.
            await storage.updateCampaign(c.id, {
              status: "paused",
              pauseReason: `retry_budget_exceeded: ${c.detail}`.slice(0, 500),
            });
            logger.error(`[CAMPAIGN_GUARDIAN] Paused ${c.id} (${c.name}) — retry budget exceeded after ${c.retryCount} retries`);
            break;
          }
          case "extend_retry_budget_transient": {
            // 2026-05-23 incident (campaign #3050): all of the last N
            // failures carry the `transient=true` marker, meaning the
            // root cause is an infrastructure incident (pool / lock /
            // network), NOT a campaign-specific fault. Pausing here
            // would strand the campaign indefinitely. Rewind
            // retry_count short of the cap (so a fresh round of normal
            // exponential backoff fires) and re-enqueue with max
            // backoff (15 min) — by then either the incident has
            // cleared and the job succeeds, or another N failures
            // accumulate and we re-enter this branch (idempotent).
            //
            // We do NOT reset retry_count to 0: that would mask a
            // genuine fault loop where the infrastructure keeps
            // crashing the sender. Keeping retry_count high preserves
            // the long backoff (15min cap) the sender already uses
            // and means a persistent infra outage still surfaces in
            // Prometheus as `sending_retry_budget_extended_transient`
            // for on-call to see, instead of looking healthy.
            const { STUCK_MAX_JOB_RETRIES: cap, STUCK_TRANSIENT_REWIND: rewind } =
              await import("./services/stuck-campaign-diagnosis");
            const newRetryCount = Math.max(0, cap - rewind);
            const MAX_BACKOFF_S = 15 * 60;
            try {
              // Stamp the diagnosis on the prior failed job so audit
              // trail shows "guardian extended" rather than a silent
              // re-enqueue. Best-effort.
              if (c.jobId) {
                await storage.completeJob(c.jobId, "failed",
                  `Guardian extended transient retry budget (${c.detail})`).catch(() => {});
              }
              await storage.enqueueCampaignJobWithRetry(c.id, newRetryCount, MAX_BACKOFF_S);
              await messageQueue.notify("campaign_jobs", { campaignId: c.id });
              logger.warn(`[CAMPAIGN_GUARDIAN] Extended retry budget for ${c.id} (${c.name}) — last ${(c.retryCount ?? 0) + 1} failures all transient (infra), rewound retry_count to ${newRetryCount}, next attempt in ${MAX_BACKOFF_S}s`);
            } catch (extErr: any) {
              logger.error(`[CAMPAIGN_GUARDIAN] extend_retry_budget_transient for ${c.id} failed: ${extErr?.message}`);
            }
            break;
          }
        }
      } catch (actionErr: any) {
        logger.error(`[CAMPAIGN_GUARDIAN] Action '${c.action}' for ${c.id} failed: ${actionErr?.message}`);
      }
    }
  } catch (err: any) {
    logger.error('[CAMPAIGN_GUARDIAN] Error in campaign guardian poll:', err?.message);
  }
}

export function startCampaignGuardian(): void {
  if (campaignGuardianInterval) return;
  logger.info('[CAMPAIGN_GUARDIAN] Campaign guardian started (polls every 60 s for stuck campaigns)');
  campaignGuardianInterval = setInterval(runCampaignGuardianPoll, 60000);
}

export function stopCampaignGuardian(): void {
  if (campaignGuardianInterval) {
    clearInterval(campaignGuardianInterval);
    campaignGuardianInterval = null;
    logger.info('[CAMPAIGN_GUARDIAN] Campaign guardian stopped');
  }
}

const MAINTENANCE_INTERVAL = 21600000; // 6 hours
const MAINTENANCE_BATCH_SIZE = 1000;
const MAINTENANCE_MAX_ROWS = 50000;

// tracking_tokens is a high-volume table (~310M rows on prod ≈ 65 GB). The
// initial purge needs a much larger per-run budget than the default 50k cap so
// the backlog actually drains; subsequent steady-state runs hit the cutoff
// quickly and exit early. Both the retention horizon and per-run delete cap
// are env-configurable.
const TRACKING_TOKEN_DEFAULT_RETENTION_DAYS = 90;
const TRACKING_TOKEN_DEFAULT_MAX_ROWS = 5_000_000;

const TABLE_CLEANUP_QUERIES: Record<string, { column: string; statusFilter?: boolean }> = {
  nullsink_captures: { column: "timestamp" },
  campaign_sends: { column: "sent_at" },
  pending_tag_operations: { column: "created_at", statusFilter: true },
  campaign_jobs: { column: "created_at", statusFilter: true },
  import_job_queue: { column: "created_at", statusFilter: true },
  error_logs: { column: "timestamp" },
  session: { column: "expire" },
  tracking_tokens: { column: "created_at" },
};

function getTrackingTokenRetentionDays(): number {
  const raw = parseInt(process.env.TRACKING_TOKEN_RETENTION_DAYS || "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : TRACKING_TOKEN_DEFAULT_RETENTION_DAYS;
}

function getTrackingTokenMaxRowsPerRun(): number {
  const raw = parseInt(process.env.TRACKING_TOKEN_MAX_DELETE_PER_RUN || "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : TRACKING_TOKEN_DEFAULT_MAX_ROWS;
}

async function runMaintenanceForRule(rule: any, triggeredBy: string): Promise<{ rowsDeleted: number; durationMs: number; status: string; errorMessage?: string }> {
  const startTime = Date.now();
  let totalDeleted = 0;
  const config = TABLE_CLEANUP_QUERIES[rule.tableName];
  if (!config) {
    return { rowsDeleted: 0, durationMs: 0, status: "failed", errorMessage: `No cleanup config for table ${rule.tableName}` };
  }

  // Per-table overrides (env-configurable). Tracking tokens use a much larger
  // per-run cap because the steady-state backlog can exceed the default 50k.
  let retentionDays = rule.retentionDays;
  let maxRowsPerRun = MAINTENANCE_MAX_ROWS;
  if (rule.tableName === "tracking_tokens") {
    retentionDays = getTrackingTokenRetentionDays();
    maxRowsPerRun = getTrackingTokenMaxRowsPerRun();
  }

  try {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

    while (totalDeleted < maxRowsPerRun) {
      let query: string;
      let params: any[];

      if (rule.tableName === "session") {
        query = `DELETE FROM session WHERE ctid IN (SELECT ctid FROM session WHERE expire < NOW() LIMIT $1)`;
        params = [MAINTENANCE_BATCH_SIZE];
      } else if (config.statusFilter) {
        query = `DELETE FROM ${rule.tableName} WHERE ctid IN (SELECT ctid FROM ${rule.tableName} WHERE status IN ('completed', 'failed') AND ${config.column} < $1 LIMIT $2)`;
        params = [cutoff, MAINTENANCE_BATCH_SIZE];
      } else {
        query = `DELETE FROM ${rule.tableName} WHERE ctid IN (SELECT ctid FROM ${rule.tableName} WHERE ${config.column} < $1 LIMIT $2)`;
        params = [cutoff, MAINTENANCE_BATCH_SIZE];
      }

      const result = await pool.query(query, params);
      const deletedCount = result.rowCount || 0;
      totalDeleted += deletedCount;

      if (deletedCount < MAINTENANCE_BATCH_SIZE) {
        break;
      }

      await new Promise(resolve => setTimeout(resolve, 100));
    }

    const durationMs = Date.now() - startTime;
    return { rowsDeleted: totalDeleted, durationMs, status: "success" };
  } catch (error: any) {
    const durationMs = Date.now() - startTime;
    return { rowsDeleted: totalDeleted, durationMs, status: totalDeleted > 0 ? "partial" : "failed", errorMessage: error.message };
  }
}

let maintenanceRunning = false;

export async function runMaintenanceNow(triggeredBy: string = "auto"): Promise<Array<{ tableName: string; rowsDeleted: number; durationMs: number; status: string }>> {
  if (maintenanceRunning) {
    logger.info(`[MAINTENANCE] Skipping ${triggeredBy} run - already in progress`);
    return [];
  }
  maintenanceRunning = true;
  try {
    return await _runMaintenance(triggeredBy);
  } finally {
    maintenanceRunning = false;
  }
}

async function _runMaintenance(triggeredBy: string): Promise<Array<{ tableName: string; rowsDeleted: number; durationMs: number; status: string }>> {
  const rules = await storage.getMaintenanceRules();
  // tracking_tokens is handled by a dedicated daily 1 AM Paris job
  // (scheduleDailyTrackingTokenPurge). Excluded from the 6h cycle so a
  // 100M+ row purge never starts in the middle of business hours.
  // The "daily_1am_paris" trigger bypasses this filter via runMaintenanceForRule
  // directly (see runDailyTrackingTokenPurge below).
  const enabledRules = rules.filter(r => r.enabled && r.tableName !== "tracking_tokens");
  const results: Array<{ tableName: string; rowsDeleted: number; durationMs: number; status: string }> = [];

  logger.info(`[MAINTENANCE] Starting cleanup run (${triggeredBy}), ${enabledRules.length} rules enabled`);

  for (const rule of enabledRules) {
    try {
      const result = await runMaintenanceForRule(rule, triggeredBy);

      await storage.createMaintenanceLog({
        ruleId: rule.id,
        tableName: rule.tableName,
        rowsDeleted: result.rowsDeleted,
        durationMs: result.durationMs,
        status: result.status,
        errorMessage: result.errorMessage || null,
        triggeredBy,
      });

      await storage.updateMaintenanceRule(rule.id, {});
      await pool.query(
        `UPDATE db_maintenance_rules SET last_run_at = NOW(), last_rows_deleted = $1 WHERE id = $2`,
        [result.rowsDeleted, rule.id]
      );

      results.push({ tableName: rule.tableName, ...result });

      if (result.rowsDeleted > 0) {
        logger.info(`[MAINTENANCE] ${rule.tableName}: deleted ${result.rowsDeleted} rows in ${result.durationMs}ms (${result.status})`);
      }
    } catch (error: any) {
      logger.error(`[MAINTENANCE] Error processing rule for ${rule.tableName}:`, error);
      results.push({ tableName: rule.tableName, rowsDeleted: 0, durationMs: 0, status: "failed" });
    }
  }

  const totalDeleted = results.reduce((sum, r) => sum + r.rowsDeleted, 0);
  logger.info(`[MAINTENANCE] Cleanup run complete (${triggeredBy}): ${totalDeleted} total rows deleted across ${results.length} tables`);

  return results;
}

// Tracks the last reclaim-recommended state we logged for tracking_tokens so
// the alert fires once on transition (healthy → bloated) and once when it
// clears, instead of repeating every maintenance cycle.
let lastTrackingTokenBloatAlerted = false;

async function checkTrackingTokenBloat(): Promise<void> {
  try {
    const status = await storage.getTrackingTokenBloat();
    if (status.reclaimRecommended && !lastTrackingTokenBloatAlerted) {
      logger.warn(
        `[MAINTENANCE] tracking_tokens reclaim recommended — ${status.reasons.join(" ")} ` +
        `live=${status.liveRows} dead=${status.deadRows} size=${status.totalSizePretty}. ` +
        `See ${status.runbookPath} to run the one-shot reclamation.`
      );
      lastTrackingTokenBloatAlerted = true;
    } else if (!status.reclaimRecommended && lastTrackingTokenBloatAlerted) {
      logger.info(
        `[MAINTENANCE] tracking_tokens bloat cleared — ` +
        `live=${status.liveRows} dead=${status.deadRows} size=${status.totalSizePretty}.`
      );
      lastTrackingTokenBloatAlerted = false;
    }
  } catch (err) {
    logger.error("[MAINTENANCE] tracking_tokens bloat check failed:", err);
  }
}

function startMaintenanceWorker() {
  if (maintenanceInterval) return;
  logger.info("[MAINTENANCE] Starting maintenance worker (6h interval)");
  maintenanceInterval = setInterval(async () => {
    try {
      await runMaintenanceNow("auto");
    } catch (err) {
      logger.error("[MAINTENANCE] Auto maintenance run failed:", err);
    }
    try {
      const expired = await storage.expireAbandonedImports();
      if (expired > 0) {
        logger.info(`[MAINTENANCE] Expired ${expired} abandoned import(s) stuck in awaiting_confirmation`);
      }
    } catch (err) {
      logger.error("[MAINTENANCE] Failed to expire abandoned imports:", err);
    }
    await checkTrackingTokenBloat();
  }, MAINTENANCE_INTERVAL);
  scheduleDailyTrackingTokenPurge();
}

// ── Daily 1 AM Paris purge for tracking_tokens ────────────────────
// tracking_tokens grows ~5 GB/day on prod and dominates DB size (234 GB / 1B
// rows observed 2026-05-27). Purging it every 6h with the rest of the cycle
// risks a multi-hour DELETE landing during business hours. This dedicated
// scheduler fires once a day at 01:00 Europe/Paris (handles DST via the
// Intl.DateTimeFormat round-trip) so the big DELETE runs strictly off-peak.
//
// Multi-process safety: the cluster runs 3 PM2 processes (web/worker/drainer).
// All three will arm a 01:00 timer, so before running we check
// db_maintenance_logs for any 'success' run of tracking_tokens in the last
// 23 hours and skip if found. This is a cheap idempotency gate — DELETE LIMIT
// is already safe to run concurrently, the gate just avoids wasted work.
function msUntilNextHourInTz(hour: number, tz: string): number {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(now).filter(p => p.type !== "literal").map(p => [p.type, p.value])
  );
  const tzYear = +parts.year, tzMonth = +parts.month, tzDay = +parts.day;
  const tzHour = +parts.hour, tzMinute = +parts.minute, tzSecond = +parts.second;
  // Convert "now in tz" treated as UTC to derive tz offset vs real UTC.
  const tzNowAsUtcMs = Date.UTC(tzYear, tzMonth - 1, tzDay, tzHour, tzMinute, tzSecond);
  const offsetMs = tzNowAsUtcMs - (now.getTime() - (now.getTime() % 1000));
  // Target day: today if before target hour, else tomorrow
  let targetY = tzYear, targetM = tzMonth, targetD = tzDay;
  if (tzHour >= hour) {
    const tomorrow = new Date(Date.UTC(tzYear, tzMonth - 1, tzDay + 1));
    targetY = tomorrow.getUTCFullYear();
    targetM = tomorrow.getUTCMonth() + 1;
    targetD = tomorrow.getUTCDate();
  }
  const targetTzAsUtcMs = Date.UTC(targetY, targetM - 1, targetD, hour, 0, 0);
  const targetMs = targetTzAsUtcMs - offsetMs;
  return Math.max(targetMs - now.getTime(), 1000);
}

async function runDailyTrackingTokenPurge(): Promise<void> {
  try {
    // Idempotency gate: skip if any process already purged successfully in last 23h
    const recent = await pool.query(
      `SELECT 1 FROM db_maintenance_logs
        WHERE table_name = 'tracking_tokens'
          AND status IN ('success', 'partial')
          AND executed_at > NOW() - INTERVAL '23 hours'
        LIMIT 1`
    );
    if ((recent.rowCount ?? 0) > 0) {
      logger.info("[MAINTENANCE_DAILY] tracking_tokens already purged within 23h — skipping");
      return;
    }

    const rules = await storage.getMaintenanceRules();
    const rule = rules.find(r => r.tableName === "tracking_tokens" && r.enabled);
    if (!rule) {
      logger.warn("[MAINTENANCE_DAILY] tracking_tokens rule not found or disabled — skipping");
      return;
    }

    logger.info("[MAINTENANCE_DAILY] Starting 1 AM Paris tracking_tokens purge");
    const result = await runMaintenanceForRule(rule, "daily_1am_paris");

    await storage.createMaintenanceLog({
      ruleId: rule.id,
      tableName: rule.tableName,
      rowsDeleted: result.rowsDeleted,
      durationMs: result.durationMs,
      status: result.status,
      errorMessage: result.errorMessage || null,
      triggeredBy: "daily_1am_paris",
    });

    await pool.query(
      `UPDATE db_maintenance_rules SET last_run_at = NOW(), last_rows_deleted = $1 WHERE id = $2`,
      [result.rowsDeleted, rule.id],
    );

    logger.info(
      `[MAINTENANCE_DAILY] tracking_tokens purge done: deleted=${result.rowsDeleted} ` +
      `duration=${result.durationMs}ms status=${result.status}` +
      (result.errorMessage ? ` error=${result.errorMessage}` : "")
    );

    await checkTrackingTokenBloat();
  } catch (err: any) {
    logger.error("[MAINTENANCE_DAILY] tracking_tokens purge failed:", err);
  } finally {
    scheduleDailyTrackingTokenPurge();
  }
}

function scheduleDailyTrackingTokenPurge(): void {
  if (trackingTokenDailyTimer) {
    clearTimeout(trackingTokenDailyTimer);
    trackingTokenDailyTimer = null;
  }
  const ms = msUntilNextHourInTz(1, "Europe/Paris");
  logger.info(
    `[MAINTENANCE_DAILY] tracking_tokens purge scheduled in ${Math.round(ms / 60000)} min ` +
    `(next 01:00 Europe/Paris)`
  );
  trackingTokenDailyTimer = setTimeout(() => {
    void runDailyTrackingTokenPurge();
  }, ms);
  trackingTokenDailyTimer.unref?.();
}

function stopDailyTrackingTokenPurge(): void {
  if (trackingTokenDailyTimer) {
    clearTimeout(trackingTokenDailyTimer);
    trackingTokenDailyTimer = null;
  }
}

function stopMaintenanceWorker() {
  if (maintenanceInterval) {
    clearInterval(maintenanceInterval);
    maintenanceInterval = null;
    logger.info("[MAINTENANCE] Maintenance worker stopped");
  }
}

async function publishWorkerHeartbeat() {
  if (!isRedisConfigured || !redisConnection) return;
  try {
    const payload = JSON.stringify({
      ...getWorkerHealth(),
      pid: process.pid,
      processType: process.env.PROCESS_TYPE || "monolith",
      timestamp: Date.now(),
    });
    await redisConnection.set(WORKER_HEARTBEAT_KEY, payload, "EX", WORKER_HEARTBEAT_TTL_SECONDS);
  } catch (err: any) {
    logger.warn(`[WORKER_HEARTBEAT] Failed to publish heartbeat: ${err.message}`);
  }
}

function startWorkerHeartbeat() {
  if (workerHeartbeatInterval) return;
  if (!isRedisConfigured || !redisConnection) {
    // Monolith mode (no Redis): web reads in-process flags directly, no heartbeat needed.
    return;
  }
  publishWorkerHeartbeat();
  workerHeartbeatInterval = setInterval(publishWorkerHeartbeat, WORKER_HEARTBEAT_INTERVAL_MS);
  workerHeartbeatInterval.unref?.();
  logger.info(`[WORKER_HEARTBEAT] Started (every ${WORKER_HEARTBEAT_INTERVAL_MS / 1000}s, TTL ${WORKER_HEARTBEAT_TTL_SECONDS}s)`);
}

function stopWorkerHeartbeat() {
  if (workerHeartbeatInterval) {
    clearInterval(workerHeartbeatInterval);
    workerHeartbeatInterval = null;
  }
  if (isRedisConfigured && redisConnection) {
    // Best-effort: drop the key on clean shutdown so /api/health flips to
    // "worker down" immediately instead of waiting for TTL expiry.
    redisConnection.del(WORKER_HEARTBEAT_KEY).catch(() => {});
  }
}

export async function startAllWorkers() {
  // Task #152: preemptively terminate any idle PgBouncer-labelled backend
  // still holding a session-level advisory bootstrap lock from a previous
  // worker incarnation (pm2 reload leak). Best-effort, never throws. Runs
  // BEFORE the bootstrap calls below so they don't get "skipped" on a
  // leaked lock. See server/bootstrap-lock-recovery.ts for full rationale.
  const { releaseStuckBootstrapLocks } = await import("./bootstrap-lock-recovery");
  await releaseStuckBootstrapLocks("worker-boot");

  await startJobProcessor();
  startTagQueueWorker();
  startMaintenanceWorker();
  startGhostCampaignSweep();
  startScheduledCampaignPoller();
  startFollowUpSpawner();
  startAutomationProcessor();
  // Marketing Pressure Guard (Task #144) — bootstrap (idempotent, advisory-locked)
  // then start the deferred-drain poller. Bootstrap can also run from the web
  // process; the lock prevents double DDL.
  runPressureGuardBootstrap()
    .catch((err: any) => logger.error(`[PRESSURE_GUARD] Bootstrap (worker) failed (non-fatal): ${err?.message || err}`))
    .finally(() => {
      // Task #160: when DRAIN_PROCESS_DEDICATED=true, the dedicated
      // critsend-drainer process runs the drain — skip the embedded one
      // here so the worker process doesn't compete for the leader lease
      // (it would always lose, but the wasted poll still costs DB calls).
      if (process.env.DRAIN_PROCESS_DEDICATED === 'true') {
        logger.info('[WORKER] DRAIN_PROCESS_DEDICATED=true — skipping embedded pressure-guard drain (handled by critsend-drainer process)');
      } else {
        startPressureGuardWorker();
      }
    });
  // 2026-05-23 — async urgent-flush worker. Polls urgent_flush_jobs and
  // drains held queues in small batches with sleeps between batches so
  // the main pool is never starved. Safe in every topology: SKIP LOCKED
  // on the claim guarantees only one worker processes any given job at
  // a time, so we can start it unconditionally in both worker and web
  // processes.
  import("./services/urgent-flush-service").then(({ startUrgentFlushWorker }) => {
    startUrgentFlushWorker();
  });
  // Task #160: orphaned-sends reconciler (closes campaign_sends rows
  // stuck in pending/attempting on completed campaigns). Always-on in
  // the worker — tiny cost, runs hourly, guards against silent counter
  // drift after a process kill mid-claim.
  import("./workers/orphaned-sends-reconciler").then(({ startOrphanedSendsReconciler }) => {
    startOrphanedSendsReconciler();
  }).catch((err: any) => logger.error(`[ORPHANED_SENDS_RECONCILER] failed to start: ${err?.message || err}`));
  startWorkerHeartbeat();
  storage.seedDefaultMaintenanceRules().catch(err => {
    logger.error("[MAINTENANCE] Failed to seed default rules:", err);
  });
  // Task #193 — PMTA queue monitoring collector. Lease-table leader election
  // means it's safe to call from every PM2 process; only one runs per tick.
  import("./services/pmta-collector").then(({ startPmtaCollector }) => {
    void startPmtaCollector();
  }).catch((err: any) => logger.error(`[PMTA_COLLECTOR] failed to start: ${err?.message || err}`));
}

export function stopAllBackgroundWorkers() {
  logger.info("[SHUTDOWN] Stopping all background workers...");
  stopWorkerHeartbeat();
  stopMemoryMonitor();
  stopJobProcessor();
  stopTagQueueWorker();
  stopMaintenanceWorker();
  stopDailyTrackingTokenPurge();
  stopGhostCampaignSweep();
  stopScheduledCampaignPoller();
  stopFollowUpSpawner();
  stopAutomationProcessor();
  stopPressureGuardWorker();
  // Task #193 — PMTA collector
  import("./services/pmta-collector").then(({ stopPmtaCollector }) => {
    stopPmtaCollector();
  }).catch(() => { /* shutdown best-effort */ });
  // Task #160
  import("./workers/orphaned-sends-reconciler").then(({ stopOrphanedSendsReconciler }) => {
    stopOrphanedSendsReconciler();
  }).catch(() => { /* shutdown best-effort */ });
  closeNullsinkTransporter();
  // Close all per-MTA SMTP transporter pools to flush sockets/FDs cleanly on
  // pm2 reload. Safe here because stopJobProcessor()/stopPressureGuardWorker()
  // above (and the await waitForActiveJobsToDrain in worker-main.ts:98) have
  // already drained in-flight sendMail() calls — no peer campaign can be mid-
  // send when this runs. Without this, every reload leaks N socket pools (one
  // per active MTA) until the process exits via SIGKILL after the 30s grace.
  closeAllTransporters();
  logger.info("[SHUTDOWN] All background workers stopped");
}

/**
 * Snapshot of in-flight background work that holds a DB pool connection.
 * Used by the worker shutdown sequence to decide whether it's safe to
 * close the pool yet.
 */
export function getActiveJobCount(): { campaigns: number; importJob: boolean; flushJob: boolean; total: number } {
  return {
    campaigns: activeCampaigns.size,
    importJob: isActiveImportJob,
    flushJob: activeFlushJob,
    total: activeCampaigns.size + (isActiveImportJob ? 1 : 0) + (activeFlushJob ? 1 : 0),
  };
}

/**
 * Returns the IDs of campaigns currently being processed in this worker.
 * Used by the shutdown sequence to log which campaigns are still in flight
 * if the drain timeout expires.
 */
export function getActiveCampaignIds(): string[] {
  return Array.from(activeCampaigns);
}

/**
 * Waits for all in-flight jobs (campaigns + import + flush) to finish, or
 * until `timeoutMs` elapses. Returns true if everything drained cleanly,
 * false if the timeout fired with work still in flight.
 *
 * Callers MUST call `stopAllBackgroundWorkers()` (or otherwise stop the
 * pollers) BEFORE invoking this — otherwise new jobs can keep arriving and
 * the count may never reach zero. This function only waits; it does not
 * stop new work from being claimed.
 */
export async function waitForActiveJobsToDrain(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  const initial = getActiveJobCount();
  if (initial.total === 0) return true;

  logger.info(
    `[SHUTDOWN] Waiting for ${initial.campaigns} active campaign job(s)` +
    `${initial.importJob ? ' + 1 import job' : ''}` +
    `${initial.flushJob ? ' + 1 flush job' : ''}` +
    ` to finish (max ${Math.round(timeoutMs / 1000)}s)…`
  );

  let lastLogged = 0;
  while (Date.now() < deadline) {
    const snapshot = getActiveJobCount();
    if (snapshot.total === 0) {
      logger.info(`[SHUTDOWN] All active jobs drained`);
      return true;
    }
    // Periodic progress log every ~3s so ops can see what we're waiting on.
    if (Date.now() - lastLogged > 3000) {
      logger.info(
        `[SHUTDOWN] Still waiting: campaigns=${snapshot.campaigns}` +
        `${snapshot.importJob ? ' import=1' : ''}` +
        `${snapshot.flushJob ? ' flush=1' : ''}`
      );
      lastLogged = Date.now();
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  // Timed out — caller is expected to log the campaign IDs and proceed.
  return false;
}
