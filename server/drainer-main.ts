/**
 * drainer-main.ts — dedicated pressure-guard drainer process (Task #160).
 *
 * Runs ONLY the pressure-guard deferred-drain worker, isolated from the
 * web/worker processes so that:
 *   • a stalled query / GC pause in web/worker can never starve the drain;
 *   • the drain has a tiny dedicated DB pool (default 6 connections) that
 *     is never contested by the campaign sender, import processor, or
 *     analytics queries;
 *   • a drain crash auto-restarts via PM2 in <30s without affecting the
 *     rest of the cluster.
 *
 * Compatible with the existing leader-lease (pressure_guard_leader table):
 * even when DRAIN_PROCESS_DEDICATED=true the embedded drain in web/worker
 * is skipped, but if the rollout is partial, the lease still guarantees
 * only one node drains a tick.
 */

import { logger } from "./logger";
import { validateConnectionBudget } from "./connection-budget";
import { pool } from "./db";

let isShuttingDown = false;

process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  logger.error("[DRAINER] Unhandled Promise Rejection", { reason: msg });
});

process.on("uncaughtException", (error) => {
  logger.error("[DRAINER] Uncaught Exception", {
    error: error.message,
    stack: error.stack,
  });
});

const DRAIN_SHUTDOWN_TIMEOUT_MS = Number(
  process.env.DRAIN_SHUTDOWN_TIMEOUT_MS || 25_000,
);

async function gracefulShutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logger.info(`[DRAINER] Received ${signal}, starting graceful shutdown...`);
  const force = setTimeout(() => {
    logger.error(
      `[DRAINER] Force-exit after ${DRAIN_SHUTDOWN_TIMEOUT_MS}ms graceful timeout`,
    );
    process.exit(1);
  }, DRAIN_SHUTDOWN_TIMEOUT_MS);
  force.unref();
  try {
    const { stopPressureGuardWorker } = await import(
      "./workers/pressure-guard-worker"
    );
    stopPressureGuardWorker();
    await pool.end().catch(() => {});
    logger.info("[DRAINER] Graceful shutdown complete");
  } catch (err: any) {
    logger.error("[DRAINER] Error during shutdown", { error: String(err) });
  }
  clearTimeout(force);
  process.exit(0);
}

process.on("SIGTERM", () => {
  void gracefulShutdown("SIGTERM");
});
process.on("SIGINT", () => {
  void gracefulShutdown("SIGINT");
});

(async () => {
  logger.info(
    `[DRAINER] Drainer process starting (PROCESS_TYPE=${process.env.PROCESS_TYPE || "drainer"})...`,
  );
  validateConnectionBudget();

  // 2026-05-22: proactive INVALID-index reaper. Advisory-locked so only
  // one of web/worker/drainer does the work. The drainer is usually
  // last to boot (after web + worker) so it normally observes "skipped",
  // but if web/worker fail to start the drainer still self-heals.
  try {
    const { releaseStuckBootstrapLocks } = await import("./bootstrap-lock-recovery");
    await releaseStuckBootstrapLocks("drainer-boot");
    const { reapInvalidIndexes } = await import("./bootstrap-lock");
    reapInvalidIndexes("drainer-boot").catch((err: any) =>
      logger.warn(`[INVALID_INDEX_REAPER] drainer-boot scan failed (non-fatal): ${err?.message || err}`)
    );
  } catch (err: any) {
    logger.warn(`[DRAINER] Invalid-index reaper bootstrap skipped: ${err?.message || err}`);
  }

  // campaign-job stall RCA (2026-05-19) — Zombie sweeper also runs in the drainer process. The
  // drainer issues its own UPDATE...SKIP LOCKED queries against
  // campaign_sends + holds locks during the force-reserve cascade. A
  // crashed drainer would otherwise leave its own stranded backends.
  try {
    const { startZombieCleanup } = await import("./db-zombie-killer");
    startZombieCleanup();
  } catch (err: any) {
    logger.warn(`[DRAINER] Failed to start DB zombie cleanup (non-fatal): ${err?.message || err}`);
  }

  const { runPressureGuardBootstrap } = await import(
    "./services/pressure-guard"
  );
  await runPressureGuardBootstrap().catch((err: any) =>
    logger.warn(
      `[DRAINER] pressure-guard bootstrap deferred (will retry via worker): ${err?.message || err}`,
    ),
  );

  const { startPressureGuardWorker } = await import(
    "./workers/pressure-guard-worker"
  );
  startPressureGuardWorker();

  // Note: orphaned-sends reconciler runs in the worker process only — the
  // drainer is intentionally kept single-purpose (pressure-guard drain).
  // See server/workers.ts for that wiring.

  logger.info("[DRAINER] Pressure-guard drainer running");
})().catch((err: any) => {
  logger.error("[DRAINER] Startup failed", {
    error: String(err),
    stack: err?.stack,
  });
  process.exit(1);
});
