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
  tagsIdx: index("tags_idx").on(table.tags),
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
  hostname: text("hostname").notNull(),
  port: integer("port").notNull().default(587),
  username: text("username").notNull(),
  password: text("password").notNull(),
  trackingDomain: text("tracking_domain"),
  openTrackingDomain: text("open_tracking_domain"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

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
