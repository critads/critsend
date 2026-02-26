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
  connectionTimeoutMillis: isExternalDb ? 15000 : 10000,
  statement_timeout: 120000,
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
