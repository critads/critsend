import { pool } from "./db";
import { logger } from "./logger";

let bootstrapPromise: Promise<void> | null = null;

async function runBootstrap(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('segment_exclusion_hashes_bootstrap'))");
    await client.query("CREATE EXTENSION IF NOT EXISTS pgcrypto");
    await client.query(`
      CREATE TABLE IF NOT EXISTS segment_exclusion_hashes (
        segment_id varchar NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
        email_hash varchar(64) NOT NULL,
        CONSTRAINT segment_exclusion_hashes_pkey PRIMARY KEY (segment_id, email_hash),
        CONSTRAINT segment_exclusion_hashes_format_check
          CHECK (email_hash ~ '^[0-9a-f]{64}$')
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS segment_exclusion_hashes_hash_idx
      ON segment_exclusion_hashes (email_hash)
    `);
    await client.query("COMMIT");
    logger.info("[SEGMENT_EXCLUSIONS] Schema ready");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export function ensureSegmentExclusionsSchema(): Promise<void> {
  if (!bootstrapPromise) {
    bootstrapPromise = runBootstrap().catch((error) => {
      bootstrapPromise = null;
      throw error;
    });
  }
  return bootstrapPromise;
}