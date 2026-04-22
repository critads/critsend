/**
 * Dedicated PostgreSQL pool for email-tracking endpoints.
 *
 * Why a separate pool? Open/click/unsubscribe traffic is bursty and originates
 * from many different recipient IPs (so per-IP rate limiting cannot protect us).
 * If those endpoints share the main pool, a campaign blast can drain every
 * connection and starve user-facing requests (login, dashboard, imports).
 *
 * This pool is only created in the web process. The flusher in tracking-buffer.ts
 * uses it for batched INSERTs; the click route uses it for cache-miss link
 * lookups. Sized via PG_TRACKING_POOL_MAX (default 6) and accounted for in the
 * connection budget.
 */
import pg from "pg";
import { logger } from "./logger";
import { isExternalDb, TRACKING_POOL_MAX } from "./connection-budget";

const { Pool } = pg;

let connectionString = process.env.NEON_DATABASE_URL || process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error(
    "NEON_DATABASE_URL or DATABASE_URL must be set for tracking pool",
  );
}

if (connectionString.includes("neon.tech")) {
  try {
    const url = new URL(connectionString);
    if (url.pathname !== "/neondb") {
      url.pathname = "/neondb";
      connectionString = url.toString();
    }
  } catch {}
}

const poolConfig: pg.PoolConfig = {
  connectionString,
  max: TRACKING_POOL_MAX,
  min: TRACKING_POOL_MAX > 0 ? 1 : 0,
  idleTimeoutMillis: isExternalDb ? 20000 : 30000,
  connectionTimeoutMillis: 5000,
  statement_timeout: 30000,
  allowExitOnIdle: false,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
};

if (isExternalDb) {
  poolConfig.ssl = { rejectUnauthorized: false };
}

export const trackingPool = new Pool(poolConfig);

trackingPool.on("error", (err) => {
  logger.error("Unexpected tracking pool error on idle client", { error: err.message });
});

trackingPool.on("connect", (client) => {
  if (isExternalDb) {
    client.query("SET search_path TO public").catch(() => {});
  }
});

logger.info(
  `[TRACKING POOL] configured: max=${TRACKING_POOL_MAX}, connTimeout=${poolConfig.connectionTimeoutMillis}ms, external=${isExternalDb}`,
);

export function getTrackingPoolStats() {
  return {
    total: trackingPool.totalCount,
    idle: trackingPool.idleCount,
    waiting: trackingPool.waitingCount,
    max: TRACKING_POOL_MAX,
  };
}

export async function closeTrackingPool(): Promise<void> {
  try {
    await trackingPool.end();
    logger.info("[TRACKING POOL] closed");
  } catch (err: any) {
    logger.error(`[TRACKING POOL] error closing: ${err?.message || err}`);
  }
}
