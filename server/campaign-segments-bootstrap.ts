import { pool } from "./db";
import { logger } from "./logger";

let bootstrapPromise: Promise<void> | null = null;

async function runCampaignSegmentsBootstrap(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('campaign_segments_bootstrap'))");
    await client.query(`
      CREATE TABLE IF NOT EXISTS campaign_segments (
        campaign_id varchar NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
        segment_id varchar NOT NULL REFERENCES segments(id) ON DELETE RESTRICT,
        position integer NOT NULL,
        CONSTRAINT campaign_segments_pkey PRIMARY KEY (campaign_id, segment_id)
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS campaign_segments_campaign_position_idx
      ON campaign_segments (campaign_id, position)
    `);
    await client.query(`
      INSERT INTO campaign_segments (campaign_id, segment_id, position)
      SELECT id, segment_id, 0
      FROM campaigns
      WHERE segment_id IS NOT NULL
      ON CONFLICT DO NOTHING
    `);
    await client.query("COMMIT");
    logger.info("[CAMPAIGN_SEGMENTS] Schema and legacy backfill ready");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export function ensureCampaignSegmentsSchema(): Promise<void> {
  if (!bootstrapPromise) {
    bootstrapPromise = runCampaignSegmentsBootstrap().catch((error) => {
      bootstrapPromise = null;
      throw error;
    });
  }
  return bootstrapPromise;
}