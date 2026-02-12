import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "@shared/schema";
import { logger } from "./logger";

const { Pool } = pg;

let connectionString = process.env.NEON_DATABASE_URL || process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error(
    "NEON_DATABASE_URL or DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const isExternalDb = connectionString.includes("neon.tech") || process.env.DB_SSL === "true";

const poolConfig: pg.PoolConfig = {
  connectionString,
  max: isExternalDb ? 15 : 20,
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

pool.on('error', (err) => {
  logger.error('Unexpected DB pool error on idle client', { error: err.message });
});

pool.on('connect', (client) => {
  if (isExternalDb) {
    client.query("SET search_path TO public").catch(() => {});
  }
});

export const db = drizzle(pool, { schema });
