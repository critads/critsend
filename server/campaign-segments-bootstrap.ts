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
    // Multi-exclusion (mirrors migrations/0008). The legacy single
    // `exclude_segment_id` column stays as a mirror of position 0; the
    // backfill only seeds campaigns that have no exclusion rows yet so a
    // campaign whose exclusions were edited through the new table is never
    // re-seeded from a stale mirror value. segment_id RESTRICTs deletion, as
    // audience rows do: a running sender keeps exclusion ids in memory and
    // skips segments it can no longer compile, so a cascaded delete would let
    // later batches reach explicitly excluded subscribers.
    await client.query(`
      CREATE TABLE IF NOT EXISTS campaign_exclusion_segments (
        campaign_id varchar NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
        segment_id varchar NOT NULL CONSTRAINT campaign_exclusion_segments_segment_id_fkey
          REFERENCES segments(id) ON DELETE RESTRICT,
        position integer NOT NULL,
        CONSTRAINT campaign_exclusion_segments_pkey PRIMARY KEY (campaign_id, segment_id)
      )
    `);
    await ensureExclusionSegmentFkRestrict(client);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS campaign_exclusion_segments_campaign_position_idx
      ON campaign_exclusion_segments (campaign_id, position)
    `);
    await client.query(`
      INSERT INTO campaign_exclusion_segments (campaign_id, segment_id, position)
      SELECT c.id, c.exclude_segment_id, 0
      FROM campaigns c
      WHERE c.exclude_segment_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM campaign_exclusion_segments ces WHERE ces.campaign_id = c.id
        )
      ON CONFLICT DO NOTHING
    `);
    await client.query("COMMIT");
    logger.info("[CAMPAIGN_SEGMENTS] Schema and legacy backfill ready (audience + exclusion segments)");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** Tables created by an earlier build carried ON DELETE CASCADE on the
 * segment reference. Rewrite any non-RESTRICT segment FK in place; a no-op
 * once the constraint already restricts. Runs under the bootstrap advisory
 * lock and transaction of the caller. */
async function ensureExclusionSegmentFkRestrict(client: { query: (sql: string) => Promise<{ rows: any[] }> }): Promise<void> {
  const { rows } = await client.query(`
    SELECT con.conname, con.confdeltype
    FROM pg_constraint con
    WHERE con.conrelid = 'campaign_exclusion_segments'::regclass
      AND con.confrelid = 'segments'::regclass
      AND con.contype = 'f'
  `);
  const lax = rows.filter((row) => row.confdeltype !== "r");
  if (!lax.length) return;
  for (const row of lax) {
    await client.query(`ALTER TABLE campaign_exclusion_segments DROP CONSTRAINT "${String(row.conname).replace(/"/g, '""')}"`);
  }
  if (!rows.some((row) => row.confdeltype === "r")) {
    await client.query(`
      ALTER TABLE campaign_exclusion_segments
      ADD CONSTRAINT campaign_exclusion_segments_segment_id_fkey
      FOREIGN KEY (segment_id) REFERENCES segments(id) ON DELETE RESTRICT
    `);
  }
  logger.warn(`[CAMPAIGN_SEGMENTS] Rewrote ${lax.length} exclusion segment FK constraint(s) to ON DELETE RESTRICT`);
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