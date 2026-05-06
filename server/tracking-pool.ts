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
 * lookups. Sized via PG_TRACKING_POOL_MAX (default 50 with pooler, 10 direct).
 * Singleflight coalescing in tracking-queries.ts and tracking-buffer.ts
 * ensures concurrent cache misses for the same key share one DB query.
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
 *
 * CRITICAL: PgBouncer in transaction mode strips `statement_timeout` from
 * startup parameters, so the pool config value is silently ignored. We enforce
 * timeouts via explicit SET on connect AND a JS-level safety net in
 * safeTrackingQuery(). Without this, hung queries leak connections permanently
 * until the pool is 100% saturated and the entire server hangs.
 */
import pg from "pg";
import { logger } from "./logger";
import { isExternalDb, TRACKING_POOL_MAX, TRACKING_POOL_USE_POOLER, derivePooledUrl, isPoolerUrl } from "./connection-budget";

const { Pool } = pg;

const TRACKING_STATEMENT_TIMEOUT_MS = Number(process.env.TRACKING_STATEMENT_TIMEOUT_MS || 10_000);
const TRACKING_QUERY_TIMEOUT_MS = Number(process.env.TRACKING_QUERY_TIMEOUT_MS || 12_000);
const FLUSH_STATEMENT_TIMEOUT_MS = Number(process.env.FLUSH_STATEMENT_TIMEOUT_MS || 60_000);
const FLUSH_QUERY_TIMEOUT_MS = Number(process.env.FLUSH_QUERY_TIMEOUT_MS || 65_000);

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
  connectionTimeoutMillis: 2000,
  statement_timeout: TRACKING_STATEMENT_TIMEOUT_MS,
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
  client.query("SET lock_timeout = '0'").catch(() => {});
  client.query(`SET statement_timeout = '${TRACKING_STATEMENT_TIMEOUT_MS}'`).catch(() => {});
});

const FLUSH_POOL_MAX = Number(process.env.PG_FLUSH_POOL_MAX || 8);

const flushPoolConfig: pg.PoolConfig = {
  connectionString,
  max: FLUSH_POOL_MAX,
  min: 1,
  idleTimeoutMillis: isExternalDb ? 20000 : 30000,
  connectionTimeoutMillis: 10000,
  statement_timeout: FLUSH_STATEMENT_TIMEOUT_MS,
  allowExitOnIdle: false,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
};

if (isExternalDb) {
  flushPoolConfig.ssl = { rejectUnauthorized: false };
}

export const flushPool = new Pool(flushPoolConfig);

flushPool.on("error", (err) => {
  logger.error("Unexpected flush pool error on idle client", { error: err.message });
});

flushPool.on("connect", (client) => {
  if (isExternalDb) {
    client.query("SET search_path TO public").catch(() => {});
  }
  client.query("SET lock_timeout = '0'").catch(() => {});
  client.query(`SET statement_timeout = '${FLUSH_STATEMENT_TIMEOUT_MS}'`).catch(() => {});
});

const modeLabel = resolved.mode === "explicit-override"
  ? `explicit override (NEON_TRACKING_DATABASE_URL, ${TRACKING_POOL_USE_POOLER ? "pooler" : "direct"})`
  : resolved.mode === "auto-pooler"
  ? "auto-derived pooler"
  : "direct";
logger.info(
  `[TRACKING POOL] read pool: max=${TRACKING_POOL_MAX}, flush pool: max=${FLUSH_POOL_MAX}, connTimeout=${poolConfig.connectionTimeoutMillis}ms, stmtTimeout=${TRACKING_STATEMENT_TIMEOUT_MS}ms, jsTimeout=${TRACKING_QUERY_TIMEOUT_MS}ms, external=${isExternalDb}, mode=${modeLabel}, pooler=${TRACKING_POOL_USE_POOLER}`,
);

/**
 * Execute a query on the tracking pool with a JS-level timeout safety net.
 *
 * PgBouncer in transaction mode strips `statement_timeout` from startup
 * parameters, so the pool config value may be silently ignored. Even if the
 * SET in the connect handler works, Neon cold starts or network partitions
 * can hang a connection at the TCP level where statement_timeout doesn't
 * help (it's a server-side timer, not a client-side one).
 *
 * This wrapper ensures that a hung query DESTROYS the connection (release
 * with `true`) instead of returning it to the pool in a broken state. The
 * pool then creates a fresh connection for the next request.
 */
export async function safeTrackingQuery<T extends pg.QueryResultRow = any>(
  sql: string,
  params?: any[],
  timeoutMs: number = TRACKING_QUERY_TIMEOUT_MS,
): Promise<pg.QueryResult<T>> {
  const client = await trackingPool.connect();
  let released = false;
  let timer: NodeJS.Timeout | null = null;

  const cleanup = (destroy: boolean) => {
    if (released) return;
    released = true;
    if (timer) clearTimeout(timer);
    try { client.release(destroy); } catch {}
  };

  return new Promise<pg.QueryResult<T>>((resolve, reject) => {
    timer = setTimeout(() => {
      cleanup(true);
      logger.error(`[TRACKING POOL] JS-level query timeout after ${timeoutMs}ms — connection destroyed. SQL: ${sql.slice(0, 80)}`);
      reject(new Error(`Tracking query timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    client.query<T>(sql, params)
      .then((result) => {
        cleanup(false);
        resolve(result);
      })
      .catch((err) => {
        const isTimeout = err?.message?.includes('timeout') || err?.code === '57014';
        cleanup(isTimeout);
        reject(err);
      });
  });
}

/**
 * Execute a query on the flush pool with a JS-level timeout safety net.
 * Same rationale as safeTrackingQuery but with longer timeouts for write operations.
 */
export async function safeFlushQuery<T extends pg.QueryResultRow = any>(
  sql: string,
  params?: any[],
  timeoutMs: number = FLUSH_QUERY_TIMEOUT_MS,
): Promise<pg.QueryResult<T>> {
  const client = await flushPool.connect();
  let released = false;
  let timer: NodeJS.Timeout | null = null;

  const cleanup = (destroy: boolean) => {
    if (released) return;
    released = true;
    if (timer) clearTimeout(timer);
    try { client.release(destroy); } catch {}
  };

  return new Promise<pg.QueryResult<T>>((resolve, reject) => {
    timer = setTimeout(() => {
      cleanup(true);
      logger.error(`[FLUSH POOL] JS-level query timeout after ${timeoutMs}ms — connection destroyed. SQL: ${sql.slice(0, 80)}`);
      reject(new Error(`Flush query timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    client.query<T>(sql, params)
      .then((result) => {
        cleanup(false);
        resolve(result);
      })
      .catch((err) => {
        const isTimeout = err?.message?.includes('timeout') || err?.code === '57014';
        cleanup(isTimeout);
        reject(err);
      });
  });
}

export async function probeTrackingPool(): Promise<void> {
  if (TRACKING_POOL_MAX <= 0) return;
  try {
    const result = await safeTrackingQuery("SELECT 1 AS ok");
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

export function getFlushPoolStats() {
  return {
    total: flushPool.totalCount,
    idle: flushPool.idleCount,
    waiting: flushPool.waitingCount,
    max: FLUSH_POOL_MAX,
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
    await Promise.all([
      trackingPool.end(),
      flushPool.end(),
    ]);
    logger.info("[TRACKING POOL] read + flush pools closed");
  } catch (err: any) {
    logger.error(`[TRACKING POOL] error closing: ${err?.message || err}`);
  }
}
