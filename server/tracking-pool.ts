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
 * lookups. Sized via PG_TRACKING_POOL_MAX (default 20 with pooler, 10 direct).
 *
 * Connection strategy:
 *   1. NEON_TRACKING_DATABASE_URL env var (explicit override)
 *   2. Auto-derived Neon pooled endpoint (ep-xxx-pooler.*.neon.tech)
 *   3. Fallback to NEON_DATABASE_URL / DATABASE_URL (direct endpoint)
 *
 * The pooled endpoint uses PgBouncer (transaction mode) and supports up to
 * 10,000 concurrent connections — its connections do NOT count against the
 * direct-connection limit (default 50). This effectively removes tracking
 * traffic from the connection budget entirely.
 */
import pg from "pg";
import { logger } from "./logger";
import { isExternalDb, TRACKING_POOL_MAX, TRACKING_POOL_USE_POOLER, derivePooledUrl, isPoolerUrl } from "./connection-budget";

const { Pool } = pg;

function resolveTrackingConnectionString(): { url: string; mode: "explicit-override" | "auto-pooler" | "direct" } {
  const baseUrl = process.env.NEON_DATABASE_URL || process.env.DATABASE_URL || "";

  if (process.env.TRACKING_POOL_USE_DIRECT === "true") {
    return { url: baseUrl, mode: "direct" };
  }

  if (process.env.NEON_TRACKING_DATABASE_URL) {
    return { url: process.env.NEON_TRACKING_DATABASE_URL, mode: "explicit-override" };
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

const resolved = resolveTrackingConnectionString();
let connectionString = resolved.url;

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

const modeLabel = resolved.mode === "explicit-override"
  ? `explicit override (NEON_TRACKING_DATABASE_URL, ${TRACKING_POOL_USE_POOLER ? "pooler" : "direct"})`
  : resolved.mode === "auto-pooler"
  ? "auto-derived pooler"
  : "direct";
logger.info(
  `[TRACKING POOL] configured: max=${TRACKING_POOL_MAX}, connTimeout=${poolConfig.connectionTimeoutMillis}ms, external=${isExternalDb}, mode=${modeLabel}, pooler=${TRACKING_POOL_USE_POOLER}`,
);

export async function probeTrackingPool(): Promise<void> {
  if (TRACKING_POOL_MAX <= 0) return;
  try {
    const result = await trackingPool.query("SELECT 1 AS ok");
    if (result.rows[0]?.ok === 1) {
      logger.info(`[TRACKING POOL] startup probe OK (mode=${modeLabel})`);
    }
  } catch (err: any) {
    logger.error(
      `[TRACKING POOL] startup probe FAILED — tracking events will not persist until connectivity is restored. ` +
      `mode=${modeLabel}, error=${err?.message || err}. ` +
      `Fix: set NEON_TRACKING_DATABASE_URL to a valid pooled/direct URL, or set TRACKING_POOL_USE_DIRECT=true to bypass auto-derivation.`
    );
  }
}

export function getTrackingPoolStats() {
  return {
    total: trackingPool.totalCount,
    idle: trackingPool.idleCount,
    waiting: trackingPool.waitingCount,
    max: TRACKING_POOL_MAX,
  };
}

export function isTrackingPoolHealthy(): boolean {
  if (TRACKING_POOL_MAX <= 0) return true;
  if (trackingPool.waitingCount > 0) return false;
  if (trackingPool.totalCount >= TRACKING_POOL_MAX && trackingPool.idleCount === 0) return false;
  return true;
}

export async function closeTrackingPool(): Promise<void> {
  try {
    await trackingPool.end();
    logger.info("[TRACKING POOL] closed");
  } catch (err: any) {
    logger.error(`[TRACKING POOL] error closing: ${err?.message || err}`);
  }
}
