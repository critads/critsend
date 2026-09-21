-- Task #304: tracked Smart segment analyses (parameters, evidence dossier,
-- validated AI proposal, provenance, created segments). Mirrors the pgTable
-- declaration in shared/schema.ts so both drizzle-kit push and hand-applied
-- migrations converge on the same shape.
CREATE TABLE IF NOT EXISTS "smart_segment_analyses" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  "fingerprint" varchar(128) NOT NULL,
  "status" varchar(16) NOT NULL DEFAULT 'queued',
  "stage" varchar(32) NOT NULL DEFAULT 'brand_history',
  "progress" integer NOT NULL DEFAULT 0,
  "error" text,
  "error_code" varchar(64),
  "params" jsonb NOT NULL,
  "evidence" jsonb,
  "proposal" jsonb,
  "model" varchar(128),
  "prompt_version" varchar(32),
  "token_usage" jsonb,
  "created_segments" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "created_by" varchar(255),
  "owner" varchar(255),
  "heartbeat_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "started_at" timestamp,
  "finished_at" timestamp,
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "smart_segment_analyses_fingerprint_created_idx"
  ON "smart_segment_analyses" ("fingerprint", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "smart_segment_analyses_status_idx"
  ON "smart_segment_analyses" ("status");

-- Liveness columns for deployments that created the table before them.
ALTER TABLE "smart_segment_analyses" ADD COLUMN IF NOT EXISTS "owner" varchar(255);
ALTER TABLE "smart_segment_analyses" ADD COLUMN IF NOT EXISTS "heartbeat_at" timestamp;
