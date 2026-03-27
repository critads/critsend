import {
  campaigns,
  campaignStats,
  campaignSends,
  campaignJobs,
  nullsinkCaptures,
  errorLogs,
  importJobs,
  type Campaign,
  type InsertCampaign,
  type CampaignStat,
  type CampaignSend,
  type NullsinkCapture,
  type InsertNullsinkCapture,
} from "@shared/schema";
import { db } from "../db";
import { eq, desc, and, sql } from "drizzle-orm";
import { logger } from "../logger";
import { campaignQueue } from "../queues";
import { mapWithConcurrency } from "../utils";

const USE_BULLMQ = process.env.USE_BULLMQ === "true";

// ═══════════════════════════════════════════════════════════════
// CAMPAIGN MANAGEMENT
// ═══════════════════════════════════════════════════════════════

export async function getCampaigns(): Promise<Campaign[]> {
  return db.select().from(campaigns).orderBy(desc(campaigns.createdAt));
}

export async function getCampaign(id: string): Promise<Campaign | undefined> {
  const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, id));
  return campaign;
}

export async function getCampaignStatus(id: string): Promise<string | null> {
  const result = await db.execute(sql`SELECT status FROM campaigns WHERE id = ${id} LIMIT 1`);
  return result.rows.length > 0 ? (result.rows[0] as any).status : null;
}

export async function getCampaignsByPauseReason(reason: string): Promise<Campaign[]> {
  return db.select().from(campaigns)
    .where(and(eq(campaigns.status, "paused"), eq(campaigns.pauseReason, reason)));
}

export async function createCampaign(data: InsertCampaign): Promise<Campaign> {
  const [campaign] = await db.insert(campaigns).values(data).returning();
  return campaign;
}

export async function updateCampaign(id: string, data: Partial<Campaign>): Promise<Campaign | undefined> {
  const [campaign] = await db.update(campaigns).set(data).where(eq(campaigns.id, id)).returning();
  return campaign;
}

export async function deleteCampaign(id: string): Promise<void> {
  await db.delete(nullsinkCaptures).where(eq(nullsinkCaptures.campaignId, id));
  // campaign_sends and campaign_stats cascade from campaign FK
  await db.delete(campaignJobs).where(eq(campaignJobs.campaignId, id));
  await db.delete(errorLogs).where(eq(errorLogs.campaignId, id));
  await db.execute(sql`DELETE FROM pending_tag_operations WHERE campaign_id = ${id}`);
  await db.execute(sql`DELETE FROM analytics_daily WHERE campaign_id = ${id}`);
  await db.delete(campaigns).where(eq(campaigns.id, id));
}

export async function copyCampaign(id: string): Promise<Campaign | undefined> {
  const original = await getCampaign(id);
  if (!original) return undefined;
  const { id: _, createdAt, startedAt, completedAt, sentCount, pendingCount, failedCount, ...copyData } = original;
  return createCampaign({
    ...copyData,
    name: `${original.name} (Copy)`,
    status: "draft",
    sendingSpeed: original.sendingSpeed as "slow" | "medium" | "fast" | "godzilla",
  });
}

// ═══════════════════════════════════════════════════════════════
// CAMPAIGN SENDING & TRACKING
// ═══════════════════════════════════════════════════════════════

export interface TrackingContext {
  ipAddress?: string;
  userAgent?: string;
  country?: string;
  city?: string;
  deviceType?: string;
  browser?: string;
  os?: string;
}

export async function addCampaignStat(campaignId: string, subscriberId: string, type: string, link?: string, ctx?: TrackingContext): Promise<void> {
  await db.insert(campaignStats).values({
    campaignId,
    subscriberId,
    type,
    link,
    ...(ctx ?? {}),
  });
}

export async function getCampaignStats(campaignId: string): Promise<CampaignStat[]> {
  return db.select().from(campaignStats).where(eq(campaignStats.campaignId, campaignId)).orderBy(desc(campaignStats.timestamp));
}

export async function recordCampaignSend(_campaignId: string, _subscriberId: string, _status: string = "sent"): Promise<boolean> {
  throw new Error("DEPRECATED: recordCampaignSend() is no longer supported. Use reserveSendSlot() + finalizeSend() for proper two-phase send.");
}

export async function wasEmailSent(campaignId: string, subscriberId: string): Promise<boolean> {
  const [result] = await db.select({ count: sql<number>`count(*)` })
    .from(campaignSends)
    .where(and(eq(campaignSends.campaignId, campaignId), eq(campaignSends.subscriberId, subscriberId)));
  return Number(result.count) > 0;
}

export async function getCampaignSendCount(campaignId: string): Promise<number> {
  const [result] = await db.select({ count: sql<number>`count(*)` })
    .from(campaignSends).where(eq(campaignSends.campaignId, campaignId));
  return Number(result.count);
}

export async function incrementCampaignSentCount(campaignId: string, increment: number = 1): Promise<void> {
  await db.execute(sql`UPDATE campaigns SET sent_count = sent_count + ${increment} WHERE id = ${campaignId}`);
}

export async function incrementCampaignFailedCount(campaignId: string, increment: number = 1): Promise<void> {
  await db.execute(sql`UPDATE campaigns SET failed_count = failed_count + ${increment} WHERE id = ${campaignId}`);
}

export async function decrementCampaignPendingCount(campaignId: string, decrement: number = 1): Promise<void> {
  await db.execute(sql`UPDATE campaigns SET pending_count = GREATEST(pending_count - ${decrement}, 0) WHERE id = ${campaignId}`);
}

export async function updateCampaignStatusAtomic(campaignId: string, newStatus: string, expectedStatus?: string): Promise<boolean> {
  let result;
  if (expectedStatus) {
    result = await db.execute(sql`
      UPDATE campaigns SET status = ${newStatus}
      WHERE id = ${campaignId} AND status = ${expectedStatus}
      RETURNING id
    `);
  } else {
    result = await db.execute(sql`
      UPDATE campaigns SET status = ${newStatus} WHERE id = ${campaignId} RETURNING id
    `);
  }
  return result.rows.length > 0;
}

export async function reserveSendSlot(campaignId: string, subscriberId: string): Promise<boolean> {
  const result = await db.execute(sql`
    INSERT INTO campaign_sends (id, campaign_id, subscriber_id, status, sent_at)
    VALUES (gen_random_uuid(), ${campaignId}, ${subscriberId}, 'pending', NOW())
    ON CONFLICT (campaign_id, subscriber_id) DO NOTHING
    RETURNING id
  `);
  return result.rows.length > 0;
}

export async function finalizeSend(campaignId: string, subscriberId: string, success: boolean): Promise<void> {
  const result = await db.execute(sql`
    WITH updated_send AS (
      UPDATE campaign_sends SET status = ${success ? 'sent' : 'failed'}
      WHERE campaign_id = ${campaignId} AND subscriber_id = ${subscriberId} AND status = 'pending'
      RETURNING id
    ),
    counter_update AS (
      UPDATE campaigns SET
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
    throw new Error(`finalizeSend invariant violation: No pending row found for campaign=${campaignId}, subscriber=${subscriberId}.`);
  }
}

export async function recordSendAndUpdateCounters(campaignId: string, subscriberId: string, success: boolean): Promise<boolean> {
  const reserved = await reserveSendSlot(campaignId, subscriberId);
  if (!reserved) return false;
  await finalizeSend(campaignId, subscriberId, success);
  return true;
}

export async function recoverOrphanedPendingSends(campaignId: string, maxAgeMinutes: number = 5): Promise<number> {
  const result = await db.execute(sql`
    WITH orphaned AS (
      UPDATE campaign_sends SET status = 'failed'
      WHERE campaign_id = ${campaignId} AND status = 'pending'
        AND sent_at < NOW() - INTERVAL '1 minute' * ${maxAgeMinutes}
      RETURNING id
    ),
    counter_update AS (
      UPDATE campaigns SET
        failed_count = failed_count + (SELECT COUNT(*) FROM orphaned),
        pending_count = GREATEST(pending_count - (SELECT COUNT(*) FROM orphaned), 0)
      WHERE id = ${campaignId} AND (SELECT COUNT(*) FROM orphaned) > 0
      RETURNING id
    )
    SELECT (SELECT COUNT(*) FROM orphaned) as recovered_count
  `);
  const recoveredCount = Number(result.rows[0]?.recovered_count ?? 0);
  if (recoveredCount > 0) logger.info('Recovered orphaned pending sends', { recoveredCount, campaignId });
  return recoveredCount;
}

export async function resetOrphanedFailedSends(campaignId: string): Promise<number> {
  const result = await db.execute(sql`
    WITH orphaned AS (
      DELETE FROM campaign_sends
      WHERE campaign_id = ${campaignId} AND status = 'failed'
        AND retry_count = 0 AND first_open_at IS NULL AND first_click_at IS NULL
      RETURNING id
    ),
    counter_update AS (
      UPDATE campaigns
      SET failed_count = GREATEST(failed_count - (SELECT COUNT(*) FROM orphaned), 0)
      WHERE id = ${campaignId} AND (SELECT COUNT(*) FROM orphaned) > 0
      RETURNING id
    )
    SELECT (SELECT COUNT(*) FROM orphaned) as reset_count
  `);
  const resetCount = Number(result.rows[0]?.reset_count ?? 0);
  if (resetCount > 0) logger.info(`[RESUME] Deleted ${resetCount} orphaned failed sends for campaign ${campaignId}`);
  return resetCount;
}

export async function forceFailPendingSend(campaignId: string, subscriberId: string): Promise<boolean> {
  const result = await db.execute(sql`
    WITH updated AS (
      UPDATE campaign_sends SET status = 'failed'
      WHERE campaign_id = ${campaignId} AND subscriber_id = ${subscriberId} AND status = 'pending'
      RETURNING id
    ),
    counter_update AS (
      UPDATE campaigns SET
        failed_count = failed_count + 1,
        pending_count = GREATEST(pending_count - 1, 0)
      WHERE id = ${campaignId} AND (SELECT COUNT(*) FROM updated) > 0
      RETURNING id
    )
    SELECT (SELECT COUNT(*) FROM updated) as updated_count
  `);
  return Number(result.rows[0]?.updated_count ?? 0) > 0;
}

export async function bulkReserveSendSlots(campaignId: string, subscriberIds: string[]): Promise<string[]> {
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
    for (const r of result.rows) allReserved.push((r as any).subscriber_id);
  }
  return allReserved;
}

export async function bulkInsertCampaignSendAttempts(campaignId: string, subscriberIds: string[]): Promise<void> {
  if (subscriberIds.length === 0) return;
  const CHUNK_SIZE = 1000;
  for (let i = 0; i < subscriberIds.length; i += CHUNK_SIZE) {
    const chunk = subscriberIds.slice(i, i + CHUNK_SIZE);
    const arrayLiteral = `{${chunk.map(id => `"${id}"`).join(',')}}`;
    await db.execute(sql`
      INSERT INTO campaign_sends (id, campaign_id, subscriber_id, status, sent_at)
      SELECT gen_random_uuid(), ${campaignId}, unnest_id, 'attempting', NOW()
      FROM unnest(${arrayLiteral}::text[]) AS unnest_id
      ON CONFLICT (campaign_id, subscriber_id) DO UPDATE
        SET status = 'attempting'
        WHERE campaign_sends.status = 'pending'
    `);
  }
}

export async function bulkFinalizeSends(campaignId: string, successIds: string[], failedIds: string[]): Promise<void> {
  const sentCount = successIds.length;
  const failCount = failedIds.length;
  const totalProcessed = sentCount + failCount;
  if (totalProcessed === 0) return;

  const CHUNK_SIZE = 1000;
  await db.transaction(async (tx) => {
    if (successIds.length > 0) {
      for (let i = 0; i < successIds.length; i += CHUNK_SIZE) {
        const chunk = successIds.slice(i, i + CHUNK_SIZE);
        const arr = `{${chunk.map(id => `"${id}"`).join(',')}}`;
        await tx.execute(sql`
          UPDATE campaign_sends SET status = 'sent'
          WHERE campaign_id = ${campaignId} AND subscriber_id = ANY(${arr}::text[]) AND status IN ('pending', 'attempting')
        `);
      }
    }
    if (failedIds.length > 0) {
      for (let i = 0; i < failedIds.length; i += CHUNK_SIZE) {
        const chunk = failedIds.slice(i, i + CHUNK_SIZE);
        const arr = `{${chunk.map(id => `"${id}"`).join(',')}}`;
        await tx.execute(sql`
          UPDATE campaign_sends SET status = 'failed'
          WHERE campaign_id = ${campaignId} AND subscriber_id = ANY(${arr}::text[]) AND status IN ('pending', 'attempting')
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

export async function heartbeatJob(jobId: string): Promise<void> {
  await db.execute(sql`
    UPDATE campaign_jobs SET started_at = NOW() WHERE id = ${jobId} AND status = 'processing'
  `);
}

export async function getCampaignSend(campaignId: string, subscriberId: string): Promise<CampaignSend | undefined> {
  const [send] = await db.select().from(campaignSends)
    .where(and(eq(campaignSends.campaignId, campaignId), eq(campaignSends.subscriberId, subscriberId)));
  return send;
}

export async function recordFirstOpen(campaignId: string, subscriberId: string): Promise<boolean> {
  const result = await db.execute(sql`
    UPDATE campaign_sends SET first_open_at = NOW()
    WHERE campaign_id = ${campaignId} AND subscriber_id = ${subscriberId} AND first_open_at IS NULL
    RETURNING id
  `);
  return result.rows.length > 0;
}

export async function recordFirstClick(campaignId: string, subscriberId: string): Promise<boolean> {
  const result = await db.execute(sql`
    UPDATE campaign_sends SET first_click_at = NOW()
    WHERE campaign_id = ${campaignId} AND subscriber_id = ${subscriberId} AND first_click_at IS NULL
    RETURNING id
  `);
  return result.rows.length > 0;
}

export async function getUniqueOpenCount(campaignId: string): Promise<number> {
  const result = await db.execute(sql`
    SELECT COUNT(*) as count FROM campaign_sends WHERE campaign_id = ${campaignId} AND first_open_at IS NOT NULL
  `);
  return Number((result.rows[0] as any)?.count || 0);
}

export async function getUniqueClickCount(campaignId: string): Promise<number> {
  const result = await db.execute(sql`
    SELECT COUNT(*) as count FROM campaign_sends WHERE campaign_id = ${campaignId} AND first_click_at IS NOT NULL
  `);
  return Number((result.rows[0] as any)?.count || 0);
}

export async function getCampaignSendCounts(campaignId: string): Promise<{total: number, sent: number, failed: number, pending: number, attempting: number}> {
  const result = await db.execute(sql`
    SELECT
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE status = 'sent') as sent,
      COUNT(*) FILTER (WHERE status = 'failed') as failed,
      COUNT(*) FILTER (WHERE status = 'pending' OR status = 'reserved') as pending,
      COUNT(*) FILTER (WHERE status = 'attempting') as attempting
    FROM campaign_sends WHERE campaign_id = ${campaignId}
  `);
  const row = result.rows[0] as any;
  return {
    total: Number(row?.total || 0),
    sent: Number(row?.sent || 0),
    failed: Number(row?.failed || 0),
    pending: Number(row?.pending || 0),
    attempting: Number(row?.attempting || 0),
  };
}

// ═══════════════════════════════════════════════════════════════
// NULLSINK
// ═══════════════════════════════════════════════════════════════

export async function createNullsinkCapture(data: InsertNullsinkCapture): Promise<NullsinkCapture> {
  const [capture] = await db.insert(nullsinkCaptures).values(data).returning();
  return capture;
}

export async function bulkCreateNullsinkCaptures(data: InsertNullsinkCapture[]): Promise<void> {
  if (data.length === 0) return;
  const CHUNK_SIZE = 500;
  for (let i = 0; i < data.length; i += CHUNK_SIZE) {
    await db.insert(nullsinkCaptures).values(data.slice(i, i + CHUNK_SIZE));
  }
}

export async function getNullsinkCaptures(options?: {
  campaignId?: string; limit?: number; offset?: number;
}): Promise<{ captures: NullsinkCapture[]; total: number }> {
  const limit = options?.limit || 100;
  const offset = options?.offset || 0;
  const whereClause = options?.campaignId ? eq(nullsinkCaptures.campaignId, options.campaignId) : undefined;

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

export async function getNullsinkMetrics(campaignId?: string): Promise<{
  totalEmails: number; successfulEmails: number; failedEmails: number;
  avgHandshakeTimeMs: number; avgTotalTimeMs: number; emailsPerSecond: number;
}> {
  const whereClause = campaignId ? sql`WHERE campaign_id = ${campaignId}` : sql``;
  const result = await db.execute(sql`
    SELECT
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE status = 'captured') as successful,
      COUNT(*) FILTER (WHERE status = 'simulated_failure') as failed,
      COALESCE(AVG(handshake_time_ms), 0) as avg_handshake,
      COALESCE(AVG(total_time_ms), 0) as avg_total,
      COALESCE(COUNT(*) / NULLIF(EXTRACT(EPOCH FROM (MAX(timestamp) - MIN(timestamp))), 0), 0) as emails_per_second
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

export async function clearNullsinkCaptures(campaignId?: string): Promise<number> {
  if (campaignId) {
    const result = await db.delete(nullsinkCaptures).where(eq(nullsinkCaptures.campaignId, campaignId));
    return result.rowCount || 0;
  }
  const result = await db.delete(nullsinkCaptures);
  return result.rowCount || 0;
}

// ═══════════════════════════════════════════════════════════════
// DASHBOARD & ANALYTICS (campaign-scoped, no subscriber-repo dep)
// ═══════════════════════════════════════════════════════════════

export async function getDashboardStats() {
  const [
    subCountResult,
    [{ campaignCount }],
    [{ openCount }],
    [{ clickCount }],
    recentCampaigns,
    recentImports,
  ] = await Promise.all([
    db.execute(sql`SELECT COUNT(*) as count FROM subscribers`),
    db.select({ campaignCount: sql<number>`count(*)` }).from(campaigns),
    db.select({ openCount: sql<number>`count(*)` }).from(campaignStats).where(eq(campaignStats.type, "open")),
    db.select({ clickCount: sql<number>`count(*)` }).from(campaignStats).where(eq(campaignStats.type, "click")),
    db.select().from(campaigns).orderBy(desc(campaigns.createdAt)).limit(5),
    db.select().from(importJobs).orderBy(desc(importJobs.createdAt)).limit(5),
  ]);
  return {
    totalSubscribers: Number((subCountResult.rows[0] as any)?.count || 0),
    totalCampaigns: Number(campaignCount),
    totalOpens: Number(openCount),
    totalClicks: Number(clickCount),
    recentCampaigns,
    recentImports,
  };
}

export async function getOverallAnalytics() {
  const [
    [{ openCount }],
    [{ clickCount }],
    allCampaigns,
  ] = await Promise.all([
    db.select({ openCount: sql<number>`count(*)` }).from(campaignStats).where(eq(campaignStats.type, "open")),
    db.select({ clickCount: sql<number>`count(*)` }).from(campaignStats).where(eq(campaignStats.type, "click")),
    db.select().from(campaigns).where(eq(campaigns.status, "completed")).orderBy(desc(campaigns.completedAt)).limit(10),
  ]);

  const campaignMetrics = await mapWithConcurrency(allCampaigns, 3, async (campaign) => {
    const [uniqueOpens, uniqueClicks] = await Promise.all([
      getUniqueOpenCount(campaign.id),
      getUniqueClickCount(campaign.id),
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
    ? campaignMetrics.reduce((acc, c) => acc + c.openRate, 0) / campaignMetrics.length : 0;
  const avgClickRate = campaignMetrics.length > 0
    ? campaignMetrics.reduce((acc, c) => acc + c.clickRate, 0) / campaignMetrics.length : 0;

  return {
    totalOpens: Number(openCount),
    totalClicks: Number(clickCount),
    totalCampaigns: allCampaigns.length,
    avgOpenRate,
    avgClickRate,
    recentCampaigns: campaignMetrics,
  };
}
