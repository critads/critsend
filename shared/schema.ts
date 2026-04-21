import { sql, relations } from "drizzle-orm";
import { pgTable, text, varchar, integer, boolean, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// Subscribers table - optimized for millions of records with proper indexing
export const subscribers = pgTable("subscribers", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  email: text("email").notNull().unique(),
  tags: text("tags").array().notNull().default(sql`ARRAY[]::text[]`),
  refs: text("refs").array().notNull().default(sql`ARRAY[]::text[]`),
  ipAddress: text("ip_address"),
  importDate: timestamp("import_date").notNull().defaultNow(),
  suppressedUntil: timestamp("suppressed_until"),
  lastEngagedAt: timestamp("last_engaged_at"),
}, (table) => ({
  emailIdx: index("email_idx").on(table.email),
  emailLowerIdx: index("subscribers_email_lower_idx").on(sql`lower(email)`),
  tagsGinIdx: index("tags_gin_idx").using("gin", table.tags),
  refsGinIdx: index("refs_gin_idx").using("gin", table.refs),
}));

export const subscribersRelations = relations(subscribers, ({ many }) => ({
  stats: many(campaignStats),
}));

// Segments table
export const segments = pgTable("segments", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  description: text("description"),
  rules: jsonb("rules").notNull().default(sql`'[]'::jsonb`),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// MTA (Mail Transfer Agent) settings
export const mtas = pgTable("mtas", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  hostname: text("hostname"),
  port: integer("port").notNull().default(587),
  username: text("username"),
  password: text("password"),
  trackingDomain: text("tracking_domain"),
  openTrackingDomain: text("open_tracking_domain"),
  imageHostingDomain: text("image_hosting_domain"), // Domain for locally hosted email images
  fromName: text("from_name").notNull().default(""),
  fromEmail: text("from_email").notNull().default(""),
  isActive: boolean("is_active").notNull().default(true),
  mode: text("mode").notNull().default("real"), // "real" or "nullsink"
  protocol: text("protocol").notNull().default("STARTTLS"), // SSL | TLS | STARTTLS | NONE
  simulatedLatencyMs: integer("simulated_latency_ms").default(0), // Latency to simulate for nullsink
  failureRate: integer("failure_rate").default(0), // Percentage of simulated failures (0-100)
  unsubscribeText: text("unsubscribe_text").default("Unsubscribe"), // Default footer unsubscribe link text
  companyAddress: text("company_address"), // Default footer company address (CAN-SPAM)
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Null-sink captures - logs emails captured during test campaigns
export const nullsinkCaptures = pgTable("nullsink_captures", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  campaignId: varchar("campaign_id").notNull().references(() => campaigns.id),
  subscriberId: varchar("subscriber_id").references(() => subscribers.id),
  mtaId: varchar("mta_id").references(() => mtas.id),
  fromEmail: text("from_email").notNull(),
  toEmail: text("to_email").notNull(),
  subject: text("subject").notNull(),
  messageSize: integer("message_size").default(0), // Size in bytes
  htmlBody: text("html_body"),
  status: text("status").notNull().default("captured"), // captured, simulated_failure
  handshakeTimeMs: integer("handshake_time_ms").default(0),
  totalTimeMs: integer("total_time_ms").default(0),
  timestamp: timestamp("timestamp").notNull().defaultNow(),
}, (table) => ({
  campaignIdx: index("nullsink_captures_campaign_idx").on(table.campaignId),
  timestampIdx: index("nullsink_captures_timestamp_idx").on(table.timestamp),
}));

// Email headers
export const emailHeaders = pgTable("email_headers", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  value: text("value").notNull(),
  isDefault: boolean("is_default").notNull().default(false),
});

// Campaigns
export const campaigns = pgTable("campaigns", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  mtaId: varchar("mta_id").references(() => mtas.id),
  segmentId: varchar("segment_id").references(() => segments.id),
  fromName: text("from_name").notNull(),
  fromEmail: text("from_email").notNull(),
  replyEmail: text("reply_email"),
  subject: text("subject").notNull(),
  preheader: text("preheader"),
  htmlContent: text("html_content").notNull(),
  trackClicks: boolean("track_clicks").notNull().default(true),
  trackOpens: boolean("track_opens").notNull().default(true),
  unsubscribeText: text("unsubscribe_text").default("Unsubscribe"),
  companyAddress: text("company_address"),
  sendingSpeed: text("sending_speed").notNull().default("medium"),
  scheduledAt: timestamp("scheduled_at"),
  status: text("status").notNull().default("draft"),
  pauseReason: text("pause_reason"),
  retryUntil: timestamp("retry_until"),
  openTag: text("open_tag"),
  clickTag: text("click_tag"),
  unsubscribeTag: text("unsubscribe_tag"),
  sentCount: integer("sent_count").notNull().default(0),
  pendingCount: integer("pending_count").notNull().default(0),
  failedCount: integer("failed_count").notNull().default(0),
  autoRetryCount: integer("auto_retry_count").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
});

export const campaignsRelations = relations(campaigns, ({ one, many }) => ({
  mta: one(mtas, {
    fields: [campaigns.mtaId],
    references: [mtas.id],
  }),
  segment: one(segments, {
    fields: [campaigns.segmentId],
    references: [segments.id],
  }),
  stats: many(campaignStats),
}));

// Campaign statistics (opens, clicks)
export const campaignStats = pgTable("campaign_stats", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  campaignId: varchar("campaign_id").notNull().references(() => campaigns.id, { onDelete: 'cascade' }),
  subscriberId: varchar("subscriber_id").notNull().references(() => subscribers.id, { onDelete: 'cascade' }),
  type: text("type").notNull(),
  link: text("link"),
  timestamp: timestamp("timestamp").notNull().defaultNow(),
  // Enriched tracking fields
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  country: text("country"),
  city: text("city"),
  deviceType: text("device_type"),
  browser: text("browser"),
  os: text("os"),
}, (table) => ({
  campaignIdx: index("campaign_stats_campaign_idx").on(table.campaignId),
  subscriberIdx: index("campaign_stats_subscriber_idx").on(table.subscriberId),
}));

export const campaignStatsRelations = relations(campaignStats, ({ one }) => ({
  campaign: one(campaigns, {
    fields: [campaignStats.campaignId],
    references: [campaigns.id],
  }),
  subscriber: one(subscribers, {
    fields: [campaignStats.subscriberId],
    references: [subscribers.id],
  }),
}));

// Campaign sends - tracks which subscribers received which campaigns to prevent duplicates
export const campaignSends = pgTable("campaign_sends", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  campaignId: varchar("campaign_id").notNull().references(() => campaigns.id, { onDelete: 'cascade' }),
  subscriberId: varchar("subscriber_id").notNull().references(() => subscribers.id, { onDelete: 'cascade' }),
  sentAt: timestamp("sent_at").notNull().defaultNow(),
  status: text("status").notNull().default("sent"), // sent, failed, bounced, pending, attempting
  retryCount: integer("retry_count").notNull().default(0),
  lastRetryAt: timestamp("last_retry_at"),
  firstOpenAt: timestamp("first_open_at"),
  firstClickAt: timestamp("first_click_at"),
}, (table) => ({
  // UNIQUE constraint ensures no email is sent twice per campaign per subscriber
  uniqueSend: uniqueIndex("campaign_sends_unique_idx").on(table.campaignId, table.subscriberId),
  campaignIdx: index("campaign_sends_campaign_idx").on(table.campaignId),
  // Composite index replaces status-only index — covers (campaign_id, status) lookup pattern
  campaignStatusIdx: index("campaign_sends_campaign_status_idx").on(table.campaignId, table.status),
}));

export const campaignSendsRelations = relations(campaignSends, ({ one }) => ({
  campaign: one(campaigns, {
    fields: [campaignSends.campaignId],
    references: [campaigns.id],
  }),
  subscriber: one(subscribers, {
    fields: [campaignSends.subscriberId],
    references: [subscribers.id],
  }),
}));

// Import jobs
export const importJobs = pgTable("import_jobs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  filename: text("filename").notNull(),
  totalRows: integer("total_rows").notNull().default(0),
  processedRows: integer("processed_rows").notNull().default(0),
  newSubscribers: integer("new_subscribers").notNull().default(0),
  updatedSubscribers: integer("updated_subscribers").notNull().default(0),
  failedRows: integer("failed_rows").notNull().default(0),
  status: text("status").notNull().default("pending"),
  tagMode: text("tag_mode").notNull().default("merge"),
  importTarget: text("import_target").notNull().default("refs"),
  detectedRefs: text("detected_refs").array().notNull().default(sql`ARRAY[]::text[]`),
  cleanExistingRefs: boolean("clean_existing_refs").notNull().default(false),
  deleteExistingRefs: boolean("delete_existing_refs").notNull().default(false),
  errorMessage: text("error_message"),
  failureReasons: jsonb("failure_reasons"),
  skippedRows: integer("skipped_rows").notNull().default(0),
  forcedTags: text("forced_tags").array().notNull().default(sql`ARRAY[]::text[]`),
  forcedRefs: text("forced_refs").array().notNull().default(sql`ARRAY[]::text[]`),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
}, (table) => ({
  statusCreatedIdx: index("import_jobs_status_created_idx").on(table.status, table.createdAt),
}));

// Dashboard cache
export const dashboardCache = pgTable("dashboard_cache", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  key: text("key").notNull().unique(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// Sessions table for connect-pg-simple
export const sessions = pgTable("session", {
  sid: varchar("sid").primaryKey(),
  sess: jsonb("sess").notNull(),
  expire: timestamp("expire").notNull(),
});

// Campaign jobs table - PostgreSQL-backed job queue for campaign processing
export const campaignJobs = pgTable("campaign_jobs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  campaignId: varchar("campaign_id").notNull().references(() => campaigns.id),
  status: text("status").notNull().default("pending"), // pending, processing, completed, failed
  retryCount: integer("retry_count").notNull().default(0),
  nextRetryAt: timestamp("next_retry_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  workerId: text("worker_id"),
  errorMessage: text("error_message"),
}, (table) => ({
  campaignIdx: index("campaign_jobs_campaign_idx").on(table.campaignId),
  statusIdx: index("campaign_jobs_status_idx").on(table.status),
  createdAtIdx: index("campaign_jobs_created_at_idx").on(table.createdAt),
  statusCreatedIdx: index("campaign_jobs_status_created_idx").on(table.status, table.createdAt),
  pendingStatusIdx: index("campaign_jobs_pending_idx").on(table.status).where(sql`status = 'pending'`),
}));

export const campaignJobsRelations = relations(campaignJobs, ({ one }) => ({
  campaign: one(campaigns, {
    fields: [campaignJobs.campaignId],
    references: [campaigns.id],
  }),
}));

// Import job queue table - PostgreSQL-backed job queue for CSV import processing
// Uses file-based storage for CSV content instead of storing in database
// Optimized for resumable streaming of 7M+ row files
export const importJobQueue = pgTable("import_job_queue", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  importJobId: varchar("import_job_id").notNull().references(() => importJobs.id),
  csvFilePath: text("csv_file_path").notNull(), // Path to CSV file on disk
  totalLines: integer("total_lines").notNull().default(0), // Total lines to process
  processedLines: integer("processed_lines").notNull().default(0), // Lines processed so far
  fileSizeBytes: integer("file_size_bytes").notNull().default(0), // Total file size in bytes
  processedBytes: integer("processed_bytes").notNull().default(0), // Bytes processed so far (for resume)
  lastCheckpointLine: integer("last_checkpoint_line").notNull().default(0), // Last successfully processed line (for resume)
  status: text("status").notNull().default("pending"), // pending, processing, completed, failed
  createdAt: timestamp("created_at").notNull().defaultNow(),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  heartbeat: timestamp("heartbeat"), // Updated during processing to show worker is alive
  workerId: text("worker_id"),
  retryCount: integer("retry_count").notNull().default(0),
  errorMessage: text("error_message"),
}, (table) => ({
  importJobIdx: index("import_job_queue_import_job_idx").on(table.importJobId),
  statusIdx: index("import_job_queue_status_idx").on(table.status),
  createdAtIdx: index("import_job_queue_created_at_idx").on(table.createdAt),
}));

export const importJobQueueRelations = relations(importJobQueue, ({ one }) => ({
  importJob: one(importJobs, {
    fields: [importJobQueue.importJobId],
    references: [importJobs.id],
  }),
}));

// Import staging table - temporary table for high-speed COPY-based bulk imports
export const importStaging = pgTable("import_staging", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  jobId: varchar("job_id").notNull(),
  email: text("email").notNull(),
  tags: text("tags").array().notNull().default(sql`ARRAY[]::text[]`),
  refs: text("refs").array().notNull().default(sql`ARRAY[]::text[]`),
  ipAddress: text("ip_address"),
  lineNumber: integer("line_number").notNull().default(0),
}, (table) => ({
  jobIdIdx: index("import_staging_job_id_idx").on(table.jobId),
  emailIdx: index("import_staging_email_idx").on(table.email),
}));

// Error logs table - centralized error logging for failed sends, imports, etc.
export const errorLogs = pgTable("error_logs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  type: text("type").notNull(), // send_failed, import_failed, campaign_failed, etc.
  severity: text("severity").notNull().default("error"), // error, warning, info
  message: text("message").notNull(),
  details: text("details"), // Additional error details (stack trace, etc.)
  campaignId: varchar("campaign_id").references(() => campaigns.id),
  subscriberId: varchar("subscriber_id").references(() => subscribers.id),
  importJobId: varchar("import_job_id").references(() => importJobs.id),
  email: text("email"), // Store email for reference even if subscriber is deleted
  timestamp: timestamp("timestamp").notNull().defaultNow(),
}, (table) => ({
  typeIdx: index("error_logs_type_idx").on(table.type),
  timestampIdx: index("error_logs_timestamp_idx").on(table.timestamp),
  campaignIdx: index("error_logs_campaign_idx").on(table.campaignId),
  severityIdx: index("error_logs_severity_idx").on(table.severity),
}));

export const errorLogsRelations = relations(errorLogs, ({ one }) => ({
  campaign: one(campaigns, {
    fields: [errorLogs.campaignId],
    references: [campaigns.id],
  }),
  subscriber: one(subscribers, {
    fields: [errorLogs.subscriberId],
    references: [subscribers.id],
  }),
  importJob: one(importJobs, {
    fields: [errorLogs.importJobId],
    references: [importJobs.id],
  }),
}));

// Pending tag operations - queue for reliable tag additions with retry logic
export const pendingTagOperations = pgTable("pending_tag_operations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  subscriberId: varchar("subscriber_id").notNull().references(() => subscribers.id, { onDelete: 'cascade' }),
  campaignId: varchar("campaign_id").references(() => campaigns.id),
  tagType: text("tag_type").notNull(), // "positive" or "negative"
  tagValue: text("tag_value").notNull(),
  eventType: text("event_type").notNull(), // "open", "click", "unsubscribe"
  status: text("status").notNull().default("pending"), // pending, processing, completed, failed
  retryCount: integer("retry_count").notNull().default(0),
  maxRetries: integer("max_retries").notNull().default(5),
  lastError: text("last_error"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  processedAt: timestamp("processed_at"),
  nextRetryAt: timestamp("next_retry_at"),
}, (table) => ({
  subscriberIdx: index("pending_tag_ops_subscriber_idx").on(table.subscriberId),
  statusIdx: index("pending_tag_ops_status_idx").on(table.status),
  createdAtIdx: index("pending_tag_ops_created_at_idx").on(table.createdAt),
  nextRetryIdx: index("pending_tag_ops_next_retry_idx").on(table.nextRetryAt),
  statusRetryIdx: index("pending_tag_ops_status_retry_idx").on(table.status, table.nextRetryAt),
}));

export const pendingTagOperationsRelations = relations(pendingTagOperations, ({ one }) => ({
  subscriber: one(subscribers, {
    fields: [pendingTagOperations.subscriberId],
    references: [subscribers.id],
  }),
  campaign: one(campaigns, {
    fields: [pendingTagOperations.campaignId],
    references: [campaigns.id],
  }),
}));

// Flush jobs table - tracks subscriber deletion progress
export const flushJobs = pgTable("flush_jobs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  totalRows: integer("total_rows").notNull().default(0),
  processedRows: integer("processed_rows").notNull().default(0),
  status: text("status").notNull().default("pending"), // pending, processing, completed, failed, cancelled
  createdAt: timestamp("created_at").notNull().defaultNow(),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  heartbeat: timestamp("heartbeat"),
  workerId: text("worker_id"),
  errorMessage: text("error_message"),
}, (table) => ({
  statusIdx: index("flush_jobs_status_idx").on(table.status),
  createdAtIdx: index("flush_jobs_created_at_idx").on(table.createdAt),
}));

// Campaign links - opaque token registry for click tracking (hides destination URLs)
export const campaignLinks = pgTable("campaign_links", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  campaignId: varchar("campaign_id").notNull().references(() => campaigns.id, { onDelete: 'cascade' }),
  destinationUrl: text("destination_url").notNull(),
}, (table) => ({
  campaignIdx: index("campaign_links_campaign_idx").on(table.campaignId),
  uniqueLink: uniqueIndex("campaign_links_unique_idx").on(table.campaignId, table.destinationUrl),
}));

export type CampaignLink = typeof campaignLinks.$inferSelect;

// Tracking tokens - short branded tokens for click (/c/) and unsubscribe (/u/) URLs
// Note: the UNIQUE expression index (COALESCE) is not expressible in Drizzle — created via raw SQL
export const trackingTokens = pgTable("tracking_tokens", {
  token: varchar("token", { length: 8 }).primaryKey(),
  type: varchar("type", { length: 11 }).notNull(), // 'click' | 'unsubscribe'
  campaignId: varchar("campaign_id").notNull().references(() => campaigns.id, { onDelete: 'cascade' }),
  subscriberId: varchar("subscriber_id").notNull(),
  linkId: varchar("link_id").references(() => campaignLinks.id, { onDelete: 'cascade' }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  campaignIdx: index("tracking_tokens_campaign_idx").on(table.campaignId),
  subscriberIdx: index("tracking_tokens_subscriber_idx").on(table.subscriberId),
  createdAtIdx: index("tracking_tokens_created_at_idx").on(table.createdAt),
}));

export type TrackingToken = typeof trackingTokens.$inferSelect;

// Insert schemas
export const insertSubscriberSchema = createInsertSchema(subscribers).omit({ id: true, importDate: true }).extend({
  email: z.string().email("Invalid email address").max(254, "Email too long").transform(v => v.toLowerCase().trim()),
  tags: z.array(z.string().max(100, "Tag too long")).max(1000, "Too many tags").optional(),
});
export const insertSegmentSchema = createInsertSchema(segments).omit({ id: true, createdAt: true }).extend({
  name: z.string().min(1, "Name required").max(200, "Name too long"),
  description: z.string().max(1000, "Description too long").nullable().optional(),
});
export const insertMtaSchema = createInsertSchema(mtas).omit({ id: true, createdAt: true }).extend({
  name: z.string().min(1, "Name required").max(200, "Name too long"),
  fromName: z.string().min(1, "From Name is required").max(200, "From Name too long"),
  fromEmail: z.string().email("Invalid From Email").min(1, "From Email is required").max(254, "From Email too long"),
  hostname: z.string().max(253, "Hostname too long").nullable().optional(),
  port: z.number().int().min(1).max(65535).optional(),
  username: z.string().max(200).nullable().optional(),
  password: z.string().max(500).nullable().optional(),
});
export const insertEmailHeaderSchema = createInsertSchema(emailHeaders).omit({ id: true }).extend({
  name: z.string().min(1, "Name required").max(200, "Header name too long"),
  value: z.string().min(1, "Value required").max(2000, "Header value too long"),
});
export const insertCampaignSchema = createInsertSchema(campaigns).omit({ 
  id: true, 
  sentCount: true, 
  pendingCount: true, 
  failedCount: true,
  autoRetryCount: true,
  createdAt: true,
  startedAt: true,
  completedAt: true,
}).extend({
  name: z.string().min(1, "Name required").max(200, "Name too long"),
  fromName: z.string().min(1, "From name required").max(200, "From name too long"),
  fromEmail: z.string().email("Invalid from email").max(254, "Email too long"),
  replyEmail: z.string().email("Invalid reply email").max(254).nullable().optional(),
  subject: z.string().min(1, "Subject required").max(998, "Subject too long"),
  preheader: z.string().max(500, "Preheader too long").nullable().optional(),
  htmlContent: z.string().min(1, "HTML content required").max(5000000, "Content too large"),
  sendingSpeed: z.enum(["drip", "very_slow", "slow", "medium", "fast", "godzilla"]).optional(),
});

export const insertCampaignDraftSchema = createInsertSchema(campaigns).omit({
  id: true,
  sentCount: true,
  pendingCount: true,
  failedCount: true,
  autoRetryCount: true,
  createdAt: true,
  startedAt: true,
  completedAt: true,
}).extend({
  name: z.string().min(1, "Name required").max(200, "Name too long"),
  fromName: z.string().max(200, "From name too long").optional().default(""),
  fromEmail: z.string().max(254, "Email too long").optional().default(""),
  replyEmail: z.preprocess(
    (v) => (v === "" ? null : v),
    z.string().email("Invalid reply email").max(254).nullable().optional()
  ),
  subject: z.string().max(998, "Subject too long").optional().default(""),
  preheader: z.string().max(500, "Preheader too long").nullable().optional(),
  htmlContent: z.string().max(5000000, "Content too large").optional().default(""),
  mtaId: z.preprocess((v) => (v === "" ? null : v), z.string().nullable().optional()),
  segmentId: z.preprocess((v) => (v === "" ? null : v), z.string().nullable().optional()),
  sendingSpeed: z.enum(["drip", "very_slow", "slow", "medium", "fast", "godzilla"]).optional(),
  status: z.string().optional().default("draft"),
});

export const updateCampaignDraftSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  fromName: z.string().max(200).optional(),
  fromEmail: z.string().max(254).optional(),
  replyEmail: z.preprocess(
    (v) => (v === "" ? null : v),
    z.string().email().max(254).nullable().optional()
  ),
  subject: z.string().max(998).optional(),
  preheader: z.preprocess(
    (v) => (v === "" ? null : v),
    z.string().max(500).nullable().optional()
  ),
  htmlContent: z.string().max(5000000).optional(),
  mtaId: z.preprocess((v) => (v === "" ? null : v), z.string().nullable().optional()),
  segmentId: z.preprocess((v) => (v === "" ? null : v), z.string().nullable().optional()),
  trackClicks: z.boolean().optional(),
  trackOpens: z.boolean().optional(),
  unsubscribeText: z.string().optional(),
  companyAddress: z.preprocess(
    (v) => (v === "" ? null : v),
    z.string().nullable().optional()
  ),
  sendingSpeed: z.enum(["drip", "very_slow", "slow", "medium", "fast", "godzilla"]).optional(),
  scheduledAt: z.preprocess(
    (v) => (v === "" || v === null ? null : v),
    z.union([z.string(), z.date()]).nullable().optional()
  ),
  status: z.string().optional(),
  openTag: z.preprocess((v) => (v === "" ? null : v), z.string().nullable().optional()),
  clickTag: z.preprocess((v) => (v === "" ? null : v), z.string().nullable().optional()),
  unsubscribeTag: z.preprocess((v) => (v === "" ? null : v), z.string().nullable().optional()),
});
export const insertImportJobSchema = createInsertSchema(importJobs).omit({ 
  id: true, 
  processedRows: true, 
  newSubscribers: true, 
  updatedSubscribers: true,
  failedRows: true,
  status: true,
  errorMessage: true,
  failureReasons: true,
  skippedRows: true,
  createdAt: true,
  completedAt: true,
});
export const insertErrorLogSchema = createInsertSchema(errorLogs).omit({ 
  id: true, 
  timestamp: true,
});
export const insertNullsinkCaptureSchema = createInsertSchema(nullsinkCaptures).omit({ 
  id: true, 
  timestamp: true,
});

// Types
export type Subscriber = typeof subscribers.$inferSelect;
export type InsertSubscriber = z.infer<typeof insertSubscriberSchema>;

export type Segment = typeof segments.$inferSelect;
export type InsertSegment = z.infer<typeof insertSegmentSchema>;

export type Mta = typeof mtas.$inferSelect;
export type InsertMta = z.infer<typeof insertMtaSchema>;

export type EmailHeader = typeof emailHeaders.$inferSelect;
export type InsertEmailHeader = z.infer<typeof insertEmailHeaderSchema>;

export type Campaign = typeof campaigns.$inferSelect;
export type InsertCampaign = z.infer<typeof insertCampaignSchema>;

export type CampaignStat = typeof campaignStats.$inferSelect;

export type CampaignSend = typeof campaignSends.$inferSelect;

export type ImportJob = typeof importJobs.$inferSelect;
export type InsertImportJob = z.infer<typeof insertImportJobSchema>;

export type ErrorLog = typeof errorLogs.$inferSelect;
export type InsertErrorLog = z.infer<typeof insertErrorLogSchema>;
export type ErrorLogType = "send_failed" | "import_failed" | "import_row_failed" | "campaign_failed" | "system_error";
export type ErrorLogSeverity = "error" | "warning" | "info";

export type NullsinkCapture = typeof nullsinkCaptures.$inferSelect;
export type InsertNullsinkCapture = z.infer<typeof insertNullsinkCaptureSchema>;
export type MtaMode = "real" | "nullsink";

export type CampaignJob = typeof campaignJobs.$inferSelect;
export type CampaignJobStatus = "pending" | "processing" | "completed" | "failed";

export type PendingTagOperation = typeof pendingTagOperations.$inferSelect;
export type TagOperationType = "positive" | "negative";
export type TagEventType = "open" | "click" | "unsubscribe";

export type ImportJobQueueItem = typeof importJobQueue.$inferSelect;
export type ImportJobQueueStatus = "pending" | "processing" | "completed" | "failed";

export type FlushJob = typeof flushJobs.$inferSelect;
export type FlushJobStatus = "pending" | "processing" | "completed" | "failed" | "cancelled";

// ====== Segment Rules DSL v2 ======

export const segmentConditionSchema = z.object({
  type: z.literal("condition"),
  field: z.enum(["email", "tags", "refs", "date_added", "ip_address"]),
  operator: z.enum([
    "equals", "not_equals", "contains", "not_contains", "starts_with", "ends_with", "is_empty", "is_not_empty",
    "has_tag", "not_has_tag", "has_any_tag", "has_no_tags", "tag_contains",
    "has_ref", "not_has_ref", "has_any_ref", "has_no_refs", "ref_contains",
    "before", "after", "between", "in_last_days", "not_in_last_days",
  ]),
  value: z.union([z.string(), z.array(z.string()), z.null()]),
  value2: z.string().nullable().default(null),
});

export type SegmentCondition = z.output<typeof segmentConditionSchema>;

type SegmentGroupInput = {
  type: "group";
  combinator: "AND" | "OR";
  children: Array<z.input<typeof segmentConditionSchema> | SegmentGroupInput>;
};

export const segmentGroupSchema: z.ZodType<SegmentGroupInput> = z.object({
  type: z.literal("group"),
  combinator: z.enum(["AND", "OR"]),
  children: z.lazy(() => z.array(z.union([segmentConditionSchema, segmentGroupSchema]))),
});

export type SegmentGroup = z.infer<typeof segmentGroupSchema>;

export const segmentRulesV2Schema = z.object({
  version: z.literal(2),
  root: segmentGroupSchema,
});

export type SegmentRulesV2 = z.infer<typeof segmentRulesV2Schema>;

export const fieldOperatorsV2 = {
  email: ["equals", "not_equals", "contains", "not_contains", "starts_with", "ends_with", "is_empty", "is_not_empty"],
  tags: ["has_tag", "not_has_tag", "has_any_tag", "has_no_tags", "tag_contains"],
  refs: ["has_ref", "not_has_ref", "has_any_ref", "has_no_refs", "ref_contains"],
  date_added: ["before", "after", "between", "in_last_days", "not_in_last_days"],
  ip_address: ["equals", "not_equals", "starts_with", "contains", "is_empty", "is_not_empty"],
} as const;

export const operatorLabelsV2: Record<string, string> = {
  equals: "equals",
  not_equals: "does not equal",
  contains: "contains",
  not_contains: "does not contain",
  starts_with: "starts with",
  ends_with: "ends with",
  is_empty: "is empty",
  is_not_empty: "is not empty",
  has_tag: "has tag",
  not_has_tag: "does not have tag",
  tag_contains: "contains",
  has_any_tag: "has any tag",
  has_no_tags: "has no tags",
  has_ref: "has ref",
  not_has_ref: "does not have ref",
  ref_contains: "contains",
  has_any_ref: "has any ref",
  has_no_refs: "has no refs",
  before: "is before",
  after: "is after",
  between: "is between",
  in_last_days: "in the last N days",
  not_in_last_days: "not in the last N days",
};

export const segmentRulesInputSchema = z.union([
  segmentRulesV2Schema,
  z.array(z.any()).min(1, "At least one rule is required"),
]);

export function migrateRulesV1toV2(rules: any[]): SegmentRulesV2 {
  function convertCondition(rule: any): SegmentCondition {
    let operator = rule.operator;
    if (rule.field === "tags") {
      if (operator === "contains") operator = "has_tag";
      else if (operator === "not_contains") operator = "not_has_tag";
    }
    return {
      type: "condition" as const,
      field: rule.field,
      operator,
      value: rule.value ?? null,
      value2: rule.value2 ?? null,
    };
  }

  function convertGroup(group: any): SegmentGroup {
    return {
      type: "group" as const,
      combinator: group.combinator || "AND",
      children: (group.rules || []).map((r: any) => convertCondition(r)),
    };
  }

  const rootChildren: Array<SegmentCondition | SegmentGroup> = [];
  let orChildren: Array<SegmentCondition | SegmentGroup> = [];

  for (const rule of rules) {
    if (rule.type === "group") {
      const nested = convertGroup(rule);
      if (rule.logic === "OR") {
        orChildren.push(nested);
      } else {
        rootChildren.push(nested);
      }
    } else {
      const cond = convertCondition(rule);
      if (rule.logic === "OR") {
        orChildren.push(cond);
      } else {
        rootChildren.push(cond);
      }
    }
  }

  if (orChildren.length > 0) {
    rootChildren.push({
      type: "group" as const,
      combinator: "OR",
      children: orChildren,
    });
  }

  return {
    version: 2,
    root: {
      type: "group" as const,
      combinator: "AND",
      children: rootChildren,
    },
  };
}

/** @deprecated Use segmentConditionSchema instead */
export const segmentRuleSchema = z.object({
  field: z.enum(["tags", "email", "date_added", "ip_address"]),
  operator: z.enum(["contains", "not_contains", "equals", "not_equals", "starts_with", "ends_with", "before", "after", "between"]),
  value: z.string(),
  value2: z.string().optional(),
  logic: z.enum(["AND", "OR"]).optional(),
});

/** @deprecated Use SegmentCondition instead */
export type SegmentRule = z.infer<typeof segmentRuleSchema>;

/** @deprecated Use segmentGroupSchema instead */
export const segmentRuleGroupSchema = z.object({
  type: z.literal("group"),
  logic: z.enum(["AND", "OR"]),
  combinator: z.enum(["AND", "OR"]),
  rules: z.array(segmentRuleSchema),
});

/** @deprecated Use SegmentGroup instead */
export type SegmentRuleGroup = z.infer<typeof segmentRuleGroupSchema>;

/** @deprecated Use SegmentCondition | SegmentGroup instead */
export type SegmentRuleItem = SegmentRule | SegmentRuleGroup;

/** @deprecated Use segmentRulesInputSchema instead */
export const segmentRuleItemSchema: z.ZodType<SegmentRuleItem> = z.union([
  segmentRuleSchema,
  segmentRuleGroupSchema,
]);

/** @deprecated Use segmentRulesInputSchema instead */
export const segmentRulesArraySchema = z.array(segmentRuleItemSchema).min(1, "At least one rule is required");

/** @deprecated Use fieldOperatorsV2 instead */
export const fieldOperators = {
  tags: ["contains", "not_contains", "equals", "not_equals"] as const,
  email: ["contains", "not_contains", "equals", "not_equals", "starts_with", "ends_with"] as const,
  date_added: ["before", "after", "between"] as const,
  ip_address: ["equals", "not_equals", "starts_with", "contains"] as const,
};

/** @deprecated Use operatorLabelsV2 instead */
export const operatorLabels: Record<string, string> = {
  contains: "contains",
  not_contains: "does not contain",
  equals: "equals",
  not_equals: "does not equal",
  starts_with: "starts with",
  ends_with: "ends with",
  before: "is before",
  after: "is after",
  between: "is between",
};

// Sending speed configuration
export const sendingSpeedConfig = {
  drip: { emailsPerMinute: 100, label: "Drip (100/min)" },
  very_slow: { emailsPerMinute: 250, label: "Very Slow (250/min)" },
  slow: { emailsPerMinute: 500, label: "Slow (500/min)" },
  medium: { emailsPerMinute: 1000, label: "Medium (1,000/min)" },
  fast: { emailsPerMinute: 2000, label: "Fast (2,000/min)" },
  godzilla: { emailsPerMinute: 3000, label: "Godzilla (3,000/min)" },
} as const;

export type SendingSpeed = keyof typeof sendingSpeedConfig;

// Campaign status types
export type CampaignStatus = "draft" | "scheduled" | "sending" | "paused" | "completed" | "failed";

// Keep users for future auth
export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertUserSchema = createInsertSchema(users).pick({
  username: true,
  password: true,
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;

// ====== A/B Testing ======

export const abTestVariants = pgTable("ab_test_variants", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  campaignId: varchar("campaign_id").notNull().references(() => campaigns.id, { onDelete: 'cascade' }),
  name: text("name").notNull(),
  subject: text("subject"),
  htmlContent: text("html_content"),
  fromName: text("from_name"),
  preheader: text("preheader"),
  allocationPercent: integer("allocation_percent").notNull().default(50),
  sentCount: integer("sent_count").notNull().default(0),
  openCount: integer("open_count").notNull().default(0),
  clickCount: integer("click_count").notNull().default(0),
  unsubscribeCount: integer("unsubscribe_count").notNull().default(0),
  bounceCount: integer("bounce_count").notNull().default(0),
  isWinner: boolean("is_winner").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  campaignIdx: index("ab_test_variants_campaign_idx").on(table.campaignId),
}));

export const abTestVariantsRelations = relations(abTestVariants, ({ one }) => ({
  campaign: one(campaigns, {
    fields: [abTestVariants.campaignId],
    references: [campaigns.id],
  }),
}));

// ====== IP Warmup Schedules ======

export const warmupSchedules = pgTable("warmup_schedules", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  mtaId: varchar("mta_id").notNull().references(() => mtas.id, { onDelete: 'cascade' }),
  name: text("name").notNull(),
  status: text("status").notNull().default("active"),
  startDate: timestamp("start_date").notNull().defaultNow(),
  currentDay: integer("current_day").notNull().default(1),
  totalDays: integer("total_days").notNull().default(30),
  dailyVolumeCap: integer("daily_volume_cap").notNull().default(50),
  maxDailyVolume: integer("max_daily_volume").notNull().default(100000),
  rampMultiplier: text("ramp_multiplier").notNull().default("1.5"),
  sentToday: integer("sent_today").notNull().default(0),
  lastResetDate: timestamp("last_reset_date").defaultNow(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  mtaIdx: index("warmup_schedules_mta_idx").on(table.mtaId),
  statusIdx: index("warmup_schedules_status_idx").on(table.status),
}));

export const warmupSchedulesRelations = relations(warmupSchedules, ({ one }) => ({
  mta: one(mtas, {
    fields: [warmupSchedules.mtaId],
    references: [mtas.id],
  }),
}));

// ====== Automation Workflows ======

export const automationWorkflows = pgTable("automation_workflows", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  description: text("description"),
  status: text("status").notNull().default("draft"),
  triggerType: text("trigger_type").notNull(),
  triggerConfig: jsonb("trigger_config").notNull().default(sql`'{}'::jsonb`),
  steps: jsonb("steps").notNull().default(sql`'[]'::jsonb`),
  totalEnrolled: integer("total_enrolled").notNull().default(0),
  totalCompleted: integer("total_completed").notNull().default(0),
  totalFailed: integer("total_failed").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  statusIdx: index("automation_workflows_status_idx").on(table.status),
  triggerTypeIdx: index("automation_workflows_trigger_type_idx").on(table.triggerType),
}));

export const automationEnrollments = pgTable("automation_enrollments", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  workflowId: varchar("workflow_id").notNull().references(() => automationWorkflows.id, { onDelete: 'cascade' }),
  subscriberId: varchar("subscriber_id").notNull().references(() => subscribers.id, { onDelete: 'cascade' }),
  currentStepIndex: integer("current_step_index").notNull().default(0),
  status: text("status").notNull().default("active"),
  enrolledAt: timestamp("enrolled_at").notNull().defaultNow(),
  nextActionAt: timestamp("next_action_at"),
  completedAt: timestamp("completed_at"),
  lastError: text("last_error"),
}, (table) => ({
  workflowIdx: index("automation_enrollments_workflow_idx").on(table.workflowId),
  subscriberIdx: index("automation_enrollments_subscriber_idx").on(table.subscriberId),
  statusIdx: index("automation_enrollments_status_idx").on(table.status),
  nextActionIdx: index("automation_enrollments_next_action_idx").on(table.nextActionAt),
  uniqueEnrollment: uniqueIndex("automation_enrollments_unique_idx").on(table.workflowId, table.subscriberId),
}));

export const automationEnrollmentsRelations = relations(automationEnrollments, ({ one }) => ({
  workflow: one(automationWorkflows, {
    fields: [automationEnrollments.workflowId],
    references: [automationWorkflows.id],
  }),
  subscriber: one(subscribers, {
    fields: [automationEnrollments.subscriberId],
    references: [subscribers.id],
  }),
}));

// ====== Advanced Analytics ======

export const analyticsDaily = pgTable("analytics_daily", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  date: timestamp("date").notNull(),
  campaignId: varchar("campaign_id").references(() => campaigns.id),
  totalSent: integer("total_sent").notNull().default(0),
  totalDelivered: integer("total_delivered").notNull().default(0),
  totalOpens: integer("total_opens").notNull().default(0),
  uniqueOpens: integer("unique_opens").notNull().default(0),
  totalClicks: integer("total_clicks").notNull().default(0),
  uniqueClicks: integer("unique_clicks").notNull().default(0),
  totalBounces: integer("total_bounces").notNull().default(0),
  totalUnsubscribes: integer("total_unsubscribes").notNull().default(0),
  totalComplaints: integer("total_complaints").notNull().default(0),
  subscriberGrowth: integer("subscriber_growth").notNull().default(0),
  subscriberChurn: integer("subscriber_churn").notNull().default(0),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  dateIdx: index("analytics_daily_date_idx").on(table.date),
  campaignIdx: index("analytics_daily_campaign_idx").on(table.campaignId),
  dateCampaignIdx: uniqueIndex("analytics_daily_date_campaign_idx").on(table.date, table.campaignId),
}));

export const analyticsDailyRelations = relations(analyticsDaily, ({ one }) => ({
  campaign: one(campaigns, {
    fields: [analyticsDaily.campaignId],
    references: [campaigns.id],
  }),
}));

// Insert schemas for enterprise features
export const insertAbTestVariantSchema = createInsertSchema(abTestVariants).omit({ id: true, sentCount: true, openCount: true, clickCount: true, unsubscribeCount: true, bounceCount: true, isWinner: true, createdAt: true }).extend({
  name: z.string().min(1).max(100),
  allocationPercent: z.number().int().min(1).max(100),
});

export const insertWarmupScheduleSchema = createInsertSchema(warmupSchedules).omit({ id: true, sentToday: true, lastResetDate: true, createdAt: true, currentDay: true }).extend({
  name: z.string().min(1).max(200),
  totalDays: z.number().int().min(1).max(90),
  dailyVolumeCap: z.number().int().min(1),
  maxDailyVolume: z.number().int().min(100),
  rampMultiplier: z.string().regex(/^\d+(\.\d+)?$/, "Must be a number"),
});

export const insertAutomationWorkflowSchema = createInsertSchema(automationWorkflows).omit({ id: true, totalEnrolled: true, totalCompleted: true, totalFailed: true, createdAt: true, updatedAt: true }).extend({
  name: z.string().min(1).max(200),
  triggerType: z.enum(["subscriber_added", "tag_added", "tag_removed", "subscriber_opened", "subscriber_clicked"]),
});

export const insertAnalyticsDailySchema = createInsertSchema(analyticsDaily).omit({ id: true, updatedAt: true });

// Single-row materialized totals — read by /api/analytics/overview so it
// never has to scan campaign_sends/campaign_stats/subscribers/campaigns.
// The rollup refreshes this once per cycle (every 15 minutes).
export const analyticsTotals = pgTable("analytics_totals", {
  id: varchar("id").primaryKey().default(sql`'global'`),
  totalSubscribers: integer("total_subscribers").notNull().default(0),
  totalCampaigns: integer("total_campaigns").notNull().default(0),
  totalSent: integer("total_sent").notNull().default(0),
  totalBounces: integer("total_bounces").notNull().default(0),
  totalOpens: integer("total_opens").notNull().default(0),
  totalClicks: integer("total_clicks").notNull().default(0),
  totalUnsubscribes: integer("total_unsubscribes").notNull().default(0),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type AnalyticsTotals = typeof analyticsTotals.$inferSelect;

// Database maintenance rules - configurable cleanup for heavy tables
export const dbMaintenanceRules = pgTable("db_maintenance_rules", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tableName: text("table_name").notNull().unique(),
  displayName: text("display_name").notNull(),
  description: text("description"),
  retentionDays: integer("retention_days").notNull().default(90),
  enabled: boolean("enabled").notNull().default(true),
  lastRunAt: timestamp("last_run_at"),
  lastRowsDeleted: integer("last_rows_deleted").default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Database maintenance execution log
export const dbMaintenanceLogs = pgTable("db_maintenance_logs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  ruleId: varchar("rule_id").notNull().references(() => dbMaintenanceRules.id),
  tableName: text("table_name").notNull(),
  rowsDeleted: integer("rows_deleted").notNull().default(0),
  durationMs: integer("duration_ms").notNull().default(0),
  status: text("status").notNull().default("success"),
  errorMessage: text("error_message"),
  triggeredBy: text("triggered_by").notNull().default("auto"),
  executedAt: timestamp("executed_at").notNull().defaultNow(),
}, (table) => ({
  ruleIdx: index("db_maint_log_rule_idx").on(table.ruleId),
  executedAtIdx: index("db_maint_log_executed_idx").on(table.executedAt),
}));

export const insertDbMaintenanceRuleSchema = createInsertSchema(dbMaintenanceRules).omit({ id: true, lastRunAt: true, lastRowsDeleted: true, createdAt: true });

// Types for enterprise features
export type AbTestVariant = typeof abTestVariants.$inferSelect;
export type InsertAbTestVariant = z.infer<typeof insertAbTestVariantSchema>;

export type WarmupSchedule = typeof warmupSchedules.$inferSelect;
export type InsertWarmupSchedule = z.infer<typeof insertWarmupScheduleSchema>;

export type AutomationWorkflow = typeof automationWorkflows.$inferSelect;
export type InsertAutomationWorkflow = z.infer<typeof insertAutomationWorkflowSchema>;

export type AutomationEnrollment = typeof automationEnrollments.$inferSelect;

export type AnalyticsDaily = typeof analyticsDaily.$inferSelect;
export type InsertAnalyticsDaily = z.infer<typeof insertAnalyticsDailySchema>;

export type TriggerType = "subscriber_added" | "tag_added" | "tag_removed" | "subscriber_opened" | "subscriber_clicked";
export type WorkflowStatus = "draft" | "active" | "paused" | "archived";
export type WarmupStatus = "active" | "paused" | "completed";
export type EnrollmentStatus = "active" | "completed" | "failed" | "cancelled";

export type DbMaintenanceRule = typeof dbMaintenanceRules.$inferSelect;
export type InsertDbMaintenanceRule = z.infer<typeof insertDbMaintenanceRuleSchema>;
export type DbMaintenanceLog = typeof dbMaintenanceLogs.$inferSelect;
