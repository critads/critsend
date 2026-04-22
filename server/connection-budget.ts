import { logger } from "./logger";

let connectionString = process.env.NEON_DATABASE_URL || process.env.DATABASE_URL || "";
export const isExternalDb = connectionString.includes("neon.tech") || process.env.DB_SSL === "true";

const DEFAULT_LIMIT_EXTERNAL = 50;
const DEFAULT_LIMIT_LOCAL = 20;

export const PG_CONNECTION_LIMIT = Number(
  process.env.PG_CONNECTION_LIMIT || (isExternalDb ? DEFAULT_LIMIT_EXTERNAL : DEFAULT_LIMIT_LOCAL)
);

export const NOTIFY_CONNECTIONS = 1;

export const IMPORT_POOL_MAX = Number(
  process.env.PG_IMPORT_POOL_MAX || (isExternalDb ? 4 : 4)
);
export const IMPORT_CONCURRENCY = IMPORT_POOL_MAX;

// PROCESS_TYPE-aware pool sizing.
// web:    20 connections — HTTP request handlers
// worker:  8 connections — campaign sends, imports, tag queue, flush, maintenance
// unset: legacy monolith mode keeps the original calculated budget
const processType = process.env.PROCESS_TYPE;

// Reserve headroom so background spikes never push us to the hard Neon limit.
// With HEADROOM_RESERVE=12: monolith main pool = 50-1-4-6-12 = 27, total allocated = 38/50.
const HEADROOM_RESERVE = Number(process.env.PG_HEADROOM_RESERVE || 12);

// Dedicated pool for /api/track/*, /c/*, /u/*, /api/unsubscribe/* endpoints.
// Carved out of the web budget so a campaign-burst open-pixel firehose can
// never starve the user-facing main pool (login, dashboard, imports).
// Only meaningful in the web process; worker inherits 0.
export const TRACKING_POOL_MAX = (() => {
  if (processType === 'worker') return 0;
  return Number(process.env.PG_TRACKING_POOL_MAX || 6);
})();

export const MAIN_POOL_MAX = (() => {
  if (processType === 'worker') {
    return parseInt(process.env.WORKER_PG_POOL_MAX || '8', 10);
  }
  if (processType === 'web') {
    // Tracking pool slots are subtracted from the configured web budget so
    // total Neon connections stay inside the existing limit.
    const webBudget = parseInt(process.env.WEB_PG_POOL_MAX || '20', 10);
    return Math.max(2, webBudget - TRACKING_POOL_MAX);
  }
  // Monolith fallback — leave HEADROOM_RESERVE connections free at all times
  return Number(process.env.PG_POOL_MAX || Math.max(2, PG_CONNECTION_LIMIT - NOTIFY_CONNECTIONS - IMPORT_POOL_MAX - TRACKING_POOL_MAX - HEADROOM_RESERVE));
})();

const TOTAL_ALLOCATED = MAIN_POOL_MAX + IMPORT_POOL_MAX + NOTIFY_CONNECTIONS + TRACKING_POOL_MAX;

export function validateConnectionBudget(): void {
  logger.info(`[CONNECTION BUDGET] Limit: ${PG_CONNECTION_LIMIT} | Process: ${processType || 'monolith'} | Main pool: ${MAIN_POOL_MAX} | Tracking pool: ${TRACKING_POOL_MAX} | Import worker: ${IMPORT_POOL_MAX} (concurrency: ${IMPORT_CONCURRENCY}) | LISTEN/NOTIFY: ${NOTIFY_CONNECTIONS} | Total allocated: ${TOTAL_ALLOCATED} | External: ${isExternalDb}`);

  if (TOTAL_ALLOCATED > PG_CONNECTION_LIMIT) {
    logger.error(`[CONNECTION BUDGET] OVER BUDGET! Allocated ${TOTAL_ALLOCATED} connections but limit is ${PG_CONNECTION_LIMIT}. Reduce PG_POOL_MAX or PG_IMPORT_POOL_MAX, or increase PG_CONNECTION_LIMIT.`);
  }
}
