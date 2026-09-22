-- Multiple exclusion segments per campaign. Mirrors the pgTable declaration in
-- shared/schema.ts and the runtime bootstrap in
-- server/campaign-segments-bootstrap.ts (which applies this idempotently at
-- startup, so a deployment never depends on this file being run by hand).
--
-- `campaigns.exclude_segment_id` is kept as a mirror of the first exclusion
-- (position 0) for older readers; this table is the canonical representation.
CREATE TABLE IF NOT EXISTS "campaign_exclusion_segments" (
  "campaign_id" varchar NOT NULL REFERENCES "campaigns"("id") ON DELETE CASCADE,
  "segment_id" varchar NOT NULL CONSTRAINT "campaign_exclusion_segments_segment_id_fkey"
    REFERENCES "segments"("id") ON DELETE RESTRICT,
  "position" integer NOT NULL,
  CONSTRAINT "campaign_exclusion_segments_pkey" PRIMARY KEY ("campaign_id", "segment_id")
);

-- Tables created by an earlier build used ON DELETE CASCADE on segment_id;
-- the bootstrap rewrites that constraint to RESTRICT (see
-- ensureExclusionSegmentFkRestrict in server/campaign-segments-bootstrap.ts).

CREATE UNIQUE INDEX IF NOT EXISTS "campaign_exclusion_segments_campaign_position_idx"
  ON "campaign_exclusion_segments" ("campaign_id", "position");

-- Seed only campaigns that have no exclusion rows yet.
INSERT INTO "campaign_exclusion_segments" ("campaign_id", "segment_id", "position")
SELECT c."id", c."exclude_segment_id", 0
FROM "campaigns" c
WHERE c."exclude_segment_id" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "campaign_exclusion_segments" ces WHERE ces."campaign_id" = c."id"
  )
ON CONFLICT DO NOTHING;
