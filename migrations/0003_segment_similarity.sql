CREATE TABLE IF NOT EXISTS "segment_similarity_analyses" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  "source_tag" text NOT NULL,
  "result" jsonb NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "segment_similarity_analyses_source_created_idx"
  ON "segment_similarity_analyses" ("source_tag", "created_at" DESC);

ALTER TABLE "campaigns"
  ADD COLUMN IF NOT EXISTS "similarity_snapshot" jsonb;