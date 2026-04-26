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
// web:    main pool for HTTP request handlers + tracking pool for open/click/bounce
// worker: 18 connections — sized for ≥1.5× MAX_CONCURRENT_CAMPAIGNS so up to
//         12 campaigns can each hold one DB conn (prefetch OR finalize, never
//         both — see campaign-sender.ts) without queueing in the pg pool.
// unset:  legacy monolith mode keeps the original calculated budget
const processType = process.env.PROCESS_TYPE;

// Reserve headroom so background spikes never push us to the hard Neon limit.
// With HEADROOM_RESERVE=12: monolith main pool = 50-1-4-6-12 = 27, total allocated = 38/50.
const HEADROOM_RESERVE = Number(process.env.PG_HEADROOM_RESERVE || 12);

// ── Tracking pool via Neon's PgBouncer pooled endpoint ────────────────────
//
// Neon provides a PgBouncer-based pooled endpoint (up to 10,000 concurrent
// connections) alongside the direct endpoint (hard-capped at 50). When the
// tracking pool uses the pooled endpoint, its connections do NOT count against
// the direct-connection limit — effectively removing tracking traffic from the
// connection budget entirely.
//
// The pooled URL is auto-derived from NEON_DATABASE_URL by inserting "-pooler"
// into the hostname (e.g. ep-xyz.us-east-2.aws.neon.tech → ep-xyz-pooler.…).
// Set NEON_TRACKING_DATABASE_URL to override the auto-derived URL.
// Set TRACKING_POOL_USE_DIRECT=true to force using the direct endpoint instead.

export function derivePooledUrl(directUrl: string): string | null {
  try {
    const url = new URL(directUrl);
    if (!url.hostname.includes("neon.tech")) return null;
    const parts = url.hostname.split(".");
    if (parts.length < 2 || parts[0].endsWith("-pooler")) return null;
    parts[0] = parts[0] + "-pooler";
    url.hostname = parts.join(".");
    return url.toString();
  } catch {
    return null;
  }
}

export function isPoolerUrl(url: string): boolean {
  try {
    return new URL(url).hostname.includes("-pooler");
  } catch {
    return false;
  }
}

export const TRACKING_POOL_USE_POOLER: boolean = (() => {
  if (process.env.TRACKING_POOL_USE_DIRECT === "true") return false;
  if (process.env.NEON_TRACKING_DATABASE_URL) {
    return isPoolerUrl(process.env.NEON_TRACKING_DATABASE_URL);
  }
  const baseUrl = process.env.NEON_DATABASE_URL || process.env.DATABASE_URL || "";
  return isPoolerUrl(baseUrl) || derivePooledUrl(baseUrl) !== null;
})();

export const TRACKING_POOL_MAX = (() => {
  if (processType === 'worker') return 0;
  return Number(process.env.PG_TRACKING_POOL_MAX || (TRACKING_POOL_USE_POOLER ? 20 : 10));
})();

export const MAIN_POOL_MAX = (() => {
  if (processType === 'worker') {
    return parseInt(process.env.WORKER_PG_POOL_MAX || '18', 10);
  }
  if (processType === 'web') {
    if (TRACKING_POOL_USE_POOLER) {
      return parseInt(process.env.WEB_PG_POOL_MAX || '14', 10);
    }
    const webBudget = parseInt(process.env.WEB_PG_POOL_MAX || '24', 10);
    return Math.max(2, webBudget - TRACKING_POOL_MAX);
  }
  const trackingDirect = TRACKING_POOL_USE_POOLER ? 0 : TRACKING_POOL_MAX;
  return Number(process.env.PG_POOL_MAX || Math.max(2, PG_CONNECTION_LIMIT - NOTIFY_CONNECTIONS - IMPORT_POOL_MAX - trackingDirect - HEADROOM_RESERVE));
})();

const TOTAL_ALLOCATED = MAIN_POOL_MAX + IMPORT_POOL_MAX + NOTIFY_CONNECTIONS + (TRACKING_POOL_USE_POOLER ? 0 : TRACKING_POOL_MAX);

export function validateConnectionBudget(): void {
  const trackingLabel = TRACKING_POOL_USE_POOLER
    ? `${TRACKING_POOL_MAX} (pooler — not counted against direct limit)`
    : `${TRACKING_POOL_MAX}`;
  logger.info(`[CONNECTION BUDGET] Limit: ${PG_CONNECTION_LIMIT} | Process: ${processType || 'monolith'} | Main pool: ${MAIN_POOL_MAX} | Tracking pool: ${trackingLabel} | Import worker: ${IMPORT_POOL_MAX} (concurrency: ${IMPORT_CONCURRENCY}) | LISTEN/NOTIFY: ${NOTIFY_CONNECTIONS} | Total allocated (direct): ${TOTAL_ALLOCATED} | External: ${isExternalDb}`);

  if (TOTAL_ALLOCATED > PG_CONNECTION_LIMIT) {
    logger.error(`[CONNECTION BUDGET] OVER BUDGET! Allocated ${TOTAL_ALLOCATED} direct connections but limit is ${PG_CONNECTION_LIMIT}. Reduce PG_POOL_MAX or PG_IMPORT_POOL_MAX, or increase PG_CONNECTION_LIMIT.`);
  }

  if (processType === 'web' || processType === 'worker') {
    const webMain = processType === 'web'
      ? MAIN_POOL_MAX
      : Math.max(2, parseInt(process.env.WEB_PG_POOL_MAX || (TRACKING_POOL_USE_POOLER_HINT() ? '14' : '24'), 10) - (TRACKING_POOL_USE_POOLER_HINT() ? 0 : TRACKING_POOL_MAX_HINT()));
    const workerMain = processType === 'worker'
      ? MAIN_POOL_MAX
      : parseInt(process.env.WORKER_PG_POOL_MAX || '18', 10);
    const trackingDirect = TRACKING_POOL_USE_POOLER_HINT() ? 0 : (processType === 'web' ? TRACKING_POOL_MAX : TRACKING_POOL_MAX_HINT());
    const importBudget = IMPORT_POOL_MAX;
    const notify = NOTIFY_CONNECTIONS * 2;
    const safetyHeadroom = Number(process.env.PG_SPLIT_PROCESS_HEADROOM || 2);
    const combined = webMain + workerMain + trackingDirect + importBudget + notify;
    const poolerNote = TRACKING_POOL_USE_POOLER_HINT() ? ` [tracking=${TRACKING_POOL_MAX_HINT()} via pooler, excluded]` : "";
    if (combined + safetyHeadroom > PG_CONNECTION_LIMIT) {
      logger.error(`[CONNECTION BUDGET] SPLIT-PROCESS OVER BUDGET! Combined web(${webMain})+worker(${workerMain})+tracking(${trackingDirect})+import(${importBudget})+notify(${notify})=${combined} + headroom ${safetyHeadroom} = ${combined + safetyHeadroom} exceeds Neon limit ${PG_CONNECTION_LIMIT}.${poolerNote} Reduce WEB_PG_POOL_MAX or WORKER_PG_POOL_MAX, or raise PG_CONNECTION_LIMIT.`);
    } else {
      logger.info(`[CONNECTION BUDGET] Split-process aggregate: web(${webMain})+worker(${workerMain})+tracking(${trackingDirect})+import(${importBudget})+notify(${notify}) = ${combined} of ${PG_CONNECTION_LIMIT} (headroom ${PG_CONNECTION_LIMIT - combined}, required ≥ ${safetyHeadroom}) ✓${poolerNote}`);
    }
  }
}

function TRACKING_POOL_MAX_HINT(): number {
  const usePooler = TRACKING_POOL_USE_POOLER_HINT();
  return Number(process.env.PG_TRACKING_POOL_MAX || (usePooler ? 20 : 10));
}

function TRACKING_POOL_USE_POOLER_HINT(): boolean {
  if (process.env.TRACKING_POOL_USE_DIRECT === "true") return false;
  if (process.env.NEON_TRACKING_DATABASE_URL) {
    return isPoolerUrl(process.env.NEON_TRACKING_DATABASE_URL);
  }
  const baseUrl = process.env.NEON_DATABASE_URL || process.env.DATABASE_URL || "";
  return isPoolerUrl(baseUrl) || derivePooledUrl(baseUrl) !== null;
}
