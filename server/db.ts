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

// ──────────────────────────────────────────────────────────────────────
// PgBouncer-safe backend timeouts — campaign-job stall RCA (2026-05-19).
//
// Root cause of the 2026-05-19 outage: pg.Pool's `connect` event runs
// `SET statement_timeout/lock_timeout` as plain (non-LOCAL) SETs. Under
// Neon's PgBouncer **transaction pooling**, those session-level SETs are
// silently discarded on every transaction boundary — the backend stays
// at its server defaults (`lock_timeout=0`, `idle_in_transaction_session
// _timeout=300000ms`). When a worker crashed mid-`pressureGuardReserve
// SendSlots`, the backend kept 1000 advisory locks + row locks for the
// full 5 min Neon timeout; every retry of the same chunk blocked on
// those locks until `statement_timeout=120s` fired, the job timed out
// at 30 min, was requeued, blocked again — indefinitely.
//
// The ONLY parameters that survive PgBouncer transaction pooling are
// those passed via the `options` libpq startup parameter (pgbouncer
// forwards them to the backend at session establishment, and they
// become the new defaults — not session SETs that get wiped). We inject
// `idle_in_transaction_session_timeout=60s` so a crashed worker's locks
// auto-release in 60s instead of 5min, plus re-state lock/statement
// timeouts at the backend level so they cannot be wiped.
const REQUIRED_BACKEND_OPTIONS: Record<string, string> = {
  lock_timeout: '15000',
  statement_timeout: '120000',
  idle_in_transaction_session_timeout: '60000',
};
try {
  const url = new URL(connectionString);
  // Code-review caveat: if the operator already set `options`, do NOT skip
  // injection — merge instead. Otherwise the fix is silently bypassed for any
  // env where DATABASE_URL was hand-tuned with custom GUCs (e.g. `search_path`).
  const existing = url.searchParams.get('options') ?? '';
  // Parse existing `-c k=v` pairs (libpq format) so we only append the ones
  // not already explicitly overridden by the operator.
  const overridden = new Set<string>();
  for (const match of existing.matchAll(/-c\s+([\w.]+)\s*=/g)) {
    overridden.add(match[1]);
  }
  const toAppend: string[] = [];
  for (const [key, val] of Object.entries(REQUIRED_BACKEND_OPTIONS)) {
    if (!overridden.has(key)) toAppend.push(`-c ${key}=${val}`);
  }
  if (toAppend.length > 0) {
    const merged = existing ? `${existing} ${toAppend.join(' ')}` : toAppend.join(' ');
    url.searchParams.set('options', merged);
    connectionString = url.toString();
    logger.info(`DB backend options merged: appended [${toAppend.join(', ')}]${existing ? ` to existing options [${existing}]` : ''}`);
  } else {
    logger.info(`DB backend options: all required GUCs already present in operator-supplied options [${existing}]`);
  }
} catch (err: any) {
  logger.warn(`Could not inject backend options into connection string: ${err?.message || err}`);
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

const STARTUP_GRACE_MS = Number(process.env.STARTUP_GRACE_MS || 180_000);
const startupTimestamp = Date.now();

export function isInStartupGrace(): boolean {
  return Date.now() - startupTimestamp < STARTUP_GRACE_MS;
}

const BG_POOL_SATURATION_THRESHOLD = 0.6;

export async function backgroundQuery<T = any>(
  queryText: string,
  values?: any[],
  label = "background",
): Promise<pg.QueryResult<T> | null> {
  const active = pool.totalCount - pool.idleCount;
  const saturation = MAIN_POOL_MAX > 0 ? active / MAIN_POOL_MAX : 0;
  if (saturation >= BG_POOL_SATURATION_THRESHOLD || pool.waitingCount > 0) {
    logger.warn(`[BG_QUERY] Skipped ${label}: pool saturation ${(saturation * 100).toFixed(0)}% (active=${active}/${MAIN_POOL_MAX}, waiting=${pool.waitingCount})`);
    return null;
  }
  return pool.query<T>(queryText, values);
}

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
  const e = err as { message?: string; code?: string; severity?: string };
  // 1. PostgreSQL SQLSTATE codes that signal capacity / connection exhaustion.
  //    Covers Neon's "too many clients" + driver-level connection failures
  //    that should always be retryable from the client's perspective.
  //    See https://www.postgresql.org/docs/current/errcodes-appendix.html
  //      53300 = too_many_connections
  //      53400 = configuration_limit_exceeded
  //      57P03 = cannot_connect_now
  //      08006 = connection_failure
  //      08001 = sqlclient_unable_to_establish_sqlconnection
  //      08004 = sqlserver_rejected_establishment_of_sqlconnection
  if (e.code && /^(53300|53400|57P03|08006|08001|08004)$/.test(e.code)) return true;
  // 2. Message-pattern fallback for pg-pool-internal errors that don't carry
  //    a SQLSTATE (the pool layer raises plain JS Errors before reaching the
  //    server). Matches both modern and legacy pg builds.
  const msg = e.message || String(err);
  return /timeout exceeded when trying to connect|Connection terminated due to connection timeout|Cannot use a pool after calling end|too many connections for role|remaining connection slots are reserved/i.test(msg);
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
  client.query(`SET statement_timeout = '${poolConfig.statement_timeout}'`).catch(() => {});
  client.query(`SET lock_timeout = '${poolConfig.lock_timeout}'`).catch(() => {});
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
