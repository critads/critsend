import { logger } from "./logger";

let connectionString = process.env.NEON_DATABASE_URL || process.env.DATABASE_URL || "";
export const isExternalDb = connectionString.includes("neon.tech") || process.env.DB_SSL === "true";

const DEFAULT_LIMIT_EXTERNAL = 50;
const DEFAULT_LIMIT_LOCAL = 20;

export const PG_CONNECTION_LIMIT = Number(
  process.env.PG_CONNECTION_LIMIT || (isExternalDb ? DEFAULT_LIMIT_EXTERNAL : DEFAULT_LIMIT_LOCAL)
);

export const NOTIFY_CONNECTIONS = 1;

const processType = process.env.PROCESS_TYPE;

const HEADROOM_RESERVE = Number(process.env.PG_HEADROOM_RESERVE || 10);

// ── PgBouncer pooled endpoint helpers ─────────────────────────────────────
//
// Neon provides a PgBouncer-based pooled endpoint (up to 10,000 concurrent
// connections) alongside the direct endpoint (hard-capped at 50). When a pool
// uses the pooled endpoint, its connections do NOT count against the direct-
// connection limit. The pooled URL is auto-derived from NEON_DATABASE_URL by
// inserting "-pooler" into the hostname.

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

function detectPoolerAvailable(): boolean {
  const baseUrl = process.env.NEON_DATABASE_URL || process.env.DATABASE_URL || "";
  return isPoolerUrl(baseUrl) || derivePooledUrl(baseUrl) !== null;
}

// ── Tracking pool ─────────────────────────────────────────────────────────

export const TRACKING_POOL_USE_POOLER: boolean = (() => {
  if (process.env.TRACKING_POOL_USE_DIRECT === "true") return false;
  if (process.env.NEON_TRACKING_DATABASE_URL) {
    return isPoolerUrl(process.env.NEON_TRACKING_DATABASE_URL);
  }
  return detectPoolerAvailable();
})();

export const TRACKING_POOL_MAX = (() => {
  if (processType === 'worker') return 0;
  return Number(process.env.PG_TRACKING_POOL_MAX || (TRACKING_POOL_USE_POOLER ? 20 : 10));
})();

// ── Import pool ───────────────────────────────────────────────────────────

export const IMPORT_POOL_USE_POOLER: boolean = (() => {
  if (process.env.IMPORT_POOL_USE_DIRECT === "true") return false;
  return detectPoolerAvailable();
})();

export const IMPORT_POOL_MAX = Number(
  process.env.PG_IMPORT_POOL_MAX || (IMPORT_POOL_USE_POOLER ? 6 : 4)
);
export const IMPORT_CONCURRENCY = IMPORT_POOL_MAX;

// ── Main pool ─────────────────────────────────────────────────────────────

export const MAIN_POOL_MAX = (() => {
  if (processType === 'worker') {
    return parseInt(process.env.WORKER_PG_POOL_MAX || '18', 10);
  }

  const trackingDirect = TRACKING_POOL_USE_POOLER ? 0 : TRACKING_POOL_MAX;
  const importDirect = IMPORT_POOL_USE_POOLER ? 0 : IMPORT_POOL_MAX;

  if (processType === 'web') {
    const allPooler = TRACKING_POOL_USE_POOLER && IMPORT_POOL_USE_POOLER;
    if (allPooler) {
      return parseInt(process.env.WEB_PG_POOL_MAX || '20', 10);
    }
    const webBudget = parseInt(process.env.WEB_PG_POOL_MAX || '24', 10);
    return Math.max(2, webBudget - trackingDirect - importDirect);
  }

  return Number(process.env.PG_POOL_MAX || Math.max(2, PG_CONNECTION_LIMIT - NOTIFY_CONNECTIONS - importDirect - trackingDirect - HEADROOM_RESERVE));
})();

const TOTAL_DIRECT = MAIN_POOL_MAX
  + (IMPORT_POOL_USE_POOLER ? 0 : IMPORT_POOL_MAX)
  + NOTIFY_CONNECTIONS
  + (TRACKING_POOL_USE_POOLER ? 0 : TRACKING_POOL_MAX);

export function validateConnectionBudget(): void {
  const trackingLabel = TRACKING_POOL_USE_POOLER
    ? `${TRACKING_POOL_MAX} (pooler)`
    : `${TRACKING_POOL_MAX}`;
  const importLabel = IMPORT_POOL_USE_POOLER
    ? `${IMPORT_POOL_MAX} (pooler)`
    : `${IMPORT_POOL_MAX}`;
  logger.info(`[CONNECTION BUDGET] Limit: ${PG_CONNECTION_LIMIT} | Process: ${processType || 'monolith'} | Main pool: ${MAIN_POOL_MAX} | Tracking pool: ${trackingLabel} | Import pool: ${importLabel} (concurrency: ${IMPORT_CONCURRENCY}) | LISTEN/NOTIFY: ${NOTIFY_CONNECTIONS} | Total direct: ${TOTAL_DIRECT} | External: ${isExternalDb}`);

  if (TOTAL_DIRECT > PG_CONNECTION_LIMIT) {
    logger.error(`[CONNECTION BUDGET] OVER BUDGET! Allocated ${TOTAL_DIRECT} direct connections but limit is ${PG_CONNECTION_LIMIT}. Reduce pool sizes or increase PG_CONNECTION_LIMIT.`);
  }

  if (processType === 'web' || processType === 'worker') {
    const webMain = processType === 'web'
      ? MAIN_POOL_MAX
      : computeHintWebMain();
    const workerMain = processType === 'worker'
      ? MAIN_POOL_MAX
      : parseInt(process.env.WORKER_PG_POOL_MAX || '18', 10);
    const trackingDirect = TRACKING_POOL_USE_POOLER_HINT() ? 0 : (processType === 'web' ? TRACKING_POOL_MAX : TRACKING_POOL_MAX_HINT());
    const importDirect = IMPORT_POOL_USE_POOLER_HINT() ? 0 : IMPORT_POOL_MAX_HINT();
    const notify = NOTIFY_CONNECTIONS * 2;
    const safetyHeadroom = Number(process.env.PG_SPLIT_PROCESS_HEADROOM || 2);
    const combined = webMain + workerMain + trackingDirect + importDirect + notify;

    const poolerParts: string[] = [];
    if (TRACKING_POOL_USE_POOLER_HINT()) poolerParts.push(`tracking=${TRACKING_POOL_MAX_HINT()}`);
    if (IMPORT_POOL_USE_POOLER_HINT()) poolerParts.push(`import=${IMPORT_POOL_MAX_HINT()}`);
    const poolerNote = poolerParts.length > 0 ? ` [${poolerParts.join(", ")} via pooler, excluded]` : "";

    if (combined + safetyHeadroom > PG_CONNECTION_LIMIT) {
      logger.error(`[CONNECTION BUDGET] SPLIT-PROCESS OVER BUDGET! Combined web(${webMain})+worker(${workerMain})+tracking(${trackingDirect})+import(${importDirect})+notify(${notify})=${combined} + headroom ${safetyHeadroom} = ${combined + safetyHeadroom} exceeds Neon limit ${PG_CONNECTION_LIMIT}.${poolerNote}`);
    } else {
      logger.info(`[CONNECTION BUDGET] Split-process aggregate: web(${webMain})+worker(${workerMain})+tracking(${trackingDirect})+import(${importDirect})+notify(${notify}) = ${combined} of ${PG_CONNECTION_LIMIT} (headroom ${PG_CONNECTION_LIMIT - combined}, required >= ${safetyHeadroom}) OK${poolerNote}`);
    }
  }
}

function computeHintWebMain(): number {
  const allPooler = TRACKING_POOL_USE_POOLER_HINT() && IMPORT_POOL_USE_POOLER_HINT();
  if (allPooler) return parseInt(process.env.WEB_PG_POOL_MAX || '20', 10);
  const webBudget = parseInt(process.env.WEB_PG_POOL_MAX || '24', 10);
  const td = TRACKING_POOL_USE_POOLER_HINT() ? 0 : TRACKING_POOL_MAX_HINT();
  const id = IMPORT_POOL_USE_POOLER_HINT() ? 0 : IMPORT_POOL_MAX_HINT();
  return Math.max(2, webBudget - td - id);
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
  return detectPoolerAvailable();
}

function IMPORT_POOL_MAX_HINT(): number {
  const usePooler = IMPORT_POOL_USE_POOLER_HINT();
  return Number(process.env.PG_IMPORT_POOL_MAX || (usePooler ? 6 : 4));
}

function IMPORT_POOL_USE_POOLER_HINT(): boolean {
  if (process.env.IMPORT_POOL_USE_DIRECT === "true") return false;
  return detectPoolerAvailable();
}
