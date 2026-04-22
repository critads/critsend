import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "@shared/schema";
import { logger } from "./logger";
import { MAIN_POOL_MAX, isExternalDb } from "./connection-budget";

const { Pool } = pg;

let connectionString = process.env.NEON_DATABASE_URL || process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error(
    "NEON_DATABASE_URL or DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

if (connectionString.includes("neon.tech")) {
  try {
    const url = new URL(connectionString);
    if (url.pathname !== "/neondb") {
      logger.info(`Database path override: '${url.pathname}' -> '/neondb'`);
      url.pathname = "/neondb";
      connectionString = url.toString();
    }
  } catch {}
}

export { isExternalDb };

const poolConfig: pg.PoolConfig = {
  connectionString,
  max: MAIN_POOL_MAX,
  min: isExternalDb ? 1 : 2,
  idleTimeoutMillis: isExternalDb ? 20000 : 30000,
  // Fail fast on checkout when the pool is saturated. The 503 middleware
  // (server/middleware/pool-safety.ts) catches the timeout error and turns
  // it into a 503 + Retry-After:1, so a brief saturation spike degrades to
  // "retry soon" instead of a 10-second user-visible hang.
  connectionTimeoutMillis: isExternalDb ? 2000 : 2000,
  statement_timeout: 120000,
  lock_timeout: 30000,
  allowExitOnIdle: false,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
};

if (isExternalDb) {
  poolConfig.ssl = { rejectUnauthorized: false };
  logger.info("Database SSL enabled for external connection (Neon)");
}

export const pool = new Pool(poolConfig);

logger.info(`PG pool configured: max=${MAIN_POOL_MAX}, min=${poolConfig.min}, idleTimeout=${poolConfig.idleTimeoutMillis}ms, connTimeout=${poolConfig.connectionTimeoutMillis}ms, external=${isExternalDb}`);

pool.on('error', (err) => {
  logger.error('Unexpected DB pool error on idle client', { error: err.message });
});

export function isPoolHealthy(): boolean {
  if (pool.waitingCount > 0) return false;
  if (pool.totalCount >= MAIN_POOL_MAX && pool.idleCount === 0) return false;
  return true;
}

/**
 * Pool saturation in [0..1].
 *   total>=max with no idle and waiters > 0  → 1.0 (fully saturated)
 *   active connections / max                 → otherwise.
 * Used by the load-shedding middleware to short-circuit non-critical
 * requests before they ever try to acquire a connection.
 */
export function getPoolSaturation(): number {
  const active = pool.totalCount - pool.idleCount;
  if (MAIN_POOL_MAX <= 0) return 0;
  if (pool.waitingCount > 0 && pool.idleCount === 0) return 1;
  return Math.min(1, active / MAIN_POOL_MAX);
}

/**
 * Returns true when the error originates from `pg`'s pool checkout timeout.
 * Used by the safety middleware to convert these into 503 instead of 500.
 */
export function isPoolCheckoutError(err: unknown): boolean {
  if (!err) return false;
  const msg = (err as Error)?.message || String(err);
  return /timeout exceeded when trying to connect|Connection terminated due to connection timeout|Cannot use a pool after calling end/i.test(msg);
}

if (isExternalDb) {
  const KEEPALIVE_INTERVAL = 4 * 60 * 1000;
  const keepaliveTimer = setInterval(() => {
    if (pool.waitingCount > 0) return;
    pool.query('SELECT 1').catch((err) => {
      logger.warn('Pool keepalive query failed', { error: err.message });
    });
  }, KEEPALIVE_INTERVAL);
  keepaliveTimer.unref();
}

pool.on('connect', (client) => {
  if (isExternalDb) {
    client.query("SET search_path TO public").catch(() => {});
  }
});

export const db = drizzle(pool, { schema });

setInterval(() => {
  logger.debug("PG pool stats", {
    total: pool.totalCount,
    idle: pool.idleCount,
    waiting: pool.waitingCount,
    max: MAIN_POOL_MAX,
  });
}, 30_000);
