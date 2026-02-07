CREATE TABLE "campaign_jobs" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" varchar NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"started_at" timestamp,
	"completed_at" timestamp,
	"worker_id" text,
	"error_message" text
);
--> statement-breakpoint
CREATE TABLE "campaign_sends" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" varchar NOT NULL,
	"subscriber_id" varchar NOT NULL,
	"sent_at" timestamp DEFAULT now() NOT NULL,
	"status" text DEFAULT 'sent' NOT NULL,
	"first_open_at" timestamp,
	"first_click_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "campaign_stats" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" varchar NOT NULL,
	"subscriber_id" varchar NOT NULL,
	"type" text NOT NULL,
	"link" text,
	"timestamp" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"mta_id" varchar,
	"segment_id" varchar,
	"from_name" text NOT NULL,
	"from_email" text NOT NULL,
	"reply_email" text,
	"subject" text NOT NULL,
	"preheader" text,
	"html_content" text NOT NULL,
	"track_clicks" boolean DEFAULT true NOT NULL,
	"track_opens" boolean DEFAULT true NOT NULL,
	"unsubscribe_text" text DEFAULT 'Unsubscribe',
	"company_address" text,
	"sending_speed" text DEFAULT 'medium' NOT NULL,
	"scheduled_at" timestamp,
	"status" text DEFAULT 'draft' NOT NULL,
	"pause_reason" text,
	"open_tag" text,
	"click_tag" text,
	"unsubscribe_tag" text,
	"sent_count" integer DEFAULT 0 NOT NULL,
	"pending_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"started_at" timestamp,
	"completed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "dashboard_cache" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "dashboard_cache_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "email_headers" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"value" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "error_logs" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"severity" text DEFAULT 'error' NOT NULL,
	"message" text NOT NULL,
	"details" text,
	"campaign_id" varchar,
	"subscriber_id" varchar,
	"import_job_id" varchar,
	"email" text,
	"timestamp" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "flush_jobs" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"total_rows" integer DEFAULT 0 NOT NULL,
	"processed_rows" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"started_at" timestamp,
	"completed_at" timestamp,
	"heartbeat" timestamp,
	"worker_id" text,
	"error_message" text
);
--> statement-breakpoint
CREATE TABLE "import_job_queue" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"import_job_id" varchar NOT NULL,
	"csv_file_path" text NOT NULL,
	"total_lines" integer DEFAULT 0 NOT NULL,
	"processed_lines" integer DEFAULT 0 NOT NULL,
	"file_size_bytes" integer DEFAULT 0 NOT NULL,
	"processed_bytes" integer DEFAULT 0 NOT NULL,
	"last_checkpoint_line" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"started_at" timestamp,
	"completed_at" timestamp,
	"heartbeat" timestamp,
	"worker_id" text,
	"error_message" text
);
--> statement-breakpoint
CREATE TABLE "import_jobs" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"filename" text NOT NULL,
	"total_rows" integer DEFAULT 0 NOT NULL,
	"processed_rows" integer DEFAULT 0 NOT NULL,
	"new_subscribers" integer DEFAULT 0 NOT NULL,
	"updated_subscribers" integer DEFAULT 0 NOT NULL,
	"failed_rows" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"tag_mode" text DEFAULT 'merge' NOT NULL,
	"error_message" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"started_at" timestamp,
	"completed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "import_staging" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" varchar NOT NULL,
	"email" text NOT NULL,
	"tags" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"ip_address" text,
	"line_number" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mtas" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"hostname" text,
	"port" integer DEFAULT 587 NOT NULL,
	"username" text,
	"password" text,
	"tracking_domain" text,
	"open_tracking_domain" text,
	"image_hosting_domain" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"mode" text DEFAULT 'real' NOT NULL,
	"simulated_latency_ms" integer DEFAULT 0,
	"failure_rate" integer DEFAULT 0,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nullsink_captures" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" varchar NOT NULL,
	"subscriber_id" varchar,
	"mta_id" varchar,
	"from_email" text NOT NULL,
	"to_email" text NOT NULL,
	"subject" text NOT NULL,
	"message_size" integer DEFAULT 0,
	"status" text DEFAULT 'captured' NOT NULL,
	"handshake_time_ms" integer DEFAULT 0,
	"total_time_ms" integer DEFAULT 0,
	"timestamp" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pending_tag_operations" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subscriber_id" varchar NOT NULL,
	"campaign_id" varchar,
	"tag_type" text NOT NULL,
	"tag_value" text NOT NULL,
	"event_type" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"max_retries" integer DEFAULT 5 NOT NULL,
	"last_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"processed_at" timestamp,
	"next_retry_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "segments" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"rules" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"sid" varchar PRIMARY KEY NOT NULL,
	"sess" jsonb NOT NULL,
	"expire" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscribers" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"tags" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"ip_address" text,
	"import_date" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "subscribers_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" text NOT NULL,
	"password" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "users_username_unique" UNIQUE("username")
);
--> statement-breakpoint
ALTER TABLE "campaign_jobs" ADD CONSTRAINT "campaign_jobs_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_sends" ADD CONSTRAINT "campaign_sends_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_sends" ADD CONSTRAINT "campaign_sends_subscriber_id_subscribers_id_fk" FOREIGN KEY ("subscriber_id") REFERENCES "public"."subscribers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_stats" ADD CONSTRAINT "campaign_stats_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_stats" ADD CONSTRAINT "campaign_stats_subscriber_id_subscribers_id_fk" FOREIGN KEY ("subscriber_id") REFERENCES "public"."subscribers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_mta_id_mtas_id_fk" FOREIGN KEY ("mta_id") REFERENCES "public"."mtas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_segment_id_segments_id_fk" FOREIGN KEY ("segment_id") REFERENCES "public"."segments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "error_logs" ADD CONSTRAINT "error_logs_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "error_logs" ADD CONSTRAINT "error_logs_subscriber_id_subscribers_id_fk" FOREIGN KEY ("subscriber_id") REFERENCES "public"."subscribers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "error_logs" ADD CONSTRAINT "error_logs_import_job_id_import_jobs_id_fk" FOREIGN KEY ("import_job_id") REFERENCES "public"."import_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_job_queue" ADD CONSTRAINT "import_job_queue_import_job_id_import_jobs_id_fk" FOREIGN KEY ("import_job_id") REFERENCES "public"."import_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nullsink_captures" ADD CONSTRAINT "nullsink_captures_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nullsink_captures" ADD CONSTRAINT "nullsink_captures_subscriber_id_subscribers_id_fk" FOREIGN KEY ("subscriber_id") REFERENCES "public"."subscribers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nullsink_captures" ADD CONSTRAINT "nullsink_captures_mta_id_mtas_id_fk" FOREIGN KEY ("mta_id") REFERENCES "public"."mtas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_tag_operations" ADD CONSTRAINT "pending_tag_operations_subscriber_id_subscribers_id_fk" FOREIGN KEY ("subscriber_id") REFERENCES "public"."subscribers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_tag_operations" ADD CONSTRAINT "pending_tag_operations_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "campaign_jobs_campaign_idx" ON "campaign_jobs" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "campaign_jobs_status_idx" ON "campaign_jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "campaign_jobs_created_at_idx" ON "campaign_jobs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "campaign_jobs_status_created_idx" ON "campaign_jobs" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_sends_unique_idx" ON "campaign_sends" USING btree ("campaign_id","subscriber_id");--> statement-breakpoint
CREATE INDEX "campaign_sends_campaign_idx" ON "campaign_sends" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "campaign_sends_status_idx" ON "campaign_sends" USING btree ("status");--> statement-breakpoint
CREATE INDEX "campaign_stats_campaign_idx" ON "campaign_stats" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "campaign_stats_subscriber_idx" ON "campaign_stats" USING btree ("subscriber_id");--> statement-breakpoint
CREATE INDEX "error_logs_type_idx" ON "error_logs" USING btree ("type");--> statement-breakpoint
CREATE INDEX "error_logs_timestamp_idx" ON "error_logs" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX "error_logs_campaign_idx" ON "error_logs" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "error_logs_severity_idx" ON "error_logs" USING btree ("severity");--> statement-breakpoint
CREATE INDEX "flush_jobs_status_idx" ON "flush_jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "flush_jobs_created_at_idx" ON "flush_jobs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "import_job_queue_import_job_idx" ON "import_job_queue" USING btree ("import_job_id");--> statement-breakpoint
CREATE INDEX "import_job_queue_status_idx" ON "import_job_queue" USING btree ("status");--> statement-breakpoint
CREATE INDEX "import_job_queue_created_at_idx" ON "import_job_queue" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "import_jobs_status_created_idx" ON "import_jobs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "import_staging_job_id_idx" ON "import_staging" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "import_staging_email_idx" ON "import_staging" USING btree ("email");--> statement-breakpoint
CREATE INDEX "nullsink_captures_campaign_idx" ON "nullsink_captures" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "nullsink_captures_timestamp_idx" ON "nullsink_captures" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX "pending_tag_ops_subscriber_idx" ON "pending_tag_operations" USING btree ("subscriber_id");--> statement-breakpoint
CREATE INDEX "pending_tag_ops_status_idx" ON "pending_tag_operations" USING btree ("status");--> statement-breakpoint
CREATE INDEX "pending_tag_ops_created_at_idx" ON "pending_tag_operations" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "pending_tag_ops_next_retry_idx" ON "pending_tag_operations" USING btree ("next_retry_at");--> statement-breakpoint
CREATE INDEX "pending_tag_ops_status_retry_idx" ON "pending_tag_operations" USING btree ("status","next_retry_at");--> statement-breakpoint
CREATE INDEX "email_idx" ON "subscribers" USING btree ("email");--> statement-breakpoint
CREATE INDEX "tags_gin_idx" ON "subscribers" USING gin ("tags");