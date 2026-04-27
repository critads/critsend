/**
 * Dedicated PostgreSQL pool for CSV import operations.
 *
 * Why a separate pool? Large CSV imports hold connections for extended periods
 * (COPY + staging tables + bulk upserts) and run long-running transactions.
 * If those operations share the main pool, a heavy import can starve dashboard
 * and API requests.
 *
 * Like the tracking pool, this routes through Neon's PgBouncer pooled endpoint
 * by default — its connections do NOT count against the 50-connection direct
 * limit. All import operations use explicit transactions (BEGIN/COMMIT/ROLLBACK)
 * with COPY, temp tables (ON COMMIT DROP), and batched inserts, which are fully
 * compatible with PgBouncer transaction mode.
 *
 * Connection strategy (same as tracking pool):
 *   1. IMPORT_POOL_USE_DIRECT=true forces direct endpoint
 *   2. Auto-derived Neon pooled endpoint (ep-xxx-pooler.*.neon.tech)
 *   3. Fallback to NEON_DATABASE_URL / DATABASE_URL (direct endpoint)
 */
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@shared/schema";
import { logger } from "./logger";
import { isExternalDb, IMPORT_POOL_MAX, IMPORT_POOL_USE_POOLER, derivePooledUrl, isPoolerUrl } from "./connection-budget";

const { Pool } = pg;

function resolveImportConnectionString(): { url: string; mode: "auto-pooler" | "direct" } {
  const baseUrl = process.env.NEON_DATABASE_URL || process.env.DATABASE_URL || "";

  if (process.env.IMPORT_POOL_USE_DIRECT === "true") {
    return { url: baseUrl, mode: "direct" };
  }

  if (isPoolerUrl(baseUrl)) {
    return { url: baseUrl, mode: "auto-pooler" };
  }

  const pooled = derivePooledUrl(baseUrl);
  if (pooled) {
    return { url: pooled, mode: "auto-pooler" };
  }

  return { url: baseUrl, mode: "direct" };
}

const resolved = resolveImportConnectionString();
let connectionString = resolved.url;

if (!connectionString) {
  throw new Error(
    "NEON_DATABASE_URL or DATABASE_URL must be set for import pool",
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
  max: IMPORT_POOL_MAX,
  min: IMPORT_POOL_MAX > 0 ? 1 : 0,
  idleTimeoutMillis: isExternalDb ? 20000 : 30000,
  connectionTimeoutMillis: 15000,
  statement_timeout: 300000,
  lock_timeout: 30000,
  allowExitOnIdle: false,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
};

if (isExternalDb) {
  poolConfig.ssl = { rejectUnauthorized: false };
}

export const importPool = new Pool(poolConfig);

importPool.on("error", (err) => {
  logger.error("Unexpected import pool error on idle client", { error: err.message });
});

importPool.on("connect", (client) => {
  if (isExternalDb) {
    client.query("SET search_path TO public").catch(() => {});
  }
});

export const importDb = drizzle(importPool, { schema });

const modeLabel = resolved.mode === "auto-pooler" ? "auto-derived pooler" : "direct";
logger.info(
  `[IMPORT POOL] configured: max=${IMPORT_POOL_MAX}, connTimeout=${poolConfig.connectionTimeoutMillis}ms, stmtTimeout=${poolConfig.statement_timeout}ms, external=${isExternalDb}, mode=${modeLabel}, pooler=${IMPORT_POOL_USE_POOLER}`,
);

export async function probeImportPool(): Promise<void> {
  if (IMPORT_POOL_MAX <= 0) return;
  try {
    const result = await importPool.query("SELECT 1 AS ok");
    if (result.rows[0]?.ok === 1) {
      logger.info(`[IMPORT POOL] startup probe OK (mode=${modeLabel})`);
    }
  } catch (err: any) {
    logger.error(
      `[IMPORT POOL] startup probe FAILED — CSV imports will not work until connectivity is restored. ` +
      `mode=${modeLabel}, error=${err?.message || err}. ` +
      `Fix: check NEON_DATABASE_URL, or set IMPORT_POOL_USE_DIRECT=true to bypass pooler auto-derivation.`
    );
  }
}

export function getImportPoolStats() {
  return {
    total: importPool.totalCount,
    idle: importPool.idleCount,
    waiting: importPool.waitingCount,
    max: IMPORT_POOL_MAX,
  };
}

export async function closeImportPool(): Promise<void> {
  try {
    await importPool.end();
    logger.info("[IMPORT POOL] closed");
  } catch (err: any) {
    logger.error(`[IMPORT POOL] error closing: ${err?.message || err}`);
  }
}
