import { pool } from "./db";
import { logger } from "./logger";
import type { PoolClient } from "pg";

const ADVISORY_LOCK_KEY_TRACKING_TOKENS = 900001;
const ADVISORY_LOCK_KEY_TRACKING_BOOTSTRAP = 900002;
const ADVISORY_LOCK_KEY_ANALYTICS_BOOTSTRAP = 900003;
const ADVISORY_LOCK_KEY_TRIGRAM_INDEX = 900004;
const ADVISORY_LOCK_KEY_SEGMENT_NAME_TRGM = 900005;
const ADVISORY_LOCK_KEY_CAMPAIGN_NAME_TRGM = 900006;
const ADVISORY_LOCK_KEY_MTA_NAME_TRGM = 900007;
const ADVISORY_LOCK_KEY_SEGMENT_NAME_LOWER = 900008;
const ADVISORY_LOCK_KEY_CAMPAIGN_SUBJECT_TRGM = 900009;
const ADVISORY_LOCK_KEY_MTA_HOSTNAME_TRGM = 900010;
const ADVISORY_LOCK_KEY_CAMPAIGN_ORIGINALS_LIST = 900011;
const ADVISORY_LOCK_KEY_CAMPAIGN_EXCLUDE_SEGMENT = 900012;
const ADVISORY_LOCK_KEY_PRESSURE_GUARD = 900013;
const ADVISORY_LOCK_KEY_PRESSURE_DRAIN = 900014;
const ADVISORY_LOCK_KEY_PRESSURE_MAINTENANCE = 900015;
const ADVISORY_LOCK_KEY_PRESSURE_AUDIT_TTL = 900016;
const ADVISORY_LOCK_KEY_CAMPAIGN_SENDS_PRESSURE_HELD = 900017;

export const LOCK_KEYS = {
  TRACKING_TOKENS: ADVISORY_LOCK_KEY_TRACKING_TOKENS,
  TRACKING_BOOTSTRAP: ADVISORY_LOCK_KEY_TRACKING_BOOTSTRAP,
  ANALYTICS_BOOTSTRAP: ADVISORY_LOCK_KEY_ANALYTICS_BOOTSTRAP,
  TRIGRAM_INDEX: ADVISORY_LOCK_KEY_TRIGRAM_INDEX,
  SEGMENT_NAME_TRGM: ADVISORY_LOCK_KEY_SEGMENT_NAME_TRGM,
  CAMPAIGN_NAME_TRGM: ADVISORY_LOCK_KEY_CAMPAIGN_NAME_TRGM,
  MTA_NAME_TRGM: ADVISORY_LOCK_KEY_MTA_NAME_TRGM,
  SEGMENT_NAME_LOWER: ADVISORY_LOCK_KEY_SEGMENT_NAME_LOWER,
  CAMPAIGN_SUBJECT_TRGM: ADVISORY_LOCK_KEY_CAMPAIGN_SUBJECT_TRGM,
  MTA_HOSTNAME_TRGM: ADVISORY_LOCK_KEY_MTA_HOSTNAME_TRGM,
  CAMPAIGN_ORIGINALS_LIST: ADVISORY_LOCK_KEY_CAMPAIGN_ORIGINALS_LIST,
  CAMPAIGN_EXCLUDE_SEGMENT: ADVISORY_LOCK_KEY_CAMPAIGN_EXCLUDE_SEGMENT,
  PRESSURE_GUARD: ADVISORY_LOCK_KEY_PRESSURE_GUARD,
  PRESSURE_DRAIN: ADVISORY_LOCK_KEY_PRESSURE_DRAIN,
  PRESSURE_MAINTENANCE: ADVISORY_LOCK_KEY_PRESSURE_MAINTENANCE,
  PRESSURE_AUDIT_TTL: ADVISORY_LOCK_KEY_PRESSURE_AUDIT_TTL,
  CAMPAIGN_SENDS_PRESSURE_HELD: ADVISORY_LOCK_KEY_CAMPAIGN_SENDS_PRESSURE_HELD,
} as const;

export type LockResult = "ran" | "skipped" | "error";

export async function withAdvisoryLock(
  lockKey: number,
  label: string,
  fn: (client: PoolClient) => Promise<void>,
): Promise<LockResult> {
  let client: PoolClient | null = null;
  try {
    client = await pool.connect();
    const res = await client.query<{ acquired: boolean }>(
      `SELECT pg_try_advisory_lock($1) AS acquired`,
      [lockKey],
    );
    const acquired = res.rows[0]?.acquired === true;
    if (!acquired) {
      logger.info(`[${label}] Another process is running bootstrap — skipping`);
      client.release();
      return "skipped";
    }
    try {
      await fn(client);
    } finally {
      try {
        await client.query(`SELECT pg_advisory_unlock($1)`, [lockKey]);
      } catch (unlockErr: any) {
        logger.warn(`[${label}] Failed to release advisory lock ${lockKey}: ${unlockErr?.message || unlockErr}`);
      }
      client.release();
    }
    return "ran";
  } catch (err: any) {
    logger.warn(`[${label}] Bootstrap lock error: ${err?.message || err}`);
    if (client) {
      try { client.release(); } catch {}
    }
    return "error";
  }
}

export async function indexExistsAndValid(indexName: string): Promise<boolean> {
  try {
    const result = await pool.query<{ valid: boolean }>(
      `SELECT i.indisvalid AS valid
       FROM pg_class c
       JOIN pg_index i ON i.indexrelid = c.oid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = $1
       LIMIT 1`,
      [indexName],
    );
    if (result.rows.length === 0) return false;
    if (!result.rows[0].valid) {
      logger.warn(`[BOOTSTRAP_LOCK] Index ${indexName} exists but is INVALID — will be dropped and rebuilt`);
      // DROP CONCURRENTLY on a large table can also exceed the global
      // statement_timeout; run on a dedicated client with timeout=0.
      await runIndexDdlNoTimeout(`DROP INDEX CONCURRENTLY IF EXISTS "${indexName}"`, `DROP ${indexName}`);
      return false;
    }
    return true;
  } catch (err: any) {
    logger.warn(`[BOOTSTRAP_LOCK] Failed to check index existence for ${indexName}: ${err?.message || err}`);
    return false;
  }
}

/**
 * Run `CREATE INDEX CONCURRENTLY` (or any single-statement DDL that cannot
 * live in a transaction) on a dedicated client with `statement_timeout`
 * disabled and a bounded `lock_timeout`. Required for partial/GIN indexes
 * on large tables (campaign_sends ~11GB / 60M rows, subscribers ~1.5M GIN
 * trigram) where the global 2-min Neon statement_timeout reliably aborts
 * the build mid-flight and leaves the index in the INVALID state — which
 * then poisons subsequent boots until manually dropped.
 *
 * Note: CONCURRENTLY itself cannot run inside a transaction block, so we
 * issue the SETs and the DDL as separate top-level statements on the same
 * session. `statement_timeout=0` is session-scoped and dies with the
 * client (which we release in `finally`), so it never leaks to the pool.
 */
export async function runIndexDdlNoTimeout(ddl: string, label: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`SET statement_timeout = 0`);
    await client.query(`SET lock_timeout = '5min'`);
    await client.query(ddl);
  } catch (err: any) {
    logger.warn(`[BOOTSTRAP_LOCK] ${label} DDL failed: ${err?.message || err}`);
    throw err;
  } finally {
    // Defensive: clear session-scoped SETs before returning the client to
    // the pool. node-postgres recycles clients across consumers, and we
    // don't want a leftover `statement_timeout=0` to bleed into the next
    // borrower (which could be a hot-path query that should be bounded).
    try { await client.query(`RESET statement_timeout; RESET lock_timeout`); } catch {}
    try { client.release(); } catch {}
  }
}

export async function columnHasData(table: string, column: string): Promise<boolean> {
  try {
    const result = await pool.query(
      `SELECT 1 FROM ${table} WHERE ${column} IS NOT NULL LIMIT 1`,
    );
    return (result.rows?.length ?? 0) > 0;
  } catch {
    return false;
  }
}
