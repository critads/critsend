import { Worker } from "bullmq";
import { redisBullMQ, isRedisConfigured } from "./redis";
import { logger } from "./logger";
import {
  triggerCampaignJobPoll,
  triggerImportJobPoll,
  triggerFlushJobPoll,
  triggerAutomationPoll,
} from "./workers";

let campaignWorker: Worker | null = null;
let importWorker: Worker | null = null;
let flushWorker: Worker | null = null;
let automationWorker: Worker | null = null;

export function startBullMQWorkers(): void {
  if (!isRedisConfigured || !redisBullMQ) {
    logger.info("[BullMQ] Workers not started — Redis not configured");
    return;
  }

  campaignWorker = new Worker(
    "campaigns",
    async (job) => {
      logger.info(
        `[BullMQ/campaigns] Job received: id=${job.id} campaignId=${job.data.campaignId}`
      );
      await triggerCampaignJobPoll();
    },
    { connection: redisBullMQ, concurrency: 5 }
  );

  campaignWorker.on("completed", (job) => {
    logger.info(`[BullMQ/campaigns] Job ${job.id} completed`);
  });
  campaignWorker.on("failed", (job, err) => {
    logger.error(
      `[BullMQ/campaigns] Job ${job?.id} failed: ${err.message}`
    );
  });

  importWorker = new Worker(
    "imports",
    async (job) => {
      logger.info(
        `[BullMQ/imports] Job received: id=${job.id} jobId=${job.data.jobId}`
      );
      await triggerImportJobPoll();
    },
    { connection: redisBullMQ, concurrency: 1 }
  );

  importWorker.on("completed", (job) => {
    logger.info(`[BullMQ/imports] Job ${job.id} completed`);
  });
  importWorker.on("failed", (job, err) => {
    logger.error(`[BullMQ/imports] Job ${job?.id} failed: ${err.message}`);
  });

  flushWorker = new Worker(
    "flushes",
    async (job) => {
      logger.info(
        `[BullMQ/flushes] Job received: id=${job.id} jobId=${job.data.jobId}`
      );
      await triggerFlushJobPoll();
    },
    { connection: redisBullMQ, concurrency: 1 }
  );

  flushWorker.on("completed", (job) => {
    logger.info(`[BullMQ/flushes] Job ${job.id} completed`);
  });
  flushWorker.on("failed", (job, err) => {
    logger.error(`[BullMQ/flushes] Job ${job?.id} failed: ${err.message}`);
  });

  automationWorker = new Worker(
    "automations",
    async (job) => {
      logger.info(
        `[BullMQ/automations] Job received: id=${job.id}`
      );
      await triggerAutomationPoll();
    },
    { connection: redisBullMQ, concurrency: 1 }
  );

  automationWorker.on("completed", (job) => {
    logger.info(`[BullMQ/automations] Job ${job.id} completed`);
  });
  automationWorker.on("failed", (job, err) => {
    logger.error(`[BullMQ/automations] Job ${job?.id} failed: ${err.message}`);
  });

  logger.info("[BullMQ] Workers started: campaigns, imports, flushes, automations");
}

export async function closeBullMQWorkers(): Promise<void> {
  await Promise.allSettled([
    campaignWorker?.close(),
    importWorker?.close(),
    flushWorker?.close(),
    automationWorker?.close(),
  ]);
  logger.info("[BullMQ] Workers closed");
}
