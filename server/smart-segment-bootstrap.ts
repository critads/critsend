import { pool } from "./db";
import { logger } from "./logger";

let bootstrapPromise: Promise<void> | null = null;

/**
 * Task #304 — smart_segment_analyses. Mirrors migrations/0006 so a deployment
 * that missed the migration run still gets the table on next start (same
 * convention as the brands / unsubscribe-continue bootstraps).
 */
async function runSmartSegmentBootstrap(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('smart_segment_analyses_bootstrap'))");
    await client.query(`
      CREATE TABLE IF NOT EXISTS smart_segment_analyses (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        fingerprint varchar(128) NOT NULL,
        status varchar(16) NOT NULL DEFAULT 'queued',
        stage varchar(32) NOT NULL DEFAULT 'brand_history',
        progress integer NOT NULL DEFAULT 0,
        error text,
        error_code varchar(64),
        params jsonb NOT NULL,
        evidence jsonb,
        proposal jsonb,
        model varchar(128),
        prompt_version varchar(32),
        token_usage jsonb,
        created_segments jsonb NOT NULL DEFAULT '[]'::jsonb,
        created_by varchar(255),
        owner varchar(255),
        heartbeat_at timestamp,
        created_at timestamp NOT NULL DEFAULT now(),
        started_at timestamp,
        finished_at timestamp,
        updated_at timestamp NOT NULL DEFAULT now()
      )
    `);
    // Liveness columns (multi-instance job tracking) for tables created
    // before they existed.
    await client.query(`ALTER TABLE smart_segment_analyses ADD COLUMN IF NOT EXISTS owner varchar(255)`);
    await client.query(`ALTER TABLE smart_segment_analyses ADD COLUMN IF NOT EXISTS heartbeat_at timestamp`);
    await client.query(`
      CREATE INDEX IF NOT EXISTS smart_segment_analyses_fingerprint_created_idx
      ON smart_segment_analyses (fingerprint, created_at DESC)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS smart_segment_analyses_status_idx
      ON smart_segment_analyses (status)
    `);
    await client.query("COMMIT");
    logger.info("[SMART_SEGMENT] Schema ready");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export function ensureSmartSegmentSchema(): Promise<void> {
  if (!bootstrapPromise) {
    bootstrapPromise = runSmartSegmentBootstrap().catch((error) => {
      bootstrapPromise = null;
      throw error;
    });
  }
  return bootstrapPromise;
}
