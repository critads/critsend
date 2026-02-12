import { storage } from "./storage";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { processCampaignInternal } from "./services/campaign-sender";
import { verifyTransporter, closeNullsinkTransporter } from "./email-service";
import { messageQueue } from "./message-queue";
import { logger } from "./logger";
import { fork, ChildProcess } from "child_process";
import * as path from "path";
import * as fs from "fs";

const WORKER_ID = `worker-${process.pid}-${Date.now()}`;

import { pool } from "./db";

let tagQueueInterval: NodeJS.Timeout | null = null;
let tagCleanupInterval: NodeJS.Timeout | null = null;
let jobPollingInterval: NodeJS.Timeout | null = null;
let importJobPollingInterval: NodeJS.Timeout | null = null;
let flushJobPollingInterval: NodeJS.Timeout | null = null;
let mtaRecoveryInterval: NodeJS.Timeout | null = null;
let memoryCheckInterval: NodeJS.Timeout | null = null;
let maintenanceInterval: NodeJS.Timeout | null = null;

let activeImportWorker: ChildProcess | null = null;
let activeImportJobInfo: { queueId: string; importJobId: string } | null = null;
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

export function getWorkerHealth(): { jobProcessor: boolean; importProcessor: boolean; tagQueueWorker: boolean; flushProcessor: boolean; maintenanceWorker: boolean } {
  return {
    jobProcessor: !!jobPollingInterval,
    importProcessor: !!importJobPollingInterval,
    tagQueueWorker: !!tagQueueInterval,
    flushProcessor: !!flushJobPollingInterval,
    maintenanceWorker: !!maintenanceInterval,
  };
}

async function processTagQueue() {
  try {
    const operations = await storage.claimPendingTagOperations(50);

    if (operations.length === 0) {
      return;
    }

    for (const op of operations) {
      try {
        await storage.addTagToSubscriber(
          op.subscriberId,
          op.tagValue
        );

        await storage.completeTagOperation(op.id);
      } catch (error: any) {
        logger.error(`Failed to process tag operation ${op.id}:`, error);
        await storage.failTagOperation(op.id, error.message || "Unknown error");
      }
    }

    if (operations.length > 0) {
      logger.info(`Processed ${operations.length} tag operations`);
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
  tagQueueInterval = setInterval(processTagQueue, 500);

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
  flushJobPollingInterval = setInterval(pollForFlushJobs, 1000);
  pollForFlushJobs();
}

function stopFlushJobProcessor() {
  if (flushJobPollingInterval) {
    clearInterval(flushJobPollingInterval);
    flushJobPollingInterval = null;
    logger.info("Flush job processor stopped");
  }
}

async function pollForFlushJobs() {
  if (isMemoryPressure) {
    logger.warn('Skipping flush job poll - memory pressure active');
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
      await processFlushJob(job.id, job.totalRows);
      await storage.completeFlushJob(job.id, "completed");
      storage.invalidateSegmentCountCache();
      logger.info(`Flush job ${job.id} completed successfully`);
    } catch (error: any) {
      logger.error(`Error processing flush job ${job.id}:`, error);
      await storage.completeFlushJob(job.id, "failed", error.message || "Unknown error");
    } finally {
      activeFlushJob = false;
    }
  } catch (error) {
    logger.error("Error in flush job polling:", error);
  }
}

async function processFlushJob(jobId: string, totalRows: number) {
  logger.info(`[FLUSH] Job ${jobId}: Clearing dependent tables first...`);
  await storage.clearSubscriberDependencies();
  logger.info(`[FLUSH] Job ${jobId}: Dependent tables cleared. Starting subscriber batch deletion...`);

  let processedRows = 0;

  while (processedRows < totalRows) {
    const job = await storage.getFlushJob(jobId);
    if (!job || job.status === "cancelled") {
      logger.info(`Flush job ${jobId} was cancelled`);
      return;
    }

    const deletedCount = await storage.deleteSubscriberBatch(FLUSH_BATCH_SIZE);

    if (deletedCount === 0) {
      break;
    }

    processedRows += deletedCount;
    await storage.updateFlushJobProgress(jobId, processedRows);

    logger.info(`[FLUSH] Job ${jobId}: Deleted ${processedRows}/${totalRows} subscribers (${Math.round(processedRows/totalRows*100)}%)`);

    await new Promise(resolve => setTimeout(resolve, 50));
  }

  await storage.updateFlushJobProgress(jobId, processedRows);
}

let isProcessingCampaign = false;
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

async function pollForJobs() {
  if (isPolling) return;
  isPolling = true;

  try {
    if (isMemoryPressure) {
      logger.warn('[JOB_POLL] Skipping - memory pressure active');
      return;
    }

    const staleCount = await storage.cleanupStaleJobs(30);
    if (staleCount > 0) {
      logger.info(`[JOB_POLL] Cleaned up ${staleCount} stale jobs`);
      await resumeInterruptedCampaigns();
    }

    if (isProcessingCampaign) {
      return;
    }

    const job = await storage.claimNextJob(WORKER_ID);
    if (!job) {
      return;
    }

    logger.info(`[JOB_POLL] Worker ${WORKER_ID} claimed job ${job.id} for campaign ${job.campaignId}`);
    isProcessingCampaign = true;

    try {
      await processCampaignInternal(job.campaignId, job.id);

      const finalStatus = await storage.getCampaignStatus(job.campaignId);
      if (finalStatus === "failed" || finalStatus === "paused") {
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
          await storage.completeJob(job.id, "failed", `Campaign ${finalStatus} - scheduling retry #${jobRetryCount + 1}`);
          await storage.updateCampaign(job.campaignId, { status: "sending", pauseReason: null });
          await storage.enqueueCampaignJobWithRetry(job.campaignId, jobRetryCount + 1, backoffSeconds);
          logger.info(`[JOB_POLL] Campaign ${job.campaignId} ${finalStatus} - retry #${jobRetryCount + 1} scheduled in ${backoffSeconds}s (deadline: ${retryDeadline.toISOString()})`);
        } else {
          await storage.completeJob(job.id, "failed", `Campaign ended in ${finalStatus} state (retry window expired or not set)`);
          logger.info(`[JOB_POLL] Job ${job.id} marked failed (campaign ${job.campaignId} status: ${finalStatus}, no more retries)`);
        }
      } else {
        await storage.completeJob(job.id, "completed");
        logger.info(`[JOB_POLL] Job ${job.id} completed (campaign ${job.campaignId} status: ${finalStatus})`);
      }
    } catch (error: any) {
      logger.error(`[JOB_POLL] Error processing job ${job.id} for campaign ${job.campaignId}:`, error);

      const campaignData = await storage.getCampaign(job.campaignId).catch(() => null);
      let retryDeadline = campaignData?.retryUntil;
      const jobRetryCount = (job as any).retryCount || 0;

      if (!retryDeadline && campaignData) {
        retryDeadline = new Date(Date.now() + 12 * 60 * 60 * 1000);
        await storage.updateCampaign(job.campaignId, { retryUntil: retryDeadline }).catch(() => {});
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
    } finally {
      isProcessingCampaign = false;
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
        AND cj.status IN ('pending', 'processing')
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

async function startJobProcessor() {
  if (jobPollingInterval) {
    return;
  }

  logger.info(`[JOB_POLL] Starting job processor with worker ID: ${WORKER_ID}`);

  jobPollingInterval = setInterval(pollForJobs, 5000);

  messageQueue.onMessage("campaign_jobs", (payload) => {
    logger.info(`[JOB_POLL] NOTIFY received for campaign_jobs, triggering immediate poll`);
    pollForJobs();
  });

  const startupStaleCount = await storage.cleanupStaleJobs(0);
  if (startupStaleCount > 0) {
    logger.info(`[JOB_POLL] Startup: cleaned up ${startupStaleCount} orphaned processing jobs`);
  }

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

  importJobPollingInterval = setInterval(pollForImportJobs, 2000);

  pollForImportJobs();
}

function stopImportJobProcessor() {
  if (importJobPollingInterval) {
    clearInterval(importJobPollingInterval);
    importJobPollingInterval = null;
    logger.info("Import job processor stopped");
  }
  if (activeImportWorker) {
    logger.info("Killing active import worker process");
    activeImportWorker.kill("SIGTERM");
    activeImportWorker = null;
    activeImportJobInfo = null;
  }
}

async function pollForImportJobs() {
  if (activeImportWorker) {
    return;
  }
  if (activeFlushJob) {
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

    logger.info(`Worker ${WORKER_ID} claimed import job queue item ${queueItem.id} for import ${queueItem.importJobId} - forking child process`);

    const isDev = process.env.NODE_ENV !== "production";
    let workerPath: string;
    if (isDev) {
      const currentDir = path.dirname(new URL(import.meta.url).pathname);
      workerPath = path.resolve(currentDir, "import-worker.ts");
    } else {
      workerPath = path.resolve(process.cwd(), "dist", "import-worker.cjs");
    }

    if (!fs.existsSync(workerPath)) {
      logger.error(`Import worker file not found at: ${workerPath}`);
      await storage.completeImportQueueJob(queueItem.id, "failed", "Import worker file not found - server build may be incomplete");
      await storage.updateImportJob(queueItem.importJobId, {
        status: "failed",
        errorMessage: "Import worker file not found - server build may be incomplete",
      });
      activeImportWorker = null;
      activeImportJobInfo = null;
      return;
    }

    const forkOptions: any = {
      env: {
        ...process.env,
        NODE_OPTIONS: "--max-old-space-size=4096",
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    };

    if (isDev) {
      const tsxPath = path.resolve(process.cwd(), "node_modules", ".bin", "tsx");
      forkOptions.execPath = tsxPath;
    }

    const child = fork(workerPath, [], forkOptions);

    activeImportWorker = child;
    activeImportJobInfo = { queueId: queueItem.id, importJobId: queueItem.importJobId };

    child.on("message", async (msg: any) => {
      if (!msg || !msg.type) return;

      switch (msg.type) {
        case "complete": {
          const d = msg.data;
          logger.info(`[IMPORT] Worker completed: committed=${d.committedRows}, new=${d.newSubscribers}, updated=${d.updatedSubscribers}, failed=${d.failedRows}, duration=${d.duration}s`);
          try {
            const finalJob = await storage.getImportJob(queueItem.importJobId);
            if (finalJob?.status === "cancelled") {
              logger.info(`Import job ${queueItem.id} was cancelled during processing`);
            } else {
              await storage.completeImportQueueJob(queueItem.id, "completed");
              storage.invalidateSegmentCountCache();
              logger.info(`Import job ${queueItem.id} completed successfully`);
            }
          } catch (err: any) {
            logger.error(`Failed to finalize import job ${queueItem.id}:`, err);
          }
          break;
        }
        case "error": {
          const d = msg.data;
          logger.error(`[IMPORT] Worker error: ${d.message}`);
          try {
            const jobAfterError = await storage.getImportJob(queueItem.importJobId);
            if (jobAfterError?.status === "cancelled") {
              logger.info(`Import job ${queueItem.id} was cancelled, not marking as failed`);
            } else {
              await storage.completeImportQueueJob(queueItem.id, "failed", d.message || "Unknown error");
              await storage.updateImportJob(queueItem.importJobId, {
                status: "failed",
                errorMessage: d.message || "Unknown error",
              });
            }
            await storage.logError({
              type: "import_failed",
              severity: "error",
              message: `Import job failed: ${d.message || "Unknown error"}`,
              importJobId: queueItem.importJobId,
              details: d.stack || String(d.message),
            });
          } catch (logErr) {
            logger.error("Failed to log import error:", logErr);
          }
          break;
        }
        case "log": {
          const d = msg.data;
          const level = d.level as "info" | "warn" | "error" | "debug";
          if (logger[level]) {
            logger[level](`[IMPORT-WORKER] ${d.message}`, d.extra);
          }
          break;
        }
      }
    });

    child.on("exit", (code, signal) => {
      const jobInfo = activeImportJobInfo;
      activeImportWorker = null;
      activeImportJobInfo = null;

      if (code !== 0 && code !== null) {
        logger.error(`[IMPORT] Worker process exited with code ${code}, signal ${signal}`);
        if (jobInfo) {
          storage.completeImportQueueJob(jobInfo.queueId, "failed", `Worker crashed with exit code ${code}`)
            .catch((err) => logger.error("Failed to mark crashed import as failed:", err));
          storage.updateImportJob(jobInfo.importJobId, {
            status: "failed",
            errorMessage: `Worker process crashed (exit code ${code})`,
          }).catch((err) => logger.error("Failed to update crashed import job:", err));
        }
      } else {
        logger.info(`[IMPORT] Worker process exited cleanly (code=${code})`);
      }
    });

    child.on("error", (err) => {
      logger.error(`[IMPORT] Worker process error:`, err);
      activeImportWorker = null;
      activeImportJobInfo = null;
    });

    child.send({
      type: "start",
      data: {
        queueId: queueItem.id,
        importJobId: queueItem.importJobId,
        csvFilePath: queueItem.csvFilePath,
      },
    });

  } catch (error: any) {
    logger.error(`Error in import job polling: ${error?.message || String(error)}`, { stack: error?.stack });
    activeImportWorker = null;
    activeImportJobInfo = null;
  }
}

const MAINTENANCE_INTERVAL = 21600000; // 6 hours
const MAINTENANCE_BATCH_SIZE = 1000;
const MAINTENANCE_MAX_ROWS = 50000;

const TABLE_CLEANUP_QUERIES: Record<string, { column: string; statusFilter?: boolean }> = {
  nullsink_captures: { column: "timestamp" },
  campaign_sends: { column: "sent_at" },
  pending_tag_operations: { column: "created_at", statusFilter: true },
  campaign_jobs: { column: "created_at", statusFilter: true },
  import_job_queue: { column: "created_at", statusFilter: true },
  error_logs: { column: "timestamp" },
  session: { column: "expire" },
};

async function runMaintenanceForRule(rule: any, triggeredBy: string): Promise<{ rowsDeleted: number; durationMs: number; status: string; errorMessage?: string }> {
  const startTime = Date.now();
  let totalDeleted = 0;
  const config = TABLE_CLEANUP_QUERIES[rule.tableName];
  if (!config) {
    return { rowsDeleted: 0, durationMs: 0, status: "failed", errorMessage: `No cleanup config for table ${rule.tableName}` };
  }

  try {
    const cutoff = new Date(Date.now() - rule.retentionDays * 24 * 60 * 60 * 1000);

    while (totalDeleted < MAINTENANCE_MAX_ROWS) {
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

function startMaintenanceWorker() {
  if (maintenanceInterval) return;
  logger.info("[MAINTENANCE] Starting maintenance worker (6h interval)");
  maintenanceInterval = setInterval(() => {
    runMaintenanceNow("auto").catch(err => {
      logger.error("[MAINTENANCE] Auto maintenance run failed:", err);
    });
  }, MAINTENANCE_INTERVAL);
}

function stopMaintenanceWorker() {
  if (maintenanceInterval) {
    clearInterval(maintenanceInterval);
    maintenanceInterval = null;
    logger.info("[MAINTENANCE] Maintenance worker stopped");
  }
}

export async function startAllWorkers() {
  await startJobProcessor();
  startTagQueueWorker();
  startMaintenanceWorker();
  storage.seedDefaultMaintenanceRules().catch(err => {
    logger.error("[MAINTENANCE] Failed to seed default rules:", err);
  });
}

export function stopAllBackgroundWorkers() {
  logger.info("[SHUTDOWN] Stopping all background workers...");
  stopMemoryMonitor();
  stopJobProcessor();
  stopTagQueueWorker();
  stopMaintenanceWorker();
  closeNullsinkTransporter();
  logger.info("[SHUTDOWN] All background workers stopped");
}
