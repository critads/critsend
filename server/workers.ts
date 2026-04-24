import { storage } from "./storage";
import { db, pool, isPoolHealthy } from "./db";
import { sql } from "drizzle-orm";
import type { CampaignJob } from "@shared/schema";
import { processCampaignInternal } from "./services/campaign-sender";
import { verifyTransporter, closeNullsinkTransporter } from "./email-service";
import { messageQueue } from "./message-queue";
import { logger } from "./logger";
import { workerRestartsTotal, flushJobsTotal } from "./metrics";
import { jobEvents, type JobProgressEvent } from "./job-events";
import { redisConnection, isRedisConfigured } from "./redis";
import { processImportJob } from "./services/import-processor";

const WORKER_ID = `worker-${process.pid}-${Date.now()}`;

let tagQueueInterval: NodeJS.Timeout | null = null;
let tagCleanupInterval: NodeJS.Timeout | null = null;
let jobPollingInterval: NodeJS.Timeout | null = null;
let importJobPollingInterval: NodeJS.Timeout | null = null;
let flushJobPollingInterval: NodeJS.Timeout | null = null;
let mtaRecoveryInterval: NodeJS.Timeout | null = null;
let memoryCheckInterval: NodeJS.Timeout | null = null;
let maintenanceInterval: NodeJS.Timeout | null = null;
let scheduledCampaignInterval: NodeJS.Timeout | null = null;
let workerHeartbeatInterval: NodeJS.Timeout | null = null;

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

export function getWorkerHealth(): { jobProcessor: boolean; importProcessor: boolean; tagQueueWorker: boolean; flushProcessor: boolean; maintenanceWorker: boolean; scheduledCampaignPoller: boolean } {
  return {
    jobProcessor: !!jobPollingInterval,
    importProcessor: !!importJobPollingInterval,
    tagQueueWorker: !!tagQueueInterval,
    flushProcessor: !!flushJobPollingInterval,
    maintenanceWorker: !!maintenanceInterval,
    scheduledCampaignPoller: !!scheduledCampaignInterval,
  };
}

/**
 * Publishes a job progress event.
 * When Redis is available (worker process), publishes to the "job-progress" channel
 * so the web server's SSE bridge can forward it to connected clients.
 * Falls back to direct in-process emit when Redis is not configured (monolith mode).
 */
function publishJobProgress(event: JobProgressEvent): void {
  if (isRedisConfigured && redisConnection) {
    redisConnection.publish("job-progress", JSON.stringify(event)).catch((err: any) => {
      logger.warn("[JOB_EVENTS] Redis publish failed, falling back to direct emit", { error: err.message });
      jobEvents.emitProgress(event);
    });
  } else {
    jobEvents.emitProgress(event);
  }
}

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
  const campaignData = await storage.getCampaign(job.campaignId).catch(() => null);
  const campaignStatus = campaignData?.status;
  const jobRetryCount = (job as any).retryCount || 0;

  if (campaignStatus === "paused") {
    try {
      await storage.completeJob(job.id, "failed", `Campaign paused - no automatic retry for paused campaigns`);
      logger.info(`[JOB_POLL] Job ${job.id} error but campaign ${job.campaignId} is paused (skipping retry)`);
    } catch (completeErr) {
      logger.error(`[JOB_POLL] Failed to mark job ${job.id} as failed:`, completeErr);
    }
  } else {
    const errMsg = (error?.message || String(error || '')).toString();
    const isTransientDb = /connection timeout|timeout exceeded when trying to connect|timeout exceeded|Connection terminated|connection refused|ECONNRESET|ETIMEDOUT|EPIPE|unexpected eof|Client has encountered a connection error|server closed the connection unexpectedly|terminating connection|connection reset by peer|Cannot use a pool after calling end|read ECONNRESET|getaddrinfo ENOTFOUND/i.test(errMsg);

    let retryDeadline = campaignData?.retryUntil;

    // If retryUntil is missing OR already in the past, set/refresh it.
    // A stale (past) retryUntil from a prior run must NOT prevent recovery
    // of an in-flight send (e.g. the campaign that left 4,283 pending).
    const nowMsErr = Date.now();
    const needsFreshDeadline = !retryDeadline || retryDeadline.getTime() <= nowMsErr;
    if (needsFreshDeadline && campaignData) {
      retryDeadline = new Date(nowMsErr + 12 * 60 * 60 * 1000);
      await storage.updateCampaign(job.campaignId, { retryUntil: retryDeadline }).catch(() => {});
      if (retryDeadline) {
        logger.info(`[JOB_POLL] Refreshed retry deadline for campaign ${job.campaignId} to ${retryDeadline.toISOString()}`);
      }
    }

    // Transient DB errors (e.g. Neon connect timeout) are infrastructure issues,
    // not real send failures. Pause the campaign with a recoverable reason
    // and requeue the job with backoff regardless of retry-count budget,
    // so the campaign auto-resume / guardian can take over.
    if (isTransientDb && campaignData) {
      const backoffSeconds = Math.min(30 * Math.pow(2, jobRetryCount), 15 * 60);
      try {
        await storage.completeJob(job.id, "failed", `Transient DB error: ${errMsg} - requeuing in ${backoffSeconds}s`);
        await storage.updateCampaign(job.campaignId, { status: "sending", pauseReason: null });
        await storage.enqueueCampaignJobWithRetry(job.campaignId, jobRetryCount + 1, backoffSeconds);
        logger.warn(`[JOB_POLL] Campaign ${job.campaignId} hit transient DB error - requeued in ${backoffSeconds}s (retry #${jobRetryCount + 1}): ${errMsg}`);
        return;
      } catch (transientRetryErr) {
        logger.error(`[JOB_POLL] Failed to requeue after transient DB error for ${job.campaignId}:`, transientRetryErr);
        // Fall through to the normal retry path below.
      }
    }

    if (retryDeadline && Date.now() < retryDeadline.getTime()) {
      const backoffSeconds = Math.min(30 * Math.pow(2, jobRetryCount), 15 * 60);
      try {
        await storage.completeJob(job.id, "failed", `Error: ${error.message} - scheduling retry #${jobRetryCount + 1}`);
        await storage.updateCampaign(job.campaignId, { status: "sending", pauseReason: null });
        await storage.enqueueCampaignJobWithRetry(job.campaignId, jobRetryCount + 1, backoffSeconds);
        logger.info(`[JOB_POLL] Campaign ${job.campaignId} error - retry #${jobRetryCount + 1} scheduled in ${backoffSeconds}s`);
      } catch (retryErr) {
        logger.error(`[JOB_POLL] Failed to schedule retry for campaign ${job.campaignId}:`, retryErr);
        try {
          await storage.completeJob(job.id, "failed", error.message || "Unknown error");
        } catch (completeErr) {
          logger.error(`[JOB_POLL] Failed to mark job ${job.id} as failed:`, completeErr);
        }
      }
    } else {
      try {
        await storage.completeJob(job.id, "failed", error.message || "Unknown error");
      } catch (completeErr) {
        logger.error(`[JOB_POLL] Failed to mark job ${job.id} as failed:`, completeErr);
      }
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await storage.updateCampaignStatusAtomic(job.campaignId, "failed");
          logger.info(`[JOB_POLL] Campaign ${job.campaignId} marked as failed (attempt ${attempt + 1})`);
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
          AND j.status = 'cancelled'
        )
      RETURNING q.import_job_id
    `);

    if (stuckImportQueue.rows.length > 0) {
      logger.info(`[RECOVERY] Reset ${stuckImportQueue.rows.length} stuck import queue item(s)`);
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
        // Per spec: zero-opener parents get a child created in 'completed'
        // state with 0 recipients (not skipped indefinitely) so the UI
        // surfaces the spawn outcome consistently. Non-zero parents get a
        // 'scheduled' child — the standard pollScheduledCampaigns worker
        // promotes scheduled→sending at the right time, exactly like a
        // user-scheduled campaign. We DO NOT auto-promote here, so the user
        // can pause / edit / cancel the child via the normal scheduled-
        // campaign controls during the delay window.
        const openerCount = await storage.countOpenersForParentCampaign(parent.id);
        const child = await storage.spawnFollowUpCampaign(parent, { openerCount });
        if (!child) continue; // race loser; another worker handled it
        if (openerCount === 0) {
          logger.info(`[FOLLOWUP_POLL] Spawned zero-audience follow-up child=${child.id} for parent=${parent.id} (${parent.name}) — marked completed`);
        } else {
          logger.info(`[FOLLOWUP_POLL] Spawned scheduled follow-up child=${child.id} (audience=${openerCount}) for parent=${parent.id} (${parent.name}) — will send at ${child.scheduledAt?.toISOString()}`);
        }
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

async function startJobProcessor() {
  if (jobPollingInterval) {
    return;
  }

  logger.info(`[JOB_POLL] Starting job processor with worker ID: ${WORKER_ID}, max concurrent campaigns: ${MAX_CONCURRENT_CAMPAIGNS}`);

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
        logger.error(`[IMPORT] In-process job ${importJobId} failed: ${err.message}`, { stack: err.stack });
        try {
          const jobAfterError = await storage.getImportJob(importJobId).catch(() => null);
          if (jobAfterError?.status === "cancelled") {
            logger.info(`[IMPORT] Job ${importJobId} was cancelled, marking queue item failed`);
            await storage.completeImportQueueJob(queueId, "failed", "Job cancelled").catch(() => {});
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
    const stuckCampaigns = await db.execute(sql`
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

    const campaigns = stuckCampaigns.rows as Array<{ id: string; name: string }>;
    if (campaigns.length > 0) {
      logger.warn(`[CAMPAIGN_GUARDIAN] Found ${campaigns.length} stuck campaign(s) in 'sending' with no active job — re-enqueuing`);
      for (const campaign of campaigns) {
        logger.info(`[CAMPAIGN_GUARDIAN] Re-enqueuing campaign ${campaign.id} (${campaign.name})`);
        await storage.enqueueCampaignJob(campaign.id);
        await messageQueue.notify("campaign_jobs", { campaignId: campaign.id });
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
  const enabledRules = rules.filter(r => r.enabled);
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
  await startJobProcessor();
  startTagQueueWorker();
  startMaintenanceWorker();
  startScheduledCampaignPoller();
  startFollowUpSpawner();
  startWorkerHeartbeat();
  storage.seedDefaultMaintenanceRules().catch(err => {
    logger.error("[MAINTENANCE] Failed to seed default rules:", err);
  });
}

export function stopAllBackgroundWorkers() {
  logger.info("[SHUTDOWN] Stopping all background workers...");
  stopWorkerHeartbeat();
  stopMemoryMonitor();
  stopJobProcessor();
  stopTagQueueWorker();
  stopMaintenanceWorker();
  stopScheduledCampaignPoller();
  stopFollowUpSpawner();
  closeNullsinkTransporter();
  logger.info("[SHUTDOWN] All background workers stopped");
}
