import {
  subscribers,
  segments,
  mtas,
  emailHeaders,
  campaigns,
  campaignStats,
  importJobs,
  dashboardCache,
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
  type ImportJob,
  type InsertImportJob,
  type SegmentRule,
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
  
  // Import Jobs
  getImportJobs(): Promise<ImportJob[]>;
  getImportJob(id: string): Promise<ImportJob | undefined>;
  createImportJob(data: InsertImportJob): Promise<ImportJob>;
  updateImportJob(id: string, data: Partial<ImportJob>): Promise<ImportJob | undefined>;
  
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
        const stats = await this.getCampaignStats(campaign.id);
        const opens = stats.filter(s => s.type === "open").length;
        const clicks = stats.filter(s => s.type === "click").length;
        return {
          id: campaign.id,
          name: campaign.name,
          sentCount: campaign.sentCount,
          openRate: campaign.sentCount > 0 ? (opens / campaign.sentCount) * 100 : 0,
          clickRate: campaign.sentCount > 0 ? (clicks / campaign.sentCount) * 100 : 0,
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

    const stats = await this.getCampaignStats(campaignId);
    
    const opens = stats.filter(s => s.type === "open");
    const clicks = stats.filter(s => s.type === "click");
    
    const uniqueOpeners = new Set(opens.map(o => o.subscriberId)).size;
    const uniqueClickers = new Set(clicks.map(c => c.subscriberId)).size;

    // Top links
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

    return {
      campaign,
      totalOpens: opens.length,
      uniqueOpens: uniqueOpeners,
      totalClicks: clicks.length,
      uniqueClicks: uniqueClickers,
      openRate: campaign.sentCount > 0 ? (uniqueOpeners / campaign.sentCount) * 100 : 0,
      clickRate: campaign.sentCount > 0 ? (uniqueClickers / campaign.sentCount) * 100 : 0,
      topLinks,
      recentActivity,
    };
  }
}

export const storage = new DatabaseStorage();
