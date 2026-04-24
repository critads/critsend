import { pool } from "./db";
import { logger } from "./logger";
import type { PoolClient } from "pg";

const ADVISORY_LOCK_KEY_TRACKING_TOKENS = 900001;
const ADVISORY_LOCK_KEY_TRACKING_BOOTSTRAP = 900002;
const ADVISORY_LOCK_KEY_ANALYTICS_BOOTSTRAP = 900003;
const ADVISORY_LOCK_KEY_TRIGRAM_INDEX = 900004;

export const LOCK_KEYS = {
  TRACKING_TOKENS: ADVISORY_LOCK_KEY_TRACKING_TOKENS,
  TRACKING_BOOTSTRAP: ADVISORY_LOCK_KEY_TRACKING_BOOTSTRAP,
  ANALYTICS_BOOTSTRAP: ADVISORY_LOCK_KEY_ANALYTICS_BOOTSTRAP,
  TRIGRAM_INDEX: ADVISORY_LOCK_KEY_TRIGRAM_INDEX,
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
      await pool.query(`DROP INDEX IF EXISTS "${indexName}"`);
      return false;
    }
    return true;
  } catch (err: any) {
    logger.warn(`[BOOTSTRAP_LOCK] Failed to check index existence for ${indexName}: ${err?.message || err}`);
    return false;
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
