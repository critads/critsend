import {
  users,
  dbMaintenanceRules,
  dbMaintenanceLogs,
  type DbMaintenanceRule,
  type InsertDbMaintenanceRule,
  type DbMaintenanceLog,
} from "@shared/schema";
import { db, pool } from "../db";
import { eq, desc, sql } from "drizzle-orm";
import { logger } from "../logger";
import bcrypt from "bcrypt";
import { getCampaign, getCampaignStats, getUniqueOpenCount, getUniqueClickCount } from "./campaign-repository";
import { getSubscriber } from "./subscriber-repository";
import { mapWithConcurrency } from "../utils";

// ═══════════════════════════════════════════════════════════════
// HEALTH CHECK
// ═══════════════════════════════════════════════════════════════

export async function healthCheck(): Promise<boolean> {
  const result = await db.execute(sql`SELECT 1 as ok`);
  return result.rows.length > 0;
}

// ═══════════════════════════════════════════════════════════════
// USERS
// ═══════════════════════════════════════════════════════════════

export async function createUser(data: { username: string; password: string }): Promise<any> {
  const hashedPassword = await bcrypt.hash(data.password, 12);
  const [user] = await db.insert(users).values({ username: data.username, password: hashedPassword }).returning();
  return { id: user.id, username: user.username, createdAt: user.createdAt };
}

export async function getUserByUsername(username: string): Promise<any | null> {
  const [user] = await db.select().from(users).where(eq(users.username, username)).limit(1);
  return user || null;
}

export async function updateUserPassword(userId: string, hashedPassword: string): Promise<void> {
  await db.update(users).set({ password: hashedPassword }).where(eq(users.id, userId));
}

export async function getUserById(id: string): Promise<any | null> {
  const [user] = await db.select({
    id: users.id,
    username: users.username,
    createdAt: users.createdAt,
  }).from(users).where(eq(users.id, id)).limit(1);
  return user || null;
}

export async function getUserCount(): Promise<number> {
  const result = await db.execute(sql`SELECT COUNT(*)::int as count FROM users`);
  return Number(result.rows[0]?.count ?? 0);
}

// ═══════════════════════════════════════════════════════════════
// DATABASE MAINTENANCE
// ═══════════════════════════════════════════════════════════════

export async function getMaintenanceRules(): Promise<DbMaintenanceRule[]> {
  return db.select().from(dbMaintenanceRules).orderBy(dbMaintenanceRules.tableName);
}

export async function getMaintenanceRule(id: string): Promise<DbMaintenanceRule | undefined> {
  const [rule] = await db.select().from(dbMaintenanceRules).where(eq(dbMaintenanceRules.id, id));
  return rule;
}

export async function upsertMaintenanceRule(data: InsertDbMaintenanceRule): Promise<DbMaintenanceRule> {
  const [rule] = await db.insert(dbMaintenanceRules).values(data)
    .onConflictDoNothing({ target: dbMaintenanceRules.tableName }).returning();
  if (!rule) {
    const [existing] = await db.select().from(dbMaintenanceRules).where(eq(dbMaintenanceRules.tableName, data.tableName));
    return existing;
  }
  return rule;
}

export async function updateMaintenanceRule(id: string, data: Partial<InsertDbMaintenanceRule>): Promise<DbMaintenanceRule | undefined> {
  const [rule] = await db.update(dbMaintenanceRules).set(data).where(eq(dbMaintenanceRules.id, id)).returning();
  return rule;
}

export async function deleteMaintenanceRule(id: string): Promise<void> {
  await db.delete(dbMaintenanceLogs).where(eq(dbMaintenanceLogs.ruleId, id));
  await db.delete(dbMaintenanceRules).where(eq(dbMaintenanceRules.id, id));
}

export async function getMaintenanceLogs(limit: number = 50): Promise<DbMaintenanceLog[]> {
  return db.select().from(dbMaintenanceLogs).orderBy(desc(dbMaintenanceLogs.executedAt)).limit(limit);
}

export async function createMaintenanceLog(data: Omit<DbMaintenanceLog, 'id' | 'executedAt'>): Promise<DbMaintenanceLog> {
  const [log] = await db.insert(dbMaintenanceLogs).values(data).returning();
  return log;
}

export async function getTableStats(): Promise<Array<{tableName: string; rowCount: number; sizeBytes: number; sizePretty: string}>> {
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

export async function seedDefaultMaintenanceRules(): Promise<void> {
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
    await upsertMaintenanceRule(rule);
  }
  logger.info("[MAINTENANCE] Default maintenance rules seeded");
}

// ═══════════════════════════════════════════════════════════════
// CAMPAIGN ANALYTICS (requires cross-repo access to campaign + subscriber data)
// ═══════════════════════════════════════════════════════════════

export async function getCampaignDeviceStats(campaignId: string): Promise<{
  deviceTypes: Array<{ value: string; count: number }>;
  browsers: Array<{ value: string; count: number }>;
  operatingSystems: Array<{ value: string; count: number }>;
}> {
  const [deviceResult, browserResult, osResult] = await Promise.all([
    db.execute(sql`
      SELECT device_type AS value, COUNT(DISTINCT subscriber_id)::int AS count
      FROM campaign_stats
      WHERE campaign_id = ${campaignId} AND type = 'open'
        AND device_type IS NOT NULL AND device_type <> ''
      GROUP BY device_type ORDER BY count DESC
    `),
    db.execute(sql`
      SELECT browser AS value, COUNT(DISTINCT subscriber_id)::int AS count
      FROM campaign_stats
      WHERE campaign_id = ${campaignId} AND type = 'open'
        AND browser IS NOT NULL AND browser <> ''
      GROUP BY browser ORDER BY count DESC LIMIT 15
    `),
    db.execute(sql`
      SELECT INITCAP(os) AS value, COUNT(DISTINCT subscriber_id)::int AS count
      FROM campaign_stats
      WHERE campaign_id = ${campaignId} AND type = 'open'
        AND os IS NOT NULL AND os <> ''
      GROUP BY INITCAP(os) ORDER BY count DESC LIMIT 15
    `),
  ]);
  const toArr = (rows: any[]) => rows.map(r => ({ value: r.value as string, count: Number(r.count) }));
  return {
    deviceTypes: toArr(deviceResult.rows as any[]),
    browsers: toArr(browserResult.rows as any[]),
    operatingSystems: toArr(osResult.rows as any[]),
  };
}

export async function getCampaignProviderOpenRates(campaignId: string): Promise<Array<{
  provider: string;
  recipients: number;
  uniqueOpeners: number;
  openRate: number;
}>> {
  const result = await db.execute(sql`
    SELECT
      SPLIT_PART(s.email, '@', 2)                                                 AS provider,
      COUNT(DISTINCT cs.subscriber_id)::int                                        AS recipients,
      COUNT(DISTINCT CASE WHEN st.type = 'open' THEN st.subscriber_id END)::int   AS unique_openers
    FROM campaign_sends cs
    JOIN subscribers s ON s.id = cs.subscriber_id
    LEFT JOIN campaign_stats st
      ON st.campaign_id = cs.campaign_id
      AND st.subscriber_id = cs.subscriber_id
      AND st.type = 'open'
    WHERE cs.campaign_id = ${campaignId}
    GROUP BY provider
    ORDER BY recipients DESC
    LIMIT 50
  `);
  return (result.rows as any[]).map(r => ({
    provider: r.provider as string,
    recipients: Number(r.recipients),
    uniqueOpeners: Number(r.unique_openers),
    openRate: Number(r.recipients) > 0
      ? Math.round((Number(r.unique_openers) / Number(r.recipients)) * 10000) / 100
      : 0,
  }));
}

export async function getCampaignAnalytics(campaignId: string) {
  const campaign = await getCampaign(campaignId);
  if (!campaign) return undefined;

  const [uniqueOpeners, uniqueClickers, topIpsResult, unsubscribeResult] = await Promise.all([
    getUniqueOpenCount(campaignId),
    getUniqueClickCount(campaignId),
    db.execute(sql`
      SELECT ip_address, COUNT(*)::int AS cnt
      FROM campaign_stats
      WHERE campaign_id = ${campaignId}
        AND type = 'open'
        AND ip_address IS NOT NULL
        AND ip_address <> ''
      GROUP BY ip_address
      ORDER BY cnt DESC
      LIMIT 30
    `),
    db.execute(sql`
      SELECT COUNT(DISTINCT subscriber_id)::int AS cnt
      FROM campaign_stats
      WHERE campaign_id = ${campaignId} AND type = 'unsubscribe'
    `),
  ]);

  const topOpenerIps = (topIpsResult.rows as any[]).map(r => ({
    ip: r.ip_address as string,
    count: Number(r.cnt),
  }));
  const unsubscribeCount = Number((unsubscribeResult.rows[0] as any)?.cnt ?? 0);

  const stats = await getCampaignStats(campaignId);
  const clicks = stats.filter(s => s.type === "click");

  const linkCounts: Record<string, number> = {};
  clicks.forEach(c => {
    if (c.link) linkCounts[c.link] = (linkCounts[c.link] || 0) + 1;
  });
  const topLinks = Object.entries(linkCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([url, count]) => ({ url, clicks: count }));

  const recentStats = stats.slice(0, 20);
  const recentActivity = await mapWithConcurrency(recentStats, 3, async (stat: any) => {
    const sub = await getSubscriber(stat.subscriberId);
    return {
      email: sub?.email || "unknown",
      type: stat.type,
      timestamp: stat.timestamp.toISOString(),
      link: stat.link || undefined,
    };
  });

  return {
    campaign,
    totalOpens: uniqueOpeners,
    uniqueOpens: uniqueOpeners,
    totalClicks: uniqueClickers,
    uniqueClicks: uniqueClickers,
    unsubscribeCount,
    openRate: campaign.sentCount > 0 ? (uniqueOpeners / campaign.sentCount) * 100 : 0,
    clickRate: campaign.sentCount > 0 ? (uniqueClickers / campaign.sentCount) * 100 : 0,
    topLinks,
    topOpenerIps,
    recentActivity,
  };
}
