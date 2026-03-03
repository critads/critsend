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

export const MAIN_POOL_MAX = Number(
  process.env.PG_POOL_MAX || Math.max(2, PG_CONNECTION_LIMIT - NOTIFY_CONNECTIONS - IMPORT_POOL_MAX)
);

const TOTAL_ALLOCATED = MAIN_POOL_MAX + IMPORT_POOL_MAX + NOTIFY_CONNECTIONS;

export function validateConnectionBudget(): void {
  logger.info(`[CONNECTION BUDGET] Limit: ${PG_CONNECTION_LIMIT} | Main pool: ${MAIN_POOL_MAX} | Import worker: ${IMPORT_POOL_MAX} (concurrency: ${IMPORT_CONCURRENCY}) | LISTEN/NOTIFY: ${NOTIFY_CONNECTIONS} | Total allocated: ${TOTAL_ALLOCATED} | External: ${isExternalDb}`);

  if (TOTAL_ALLOCATED > PG_CONNECTION_LIMIT) {
    logger.error(`[CONNECTION BUDGET] OVER BUDGET! Allocated ${TOTAL_ALLOCATED} connections but limit is ${PG_CONNECTION_LIMIT}. Reduce PG_POOL_MAX or PG_IMPORT_POOL_MAX, or increase PG_CONNECTION_LIMIT.`);
  }
}
