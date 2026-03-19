import { Queue } from "bullmq";
import { redisBullMQ, isRedisConfigured } from "./redis";
import { logger } from "./logger";

const DEFAULT_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: "exponential" as const, delay: 5000 },
  removeOnComplete: { age: 86400, count: 1000 },
  removeOnFail: { age: 604800 },
};

export let campaignQueue: Queue | null = null;
export let importQueue: Queue | null = null;
export let flushQueue: Queue | null = null;

export function initQueues(): void {
  if (!isRedisConfigured || !redisBullMQ) {
    logger.info(
      "[BullMQ] Redis not configured — queues disabled (PG queue fallback active)"
    );
    return;
  }

  campaignQueue = new Queue("campaigns", {
    connection: redisBullMQ,
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  });

  importQueue = new Queue("imports", {
    connection: redisBullMQ,
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  });

  flushQueue = new Queue("flushes", {
    connection: redisBullMQ,
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  });

  logger.info("[BullMQ] Queues initialized: campaigns, imports, flushes");
}

export async function closeQueues(): Promise<void> {
  await Promise.allSettled([
    campaignQueue?.close(),
    importQueue?.close(),
    flushQueue?.close(),
  ]);
  logger.info("[BullMQ] Queues closed");
}
