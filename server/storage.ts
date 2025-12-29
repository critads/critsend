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
} from "@shared/schema";
import { db } from "./db";
import { eq, like, or, sql, desc, and, arrayContains, not } from "drizzle-orm";

export interface IStorage {
  // Subscribers
  getSubscribers(page: number, limit: number, search?: string): Promise<{ subscribers: Subscriber[]; total: number }>;
  getSubscriber(id: string): Promise<Subscriber | undefined>;
  getSubscriberByEmail(email: string): Promise<Subscriber | undefined>;
  createSubscriber(data: InsertSubscriber): Promise<Subscriber>;
  updateSubscriber(id: string, data: Partial<InsertSubscriber>): Promise<Subscriber | undefined>;
  deleteSubscriber(id: string): Promise<void>;
  deleteAllSubscribers(): Promise<number>;
  getSubscribersForSegment(segmentId: string): Promise<Subscriber[]>;
  countSubscribersForSegment(segmentId: string): Promise<number>;
  
  // Segments
  getSegments(): Promise<Segment[]>;
  getSegment(id: string): Promise<Segment | undefined>;
  createSegment(data: InsertSegment): Promise<Segment>;
  updateSegment(id: string, data: Partial<InsertSegment>): Promise<Segment | undefined>;
  deleteSegment(id: string): Promise<void>;
  
  // MTAs
  getMtas(): Promise<Mta[]>;
  getMta(id: string): Promise<Mta | undefined>;
  createMta(data: InsertMta): Promise<Mta>;
  updateMta(id: string, data: Partial<InsertMta>): Promise<Mta | undefined>;
  deleteMta(id: string): Promise<void>;
  
  // Email Headers
  getHeaders(): Promise<EmailHeader[]>;
  getHeader(id: string): Promise<EmailHeader | undefined>;
  createHeader(data: InsertEmailHeader): Promise<EmailHeader>;
  updateHeader(id: string, data: Partial<InsertEmailHeader>): Promise<EmailHeader | undefined>;
  deleteHeader(id: string): Promise<void>;
  
  // Campaigns
  getCampaigns(): Promise<Campaign[]>;
  getCampaign(id: string): Promise<Campaign | undefined>;
  createCampaign(data: InsertCampaign): Promise<Campaign>;
  updateCampaign(id: string, data: Partial<Campaign>): Promise<Campaign | undefined>;
  deleteCampaign(id: string): Promise<void>;
  copyCampaign(id: string): Promise<Campaign | undefined>;
  
  // Campaign Stats
  addCampaignStat(campaignId: string, subscriberId: string, type: string, link?: string): Promise<void>;
  getCampaignStats(campaignId: string): Promise<CampaignStat[]>;
  
  // Campaign Sends - for preventing duplicate emails
  recordCampaignSend(campaignId: string, subscriberId: string, status?: string): Promise<boolean>;
  wasEmailSent(campaignId: string, subscriberId: string): Promise<boolean>;
  getCampaignSendCount(campaignId: string): Promise<number>;
  
  // Atomic campaign counter updates (thread-safe)
  incrementCampaignSentCount(campaignId: string, increment?: number): Promise<void>;
  incrementCampaignFailedCount(campaignId: string, increment?: number): Promise<void>;
  decrementCampaignPendingCount(campaignId: string, decrement?: number): Promise<void>;
  
  // Atomic campaign status update with row locking
  updateCampaignStatusAtomic(campaignId: string, newStatus: string, expectedStatus?: string): Promise<boolean>;
  
  // Two-phase send recording for proper race condition prevention
  // Step 1: Reserve slot BEFORE sending (prevents duplicate sends)
  reserveSendSlot(campaignId: string, subscriberId: string): Promise<boolean>;
  // Step 2: Finalize after SMTP attempt (update status + counters atomically)
  // Throws error if no pending row found (invariant violation)
  finalizeSend(campaignId: string, subscriberId: string, success: boolean): Promise<void>;
  // Combined method (for simple use cases)
  recordSendAndUpdateCounters(campaignId: string, subscriberId: string, success: boolean): Promise<boolean>;
  // Recovery: Clean up orphaned pending sends (from crashes/anomalies)
  // Marks stale pending rows as failed and adjusts counters
  recoverOrphanedPendingSends(campaignId: string, maxAgeMinutes?: number): Promise<number>;
  // Force-fail a specific pending send (for reconciliation during invariant violations)
  forceFailPendingSend(campaignId: string, subscriberId: string): Promise<boolean>;
  
  // Tracking deduplication - returns true if this is the first open/click for this subscriber
  recordFirstOpen(campaignId: string, subscriberId: string): Promise<boolean>;
  recordFirstClick(campaignId: string, subscriberId: string): Promise<boolean>;
  getCampaignSend(campaignId: string, subscriberId: string): Promise<CampaignSend | undefined>;
  getUniqueOpenCount(campaignId: string): Promise<number>;
  getUniqueClickCount(campaignId: string): Promise<number>;
  
  // Import Jobs
  getImportJobs(): Promise<ImportJob[]>;
  getImportJob(id: string): Promise<ImportJob | undefined>;
  createImportJob(data: InsertImportJob): Promise<ImportJob>;
  updateImportJob(id: string, data: Partial<ImportJob>): Promise<ImportJob | undefined>;
  
  // Campaign Job Queue (PostgreSQL-backed)
  enqueueCampaignJob(campaignId: string): Promise<CampaignJob>;
  claimNextJob(workerId: string): Promise<CampaignJob | null>;
  completeJob(jobId: string, status: "completed" | "failed", errorMessage?: string): Promise<void>;
  clearStuckJobsForCampaign(campaignId: string): Promise<number>;
  getJobStatus(campaignId: string): Promise<CampaignJobStatus | null>;
  getActiveJobs(): Promise<CampaignJob[]>;
  cleanupStaleJobs(maxAgeMinutes?: number): Promise<number>;
  
  // Import Job Queue (PostgreSQL-backed with file storage)
  enqueueImportJob(importJobId: string, csvFilePath: string, totalLines: number): Promise<ImportJobQueueItem>;
  claimNextImportJob(workerId: string): Promise<ImportJobQueueItem | null>;
  updateImportQueueProgress(queueId: string, processedLines: number): Promise<void>;
  updateImportQueueHeartbeat(queueId: string): Promise<void>;
  completeImportQueueJob(jobId: string, status: "completed" | "failed", errorMessage?: string): Promise<void>;
  getImportJobQueueStatus(importJobId: string): Promise<ImportJobQueueStatus | null>;
  cleanupStaleImportJobs(maxAgeMinutes?: number): Promise<number>;
  recoverStuckImportJobs(): Promise<number>;
  
  // Error Logs
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
  
  // Health Check
  healthCheck(): Promise<boolean>;
  
  // Nullsink Captures
  createNullsinkCapture(data: InsertNullsinkCapture): Promise<NullsinkCapture>;
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
  
  // Dashboard
  getDashboardStats(): Promise<{
    totalSubscribers: number;
    totalCampaigns: number;
    totalOpens: number;
    totalClicks: number;
    recentCampaigns: Campaign[];
    recentImports: ImportJob[];
  }>;
  
  // Analytics
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
  // Subscribers
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
    await db.delete(subscribers).where(eq(subscribers.id, id));
  }

  async deleteAllSubscribers(): Promise<number> {
    const result = await db.delete(subscribers).returning({ id: subscribers.id });
    return result.length;
  }

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

  private buildSegmentSqlCondition(rules: SegmentRule[]) {
    // Build SQL conditions from segment rules
    // This is much more efficient than loading all records into memory
    const conditions: ReturnType<typeof sql>[] = [];
    
    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i];
      let condition: ReturnType<typeof sql>;
      
      if (rule.field === "email") {
        // Email field filtering
        switch (rule.operator) {
          case "contains":
            condition = sql`${subscribers.email} ILIKE ${'%' + rule.value + '%'}`;
            break;
          case "not_contains":
            condition = sql`${subscribers.email} NOT ILIKE ${'%' + rule.value + '%'}`;
            break;
          case "equals":
            condition = sql`LOWER(${subscribers.email}) = LOWER(${rule.value})`;
            break;
          case "not_equals":
            condition = sql`LOWER(${subscribers.email}) != LOWER(${rule.value})`;
            break;
          case "starts_with":
            condition = sql`${subscribers.email} ILIKE ${rule.value + '%'}`;
            break;
          case "ends_with":
            condition = sql`${subscribers.email} ILIKE ${'%' + rule.value}`;
            break;
          default:
            continue;
        }
      } else {
        // Tags field filtering (default)
        switch (rule.operator) {
          case "contains":
            // Check if any tag contains the value (using LIKE pattern)
            condition = sql`EXISTS (SELECT 1 FROM unnest(${subscribers.tags}) AS t WHERE t ILIKE ${'%' + rule.value + '%'})`;
            break;
          case "not_contains":
            condition = sql`NOT EXISTS (SELECT 1 FROM unnest(${subscribers.tags}) AS t WHERE t ILIKE ${'%' + rule.value + '%'})`;
            break;
          case "equals":
            // Check if exact tag exists
            condition = sql`${rule.value} = ANY(${subscribers.tags})`;
            break;
          case "not_equals":
            condition = sql`NOT (${rule.value} = ANY(${subscribers.tags}))`;
            break;
          default:
            continue;
        }
      }
      
      conditions.push(condition);
    }
    
    if (conditions.length === 0) {
      return sql`TRUE`;
    }
    
    // For simplicity, we combine all rules with AND 
    // (first rule logic is ignored, subsequent use specified logic)
    // Complex OR logic would need more sophisticated SQL building
    let result = conditions[0];
    for (let i = 1; i < conditions.length; i++) {
      const rule = rules[i];
      if (rule.logic === "OR") {
        result = sql`(${result} OR ${conditions[i]})`;
      } else {
        result = sql`(${result} AND ${conditions[i]})`;
      }
    }
    
    return result;
  }

  // Segments
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
    await db.delete(segments).where(eq(segments.id, id));
  }

  // MTAs
  async getMtas(): Promise<Mta[]> {
    return db.select().from(mtas).orderBy(desc(mtas.createdAt));
  }

  async getMta(id: string): Promise<Mta | undefined> {
    const [mta] = await db.select().from(mtas).where(eq(mtas.id, id));
    return mta;
  }

  async createMta(data: InsertMta): Promise<Mta> {
    const [mta] = await db.insert(mtas).values(data).returning();
    return mta;
  }

  async updateMta(id: string, data: Partial<InsertMta>): Promise<Mta | undefined> {
    const [mta] = await db.update(mtas).set(data).where(eq(mtas.id, id)).returning();
    return mta;
  }

  async deleteMta(id: string): Promise<void> {
    await db.delete(mtas).where(eq(mtas.id, id));
  }

  // Email Headers
  async getHeaders(): Promise<EmailHeader[]> {
    return db.select().from(emailHeaders);
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

  // Campaigns
  async getCampaigns(): Promise<Campaign[]> {
    return db.select().from(campaigns).orderBy(desc(campaigns.createdAt));
  }

  async getCampaign(id: string): Promise<Campaign | undefined> {
    const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, id));
    return campaign;
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
    await db.delete(campaignStats).where(eq(campaignStats.campaignId, id));
    await db.delete(campaignSends).where(eq(campaignSends.campaignId, id));
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
    });
  }

  // Campaign Stats
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

  // Campaign Sends - prevents duplicate emails per campaign
  // DEPRECATED: This method is no longer supported. Use reserveSendSlot() + finalizeSend() instead.
  // Throws an error to prevent accidental use of the deprecated pattern
  async recordCampaignSend(campaignId: string, subscriberId: string, status: string = "sent"): Promise<boolean> {
    throw new Error("DEPRECATED: recordCampaignSend() is no longer supported. Use reserveSendSlot() + finalizeSend() for proper two-phase send.");
  }

  async wasEmailSent(campaignId: string, subscriberId: string): Promise<boolean> {
    const [result] = await db.select({ count: sql<number>`count(*)` })
      .from(campaignSends)
      .where(and(
        eq(campaignSends.campaignId, campaignId),
        eq(campaignSends.subscriberId, subscriberId)
      ));
    return Number(result.count) > 0;
  }

  async getCampaignSendCount(campaignId: string): Promise<number> {
    const [result] = await db.select({ count: sql<number>`count(*)` })
      .from(campaignSends)
      .where(eq(campaignSends.campaignId, campaignId));
    return Number(result.count);
  }

  // Atomic counter updates - these use SQL increments to avoid race conditions
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

  // Atomic status update with optional expected status check (for row-level locking)
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

  // Step 1: Reserve a send slot BEFORE attempting to send
  // This prevents duplicates by inserting a 'pending' record first
  // Returns false if this subscriber was already reserved/sent
  async reserveSendSlot(campaignId: string, subscriberId: string): Promise<boolean> {
    const result = await db.execute(sql`
      INSERT INTO campaign_sends (id, campaign_id, subscriber_id, status, sent_at)
      VALUES (gen_random_uuid(), ${campaignId}, ${subscriberId}, 'pending', NOW())
      ON CONFLICT (campaign_id, subscriber_id) DO NOTHING
      RETURNING id
    `);
    return result.rows.length > 0;
  }

  // Step 2: Finalize the send after SMTP attempt (update status and counters atomically)
  // Throws if no pending row found (indicates invariant violation)
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

  // Combined method for backwards compatibility (reserves + finalizes in one call)
  // Use reserveSendSlot + finalizeSend for proper two-phase commit
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

  // Recovery: Clean up orphaned pending sends from crashes/anomalies
  // Marks stale pending rows as failed and adjusts campaign counters atomically
  // Returns the number of orphaned sends recovered
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
      console.log(`Recovered ${recoveredCount} orphaned pending sends for campaign ${campaignId}`);
    }
    return recoveredCount;
  }

  // Force-fail a specific pending send (for reconciliation during invariant violations)
  // Returns true if a pending row was found and marked failed
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

  // Tracking deduplication methods
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

  // Import Jobs
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

  // Campaign Job Queue (PostgreSQL-backed)
  async enqueueCampaignJob(campaignId: string): Promise<CampaignJob> {
    const [job] = await db.insert(campaignJobs).values({
      campaignId,
      status: "pending",
    }).returning();
    return job;
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
      createdAt: new Date(row.created_at),
      startedAt: row.started_at ? new Date(row.started_at) : null,
      completedAt: row.completed_at ? new Date(row.completed_at) : null,
      workerId: row.worker_id,
      errorMessage: row.error_message,
    };
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

  // Import Job Queue (PostgreSQL-backed with file storage)
  async enqueueImportJob(importJobId: string, csvFilePath: string, totalLines: number): Promise<ImportJobQueueItem> {
    const [job] = await db.insert(importJobQueue).values({
      importJobId,
      csvFilePath,
      totalLines,
      processedLines: 0,
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
      status: row.status,
      createdAt: new Date(row.created_at),
      startedAt: row.started_at ? new Date(row.started_at) : null,
      completedAt: row.completed_at ? new Date(row.completed_at) : null,
      heartbeat: row.heartbeat ? new Date(row.heartbeat) : null,
      workerId: row.worker_id,
      errorMessage: row.error_message,
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
    await db.update(importJobQueue)
      .set({
        status,
        completedAt: new Date(),
        errorMessage: errorMessage || null,
      })
      .where(eq(importJobQueue.id, jobId));
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
    const queueResult = await db.execute(sql`
      UPDATE import_job_queue
      SET status = 'pending',
          started_at = NULL,
          heartbeat = NULL,
          worker_id = NULL
      WHERE status = 'processing'
        AND (heartbeat IS NULL OR heartbeat < NOW() - INTERVAL '2 minutes')
      RETURNING import_job_id
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
    
    return queueResult.rows.length;
  }

  // Dashboard
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

  // Analytics
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

    const campaignMetrics = await Promise.all(
      allCampaigns.map(async (campaign) => {
        // Use unique counts from campaign_sends for accurate rates
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
      })
    );

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
    const recentActivity = await Promise.all(
      recentStats.map(async (stat) => {
        const sub = await this.getSubscriber(stat.subscriberId);
        return {
          email: sub?.email || "unknown",
          type: stat.type,
          timestamp: stat.timestamp.toISOString(),
          link: stat.link || undefined,
        };
      })
    );

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

  // Error Logs
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

  // Nullsink Captures
  async createNullsinkCapture(data: InsertNullsinkCapture): Promise<NullsinkCapture> {
    const [capture] = await db.insert(nullsinkCaptures).values(data).returning();
    return capture;
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
}

export const storage = new DatabaseStorage();
