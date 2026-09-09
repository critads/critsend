CREATE TABLE IF NOT EXISTS "orange_wanadoo_counter_reconcile_state" (
  "singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
  "algorithm_version" integer DEFAULT 2 NOT NULL,
  "cursor_created_at" timestamp,
  "cursor_id" text,
  "active_campaign_id" text,
  "active_campaign_created_at" timestamp,
  "send_cursor_subscriber_id" text,
  "stats_cursor_subscriber_id" text,
  "phase" text DEFAULT 'sends' NOT NULL,
  "baseline_sent" integer DEFAULT 0 NOT NULL,
  "baseline_complaints" integer DEFAULT 0 NOT NULL,
  "accumulated_sent" bigint DEFAULT 0 NOT NULL,
  "accumulated_total_sent" bigint DEFAULT 0 NOT NULL,
  "accumulated_complaints" bigint DEFAULT 0 NOT NULL,
  "total_rows_examined" bigint DEFAULT 0 NOT NULL,
  "total_campaigns_completed" bigint DEFAULT 0 NOT NULL,
  "total_campaigns_fixed" bigint DEFAULT 0 NOT NULL,
  "total_retention_preserved" bigint DEFAULT 0 NOT NULL,
  "total_errors" bigint DEFAULT 0 NOT NULL,
  "last_success_at" timestamp,
  "last_error_at" timestamp,
  "completed_at" timestamp,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "orange_wanadoo_counter_reconcile_singleton_check" CHECK ("singleton")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "campaigns_ow_reconcile_cursor_idx"
  ON "campaigns" USING btree ("created_at", "id")
  WHERE "status" IN ('failed', 'completed', 'sent', 'cancelled');