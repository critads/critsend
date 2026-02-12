import {
  subscribers,
  segments,
  mtas,
  emailHeaders,
  campaigns,
  campaignStats,
  campaignSends,
  importJobs,
  dashboardCache,
  campaignJobs,
  importJobQueue,
  errorLogs,
  pendingTagOperations,
  flushJobs,
  dbMaintenanceRules,
  dbMaintenanceLogs,
  type Subscriber,
  type InsertSubscriber,
  type Segment,
  type InsertSegment,
  type Mta,
  type InsertMta,
  type EmailHeader,
  type InsertEmailHeader,
  type Campaign,
  type InsertCampaign,
  type CampaignStat,
  type CampaignSend,
  type ImportJob,
  type InsertImportJob,
  type SegmentRule,
  type CampaignJob,
  type CampaignJobStatus,
  type ImportJobQueueItem,
  type ImportJobQueueStatus,
  type ErrorLog,
  type InsertErrorLog,
  nullsinkCaptures,
  type NullsinkCapture,
  type InsertNullsinkCapture,
  type PendingTagOperation,
  type FlushJob,
  type FlushJobStatus,
  type DbMaintenanceRule,
  type InsertDbMaintenanceRule,
  type DbMaintenanceLog,
  users,
} from "@shared/schema";
import { pool } from "./db";
import { db } from "./db";
import { eq, like, or, sql, desc, and, arrayContains, not } from "drizzle-orm";
import { encrypt, decrypt } from "./crypto";
import { logger } from "./logger";
import bcrypt from "bcrypt";

export interface IStorage {
  // ═══════════════════════════════════════════════════════════════
  // SUBSCRIBER MANAGEMENT
  // ═══════════════════════════════════════════════════════════════
  getSubscribers(page: number, limit: number, search?: string): Promise<{ subscribers: Subscriber[]; total: number }>;
  getSubscriber(id: string): Promise<Subscriber | undefined>;
  getSubscriberByEmail(email: string): Promise<Subscriber | undefined>;
  createSubscriber(data: InsertSubscriber): Promise<Subscriber>;
  updateSubscriber(id: string, data: Partial<InsertSubscriber>): Promise<Subscriber | undefined>;
  deleteSubscriber(id: string): Promise<void>;
  deleteAllSubscribers(): Promise<number>; // NOTE: Potentially dead code - no callers found outside storage.ts (replaced by flush jobs)

  // ═══════════════════════════════════════════════════════════════
  // SEGMENT OPERATIONS
  // ═══════════════════════════════════════════════════════════════
  getSubscribersForSegment(segmentId: string, limit?: number, offset?: number): Promise<Subscriber[]>;
  getSubscribersForSegmentCursor(segmentId: string, limit: number, afterId?: string): Promise<Subscriber[]>;
  countSubscribersForSegment(segmentId: string): Promise<number>;
  countSubscribersForRules(rules: any[]): Promise<number>;
  getSegments(): Promise<Segment[]>;
  getSegment(id: string): Promise<Segment | undefined>;
  createSegment(data: InsertSegment): Promise<Segment>;
  updateSegment(id: string, data: Partial<InsertSegment>): Promise<Segment | undefined>;
  deleteSegment(id: string): Promise<void>;
  getSegmentSubscriberCountCached(segmentId: string): Promise<number>;
  invalidateSegmentCountCache(segmentId?: string): void;

  // ═══════════════════════════════════════════════════════════════
  // MTA MANAGEMENT
  // ═══════════════════════════════════════════════════════════════
  getMtas(): Promise<Mta[]>;
  getMta(id: string): Promise<Mta | undefined>;
  createMta(data: InsertMta): Promise<Mta>;
  updateMta(id: string, data: Partial<InsertMta>): Promise<Mta | undefined>;
  deleteMta(id: string): Promise<void>;

  // ═══════════════════════════════════════════════════════════════
  // EMAIL HEADERS
  // ═══════════════════════════════════════════════════════════════
  getHeaders(): Promise<EmailHeader[]>;
  getDefaultHeaders(): Promise<EmailHeader[]>;
  getHeader(id: string): Promise<EmailHeader | undefined>;
  createHeader(data: InsertEmailHeader): Promise<EmailHeader>;
  updateHeader(id: string, data: Partial<InsertEmailHeader>): Promise<EmailHeader | undefined>;
  deleteHeader(id: string): Promise<void>;

  // ═══════════════════════════════════════════════════════════════
  // CAMPAIGN MANAGEMENT
  // ═══════════════════════════════════════════════════════════════
  getCampaigns(): Promise<Campaign[]>;
  getCampaign(id: string): Promise<Campaign | undefined>;
  getCampaignStatus(id: string): Promise<string | null>;
  createCampaign(data: InsertCampaign): Promise<Campaign>;
  updateCampaign(id: string, data: Partial<Campaign>): Promise<Campaign | undefined>;
  deleteCampaign(id: string): Promise<void>;
  copyCampaign(id: string): Promise<Campaign | undefined>;

  // ═══════════════════════════════════════════════════════════════
  // CAMPAIGN SENDING & TRACKING
  // ═══════════════════════════════════════════════════════════════
  addCampaignStat(campaignId: string, subscriberId: string, type: string, link?: string): Promise<void>;
  getCampaignStats(campaignId: string): Promise<CampaignStat[]>;
  recordCampaignSend(campaignId: string, subscriberId: string, status?: string): Promise<boolean>; // NOTE: DEPRECATED - throws error, use reserveSendSlot() + finalizeSend()
  wasEmailSent(campaignId: string, subscriberId: string): Promise<boolean>; // NOTE: Potentially dead code - no callers found outside storage.ts
  getCampaignSendCount(campaignId: string): Promise<number>; // NOTE: Potentially dead code - no callers found outside storage.ts
  incrementCampaignSentCount(campaignId: string, increment?: number): Promise<void>;
  incrementCampaignFailedCount(campaignId: string, increment?: number): Promise<void>;
  decrementCampaignPendingCount(campaignId: string, decrement?: number): Promise<void>;
  updateCampaignStatusAtomic(campaignId: string, newStatus: string, expectedStatus?: string): Promise<boolean>;
  reserveSendSlot(campaignId: string, subscriberId: string): Promise<boolean>;
  finalizeSend(campaignId: string, subscriberId: string, success: boolean): Promise<void>;
  recordSendAndUpdateCounters(campaignId: string, subscriberId: string, success: boolean): Promise<boolean>; // NOTE: Potentially dead code - no callers found outside storage.ts
  recoverOrphanedPendingSends(campaignId: string, maxAgeMinutes?: number): Promise<number>;
  forceFailPendingSend(campaignId: string, subscriberId: string): Promise<boolean>;
  bulkReserveSendSlots(campaignId: string, subscriberIds: string[]): Promise<string[]>;
  bulkFinalizeSends(campaignId: string, successIds: string[], failedIds: string[]): Promise<void>;
  heartbeatJob(jobId: string): Promise<void>;
  recordFirstOpen(campaignId: string, subscriberId: string): Promise<boolean>;
  recordFirstClick(campaignId: string, subscriberId: string): Promise<boolean>;
  getCampaignSend(campaignId: string, subscriberId: string): Promise<CampaignSend | undefined>; // NOTE: Potentially dead code - no callers found outside storage.ts
  getUniqueOpenCount(campaignId: string): Promise<number>;
  getUniqueClickCount(campaignId: string): Promise<number>;

  // ═══════════════════════════════════════════════════════════════
  // CAMPAIGN JOB QUEUE
  // ═══════════════════════════════════════════════════════════════
  enqueueCampaignJob(campaignId: string): Promise<CampaignJob>;
  enqueueCampaignJobWithRetry(campaignId: string, retryCount: number, delaySeconds: number): Promise<any>;
  claimNextJob(workerId: string): Promise<CampaignJob | null>;
  completeJob(jobId: string, status: "completed" | "failed", errorMessage?: string): Promise<void>;
  clearStuckJobsForCampaign(campaignId: string): Promise<number>;
  getJobStatus(campaignId: string): Promise<CampaignJobStatus | null>;
  getActiveJobs(): Promise<CampaignJob[]>;
  cleanupStaleJobs(maxAgeMinutes?: number): Promise<number>;
  getFailedSendsForRetry(campaignId: string, limit: number): Promise<Array<{subscriberId: string, email: string, retryCount: number}>>;
  markSendForRetry(campaignId: string, subscriberId: string): Promise<void>;
  bulkMarkSendsForRetry(campaignId: string, subscriberIds: string[]): Promise<number>;

  // ═══════════════════════════════════════════════════════════════
  // IMPORT JOB MANAGEMENT
  // ═══════════════════════════════════════════════════════════════
  getImportJobs(): Promise<ImportJob[]>;
  getImportJob(id: string): Promise<ImportJob | undefined>;
  createImportJob(data: InsertImportJob): Promise<ImportJob>;
  updateImportJob(id: string, data: Partial<ImportJob>): Promise<ImportJob | undefined>;
  enqueueImportJob(importJobId: string, csvFilePath: string, totalLines: number, fileSizeBytes?: number): Promise<ImportJobQueueItem>;
  claimNextImportJob(workerId: string): Promise<ImportJobQueueItem | null>;
  updateImportQueueProgress(queueId: string, processedLines: number): Promise<void>;
  updateImportQueueProgressWithCheckpoint(queueId: string, processedLines: number, processedBytes: number, lastCheckpointLine: number): Promise<void>;
  updateImportQueueHeartbeat(queueId: string): Promise<void>;
  getImportQueueItem(queueId: string): Promise<ImportJobQueueItem | null>;
  completeImportQueueJob(jobId: string, status: "completed" | "failed", errorMessage?: string): Promise<void>;
  getImportJobQueueStatus(importJobId: string): Promise<ImportJobQueueStatus | null>;
  cleanupStaleImportJobs(maxAgeMinutes?: number): Promise<number>;
  recoverStuckImportJobs(): Promise<number>;

  // ═══════════════════════════════════════════════════════════════
  // DATABASE INDEX MANAGEMENT
  // ═══════════════════════════════════════════════════════════════
  dropSubscriberGinIndexes(): Promise<void>;
  recreateSubscriberGinIndexes(): Promise<void>;
  areGinIndexesPresent(): Promise<boolean>;
  ensureTrigramIndex(): Promise<void>;

  // ═══════════════════════════════════════════════════════════════
  // TAG OPERATIONS
  // ═══════════════════════════════════════════════════════════════
  enqueueTagOperation(subscriberId: string, tagValue: string, eventType: "open" | "click" | "unsubscribe", campaignId?: string): Promise<void>;
  claimPendingTagOperations(limit?: number): Promise<Array<{ id: string; subscriberId: string; tagValue: string; eventType: string; retryCount: number }>>;
  completeTagOperation(operationId: string): Promise<void>;
  failTagOperation(operationId: string, error: string): Promise<void>;
  getTagQueueStats(): Promise<{ pending: number; processing: number; completed: number; failed: number }>;
  cleanupCompletedTagOperations(olderThanDays?: number): Promise<number>;
  addTagToSubscriber(subscriberId: string, tagValue: string): Promise<boolean>;

  // ═══════════════════════════════════════════════════════════════
  // NULLSINK
  // ═══════════════════════════════════════════════════════════════
  createNullsinkCapture(data: InsertNullsinkCapture): Promise<NullsinkCapture>;
  bulkCreateNullsinkCaptures(data: InsertNullsinkCapture[]): Promise<void>;
  getNullsinkCaptures(options?: {
    campaignId?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ captures: NullsinkCapture[]; total: number }>;
  getNullsinkMetrics(campaignId?: string): Promise<{
    totalEmails: number;
    successfulEmails: number;
    failedEmails: number;
    avgHandshakeTimeMs: number;
    avgTotalTimeMs: number;
    emailsPerSecond: number;
  }>;
  clearNullsinkCaptures(campaignId?: string): Promise<number>;

  // ═══════════════════════════════════════════════════════════════
  // FLUSH JOBS
  // ═══════════════════════════════════════════════════════════════
  createFlushJob(totalRows: number): Promise<FlushJob>;
  getFlushJob(id: string): Promise<FlushJob | undefined>;
  claimFlushJob(workerId: string): Promise<FlushJob | null>;
  updateFlushJobProgress(jobId: string, processedRows: number): Promise<void>;
  completeFlushJob(jobId: string, status: "completed" | "failed" | "cancelled", errorMessage?: string): Promise<void>;
  cancelFlushJob(jobId: string): Promise<boolean>;
  clearSubscriberDependencies(): Promise<void>;
  deleteSubscriberBatch(batchSize: number): Promise<number>;
  countAllSubscribers(): Promise<number>;

  // ═══════════════════════════════════════════════════════════════
  // ERROR LOGGING
  // ═══════════════════════════════════════════════════════════════
  logError(data: InsertErrorLog): Promise<ErrorLog>;
  getErrorLogs(options?: {
    page?: number;
    limit?: number;
    type?: string;
    severity?: string;
    campaignId?: string;
    importJobId?: string;
  }): Promise<{ logs: ErrorLog[]; total: number }>;
  getErrorLogStats(): Promise<{
    total: number;
    byType: Record<string, number>;
    bySeverity: Record<string, number>;
    last24Hours: number;
  }>;
  clearErrorLogs(beforeDate?: Date): Promise<number>;

  // ═══════════════════════════════════════════════════════════════
  // USERS
  // ═══════════════════════════════════════════════════════════════
  createUser(data: { username: string; password: string }): Promise<any>;
  getUserByUsername(username: string): Promise<any | null>;
  getUserById(id: string): Promise<any | null>;
  getUserCount(): Promise<number>;

  // ═══════════════════════════════════════════════════════════════
  // DATABASE MAINTENANCE
  // ═══════════════════════════════════════════════════════════════
  getMaintenanceRules(): Promise<DbMaintenanceRule[]>;
  getMaintenanceRule(id: string): Promise<DbMaintenanceRule | undefined>;
  upsertMaintenanceRule(data: InsertDbMaintenanceRule): Promise<DbMaintenanceRule>;
  updateMaintenanceRule(id: string, data: Partial<InsertDbMaintenanceRule>): Promise<DbMaintenanceRule | undefined>;
  deleteMaintenanceRule(id: string): Promise<void>;
  getMaintenanceLogs(limit?: number): Promise<DbMaintenanceLog[]>;
  createMaintenanceLog(data: Omit<DbMaintenanceLog, 'id' | 'executedAt'>): Promise<DbMaintenanceLog>;
  getTableStats(): Promise<Array<{tableName: string; rowCount: number; sizeBytes: number; sizePretty: string}>>;
  seedDefaultMaintenanceRules(): Promise<void>;

  // ═══════════════════════════════════════════════════════════════
  // DASHBOARD & ANALYTICS
  // ═══════════════════════════════════════════════════════════════
  healthCheck(): Promise<boolean>;
  getDashboardStats(): Promise<{
    totalSubscribers: number;
    totalCampaigns: number;
    totalOpens: number;
    totalClicks: number;
    recentCampaigns: Campaign[];
    recentImports: ImportJob[];
  }>;
  getOverallAnalytics(): Promise<{
    totalOpens: number;
    totalClicks: number;
    totalCampaigns: number;
    avgOpenRate: number;
    avgClickRate: number;
    recentCampaigns: Array<{
      id: string;
      name: string;
      openRate: number;
      clickRate: number;
      sentCount: number;
    }>;
  }>;
  getCampaignAnalytics(campaignId: string): Promise<{
    campaign: Campaign;
    totalOpens: number;
    uniqueOpens: number;
    totalClicks: number;
    uniqueClicks: number;
    openRate: number;
    clickRate: number;
    topLinks: Array<{ url: string; clicks: number }>;
    recentActivity: Array<{
      email: string;
      type: string;
      timestamp: string;
      link?: string;
    }>;
  } | undefined>;
}

export class DatabaseStorage implements IStorage {
  private segmentCountCache = new Map<string, { count: number; timestamp: number }>();
  private SEGMENT_COUNT_CACHE_TTL = 300000; // 5 minutes

  // ═══════════════════════════════════════════════════════════════
  // SUBSCRIBER MANAGEMENT
  // ═══════════════════════════════════════════════════════════════

  async getSubscribers(page: number, limit: number, search?: string): Promise<{ subscribers: Subscriber[]; total: number }> {
    const offset = (page - 1) * limit;
    let query = db.select().from(subscribers);
    let countQuery = db.select({ count: sql<number>`count(*)` }).from(subscribers);

    if (search) {
      const searchCondition = or(
        like(subscribers.email, `%${search}%`),
        sql`${search} = ANY(${subscribers.tags})`
      );
      query = query.where(searchCondition) as typeof query;
      countQuery = countQuery.where(searchCondition) as typeof countQuery;
    }

    const [subs, [{ count }]] = await Promise.all([
      query.orderBy(desc(subscribers.importDate)).limit(limit).offset(offset),
      countQuery,
    ]);

    return { subscribers: subs, total: Number(count) };
  }

  async getSubscriber(id: string): Promise<Subscriber | undefined> {
    const [sub] = await db.select().from(subscribers).where(eq(subscribers.id, id));
    return sub;
  }

  async getSubscriberByEmail(email: string): Promise<Subscriber | undefined> {
    const [sub] = await db.select().from(subscribers).where(eq(subscribers.email, email.toLowerCase()));
    return sub;
  }

  async createSubscriber(data: InsertSubscriber): Promise<Subscriber> {
    const [sub] = await db.insert(subscribers).values({
      ...data,
      email: data.email.toLowerCase(),
    }).returning();
    return sub;
  }

  async updateSubscriber(id: string, data: Partial<InsertSubscriber>): Promise<Subscriber | undefined> {
    const [sub] = await db.update(subscribers).set(data).where(eq(subscribers.id, id)).returning();
    return sub;
  }

  async deleteSubscriber(id: string): Promise<void> {
    await db.delete(campaignStats).where(eq(campaignStats.subscriberId, id));
    await db.delete(campaignSends).where(eq(campaignSends.subscriberId, id));
    await db.execute(sql`DELETE FROM nullsink_captures WHERE subscriber_id = ${id}`);
    await db.execute(sql`DELETE FROM error_logs WHERE subscriber_id = ${id}`);
    await db.delete(subscribers).where(eq(subscribers.id, id));
  }

  // NOTE: Potentially dead code - no callers found outside storage.ts (replaced by flush jobs)
  async deleteAllSubscribers(): Promise<number> {
    await db.execute(sql`DELETE FROM campaign_sends`);
    await db.execute(sql`DELETE FROM campaign_stats`);
    await db.execute(sql`DELETE FROM error_logs WHERE subscriber_id IS NOT NULL`);
    await db.execute(sql`DELETE FROM nullsink_captures`);
    await db.execute(sql`DELETE FROM pending_tag_operations`);
    await db.execute(sql`DELETE FROM automation_enrollments`);
    const result = await db.execute(sql`DELETE FROM subscribers`);
    return result.rowCount || 0;
  }

  // ═══════════════════════════════════════════════════════════════
  // SEGMENT OPERATIONS
  // ═══════════════════════════════════════════════════════════════

  async getSubscribersForSegment(segmentId: string, limit?: number, offset?: number): Promise<Subscriber[]> {
    const segment = await this.getSegment(segmentId);
    if (!segment) return [];

    const rules = segment.rules as SegmentRule[];
    if (!rules || rules.length === 0) return [];

    // Build SQL WHERE clause for segment rules - much more efficient than loading all into memory
    const whereCondition = this.buildSegmentSqlCondition(rules);
    
    let query = db.select().from(subscribers).where(
      and(
        not(sql`'BCK' = ANY(${subscribers.tags})`), // Always exclude BCK
        whereCondition
      )
    );
    
    if (limit !== undefined) {
      query = query.limit(limit) as typeof query;
    }
    if (offset !== undefined) {
      query = query.offset(offset) as typeof query;
    }

    return query;
  }

  async getSubscribersForSegmentCursor(segmentId: string, limit: number, afterId?: string): Promise<Subscriber[]> {
    const segment = await this.getSegment(segmentId);
    if (!segment) return [];

    const rules = segment.rules as SegmentRule[];
    if (!rules || rules.length === 0) return [];

    const whereCondition = this.buildSegmentSqlCondition(rules);
    
    const conditions = [
      not(sql`'BCK' = ANY(${subscribers.tags})`),
      whereCondition,
    ];
    
    if (afterId) {
      conditions.push(sql`${subscribers.id} > ${afterId}`);
    }
    
    return db.select().from(subscribers)
      .where(and(...conditions))
      .orderBy(sql`${subscribers.id} ASC`)
      .limit(limit);
  }

  async countSubscribersForSegment(segmentId: string): Promise<number> {
    const segment = await this.getSegment(segmentId);
    if (!segment) return 0;

    const rules = segment.rules as SegmentRule[];
    if (!rules || rules.length === 0) return 0;

    const whereCondition = this.buildSegmentSqlCondition(rules);
    
    const [{ count }] = await db.select({ count: sql<number>`count(*)` })
      .from(subscribers)
      .where(and(
        not(sql`'BCK' = ANY(${subscribers.tags})`),
        whereCondition
      ));
    
    return Number(count);
  }

  async countSubscribersForRules(rules: any[]): Promise<number> {
    if (!rules || rules.length === 0) return 0;
    const whereCondition = this.buildSegmentSqlCondition(rules);
    const [{ count }] = await db.select({ count: sql<number>`count(*)` })
      .from(subscribers)
      .where(and(
        not(sql`'BCK' = ANY(${subscribers.tags})`),
        whereCondition
      ));
    return Number(count);
  }

  private escapeLikeValue(value: string): string {
    return value.replace(/[%_\\]/g, '\\$&');
  }

  private buildSingleRuleCondition(rule: any): ReturnType<typeof sql> | null {
    if (rule.field === "email") {
      switch (rule.operator) {
        case "contains":
          return sql`${subscribers.email} ILIKE ${'%' + this.escapeLikeValue(rule.value) + '%'}`;
        case "not_contains":
          return sql`${subscribers.email} NOT ILIKE ${'%' + this.escapeLikeValue(rule.value) + '%'}`;
        case "equals":
          return sql`LOWER(${subscribers.email}) = LOWER(${rule.value})`;
        case "not_equals":
          return sql`LOWER(${subscribers.email}) != LOWER(${rule.value})`;
        case "starts_with":
          return sql`${subscribers.email} ILIKE ${this.escapeLikeValue(rule.value) + '%'}`;
        case "ends_with":
          return sql`${subscribers.email} ILIKE ${'%' + this.escapeLikeValue(rule.value)}`;
        default:
          return null;
      }
    } else if (rule.field === "tags") {
      switch (rule.operator) {
        case "contains":
          return sql`EXISTS (SELECT 1 FROM unnest(${subscribers.tags}) AS t WHERE t ILIKE ${'%' + this.escapeLikeValue(rule.value) + '%'})`;
        case "not_contains":
          return sql`NOT EXISTS (SELECT 1 FROM unnest(${subscribers.tags}) AS t WHERE t ILIKE ${'%' + this.escapeLikeValue(rule.value) + '%'})`;
        case "equals":
          return sql`${subscribers.tags} @> ARRAY[${rule.value}]::text[]`;
        case "not_equals":
          return sql`NOT (${subscribers.tags} @> ARRAY[${rule.value}]::text[])`;
        default:
          return null;
      }
    } else if (rule.field === "date_added") {
      switch (rule.operator) {
        case "before":
          return sql`${subscribers.importDate} < ${rule.value}::timestamp`;
        case "after":
          return sql`${subscribers.importDate} > ${rule.value}::timestamp`;
        case "between":
          return sql`${subscribers.importDate} BETWEEN ${rule.value}::timestamp AND ${(rule as any).value2 || rule.value}::timestamp`;
        default:
          return null;
      }
    } else if (rule.field === "ip_address") {
      switch (rule.operator) {
        case "equals":
          return sql`${subscribers.ipAddress} = ${rule.value}`;
        case "not_equals":
          return sql`${subscribers.ipAddress} != ${rule.value}`;
        case "starts_with":
          return sql`${subscribers.ipAddress} LIKE ${this.escapeLikeValue(rule.value) + '%'}`;
        case "contains":
          return sql`${subscribers.ipAddress} LIKE ${'%' + this.escapeLikeValue(rule.value) + '%'}`;
        default:
          return null;
      }
    }
    return null;
  }

  private buildGroupCondition(group: any): ReturnType<typeof sql> | null {
    if (!group.rules || group.rules.length === 0) return null;

    const conditions: ReturnType<typeof sql>[] = [];

    for (const rule of group.rules) {
      const condition = this.buildSingleRuleCondition(rule);
      if (condition) {
        conditions.push(condition);
      }
    }

    if (conditions.length === 0) return null;

    const combinator = group.combinator || "AND";
    let result = conditions[0];
    for (let i = 1; i < conditions.length; i++) {
      if (combinator === "OR") {
        result = sql`(${result} OR ${conditions[i]})`;
      } else {
        result = sql`(${result} AND ${conditions[i]})`;
      }
    }

    return sql`(${result})`;
  }

  private buildSegmentSqlCondition(rules: any[]) {
    const conditions: ReturnType<typeof sql>[] = [];
    const logics: string[] = [];

    for (let i = 0; i < rules.length; i++) {
      const item = rules[i];

      if (item.type === "group" && Array.isArray(item.rules)) {
        const groupCondition = this.buildGroupCondition(item);
        if (groupCondition) {
          conditions.push(groupCondition);
          logics.push(i === 0 ? "AND" : (item.logic || "AND"));
        }
        continue;
      }

      const condition = this.buildSingleRuleCondition(item);
      if (condition) {
        conditions.push(condition);
        logics.push(i === 0 ? "AND" : (item.logic || "AND"));
      }
    }

    if (conditions.length === 0) {
      return sql`TRUE`;
    }

    let result = conditions[0];
    for (let i = 1; i < conditions.length; i++) {
      if (logics[i] === "OR") {
        result = sql`(${result} OR ${conditions[i]})`;
      } else {
        result = sql`(${result} AND ${conditions[i]})`;
      }
    }

    return result;
  }

  async getSegments(): Promise<Segment[]> {
    return db.select().from(segments).orderBy(desc(segments.createdAt));
  }

  async getSegment(id: string): Promise<Segment | undefined> {
    const [seg] = await db.select().from(segments).where(eq(segments.id, id));
    return seg;
  }

  async createSegment(data: InsertSegment): Promise<Segment> {
    const [seg] = await db.insert(segments).values(data).returning();
    return seg;
  }

  async updateSegment(id: string, data: Partial<InsertSegment>): Promise<Segment | undefined> {
    const [seg] = await db.update(segments).set(data).where(eq(segments.id, id)).returning();
    return seg;
  }

  async deleteSegment(id: string): Promise<void> {
    await db.execute(sql`UPDATE campaigns SET segment_id = NULL WHERE segment_id = ${id}`);
    await db.delete(segments).where(eq(segments.id, id));
  }

  // ═══════════════════════════════════════════════════════════════
  // MTA MANAGEMENT
  // ═══════════════════════════════════════════════════════════════

  async getMtas(): Promise<Mta[]> {
    const results = await db.select().from(mtas).orderBy(desc(mtas.createdAt));
    return results.map(mta => ({
      ...mta,
      password: mta.password ? "••••••••" : null,
    }));
  }

  async getMta(id: string): Promise<Mta | undefined> {
    const [mta] = await db.select().from(mtas).where(eq(mtas.id, id));
    if (mta && mta.password) {
      mta.password = decrypt(mta.password);
    }
    return mta;
  }

  async createMta(data: InsertMta): Promise<Mta> {
    const dataToInsert = { ...data };
    if (dataToInsert.password) {
      dataToInsert.password = encrypt(dataToInsert.password);
    }
    const [mta] = await db.insert(mtas).values(dataToInsert).returning();
    return mta;
  }

  async updateMta(id: string, data: Partial<InsertMta>): Promise<Mta | undefined> {
    const dataToUpdate = { ...data };
    if (dataToUpdate.password && typeof dataToUpdate.password === 'string') {
      dataToUpdate.password = encrypt(dataToUpdate.password);
    }
    const [mta] = await db.update(mtas).set(dataToUpdate).where(eq(mtas.id, id)).returning();
    return mta;
  }

  async deleteMta(id: string): Promise<void> {
    await db.delete(nullsinkCaptures).where(eq(nullsinkCaptures.mtaId, id));
    await db.execute(sql`UPDATE campaigns SET mta_id = NULL WHERE mta_id = ${id}`);
    await db.delete(mtas).where(eq(mtas.id, id));
  }

  // ═══════════════════════════════════════════════════════════════
  // EMAIL HEADERS
  // ═══════════════════════════════════════════════════════════════

  async getHeaders(): Promise<EmailHeader[]> {
    return db.select().from(emailHeaders);
  }

  async getDefaultHeaders(): Promise<EmailHeader[]> {
    return db.select().from(emailHeaders).where(eq(emailHeaders.isDefault, true));
  }

  async getHeader(id: string): Promise<EmailHeader | undefined> {
    const [header] = await db.select().from(emailHeaders).where(eq(emailHeaders.id, id));
    return header;
  }

  async createHeader(data: InsertEmailHeader): Promise<EmailHeader> {
    const [header] = await db.insert(emailHeaders).values(data).returning();
    return header;
  }

  async updateHeader(id: string, data: Partial<InsertEmailHeader>): Promise<EmailHeader | undefined> {
    const [header] = await db.update(emailHeaders).set(data).where(eq(emailHeaders.id, id)).returning();
    return header;
  }

  async deleteHeader(id: string): Promise<void> {
    await db.delete(emailHeaders).where(eq(emailHeaders.id, id));
  }

  // ═══════════════════════════════════════════════════════════════
  // CAMPAIGN MANAGEMENT
  // ═══════════════════════════════════════════════════════════════

  async getCampaigns(): Promise<Campaign[]> {
    return db.select().from(campaigns).orderBy(desc(campaigns.createdAt));
  }

  async getCampaign(id: string): Promise<Campaign | undefined> {
    const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, id));
    return campaign;
  }

  async getCampaignStatus(id: string): Promise<string | null> {
    const result = await db.execute(sql`SELECT status FROM campaigns WHERE id = ${id} LIMIT 1`);
    return result.rows.length > 0 ? (result.rows[0] as any).status : null;
  }

  async getCampaignsByPauseReason(reason: string): Promise<Campaign[]> {
    return db.select().from(campaigns)
      .where(and(eq(campaigns.status, "paused"), eq(campaigns.pauseReason, reason)));
  }

  async createCampaign(data: InsertCampaign): Promise<Campaign> {
    const [campaign] = await db.insert(campaigns).values(data).returning();
    return campaign;
  }

  async updateCampaign(id: string, data: Partial<Campaign>): Promise<Campaign | undefined> {
    const [campaign] = await db.update(campaigns).set(data).where(eq(campaigns.id, id)).returning();
    return campaign;
  }

  async deleteCampaign(id: string): Promise<void> {
    await db.delete(nullsinkCaptures).where(eq(nullsinkCaptures.campaignId, id));
    await db.delete(campaignStats).where(eq(campaignStats.campaignId, id));
    await db.delete(campaignSends).where(eq(campaignSends.campaignId, id));
    await db.delete(campaignJobs).where(eq(campaignJobs.campaignId, id));
    await db.delete(errorLogs).where(eq(errorLogs.campaignId, id));
    await db.execute(sql`DELETE FROM pending_tag_operations WHERE campaign_id = ${id}`);
    await db.execute(sql`DELETE FROM analytics_daily WHERE campaign_id = ${id}`);
    await db.delete(campaigns).where(eq(campaigns.id, id));
  }

  async copyCampaign(id: string): Promise<Campaign | undefined> {
    const original = await this.getCampaign(id);
    if (!original) return undefined;

    const { id: _, createdAt, startedAt, completedAt, sentCount, pendingCount, failedCount, ...copyData } = original;
    return this.createCampaign({
      ...copyData,
      name: `${original.name} (Copy)`,
      status: "draft",
      sendingSpeed: original.sendingSpeed as "slow" | "medium" | "fast" | "godzilla",
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // CAMPAIGN SENDING & TRACKING
  // ═══════════════════════════════════════════════════════════════

  async addCampaignStat(campaignId: string, subscriberId: string, type: string, link?: string): Promise<void> {
    await db.insert(campaignStats).values({
      campaignId,
      subscriberId,
      type,
      link,
    });
  }

  async getCampaignStats(campaignId: string): Promise<CampaignStat[]> {
    return db.select().from(campaignStats).where(eq(campaignStats.campaignId, campaignId)).orderBy(desc(campaignStats.timestamp));
  }

  // NOTE: DEPRECATED - throws error, use reserveSendSlot() + finalizeSend()
  async recordCampaignSend(campaignId: string, subscriberId: string, status: string = "sent"): Promise<boolean> {
    throw new Error("DEPRECATED: recordCampaignSend() is no longer supported. Use reserveSendSlot() + finalizeSend() for proper two-phase send.");
  }

  // NOTE: Potentially dead code - no callers found outside storage.ts
  async wasEmailSent(campaignId: string, subscriberId: string): Promise<boolean> {
    const [result] = await db.select({ count: sql<number>`count(*)` })
      .from(campaignSends)
      .where(and(
        eq(campaignSends.campaignId, campaignId),
        eq(campaignSends.subscriberId, subscriberId)
      ));
    return Number(result.count) > 0;
  }

  // NOTE: Potentially dead code - no callers found outside storage.ts
  async getCampaignSendCount(campaignId: string): Promise<number> {
    const [result] = await db.select({ count: sql<number>`count(*)` })
      .from(campaignSends)
      .where(eq(campaignSends.campaignId, campaignId));
    return Number(result.count);
  }

  async incrementCampaignSentCount(campaignId: string, increment: number = 1): Promise<void> {
    await db.execute(sql`
      UPDATE campaigns 
      SET sent_count = sent_count + ${increment}
      WHERE id = ${campaignId}
    `);
  }

  async incrementCampaignFailedCount(campaignId: string, increment: number = 1): Promise<void> {
    await db.execute(sql`
      UPDATE campaigns 
      SET failed_count = failed_count + ${increment}
      WHERE id = ${campaignId}
    `);
  }

  async decrementCampaignPendingCount(campaignId: string, decrement: number = 1): Promise<void> {
    await db.execute(sql`
      UPDATE campaigns 
      SET pending_count = GREATEST(pending_count - ${decrement}, 0)
      WHERE id = ${campaignId}
    `);
  }

  async updateCampaignStatusAtomic(campaignId: string, newStatus: string, expectedStatus?: string): Promise<boolean> {
    let result;
    if (expectedStatus) {
      // Only update if current status matches expected (optimistic locking)
      result = await db.execute(sql`
        UPDATE campaigns 
        SET status = ${newStatus}
        WHERE id = ${campaignId} AND status = ${expectedStatus}
        RETURNING id
      `);
    } else {
      result = await db.execute(sql`
        UPDATE campaigns 
        SET status = ${newStatus}
        WHERE id = ${campaignId}
        RETURNING id
      `);
    }
    return result.rows.length > 0;
  }

  async reserveSendSlot(campaignId: string, subscriberId: string): Promise<boolean> {
    const result = await db.execute(sql`
      INSERT INTO campaign_sends (id, campaign_id, subscriber_id, status, sent_at)
      VALUES (gen_random_uuid(), ${campaignId}, ${subscriberId}, 'pending', NOW())
      ON CONFLICT (campaign_id, subscriber_id) DO NOTHING
      RETURNING id
    `);
    return result.rows.length > 0;
  }

  async finalizeSend(campaignId: string, subscriberId: string, success: boolean): Promise<void> {
    const newStatus = success ? 'sent' : 'failed';
    const result = await db.execute(sql`
      WITH updated_send AS (
        UPDATE campaign_sends 
        SET status = ${newStatus}
        WHERE campaign_id = ${campaignId} AND subscriber_id = ${subscriberId} AND status = 'pending'
        RETURNING id
      ),
      counter_update AS (
        UPDATE campaigns 
        SET 
          sent_count = CASE WHEN ${success} THEN sent_count + 1 ELSE sent_count END,
          failed_count = CASE WHEN NOT ${success} THEN failed_count + 1 ELSE failed_count END,
          pending_count = GREATEST(pending_count - 1, 0)
        WHERE id = ${campaignId} AND (SELECT COUNT(*) FROM updated_send) > 0
        RETURNING id
      )
      SELECT (SELECT COUNT(*) FROM updated_send) as updated_count
    `);
    
    const updatedCount = Number(result.rows[0]?.updated_count ?? 0);
    if (updatedCount === 0) {
      // No pending row found - this violates the two-phase invariant
      // Throw so caller can handle the anomaly (e.g., compensating action, logging)
      throw new Error(`finalizeSend invariant violation: No pending row found for campaign=${campaignId}, subscriber=${subscriberId}. Already finalized, missing reservation, or manual alteration.`);
    }
  }

  // NOTE: Potentially dead code - no callers found outside storage.ts
  async recordSendAndUpdateCounters(campaignId: string, subscriberId: string, success: boolean): Promise<boolean> {
    // First reserve the slot
    const reserved = await this.reserveSendSlot(campaignId, subscriberId);
    if (!reserved) {
      return false; // Already sent/reserved
    }
    // Then finalize with the result
    await this.finalizeSend(campaignId, subscriberId, success);
    return true;
  }

  async recoverOrphanedPendingSends(campaignId: string, maxAgeMinutes: number = 5): Promise<number> {
    const result = await db.execute(sql`
      WITH orphaned AS (
        UPDATE campaign_sends 
        SET status = 'failed'
        WHERE campaign_id = ${campaignId} 
          AND status = 'pending'
          AND sent_at < NOW() - INTERVAL '1 minute' * ${maxAgeMinutes}
        RETURNING id
      ),
      counter_update AS (
        UPDATE campaigns 
        SET 
          failed_count = failed_count + (SELECT COUNT(*) FROM orphaned),
          pending_count = GREATEST(pending_count - (SELECT COUNT(*) FROM orphaned), 0)
        WHERE id = ${campaignId} AND (SELECT COUNT(*) FROM orphaned) > 0
        RETURNING id
      )
      SELECT (SELECT COUNT(*) FROM orphaned) as recovered_count
    `);
    
    const recoveredCount = Number(result.rows[0]?.recovered_count ?? 0);
    if (recoveredCount > 0) {
      logger.info('Recovered orphaned pending sends', { recoveredCount, campaignId });
    }
    return recoveredCount;
  }

  async forceFailPendingSend(campaignId: string, subscriberId: string): Promise<boolean> {
    const result = await db.execute(sql`
      WITH updated AS (
        UPDATE campaign_sends 
        SET status = 'failed'
        WHERE campaign_id = ${campaignId} 
          AND subscriber_id = ${subscriberId}
          AND status = 'pending'
        RETURNING id
      ),
      counter_update AS (
        UPDATE campaigns 
        SET 
          failed_count = failed_count + 1,
          pending_count = GREATEST(pending_count - 1, 0)
        WHERE id = ${campaignId} AND (SELECT COUNT(*) FROM updated) > 0
        RETURNING id
      )
      SELECT (SELECT COUNT(*) FROM updated) as updated_count
    `);
    
    return Number(result.rows[0]?.updated_count ?? 0) > 0;
  }

  async bulkReserveSendSlots(campaignId: string, subscriberIds: string[]): Promise<string[]> {
    if (subscriberIds.length === 0) return [];
    
    const CHUNK_SIZE = 1000;
    const allReserved: string[] = [];
    
    for (let i = 0; i < subscriberIds.length; i += CHUNK_SIZE) {
      const chunk = subscriberIds.slice(i, i + CHUNK_SIZE);
      const arrayLiteral = `{${chunk.map(id => `"${id}"`).join(',')}}`;
      const result = await db.execute(sql`
        INSERT INTO campaign_sends (id, campaign_id, subscriber_id, status, sent_at)
        SELECT gen_random_uuid(), ${campaignId}, unnest_id, 'pending', NOW()
        FROM unnest(${arrayLiteral}::text[]) AS unnest_id
        ON CONFLICT (campaign_id, subscriber_id) DO NOTHING
        RETURNING subscriber_id
      `);
      for (const r of result.rows) {
        allReserved.push((r as any).subscriber_id);
      }
    }
    
    return allReserved;
  }

  async bulkFinalizeSends(campaignId: string, successIds: string[], failedIds: string[]): Promise<void> {
    const sentCount = successIds.length;
    const failCount = failedIds.length;
    const totalProcessed = sentCount + failCount;
    
    if (totalProcessed === 0) return;
    
    const CHUNK_SIZE = 1000;
    
    await db.transaction(async (tx) => {
      if (successIds.length > 0) {
        for (let i = 0; i < successIds.length; i += CHUNK_SIZE) {
          const chunk = successIds.slice(i, i + CHUNK_SIZE);
          const arrayLiteral = `{${chunk.map(id => `"${id}"`).join(',')}}`;
          await tx.execute(sql`
            UPDATE campaign_sends SET status = 'sent'
            WHERE campaign_id = ${campaignId} AND subscriber_id = ANY(${arrayLiteral}::text[]) AND status = 'pending'
          `);
        }
      }
      if (failedIds.length > 0) {
        for (let i = 0; i < failedIds.length; i += CHUNK_SIZE) {
          const chunk = failedIds.slice(i, i + CHUNK_SIZE);
          const arrayLiteral = `{${chunk.map(id => `"${id}"`).join(',')}}`;
          await tx.execute(sql`
            UPDATE campaign_sends SET status = 'failed'
            WHERE campaign_id = ${campaignId} AND subscriber_id = ANY(${arrayLiteral}::text[]) AND status = 'pending'
          `);
        }
      }
      await tx.execute(sql`
        UPDATE campaigns SET
          sent_count = sent_count + ${sentCount},
          failed_count = failed_count + ${failCount},
          pending_count = GREATEST(pending_count - ${totalProcessed}, 0)
        WHERE id = ${campaignId}
      `);
    });
  }

  async heartbeatJob(jobId: string): Promise<void> {
    await db.execute(sql`
      UPDATE campaign_jobs 
      SET started_at = NOW()
      WHERE id = ${jobId} AND status = 'processing'
    `);
  }

  // NOTE: Potentially dead code - no callers found outside storage.ts
  async getCampaignSend(campaignId: string, subscriberId: string): Promise<CampaignSend | undefined> {
    const [send] = await db.select().from(campaignSends)
      .where(and(
        eq(campaignSends.campaignId, campaignId),
        eq(campaignSends.subscriberId, subscriberId)
      ));
    return send;
  }

  async recordFirstOpen(campaignId: string, subscriberId: string): Promise<boolean> {
    const result = await db.execute(sql`
      UPDATE campaign_sends 
      SET first_open_at = NOW()
      WHERE campaign_id = ${campaignId} 
        AND subscriber_id = ${subscriberId}
        AND first_open_at IS NULL
      RETURNING id
    `);
    return result.rows.length > 0;
  }

  async recordFirstClick(campaignId: string, subscriberId: string): Promise<boolean> {
    const result = await db.execute(sql`
      UPDATE campaign_sends 
      SET first_click_at = NOW()
      WHERE campaign_id = ${campaignId} 
        AND subscriber_id = ${subscriberId}
        AND first_click_at IS NULL
      RETURNING id
    `);
    return result.rows.length > 0;
  }

  async getUniqueOpenCount(campaignId: string): Promise<number> {
    const result = await db.execute(sql`
      SELECT COUNT(*) as count FROM campaign_sends 
      WHERE campaign_id = ${campaignId} AND first_open_at IS NOT NULL
    `);
    return Number((result.rows[0] as any)?.count || 0);
  }

  async getUniqueClickCount(campaignId: string): Promise<number> {
    const result = await db.execute(sql`
      SELECT COUNT(*) as count FROM campaign_sends 
      WHERE campaign_id = ${campaignId} AND first_click_at IS NOT NULL
    `);
    return Number((result.rows[0] as any)?.count || 0);
  }

  // ═══════════════════════════════════════════════════════════════
  // IMPORT JOB MANAGEMENT
  // ═══════════════════════════════════════════════════════════════

  async getImportJobs(): Promise<ImportJob[]> {
    return db.select().from(importJobs).orderBy(desc(importJobs.createdAt));
  }

  async getImportJob(id: string): Promise<ImportJob | undefined> {
    const [job] = await db.select().from(importJobs).where(eq(importJobs.id, id));
    return job;
  }

  async createImportJob(data: InsertImportJob): Promise<ImportJob> {
    const [job] = await db.insert(importJobs).values(data).returning();
    return job;
  }

  async updateImportJob(id: string, data: Partial<ImportJob>): Promise<ImportJob | undefined> {
    const [job] = await db.update(importJobs).set(data).where(eq(importJobs.id, id)).returning();
    return job;
  }

  // ═══════════════════════════════════════════════════════════════
  // CAMPAIGN JOB QUEUE
  // ═══════════════════════════════════════════════════════════════

  async enqueueCampaignJob(campaignId: string): Promise<CampaignJob> {
    const [job] = await db.insert(campaignJobs).values({
      campaignId,
      status: "pending",
    }).returning();
    return job;
  }

  async enqueueCampaignJobWithRetry(campaignId: string, retryCount: number, delaySeconds: number): Promise<any> {
    const result = await db.execute(sql`
      INSERT INTO campaign_jobs (id, campaign_id, status, retry_count, next_retry_at, created_at)
      VALUES (gen_random_uuid(), ${campaignId}, 'pending', ${retryCount}, NOW() + INTERVAL '1 second' * ${delaySeconds}, NOW())
      RETURNING *
    `);
    const row = result.rows[0] as any;
    return {
      id: row.id,
      campaignId: row.campaign_id,
      status: row.status,
      retryCount: Number(row.retry_count ?? 0),
      nextRetryAt: row.next_retry_at ? new Date(row.next_retry_at) : null,
      createdAt: new Date(row.created_at),
      startedAt: row.started_at ? new Date(row.started_at) : null,
      completedAt: row.completed_at ? new Date(row.completed_at) : null,
      workerId: row.worker_id,
      errorMessage: row.error_message,
    };
  }

  async claimNextJob(workerId: string): Promise<CampaignJob | null> {
    const result = await db.execute(sql`
      UPDATE campaign_jobs
      SET status = 'processing',
          started_at = NOW(),
          worker_id = ${workerId}
      WHERE id = (
        SELECT id FROM campaign_jobs
        WHERE status = 'pending'
          AND (next_retry_at IS NULL OR next_retry_at <= NOW())
        ORDER BY created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      RETURNING *
    `);
    
    if (result.rows.length === 0) {
      return null;
    }
    
    const row = result.rows[0] as any;
    return {
      id: row.id,
      campaignId: row.campaign_id,
      status: row.status,
      retryCount: Number(row.retry_count ?? 0),
      nextRetryAt: row.next_retry_at ? new Date(row.next_retry_at) : null,
      createdAt: new Date(row.created_at),
      startedAt: row.started_at ? new Date(row.started_at) : null,
      completedAt: row.completed_at ? new Date(row.completed_at) : null,
      workerId: row.worker_id,
      errorMessage: row.error_message,
    };
  }

  async getFailedSendsForRetry(campaignId: string, limit: number): Promise<Array<{subscriberId: string, email: string, retryCount: number}>> {
    const result = await db.execute(sql`
      SELECT cs.subscriber_id, s.email, cs.retry_count
      FROM campaign_sends cs
      JOIN subscribers s ON cs.subscriber_id = s.id
      WHERE cs.campaign_id = ${campaignId} AND cs.status = 'failed'
      ORDER BY cs.retry_count ASC, cs.sent_at ASC
      LIMIT ${limit}
    `);
    return result.rows.map((row: any) => ({
      subscriberId: row.subscriber_id,
      email: row.email,
      retryCount: Number(row.retry_count ?? 0),
    }));
  }

  async markSendForRetry(campaignId: string, subscriberId: string): Promise<void> {
    await db.execute(sql`
      UPDATE campaign_sends
      SET status = 'pending', retry_count = retry_count + 1, last_retry_at = NOW()
      WHERE campaign_id = ${campaignId} AND subscriber_id = ${subscriberId} AND status = 'failed'
    `);
    await db.execute(sql`
      UPDATE campaigns
      SET failed_count = failed_count - 1, pending_count = pending_count + 1
      WHERE id = ${campaignId}
    `);
  }

  async bulkMarkSendsForRetry(campaignId: string, subscriberIds: string[]): Promise<number> {
    if (subscriberIds.length === 0) return 0;
    const arrayLiteral = `{${subscriberIds.map(id => `"${id}"`).join(',')}}::text[]`;
    const result = await db.execute(sql`
      UPDATE campaign_sends
      SET status = 'pending', retry_count = retry_count + 1, last_retry_at = NOW()
      WHERE campaign_id = ${campaignId}
        AND subscriber_id = ANY(${sql.raw(arrayLiteral)})
        AND status = 'failed'
      RETURNING id
    `);
    const matchCount = result.rows.length;
    if (matchCount > 0) {
      await db.execute(sql`
        UPDATE campaigns
        SET failed_count = failed_count - ${matchCount}, pending_count = pending_count + ${matchCount}
        WHERE id = ${campaignId}
      `);
    }
    return matchCount;
  }

  async completeJob(jobId: string, status: "completed" | "failed", errorMessage?: string): Promise<void> {
    await db.update(campaignJobs)
      .set({
        status,
        completedAt: new Date(),
        errorMessage: errorMessage || null,
      })
      .where(eq(campaignJobs.id, jobId));
  }

  async clearStuckJobsForCampaign(campaignId: string): Promise<number> {
    // Mark any pending/processing jobs as cancelled so resume can create a new job
    const result = await db.update(campaignJobs)
      .set({
        status: "failed",
        completedAt: new Date(),
        errorMessage: "Cancelled for campaign resume",
      })
      .where(
        and(
          eq(campaignJobs.campaignId, campaignId),
          or(
            eq(campaignJobs.status, "pending"),
            eq(campaignJobs.status, "processing")
          )
        )
      );
    return (result as any).rowCount || 0;
  }

  async getJobStatus(campaignId: string): Promise<CampaignJobStatus | null> {
    const [result] = await db.select({ status: campaignJobs.status })
      .from(campaignJobs)
      .where(
        and(
          eq(campaignJobs.campaignId, campaignId),
          or(
            eq(campaignJobs.status, "pending"),
            eq(campaignJobs.status, "processing")
          )
        )
      )
      .orderBy(desc(campaignJobs.createdAt))
      .limit(1);
    
    return result ? (result.status as CampaignJobStatus) : null;
  }

  async getActiveJobs(): Promise<CampaignJob[]> {
    return db.select()
      .from(campaignJobs)
      .where(
        or(
          eq(campaignJobs.status, "pending"),
          eq(campaignJobs.status, "processing")
        )
      )
      .orderBy(campaignJobs.createdAt);
  }

  async cleanupStaleJobs(maxAgeMinutes: number = 30): Promise<number> {
    const result = await db.execute(sql`
      UPDATE campaign_jobs
      SET status = 'failed',
          completed_at = NOW(),
          error_message = 'Job timed out - worker may have crashed'
      WHERE status = 'processing'
        AND started_at < NOW() - INTERVAL '1 minute' * ${maxAgeMinutes}
      RETURNING id
    `);
    return result.rows.length;
  }

  async enqueueImportJob(importJobId: string, csvFilePath: string, totalLines: number, fileSizeBytes: number = 0): Promise<ImportJobQueueItem> {
    const [job] = await db.insert(importJobQueue).values({
      importJobId,
      csvFilePath,
      totalLines,
      processedLines: 0,
      fileSizeBytes,
      processedBytes: 0,
      lastCheckpointLine: 0,
      status: "pending",
    }).returning();
    return job;
  }

  async claimNextImportJob(workerId: string): Promise<ImportJobQueueItem | null> {
    const result = await db.execute(sql`
      UPDATE import_job_queue
      SET status = 'processing',
          started_at = NOW(),
          heartbeat = NOW(),
          worker_id = ${workerId}
      WHERE id = (
        SELECT id FROM import_job_queue
        WHERE status = 'pending'
        ORDER BY created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      RETURNING *
    `);
    
    if (result.rows.length === 0) {
      return null;
    }
    
    const row = result.rows[0] as any;
    return {
      id: row.id,
      importJobId: row.import_job_id,
      csvFilePath: row.csv_file_path,
      totalLines: row.total_lines,
      processedLines: row.processed_lines,
      fileSizeBytes: row.file_size_bytes || 0,
      processedBytes: row.processed_bytes || 0,
      lastCheckpointLine: row.last_checkpoint_line || 0,
      status: row.status,
      createdAt: new Date(row.created_at),
      startedAt: row.started_at ? new Date(row.started_at) : null,
      completedAt: row.completed_at ? new Date(row.completed_at) : null,
      heartbeat: row.heartbeat ? new Date(row.heartbeat) : null,
      workerId: row.worker_id,
      errorMessage: row.error_message,
      retryCount: row.retry_count || 0,
    };
  }

  async updateImportQueueProgress(queueId: string, processedLines: number): Promise<void> {
    await db.execute(sql`
      UPDATE import_job_queue
      SET processed_lines = ${processedLines},
          heartbeat = NOW()
      WHERE id = ${queueId}
    `);
  }
  
  async updateImportQueueProgressWithCheckpoint(
    queueId: string, 
    processedLines: number, 
    processedBytes: number, 
    lastCheckpointLine: number
  ): Promise<void> {
    await db.execute(sql`
      UPDATE import_job_queue
      SET processed_lines = ${processedLines},
          processed_bytes = ${processedBytes},
          last_checkpoint_line = ${lastCheckpointLine},
          heartbeat = NOW()
      WHERE id = ${queueId}
    `);
  }
  
  async getImportQueueItem(queueId: string): Promise<ImportJobQueueItem | null> {
    const result = await db.execute(sql`
      SELECT * FROM import_job_queue WHERE id = ${queueId}
    `);
    
    if (result.rows.length === 0) {
      return null;
    }
    
    const row = result.rows[0] as any;
    return {
      id: row.id,
      importJobId: row.import_job_id,
      csvFilePath: row.csv_file_path,
      totalLines: row.total_lines,
      processedLines: row.processed_lines,
      fileSizeBytes: row.file_size_bytes || 0,
      processedBytes: row.processed_bytes || 0,
      lastCheckpointLine: row.last_checkpoint_line || 0,
      status: row.status,
      createdAt: new Date(row.created_at),
      startedAt: row.started_at ? new Date(row.started_at) : null,
      completedAt: row.completed_at ? new Date(row.completed_at) : null,
      heartbeat: row.heartbeat ? new Date(row.heartbeat) : null,
      workerId: row.worker_id,
      errorMessage: row.error_message,
      retryCount: row.retry_count || 0,
    };
  }

  async updateImportQueueHeartbeat(queueId: string): Promise<void> {
    await db.execute(sql`
      UPDATE import_job_queue
      SET heartbeat = NOW()
      WHERE id = ${queueId}
    `);
  }

  async cancelImportJob(importJobId: string): Promise<boolean> {
    // Cancel the queue item first
    const queueResult = await db.execute(sql`
      UPDATE import_job_queue
      SET status = 'cancelled',
          completed_at = NOW(),
          error_message = 'Cancelled by user'
      WHERE import_job_id = ${importJobId}
        AND status IN ('pending', 'processing')
      RETURNING id
    `);
    
    // Update the import job status
    const jobResult = await db.execute(sql`
      UPDATE import_jobs
      SET status = 'cancelled',
          error_message = 'Cancelled by user',
          completed_at = NOW()
      WHERE id = ${importJobId}
        AND status IN ('pending', 'processing')
      RETURNING id
    `);
    
    return queueResult.rows.length > 0 || jobResult.rows.length > 0;
  }

  async completeImportQueueJob(jobId: string, status: "completed" | "failed", errorMessage?: string): Promise<void> {
    // Don't overwrite 'cancelled' status - if user cancelled, keep it cancelled
    await db.execute(sql`
      UPDATE import_job_queue
      SET status = ${status},
          completed_at = NOW(),
          error_message = ${errorMessage || null}
      WHERE id = ${jobId}
        AND status != 'cancelled'
    `);
  }

  async getImportJobQueueStatus(importJobId: string): Promise<ImportJobQueueStatus | null> {
    const [result] = await db.select({ status: importJobQueue.status })
      .from(importJobQueue)
      .where(
        and(
          eq(importJobQueue.importJobId, importJobId),
          or(
            eq(importJobQueue.status, "pending"),
            eq(importJobQueue.status, "processing")
          )
        )
      )
      .orderBy(desc(importJobQueue.createdAt))
      .limit(1);
    
    return result ? (result.status as ImportJobQueueStatus) : null;
  }

  async cleanupStaleImportJobs(maxAgeMinutes: number = 30): Promise<number> {
    // Jobs with no heartbeat update for 30+ minutes are considered dead
    const result = await db.execute(sql`
      UPDATE import_job_queue
      SET status = 'failed',
          completed_at = NOW(),
          error_message = 'Job timed out - no heartbeat received'
      WHERE status = 'processing'
        AND (heartbeat IS NULL OR heartbeat < NOW() - INTERVAL '1 minute' * ${maxAgeMinutes})
      RETURNING id
    `);
    return result.rows.length;
  }

  async recoverStuckImportJobs(): Promise<number> {
    // Reset jobs where heartbeat stopped (worker crashed/redeployed)
    // If no heartbeat for 2 minutes, worker is likely dead
    // IMPORTANT: Don't recover jobs where the corresponding import_job is already cancelled
    // IMPORTANT: Limit retries to prevent OOM crash loops - max 2 retries
    
    // First, fail jobs that have exceeded retry limit (retry_count >= 2)
    const failedResult = await db.execute(sql`
      UPDATE import_job_queue q
      SET status = 'failed',
          completed_at = NOW(),
          error_message = 'Import failed after multiple retries - possible memory issue. Try importing a smaller file or splitting the CSV.'
      WHERE q.status = 'processing'
        AND (q.heartbeat IS NULL OR q.heartbeat < NOW() - INTERVAL '2 minutes')
        AND q.retry_count >= 2
      RETURNING q.import_job_id
    `);
    
    // Update corresponding import_jobs to failed
    for (const row of failedResult.rows as any[]) {
      await db.execute(sql`
        UPDATE import_jobs
        SET status = 'failed',
            error_message = 'Import failed after multiple retries - possible memory issue. Try importing a smaller file or splitting the CSV.',
            completed_at = NOW()
        WHERE id = ${row.import_job_id}
      `);
      logger.warn(`[IMPORT] Job ${row.import_job_id} permanently failed after exceeding retry limit`);
    }
    
    // Then, retry jobs that still have retries remaining (retry_count < 2)
    const queueResult = await db.execute(sql`
      UPDATE import_job_queue q
      SET status = 'pending',
          started_at = NULL,
          heartbeat = NULL,
          worker_id = NULL,
          retry_count = retry_count + 1
      WHERE q.status = 'processing'
        AND (q.heartbeat IS NULL OR q.heartbeat < NOW() - INTERVAL '2 minutes')
        AND q.retry_count < 2
        AND NOT EXISTS (
          SELECT 1 FROM import_jobs j 
          WHERE j.id = q.import_job_id 
          AND j.status = 'cancelled'
        )
      RETURNING q.import_job_id
    `);
    
    // Also reset the corresponding import jobs to pending
    for (const row of queueResult.rows as any[]) {
      await db.execute(sql`
        UPDATE import_jobs
        SET status = 'pending'
        WHERE id = ${row.import_job_id}
          AND status = 'processing'
      `);
    }
    
    return queueResult.rows.length + failedResult.rows.length;
  }
  
  // ═══════════════════════════════════════════════════════════════
  // DATABASE INDEX MANAGEMENT
  // ═══════════════════════════════════════════════════════════════

  async dropSubscriberGinIndexes(): Promise<void> {
    logger.info('Dropping GIN indexes for large import optimization');
    await db.execute(sql`DROP INDEX IF EXISTS tags_gin_idx`);
    logger.info('GIN indexes dropped');
  }
  
  async recreateSubscriberGinIndexes(): Promise<void> {
    logger.info('Recreating GIN indexes after import');
    // Use CONCURRENTLY to avoid blocking other operations
    // Note: CONCURRENTLY can't run in a transaction, so we use separate statements
    try {
      await db.execute(sql`CREATE INDEX CONCURRENTLY IF NOT EXISTS tags_gin_idx ON subscribers USING gin (tags)`);
    } catch (err: any) {
      // Fall back to non-concurrent if CONCURRENTLY fails (e.g., already exists or transaction)
      logger.info('CONCURRENTLY failed for tags_gin_idx, trying regular CREATE INDEX');
      await db.execute(sql`CREATE INDEX IF NOT EXISTS tags_gin_idx ON subscribers USING gin (tags)`);
    }
    logger.info('GIN indexes recreated');
  }
  
  async areGinIndexesPresent(): Promise<boolean> {
    const result = await db.execute(sql`
      SELECT COUNT(*) as count 
      FROM pg_indexes 
      WHERE schemaname = 'public' 
        AND tablename = 'subscribers' 
        AND indexname = 'tags_gin_idx'
    `);
    const count = parseInt((result.rows[0] as any)?.count || '0', 10);
    return count >= 1;
  }

  async ensureTrigramIndex(): Promise<void> {
    await db.execute(sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
    await db.execute(sql`CREATE INDEX CONCURRENTLY IF NOT EXISTS email_trgm_idx ON subscribers USING gin (email gin_trgm_ops)`);
  }

  // ═══════════════════════════════════════════════════════════════
  // SEGMENT COUNT CACHING
  // ═══════════════════════════════════════════════════════════════

  async getSegmentSubscriberCountCached(segmentId: string): Promise<number> {
    const cached = this.segmentCountCache.get(segmentId);
    if (cached && Date.now() - cached.timestamp < this.SEGMENT_COUNT_CACHE_TTL) {
      return cached.count;
    }
    
    const count = await this.countSubscribersForSegment(segmentId);
    this.segmentCountCache.set(segmentId, { count, timestamp: Date.now() });
    return count;
  }

  invalidateSegmentCountCache(segmentId?: string): void {
    if (segmentId) {
      this.segmentCountCache.delete(segmentId);
    } else {
      this.segmentCountCache.clear();
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // DASHBOARD & ANALYTICS
  // ═══════════════════════════════════════════════════════════════

  async getDashboardStats() {
    const [
      [{ subscriberCount }],
      [{ campaignCount }],
      [{ openCount }],
      [{ clickCount }],
      recentCampaigns,
      recentImports,
    ] = await Promise.all([
      db.select({ subscriberCount: sql<number>`count(*)` }).from(subscribers),
      db.select({ campaignCount: sql<number>`count(*)` }).from(campaigns),
      db.select({ openCount: sql<number>`count(*)` }).from(campaignStats).where(eq(campaignStats.type, "open")),
      db.select({ clickCount: sql<number>`count(*)` }).from(campaignStats).where(eq(campaignStats.type, "click")),
      db.select().from(campaigns).orderBy(desc(campaigns.createdAt)).limit(5),
      db.select().from(importJobs).orderBy(desc(importJobs.createdAt)).limit(5),
    ]);

    return {
      totalSubscribers: Number(subscriberCount),
      totalCampaigns: Number(campaignCount),
      totalOpens: Number(openCount),
      totalClicks: Number(clickCount),
      recentCampaigns,
      recentImports,
    };
  }

  async getOverallAnalytics() {
    const [
      [{ openCount }],
      [{ clickCount }],
      allCampaigns,
    ] = await Promise.all([
      db.select({ openCount: sql<number>`count(*)` }).from(campaignStats).where(eq(campaignStats.type, "open")),
      db.select({ clickCount: sql<number>`count(*)` }).from(campaignStats).where(eq(campaignStats.type, "click")),
      db.select().from(campaigns).where(eq(campaigns.status, "completed")).orderBy(desc(campaigns.completedAt)).limit(10),
    ]);

    const { mapWithConcurrency } = await import("./utils");
    const campaignMetrics = await mapWithConcurrency(allCampaigns, 3, async (campaign) => {
      const [uniqueOpens, uniqueClicks] = await Promise.all([
        this.getUniqueOpenCount(campaign.id),
        this.getUniqueClickCount(campaign.id),
      ]);
      return {
        id: campaign.id,
        name: campaign.name,
        sentCount: campaign.sentCount,
        openRate: campaign.sentCount > 0 ? (uniqueOpens / campaign.sentCount) * 100 : 0,
        clickRate: campaign.sentCount > 0 ? (uniqueClicks / campaign.sentCount) * 100 : 0,
      };
    });

    const avgOpenRate = campaignMetrics.length > 0
      ? campaignMetrics.reduce((acc, c) => acc + c.openRate, 0) / campaignMetrics.length
      : 0;
    const avgClickRate = campaignMetrics.length > 0
      ? campaignMetrics.reduce((acc, c) => acc + c.clickRate, 0) / campaignMetrics.length
      : 0;

    return {
      totalOpens: Number(openCount),
      totalClicks: Number(clickCount),
      totalCampaigns: allCampaigns.length,
      avgOpenRate,
      avgClickRate,
      recentCampaigns: campaignMetrics,
    };
  }

  async getCampaignAnalytics(campaignId: string) {
    const campaign = await this.getCampaign(campaignId);
    if (!campaign) return undefined;

    // Get unique counts from campaign_sends (more accurate - based on first_open_at/first_click_at)
    const [uniqueOpeners, uniqueClickers] = await Promise.all([
      this.getUniqueOpenCount(campaignId),
      this.getUniqueClickCount(campaignId),
    ]);

    // Get stats for link-level analytics and recent activity
    const stats = await this.getCampaignStats(campaignId);
    const clicks = stats.filter(s => s.type === "click");

    // Top links (all clicks, not just unique)
    const linkCounts: Record<string, number> = {};
    clicks.forEach(c => {
      if (c.link) {
        linkCounts[c.link] = (linkCounts[c.link] || 0) + 1;
      }
    });
    const topLinks = Object.entries(linkCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([url, count]) => ({ url, clicks: count }));

    // Recent activity with subscriber emails
    const recentStats = stats.slice(0, 20);
    const { mapWithConcurrency: mapConcurrent } = await import("./utils");
    const recentActivity = await mapConcurrent(recentStats, 3, async (stat: any) => {
      const sub = await this.getSubscriber(stat.subscriberId);
      return {
        email: sub?.email || "unknown",
        type: stat.type,
        timestamp: stat.timestamp.toISOString(),
        link: stat.link || undefined,
      };
    });

    // Count total opens from campaign_stats (all events including repeat opens)
    const opens = stats.filter(s => s.type === "open");
    
    return {
      campaign,
      totalOpens: opens.length, // All opens for total count
      uniqueOpens: uniqueOpeners, // Unique opens from campaign_sends.first_open_at
      totalClicks: clicks.length, // Total clicks for link analytics
      uniqueClicks: uniqueClickers, // Unique clicks from campaign_sends.first_click_at
      openRate: campaign.sentCount > 0 ? (uniqueOpeners / campaign.sentCount) * 100 : 0,
      clickRate: campaign.sentCount > 0 ? (uniqueClickers / campaign.sentCount) * 100 : 0,
      topLinks,
      recentActivity,
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // ERROR LOGGING
  // ═══════════════════════════════════════════════════════════════

  async logError(data: InsertErrorLog): Promise<ErrorLog> {
    const [log] = await db.insert(errorLogs).values(data).returning();
    return log;
  }

  async getErrorLogs(options?: {
    page?: number;
    limit?: number;
    type?: string;
    severity?: string;
    campaignId?: string;
    importJobId?: string;
  }): Promise<{ logs: ErrorLog[]; total: number }> {
    const page = options?.page || 1;
    const limit = options?.limit || 50;
    const offset = (page - 1) * limit;
    
    const conditions = [];
    if (options?.type) {
      conditions.push(eq(errorLogs.type, options.type));
    }
    if (options?.severity) {
      conditions.push(eq(errorLogs.severity, options.severity));
    }
    if (options?.campaignId) {
      conditions.push(eq(errorLogs.campaignId, options.campaignId));
    }
    if (options?.importJobId) {
      conditions.push(eq(errorLogs.importJobId, options.importJobId));
    }
    
    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
    
    const [logs, [{ count }]] = await Promise.all([
      whereClause 
        ? db.select().from(errorLogs).where(whereClause).orderBy(desc(errorLogs.timestamp)).limit(limit).offset(offset)
        : db.select().from(errorLogs).orderBy(desc(errorLogs.timestamp)).limit(limit).offset(offset),
      whereClause
        ? db.select({ count: sql<number>`count(*)` }).from(errorLogs).where(whereClause)
        : db.select({ count: sql<number>`count(*)` }).from(errorLogs),
    ]);
    
    return { logs, total: Number(count) };
  }

  async getErrorLogStats(): Promise<{
    total: number;
    byType: Record<string, number>;
    bySeverity: Record<string, number>;
    last24Hours: number;
  }> {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    
    const [
      [{ total }],
      typeStats,
      severityStats,
      [{ last24Hours }],
    ] = await Promise.all([
      db.select({ total: sql<number>`count(*)` }).from(errorLogs),
      db.select({ 
        type: errorLogs.type, 
        count: sql<number>`count(*)` 
      }).from(errorLogs).groupBy(errorLogs.type),
      db.select({ 
        severity: errorLogs.severity, 
        count: sql<number>`count(*)` 
      }).from(errorLogs).groupBy(errorLogs.severity),
      db.select({ last24Hours: sql<number>`count(*)` })
        .from(errorLogs)
        .where(sql`${errorLogs.timestamp} > ${yesterday}`),
    ]);
    
    const byType: Record<string, number> = {};
    for (const stat of typeStats) {
      byType[stat.type] = Number(stat.count);
    }
    
    const bySeverity: Record<string, number> = {};
    for (const stat of severityStats) {
      bySeverity[stat.severity] = Number(stat.count);
    }
    
    return {
      total: Number(total),
      byType,
      bySeverity,
      last24Hours: Number(last24Hours),
    };
  }

  async clearErrorLogs(beforeDate?: Date): Promise<number> {
    if (beforeDate) {
      const result = await db.delete(errorLogs).where(sql`${errorLogs.timestamp} < ${beforeDate}`);
      return result.rowCount || 0;
    } else {
      const result = await db.delete(errorLogs);
      return result.rowCount || 0;
    }
  }

  async healthCheck(): Promise<boolean> {
    const result = await db.execute(sql`SELECT 1 as ok`);
    return result.rows.length > 0;
  }

  // ═══════════════════════════════════════════════════════════════
  // USERS
  // ═══════════════════════════════════════════════════════════════

  async createUser(data: { username: string; password: string }): Promise<any> {
    const hashedPassword = await bcrypt.hash(data.password, 12);
    const [user] = await db.insert(users).values({
      username: data.username,
      password: hashedPassword,
    }).returning();
    return { id: user.id, username: user.username, createdAt: user.createdAt };
  }

  async getUserByUsername(username: string): Promise<any | null> {
    const [user] = await db.select().from(users).where(eq(users.username, username)).limit(1);
    return user || null;
  }

  async getUserById(id: string): Promise<any | null> {
    const [user] = await db.select({
      id: users.id,
      username: users.username,
      createdAt: users.createdAt,
    }).from(users).where(eq(users.id, id)).limit(1);
    return user || null;
  }

  async getUserCount(): Promise<number> {
    const result = await db.execute(sql`SELECT COUNT(*)::int as count FROM users`);
    return Number(result.rows[0]?.count ?? 0);
  }

  // ═══════════════════════════════════════════════════════════════
  // FLUSH JOBS
  // ═══════════════════════════════════════════════════════════════

  async createFlushJob(totalRows: number): Promise<FlushJob> {
    const result = await db.insert(flushJobs).values({
      totalRows,
      status: "pending",
    }).returning();
    await db.execute(sql`NOTIFY flush_jobs`);
    return result[0];
  }

  async getFlushJob(id: string): Promise<FlushJob | undefined> {
    const result = await db.select().from(flushJobs).where(eq(flushJobs.id, id));
    return result[0];
  }

  async claimFlushJob(workerId: string): Promise<FlushJob | null> {
    const result = await db.execute(sql`
      UPDATE flush_jobs
      SET status = 'processing', started_at = NOW(), heartbeat = NOW(), worker_id = ${workerId}
      WHERE id = (
        SELECT id FROM flush_jobs
        WHERE status = 'pending'
        ORDER BY created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *
    `);
    if (result.rows.length === 0) return null;
    const row = result.rows[0] as any;
    return {
      id: row.id,
      totalRows: row.total_rows,
      processedRows: row.processed_rows,
      status: row.status,
      createdAt: row.created_at,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      heartbeat: row.heartbeat,
      workerId: row.worker_id,
      errorMessage: row.error_message,
    };
  }

  async updateFlushJobProgress(jobId: string, processedRows: number): Promise<void> {
    await db.update(flushJobs)
      .set({ processedRows, heartbeat: new Date() })
      .where(eq(flushJobs.id, jobId));
  }

  async completeFlushJob(jobId: string, status: "completed" | "failed" | "cancelled", errorMessage?: string): Promise<void> {
    await db.update(flushJobs)
      .set({ 
        status, 
        completedAt: new Date(),
        errorMessage: errorMessage || null,
      })
      .where(eq(flushJobs.id, jobId));
  }

  async cancelFlushJob(jobId: string): Promise<boolean> {
    const result = await db.update(flushJobs)
      .set({ 
        status: "cancelled", 
        completedAt: new Date(),
        errorMessage: "Cancelled by user",
      })
      .where(and(
        eq(flushJobs.id, jobId),
        or(eq(flushJobs.status, "pending"), eq(flushJobs.status, "processing"))
      ))
      .returning();
    return result.length > 0;
  }

  async clearSubscriberDependencies(): Promise<void> {
    await db.execute(sql`DELETE FROM campaign_sends`);
    await db.execute(sql`DELETE FROM campaign_stats`);
    await db.execute(sql`DELETE FROM error_logs WHERE subscriber_id IS NOT NULL`);
    await db.execute(sql`DELETE FROM nullsink_captures`);
    await db.execute(sql`DELETE FROM pending_tag_operations`);
    await db.execute(sql`DELETE FROM automation_enrollments`);
  }

  async deleteSubscriberBatch(batchSize: number): Promise<number> {
    const result = await db.execute(sql`
      DELETE FROM subscribers WHERE id IN (
        SELECT id FROM subscribers LIMIT ${batchSize}
      )
    `);
    return (result.rowCount as number) || 0;
  }

  async countAllSubscribers(): Promise<number> {
    const result = await db.execute(sql`SELECT COUNT(*) as count FROM subscribers`);
    return parseInt(result.rows[0]?.count as string || "0", 10);
  }

  // ═══════════════════════════════════════════════════════════════
  // TAG OPERATIONS
  // ═══════════════════════════════════════════════════════════════

  async enqueueTagOperation(
    subscriberId: string,
    tagValue: string,
    eventType: "open" | "click" | "unsubscribe",
    campaignId?: string
  ): Promise<void> {
    await db.insert(pendingTagOperations).values({
      subscriberId,
      tagType: "tags", // Legacy field, now always just "tags"
      tagValue,
      eventType,
      campaignId,
      status: "pending",
    });
  }

  async claimPendingTagOperations(limit: number = 100): Promise<Array<{
    id: string;
    subscriberId: string;
    tagValue: string;
    eventType: string;
    retryCount: number;
  }>> {
    // Use FOR UPDATE SKIP LOCKED to safely claim pending operations
    const result = await db.execute(sql`
      UPDATE pending_tag_operations
      SET status = 'processing'
      WHERE id IN (
        SELECT id FROM pending_tag_operations
        WHERE status = 'pending'
          AND (next_retry_at IS NULL OR next_retry_at <= NOW())
        ORDER BY created_at
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, subscriber_id, tag_value, event_type, retry_count
    `);
    
    return result.rows.map((row: any) => ({
      id: row.id,
      subscriberId: row.subscriber_id,
      tagValue: row.tag_value,
      eventType: row.event_type,
      retryCount: Number(row.retry_count),
    }));
  }

  async completeTagOperation(operationId: string): Promise<void> {
    await db.update(pendingTagOperations)
      .set({
        status: "completed",
        processedAt: new Date(),
      })
      .where(eq(pendingTagOperations.id, operationId));
  }

  async failTagOperation(operationId: string, error: string): Promise<void> {
    // Exponential backoff: 1s, 2s, 4s, 8s, 16s for retries
    await db.execute(sql`
      UPDATE pending_tag_operations
      SET 
        status = CASE WHEN retry_count >= max_retries - 1 THEN 'failed' ELSE 'pending' END,
        retry_count = retry_count + 1,
        last_error = ${error},
        next_retry_at = CASE 
          WHEN retry_count >= max_retries - 1 THEN NULL
          ELSE NOW() + (POWER(2, retry_count) * INTERVAL '1 second')
        END
      WHERE id = ${operationId}
    `);
  }

  async getTagQueueStats(): Promise<{
    pending: number;
    processing: number;
    completed: number;
    failed: number;
  }> {
    const result = await db.execute(sql`
      SELECT 
        COUNT(*) FILTER (WHERE status = 'pending') as pending,
        COUNT(*) FILTER (WHERE status = 'processing') as processing,
        COUNT(*) FILTER (WHERE status = 'completed') as completed,
        COUNT(*) FILTER (WHERE status = 'failed') as failed
      FROM pending_tag_operations
    `);
    
    const row = result.rows[0] as any;
    return {
      pending: Number(row?.pending || 0),
      processing: Number(row?.processing || 0),
      completed: Number(row?.completed || 0),
      failed: Number(row?.failed || 0),
    };
  }

  async cleanupCompletedTagOperations(olderThanDays: number = 7): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);
    
    const result = await db.delete(pendingTagOperations)
      .where(and(
        eq(pendingTagOperations.status, "completed"),
        sql`${pendingTagOperations.processedAt} < ${cutoffDate}`
      ));
    
    return result.rowCount || 0;
  }

  async addTagToSubscriber(
    subscriberId: string,
    tagValue: string
  ): Promise<boolean> {
    const result = await db.execute(sql`
      UPDATE subscribers
      SET tags = array_append(
        array_remove(tags, ${tagValue}),
        ${tagValue}
      )
      WHERE id = ${subscriberId}
      AND NOT (${tagValue} = ANY(tags))
      RETURNING id
    `);
    
    // If no rows affected, tag already exists - that's still a success
    return true;
  }

  // ═══════════════════════════════════════════════════════════════
  // NULLSINK
  // ═══════════════════════════════════════════════════════════════

  async createNullsinkCapture(data: InsertNullsinkCapture): Promise<NullsinkCapture> {
    const [capture] = await db.insert(nullsinkCaptures).values(data).returning();
    return capture;
  }

  async bulkCreateNullsinkCaptures(data: InsertNullsinkCapture[]): Promise<void> {
    if (data.length === 0) return;
    const CHUNK_SIZE = 500;
    for (let i = 0; i < data.length; i += CHUNK_SIZE) {
      const chunk = data.slice(i, i + CHUNK_SIZE);
      await db.insert(nullsinkCaptures).values(chunk);
    }
  }

  async getNullsinkCaptures(options?: {
    campaignId?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ captures: NullsinkCapture[]; total: number }> {
    const limit = options?.limit || 100;
    const offset = options?.offset || 0;
    
    const whereClause = options?.campaignId 
      ? eq(nullsinkCaptures.campaignId, options.campaignId) 
      : undefined;
    
    const [captures, [{ count }]] = await Promise.all([
      whereClause
        ? db.select().from(nullsinkCaptures).where(whereClause).orderBy(desc(nullsinkCaptures.timestamp)).limit(limit).offset(offset)
        : db.select().from(nullsinkCaptures).orderBy(desc(nullsinkCaptures.timestamp)).limit(limit).offset(offset),
      whereClause
        ? db.select({ count: sql<number>`count(*)` }).from(nullsinkCaptures).where(whereClause)
        : db.select({ count: sql<number>`count(*)` }).from(nullsinkCaptures),
    ]);
    
    return { captures, total: Number(count) };
  }

  async getNullsinkMetrics(campaignId?: string): Promise<{
    totalEmails: number;
    successfulEmails: number;
    failedEmails: number;
    avgHandshakeTimeMs: number;
    avgTotalTimeMs: number;
    emailsPerSecond: number;
  }> {
    const whereClause = campaignId 
      ? sql`WHERE campaign_id = ${campaignId}` 
      : sql``;
    
    const result = await db.execute(sql`
      SELECT 
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE status = 'captured') as successful,
        COUNT(*) FILTER (WHERE status = 'simulated_failure') as failed,
        COALESCE(AVG(handshake_time_ms), 0) as avg_handshake,
        COALESCE(AVG(total_time_ms), 0) as avg_total,
        COALESCE(
          COUNT(*) / NULLIF(EXTRACT(EPOCH FROM (MAX(timestamp) - MIN(timestamp))), 0),
          0
        ) as emails_per_second
      FROM nullsink_captures
      ${whereClause}
    `);
    
    const row = result.rows[0] as any;
    return {
      totalEmails: Number(row?.total || 0),
      successfulEmails: Number(row?.successful || 0),
      failedEmails: Number(row?.failed || 0),
      avgHandshakeTimeMs: Number(row?.avg_handshake || 0),
      avgTotalTimeMs: Number(row?.avg_total || 0),
      emailsPerSecond: Number(row?.emails_per_second || 0),
    };
  }

  async clearNullsinkCaptures(campaignId?: string): Promise<number> {
    if (campaignId) {
      const result = await db.delete(nullsinkCaptures).where(eq(nullsinkCaptures.campaignId, campaignId));
      return result.rowCount || 0;
    } else {
      const result = await db.delete(nullsinkCaptures);
      return result.rowCount || 0;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // DATABASE MAINTENANCE
  // ═══════════════════════════════════════════════════════════════

  async getMaintenanceRules(): Promise<DbMaintenanceRule[]> {
    return db.select().from(dbMaintenanceRules).orderBy(dbMaintenanceRules.tableName);
  }

  async getMaintenanceRule(id: string): Promise<DbMaintenanceRule | undefined> {
    const [rule] = await db.select().from(dbMaintenanceRules).where(eq(dbMaintenanceRules.id, id));
    return rule;
  }

  async upsertMaintenanceRule(data: InsertDbMaintenanceRule): Promise<DbMaintenanceRule> {
    const [rule] = await db.insert(dbMaintenanceRules).values(data).onConflictDoNothing({ target: dbMaintenanceRules.tableName }).returning();
    if (!rule) {
      const [existing] = await db.select().from(dbMaintenanceRules).where(eq(dbMaintenanceRules.tableName, data.tableName));
      return existing;
    }
    return rule;
  }

  async updateMaintenanceRule(id: string, data: Partial<InsertDbMaintenanceRule>): Promise<DbMaintenanceRule | undefined> {
    const [rule] = await db.update(dbMaintenanceRules).set(data).where(eq(dbMaintenanceRules.id, id)).returning();
    return rule;
  }

  async deleteMaintenanceRule(id: string): Promise<void> {
    await db.delete(dbMaintenanceLogs).where(eq(dbMaintenanceLogs.ruleId, id));
    await db.delete(dbMaintenanceRules).where(eq(dbMaintenanceRules.id, id));
  }

  async getMaintenanceLogs(limit: number = 50): Promise<DbMaintenanceLog[]> {
    return db.select().from(dbMaintenanceLogs).orderBy(desc(dbMaintenanceLogs.executedAt)).limit(limit);
  }

  async createMaintenanceLog(data: Omit<DbMaintenanceLog, 'id' | 'executedAt'>): Promise<DbMaintenanceLog> {
    const [log] = await db.insert(dbMaintenanceLogs).values(data).returning();
    return log;
  }

  async getTableStats(): Promise<Array<{tableName: string; rowCount: number; sizeBytes: number; sizePretty: string}>> {
    const result = await pool.query(`
      SELECT 
        relname as table_name,
        n_live_tup as row_count,
        pg_total_relation_size(quote_ident(relname)) as size_bytes,
        pg_size_pretty(pg_total_relation_size(quote_ident(relname))) as size_pretty
      FROM pg_stat_user_tables 
      WHERE schemaname = 'public'
      ORDER BY pg_total_relation_size(quote_ident(relname)) DESC
    `);
    return result.rows.map((row: any) => ({
      tableName: row.table_name,
      rowCount: Number(row.row_count),
      sizeBytes: Number(row.size_bytes),
      sizePretty: row.size_pretty,
    }));
  }

  async seedDefaultMaintenanceRules(): Promise<void> {
    const defaults: InsertDbMaintenanceRule[] = [
      { tableName: "nullsink_captures", displayName: "Nullsink Captures", description: "Test email captures from nullsink campaigns", retentionDays: 7, enabled: true },
      { tableName: "campaign_sends", displayName: "Campaign Sends", description: "Individual email send records per campaign", retentionDays: 180, enabled: true },
      { tableName: "pending_tag_operations", displayName: "Tag Operations", description: "Completed tag operation queue entries", retentionDays: 7, enabled: true },
      { tableName: "campaign_jobs", displayName: "Campaign Jobs", description: "Completed campaign job queue entries", retentionDays: 30, enabled: true },
      { tableName: "import_job_queue", displayName: "Import Queue", description: "Completed import queue entries", retentionDays: 30, enabled: true },
      { tableName: "error_logs", displayName: "Error Logs", description: "Application error log entries", retentionDays: 30, enabled: true },
      { tableName: "session", displayName: "Sessions", description: "Expired user sessions", retentionDays: 7, enabled: true },
    ];
    for (const rule of defaults) {
      await this.upsertMaintenanceRule(rule);
    }
    logger.info("[MAINTENANCE] Default maintenance rules seeded");
  }
}

export const storage = new DatabaseStorage();
