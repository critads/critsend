import { sql, relations } from "drizzle-orm";
import { pgTable, text, varchar, integer, boolean, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// Subscribers table - optimized for millions of records with proper indexing
export const subscribers = pgTable("subscribers", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  email: text("email").notNull().unique(),
  tags: text("tags").array().notNull().default(sql`ARRAY[]::text[]`),
  ipAddress: text("ip_address"),
  importDate: timestamp("import_date").notNull().defaultNow(),
}, (table) => ({
  emailIdx: index("email_idx").on(table.email),
  // GIN index for faster array containment queries on tags
  tagsGinIdx: index("tags_gin_idx").using("gin", table.tags),
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
  isActive: boolean("is_active").notNull().default(true),
  mode: text("mode").notNull().default("real"), // "real" or "nullsink"
  simulatedLatencyMs: integer("simulated_latency_ms").default(0), // Latency to simulate for nullsink
  failureRate: integer("failure_rate").default(0), // Percentage of simulated failures (0-100)
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
  openTag: text("open_tag"),
  clickTag: text("click_tag"),
  unsubscribeTag: text("unsubscribe_tag"),
  sentCount: integer("sent_count").notNull().default(0),
  pendingCount: integer("pending_count").notNull().default(0),
  failedCount: integer("failed_count").notNull().default(0),
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
  campaignId: varchar("campaign_id").notNull().references(() => campaigns.id),
  subscriberId: varchar("subscriber_id").notNull().references(() => subscribers.id),
  type: text("type").notNull(),
  link: text("link"),
  timestamp: timestamp("timestamp").notNull().defaultNow(),
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
  campaignId: varchar("campaign_id").notNull().references(() => campaigns.id),
  subscriberId: varchar("subscriber_id").notNull().references(() => subscribers.id),
  sentAt: timestamp("sent_at").notNull().defaultNow(),
  status: text("status").notNull().default("sent"), // sent, failed, bounced
  firstOpenAt: timestamp("first_open_at"),
  firstClickAt: timestamp("first_click_at"),
}, (table) => ({
  // UNIQUE constraint ensures no email is sent twice per campaign per subscriber
  uniqueSend: uniqueIndex("campaign_sends_unique_idx").on(table.campaignId, table.subscriberId),
  campaignIdx: index("campaign_sends_campaign_idx").on(table.campaignId),
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
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  completedAt: timestamp("completed_at"),
});

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
  createdAt: timestamp("created_at").notNull().defaultNow(),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  workerId: text("worker_id"),
  errorMessage: text("error_message"),
}, (table) => ({
  campaignIdx: index("campaign_jobs_campaign_idx").on(table.campaignId),
  statusIdx: index("campaign_jobs_status_idx").on(table.status),
  createdAtIdx: index("campaign_jobs_created_at_idx").on(table.createdAt),
}));

export const campaignJobsRelations = relations(campaignJobs, ({ one }) => ({
  campaign: one(campaigns, {
    fields: [campaignJobs.campaignId],
    references: [campaigns.id],
  }),
}));

// Import job queue table - PostgreSQL-backed job queue for CSV import processing
// Uses file-based storage for CSV content instead of storing in database
export const importJobQueue = pgTable("import_job_queue", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  importJobId: varchar("import_job_id").notNull().references(() => importJobs.id),
  csvFilePath: text("csv_file_path").notNull(), // Path to CSV file on disk
  totalLines: integer("total_lines").notNull().default(0), // Total lines to process
  processedLines: integer("processed_lines").notNull().default(0), // Lines processed so far
  status: text("status").notNull().default("pending"), // pending, processing, completed, failed
  createdAt: timestamp("created_at").notNull().defaultNow(),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  heartbeat: timestamp("heartbeat"), // Updated during processing to show worker is alive
  workerId: text("worker_id"),
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

// Insert schemas
export const insertSubscriberSchema = createInsertSchema(subscribers).omit({ id: true, importDate: true });
export const insertSegmentSchema = createInsertSchema(segments).omit({ id: true, createdAt: true });
export const insertMtaSchema = createInsertSchema(mtas).omit({ id: true, createdAt: true });
export const insertEmailHeaderSchema = createInsertSchema(emailHeaders).omit({ id: true });
export const insertCampaignSchema = createInsertSchema(campaigns).omit({ 
  id: true, 
  sentCount: true, 
  pendingCount: true, 
  failedCount: true, 
  createdAt: true,
  startedAt: true,
  completedAt: true,
});
export const insertImportJobSchema = createInsertSchema(importJobs).omit({ 
  id: true, 
  processedRows: true, 
  newSubscribers: true, 
  updatedSubscribers: true,
  failedRows: true,
  status: true,
  errorMessage: true,
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

export type ImportJobQueueItem = typeof importJobQueue.$inferSelect;
export type ImportJobQueueStatus = "pending" | "processing" | "completed" | "failed";

// Segment rule types
export const segmentRuleSchema = z.object({
  field: z.enum(["tags"]),
  operator: z.enum(["contains", "not_contains", "equals", "not_equals"]),
  value: z.string(),
  logic: z.enum(["AND", "OR"]).optional(),
});

export type SegmentRule = z.infer<typeof segmentRuleSchema>;

// Sending speed configuration
export const sendingSpeedConfig = {
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
});

export const insertUserSchema = createInsertSchema(users).pick({
  username: true,
  password: true,
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;
