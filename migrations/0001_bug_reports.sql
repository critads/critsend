-- Bug Reports — global feedback widget on every authenticated page (task #127)
CREATE TABLE IF NOT EXISTS "bug_reports" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" varchar,
  "user_email" text,
  "description" text NOT NULL,
  "screenshot_path" text,
  "page_url" text,
  "user_agent" text,
  "viewport_width" integer,
  "viewport_height" integer,
  "status" text DEFAULT 'new' NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "bug_reports_status_check" CHECK ("status" IN ('new', 'in_progress', 'completed'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bug_reports_status_idx" ON "bug_reports" USING btree ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bug_reports_created_at_idx" ON "bug_reports" USING btree ("created_at");
