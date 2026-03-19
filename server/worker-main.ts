/**
 * worker-main.ts — standalone worker process entry point.
 *
 * Runs all background workers (campaign sender, import processor,
 * flush processor, tag queue, maintenance) independently of the
 * HTTP/SSE web server.
 *
 * Receives: PROCESS_TYPE=worker  (set by dev-launcher or production config)
 * Publishes: job-progress Redis channel → web server SSE bridge
 */

import { logger } from "./logger";
import { validateConnectionBudget } from "./connection-budget";
import { messageQueue } from "./message-queue";
import { startAllWorkers, stopAllBackgroundWorkers } from "./workers";
import { startBullMQWorkers, closeBullMQWorkers } from "./queue-workers";
import { initQueues, closeQueues } from "./queues";
import { closeRedisConnections } from "./redis";
import { pool } from "./db";

process.on("unhandledRejection", (reason) => {
  logger.error("[WORKER] Unhandled Promise Rejection", { reason: String(reason) });
});

process.on("uncaughtException", (error) => {
  logger.error("[WORKER] Uncaught Exception", { error: error.message, stack: error.stack });
});

import("v8").then((v8) => {
  const heapStats = v8.getHeapStatistics();
  const heapLimitMB = Math.round(heapStats.heap_size_limit / 1024 / 1024);
  logger.info("[WORKER] Process startup diagnostics", {
    heapLimitMB,
    pid: process.pid,
    nodeVersion: process.version,
    processType: process.env.PROCESS_TYPE || "worker",
  });
}).catch(() => {});

let isShuttingDown = false;

async function gracefulShutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info(`[WORKER] Received ${signal}, starting graceful shutdown...`);

  const forceExitTimer = setTimeout(() => {
    logger.error("[WORKER] Graceful shutdown timed out, forcing exit");
    process.exit(1);
  }, 20000);
  forceExitTimer.unref();

  try {
    stopAllBackgroundWorkers();
    logger.info("[WORKER] Background workers stopped");

    await Promise.allSettled([
      messageQueue.shutdown(),
      closeBullMQWorkers(),
      closeQueues(),
    ]);

    await closeRedisConnections();

    await new Promise((resolve) => setTimeout(resolve, 1000));

    await pool.end();
    logger.info("[WORKER] Database pool closed");

    logger.info("[WORKER] Graceful shutdown complete");
  } catch (err) {
    logger.error("[WORKER] Error during shutdown", { error: String(err) });
  }

  clearTimeout(forceExitTimer);
  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

(async () => {
  logger.info("[WORKER] Worker process starting...");

  validateConnectionBudget();

  // Initialize BullMQ queues for job enqueueing and processing
  initQueues();

  // Initialize LISTEN/NOTIFY for campaign job triggers
  messageQueue.initialize().catch((err) =>
    logger.error("[WORKER] Message queue init failed", { error: String(err) })
  );

  // Start all background workers: campaign sender, import processor,
  // flush processor, tag queue worker, maintenance worker
  await startAllWorkers();

  // Start BullMQ workers if Redis/BullMQ is configured
  startBullMQWorkers();

  logger.info("[WORKER] All workers running");
})();
