import { pool } from "./db";
import { logger } from "./logger";

let bootstrapPromise: Promise<void> | null = null;

/**
 * Orange Test — mta_orange_tests. Mirrors migrations/0009 so a deployment
 * that missed the migration run still gets the table on next start (same
 * convention as the brands / smart-segment bootstraps).
 */
async function runOrangeTestBootstrap(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('mta_orange_tests_bootstrap'))");
    await client.query(`
      CREATE TABLE IF NOT EXISTS mta_orange_tests (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        mta_id varchar NOT NULL REFERENCES mtas(id) ON DELETE CASCADE,
        reference varchar(64) NOT NULL,
        message_id varchar(255) NOT NULL,
        status varchar(16) NOT NULL DEFAULT 'sending',
        verdict varchar(16),
        spam_level_raw text,
        found_in varchar(16),
        found_folder text,
        matched_by varchar(16),
        raw_headers jsonb,
        mailbox varchar(255) NOT NULL,
        from_email text NOT NULL,
        requested_by varchar(255),
        send_error jsonb,
        send_note text,
        last_check_error text,
        last_check_at timestamptz,
        poll_count integer NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now(),
        sent_at timestamptz,
        next_poll_at timestamptz,
        deadline_at timestamptz,
        received_at timestamptz,
        finished_at timestamptz,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS mta_orange_tests_reference_idx
      ON mta_orange_tests (reference)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS mta_orange_tests_mta_created_idx
      ON mta_orange_tests (mta_id, created_at DESC)
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS mta_orange_tests_pending_mta_idx
      ON mta_orange_tests (mta_id) WHERE status IN ('sending', 'waiting')
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS mta_orange_tests_due_idx
      ON mta_orange_tests (next_poll_at) WHERE status IN ('sending', 'waiting')
    `);
    await client.query("COMMIT");
    logger.info("[ORANGE_TEST] Schema ready");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export function ensureOrangeTestSchema(): Promise<void> {
  if (!bootstrapPromise) {
    bootstrapPromise = runOrangeTestBootstrap().catch((error) => {
      bootstrapPromise = null;
      throw error;
    });
  }
  return bootstrapPromise;
}
