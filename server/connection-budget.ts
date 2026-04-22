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
// web:    20 connections — HTTP request handlers (split: 14 main + 6 tracking)
// worker: 18 connections — sized for ≥1.5× MAX_CONCURRENT_CAMPAIGNS so up to
//         12 campaigns can each hold one DB conn (prefetch OR finalize, never
//         both — see campaign-sender.ts) without queueing in the pg pool.
// unset:  legacy monolith mode keeps the original calculated budget
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
    return parseInt(process.env.WORKER_PG_POOL_MAX || '18', 10);
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

  // Combined split-process assertion: each process only sees its own pool sizes
  // at runtime, so we additionally compute what the OTHER process is configured
  // to consume (from env hints) and assert the AGGREGATE stays inside the
  // hard Neon limit minus a configurable safety headroom. This catches
  // mis-configurations (e.g. someone bumps WEB_PG_POOL_MAX past 20) at
  // startup, not in production under saturation.
  if (processType === 'web' || processType === 'worker') {
    const webMain = processType === 'web'
      ? MAIN_POOL_MAX
      : Math.max(2, parseInt(process.env.WEB_PG_POOL_MAX || '20', 10) - TRACKING_POOL_MAX_HINT());
    const workerMain = processType === 'worker'
      ? MAIN_POOL_MAX
      : parseInt(process.env.WORKER_PG_POOL_MAX || '18', 10);
    const trackingMain = processType === 'web' ? TRACKING_POOL_MAX : Number(process.env.PG_TRACKING_POOL_MAX || 6);
    const importBudget = IMPORT_POOL_MAX;
    const notify = NOTIFY_CONNECTIONS * 2; // web + worker each open one LISTEN/NOTIFY conn
    const safetyHeadroom = Number(process.env.PG_SPLIT_PROCESS_HEADROOM || 6);
    const combined = webMain + workerMain + trackingMain + importBudget + notify;
    if (combined + safetyHeadroom > PG_CONNECTION_LIMIT) {
      logger.error(`[CONNECTION BUDGET] SPLIT-PROCESS OVER BUDGET! Combined web(${webMain})+worker(${workerMain})+tracking(${trackingMain})+import(${importBudget})+notify(${notify})=${combined} + headroom ${safetyHeadroom} = ${combined + safetyHeadroom} exceeds Neon limit ${PG_CONNECTION_LIMIT}. Reduce WEB_PG_POOL_MAX or WORKER_PG_POOL_MAX, or raise PG_CONNECTION_LIMIT.`);
    } else {
      logger.info(`[CONNECTION BUDGET] Split-process aggregate: web(${webMain})+worker(${workerMain})+tracking(${trackingMain})+import(${importBudget})+notify(${notify}) = ${combined} of ${PG_CONNECTION_LIMIT} (headroom ${PG_CONNECTION_LIMIT - combined}, required ≥ ${safetyHeadroom}) ✓`);
    }
  }
}

// Helper for the split-process aggregate assertion above. The web process
// reads PG_TRACKING_POOL_MAX directly; this mirrors that for the worker
// process so it can still calculate the web side's tracking footprint.
function TRACKING_POOL_MAX_HINT(): number {
  return Number(process.env.PG_TRACKING_POOL_MAX || 6);
}
