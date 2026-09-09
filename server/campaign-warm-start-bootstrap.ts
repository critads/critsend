import { pool } from "./db";
import { logger } from "./logger";

let bootstrapPromise: Promise<void> | null = null;

async function runBootstrap(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('campaign_warm_start_bootstrap'))");
    await client.query(`
      ALTER TABLE campaigns
        ADD COLUMN IF NOT EXISTS prioritize_active_clickers boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS warm_engagement_cutoff timestamp,
        ADD COLUMN IF NOT EXISTS warm_eligible_count integer,
        ADD COLUMN IF NOT EXISTS warm_clicker_count integer,
        ADD COLUMN IF NOT EXISTS warm_cap integer,
        ADD COLUMN IF NOT EXISTS warm_phase text,
        ADD COLUMN IF NOT EXISTS warm_cursor_id varchar(36),
        ADD COLUMN IF NOT EXISTS warm_audience_exhausted_at timestamp,
        ADD COLUMN IF NOT EXISTS step_execution_version integer NOT NULL DEFAULT 0
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS campaign_warm_recipients (
        campaign_id varchar NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
        subscriber_id varchar NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
        CONSTRAINT campaign_warm_recipients_pkey PRIMARY KEY (campaign_id, subscriber_id)
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS campaign_warm_recipients_subscriber_idx
      ON campaign_warm_recipients (subscriber_id)
    `);
    await client.query("COMMIT");
    logger.info("[CAMPAIGN_WARM_START] Schema ready");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export function ensureCampaignWarmStartSchema(): Promise<void> {
  if (!bootstrapPromise) {
    bootstrapPromise = runBootstrap().catch((error) => {
      bootstrapPromise = null;
      throw error;
    });
  }
  return bootstrapPromise;
}