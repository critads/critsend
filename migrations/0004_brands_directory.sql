CREATE TABLE IF NOT EXISTS "brands" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" varchar(255) NOT NULL,
  "ref" varchar(255) NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "brands_name_ref_unique"
  ON "brands" ("name", "ref");

CREATE INDEX IF NOT EXISTS "brands_created_at_idx"
  ON "brands" ("created_at");

CREATE INDEX IF NOT EXISTS "brands_name_lower_idx"
  ON "brands" (lower("name"));

CREATE INDEX IF NOT EXISTS "brands_ref_lower_idx"
  ON "brands" (lower("ref"));