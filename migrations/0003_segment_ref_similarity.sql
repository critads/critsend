CREATE TABLE IF NOT EXISTS "segment_ref_similarity_analyses" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  "source_ref" text NOT NULL,
  "result" jsonb NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "segment_ref_similarity_analyses_source_created_idx"
  ON "segment_ref_similarity_analyses" ("source_ref", "created_at" DESC);

ALTER TABLE "campaigns"
  ADD COLUMN IF NOT EXISTS "similarity_snapshot" jsonb;

UPDATE "campaigns"
   SET "similarity_snapshot" = '{}'::jsonb
 WHERE "similarity_snapshot" IS NULL
   AND ("status" <> 'draft' OR "started_at" IS NOT NULL);

ALTER TABLE "campaigns"
  ALTER COLUMN "similarity_snapshot" SET DEFAULT '{}'::jsonb;