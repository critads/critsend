-- Task #315: persisted « similar brands » lookups (web-search grounded model
-- answers) of the Smart segment wizard. Mirrors the pgTable declaration in
-- shared/schema.ts and the runtime bootstrap in server/smart-segment-bootstrap.ts.
CREATE TABLE IF NOT EXISTS "smart_segment_similar_brand_analyses" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  "brand_key" varchar(512) NOT NULL,
  "result" jsonb NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "smart_segment_similar_brand_analyses_key_created_idx"
  ON "smart_segment_similar_brand_analyses" ("brand_key", "created_at" DESC);
