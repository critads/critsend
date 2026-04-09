import {
  campaignJobs,
  campaignSends,
  flushJobs,
  errorLogs,
  subscribers,
  type CampaignJob,
  type CampaignJobStatus,
  type FlushJob,
  type ErrorLog,
  type InsertErrorLog,
} from "@shared/schema";
import { db, pool } from "../db";
import { eq, and, or, desc, sql } from "drizzle-orm";
import { logger } from "../logger";
import { campaignQueue, flushQueue } from "../queues";

const USE_BULLMQ = process.env.USE_BULLMQ === "true";

function mapJobRow(row: any): CampaignJob {
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

// ═══════════════════════════════════════════════════════════════
// CAMPAIGN JOB QUEUE
// ═══════════════════════════════════════════════════════════════

export async function enqueueCampaignJob(campaignId: string): Promise<CampaignJob> {
  const existing = await db.execute(sql`
    SELECT id FROM campaign_jobs WHERE campaign_id = ${campaignId} AND status IN ('pending', 'processing') LIMIT 1
  `);
  if (existing.rows.length > 0) {
    const row = existing.rows[0] as any;
    const existingJob = await db.select().from(campaignJobs).where(eq(campaignJobs.id, row.id)).limit(1);
    if (USE_BULLMQ && campaignQueue) {
      await campaignQueue.add("campaign", { campaignId }, { jobId: `campaign-${campaignId}` }).catch((err: any) =>
        logger.warn("[BullMQ] Failed to re-enqueue existing campaign job:", err.message)
      );
    }
    return existingJob[0];
  }
  const [job] = await db.insert(campaignJobs).values({ campaignId, status: "pending" }).returning();
  if (USE_BULLMQ && campaignQueue) {
    await campaignQueue.add("campaign", { campaignId, pgJobId: job.id }, { jobId: `campaign-${campaignId}` }).catch((err: any) =>
      logger.warn("[BullMQ] Failed to enqueue campaign job:", err.message)
    );
  }
  return job;
}

export async function enqueueCampaignJobWithRetry(campaignId: string, retryCount: number, delaySeconds: number): Promise<any> {
  const existing = await db.execute(sql`
    SELECT id FROM campaign_jobs WHERE campaign_id = ${campaignId} AND status IN ('pending', 'processing') LIMIT 1
  `);
  if (existing.rows.length > 0) {
    const row = existing.rows[0] as any;
    return { id: row.id, campaignId, status: 'pending', retryCount, nextRetryAt: null, createdAt: new Date(), startedAt: null, completedAt: null, workerId: null, errorMessage: null };
  }
  const result = await db.execute(sql`
    INSERT INTO campaign_jobs (id, campaign_id, status, retry_count, next_retry_at, created_at)
    VALUES (gen_random_uuid(), ${campaignId}, 'pending', ${retryCount}, NOW() + INTERVAL '1 second' * ${delaySeconds}, NOW())
    RETURNING *
  `);
  return mapJobRow(result.rows[0]);
}

export async function claimNextJob(workerId: string): Promise<CampaignJob | null> {
  const result = await db.execute(sql`
    UPDATE campaign_jobs
    SET status = 'processing', started_at = NOW(), worker_id = ${workerId}
    WHERE id = (
      SELECT id FROM campaign_jobs
      WHERE status = 'pending' AND (next_retry_at IS NULL OR next_retry_at <= NOW())
      ORDER BY created_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING *
  `);
  if (result.rows.length === 0) return null;
  return mapJobRow(result.rows[0]);
}

export async function completeJob(jobId: string, status: "completed" | "failed", errorMessage?: string): Promise<void> {
  await db.update(campaignJobs)
    .set({ status, completedAt: new Date(), errorMessage: errorMessage || null })
    .where(eq(campaignJobs.id, jobId));
}

export async function clearStuckJobsForCampaign(campaignId: string): Promise<number> {
  const result = await db.update(campaignJobs)
    .set({ status: "failed", completedAt: new Date(), errorMessage: "Cancelled for campaign resume" })
    .where(and(
      eq(campaignJobs.campaignId, campaignId),
      or(eq(campaignJobs.status, "pending"), eq(campaignJobs.status, "processing"))
    ));
  return (result as any).rowCount || 0;
}

export async function getJobStatus(campaignId: string): Promise<CampaignJobStatus | null> {
  const [result] = await db.select({ status: campaignJobs.status })
    .from(campaignJobs)
    .where(and(
      eq(campaignJobs.campaignId, campaignId),
      or(eq(campaignJobs.status, "pending"), eq(campaignJobs.status, "processing"))
    ))
    .orderBy(desc(campaignJobs.createdAt))
    .limit(1);
  return result ? (result.status as CampaignJobStatus) : null;
}

export async function getActiveJobs(): Promise<CampaignJob[]> {
  return db.select().from(campaignJobs)
    .where(or(eq(campaignJobs.status, "pending"), eq(campaignJobs.status, "processing")))
    .orderBy(campaignJobs.createdAt);
}

export async function cleanupStaleJobs(maxAgeMinutes: number = 30): Promise<number> {
  const result = await db.execute(sql`
    UPDATE campaign_jobs
    SET status = 'failed', completed_at = NOW(), error_message = 'Job timed out - worker may have crashed'
    WHERE status = 'processing' AND started_at < NOW() - INTERVAL '1 minute' * ${maxAgeMinutes}
    RETURNING id
  `);
  return result.rows.length;
}

export async function getFailedSendsForRetry(campaignId: string, limit: number): Promise<Array<{subscriberId: string, email: string, retryCount: number}>> {
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

export async function markSendForRetry(campaignId: string, subscriberId: string): Promise<void> {
  await db.execute(sql`
    UPDATE campaign_sends SET status = 'pending', retry_count = retry_count + 1, last_retry_at = NOW()
    WHERE campaign_id = ${campaignId} AND subscriber_id = ${subscriberId} AND status = 'failed'
  `);
  await db.execute(sql`
    UPDATE campaigns SET failed_count = failed_count - 1, pending_count = pending_count + 1 WHERE id = ${campaignId}
  `);
}

export async function bulkMarkSendsForRetry(campaignId: string, subscriberIds: string[]): Promise<number> {
  if (subscriberIds.length === 0) return 0;
  const arrayStr = `{${subscriberIds.map(id => `"${id}"`).join(',')}}`;
  const result = await db.execute(sql`
    UPDATE campaign_sends
    SET status = 'pending', retry_count = retry_count + 1, last_retry_at = NOW()
    WHERE campaign_id = ${campaignId}
      AND subscriber_id = ANY(${arrayStr}::text[])
      AND status = 'failed'
    RETURNING id
  `);
  const matchCount = result.rows.length;
  if (matchCount > 0) {
    await db.execute(sql`
      UPDATE campaigns SET failed_count = failed_count - ${matchCount}, pending_count = pending_count + ${matchCount}
      WHERE id = ${campaignId}
    `);
  }
  return matchCount;
}

// ═══════════════════════════════════════════════════════════════
// FLUSH JOBS
// ═══════════════════════════════════════════════════════════════

export async function createFlushJob(totalRows: number): Promise<FlushJob> {
  const result = await db.insert(flushJobs).values({ totalRows, status: "pending" }).returning();
  const job = result[0];
  if (USE_BULLMQ && flushQueue) {
    await flushQueue.add("flush", { jobId: job.id, totalRows }, { jobId: `flush-${job.id}` }).catch((err: any) =>
      logger.warn("[BullMQ] Failed to enqueue flush job:", err.message)
    );
  } else {
    await db.execute(sql`NOTIFY flush_jobs`);
  }
  return job;
}

export async function getFlushJob(id: string): Promise<FlushJob | undefined> {
  const result = await db.select().from(flushJobs).where(eq(flushJobs.id, id));
  return result[0];
}

export async function claimFlushJob(workerId: string): Promise<FlushJob | null> {
  const result = await db.execute(sql`
    UPDATE flush_jobs
    SET status = 'processing', started_at = NOW(), heartbeat = NOW(), worker_id = ${workerId}
    WHERE id = (
      SELECT id FROM flush_jobs WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED
    )
    RETURNING *
  `);
  if (result.rows.length === 0) return null;
  const row = result.rows[0] as any;
  return {
    id: row.id, totalRows: row.total_rows, processedRows: row.processed_rows, status: row.status,
    createdAt: row.created_at, startedAt: row.started_at, completedAt: row.completed_at,
    heartbeat: row.heartbeat, workerId: row.worker_id, errorMessage: row.error_message,
  };
}

export async function updateFlushJobProgress(jobId: string, processedRows: number): Promise<void> {
  await db.update(flushJobs).set({ processedRows, heartbeat: new Date() }).where(eq(flushJobs.id, jobId));
}

export async function updateFlushJobTotalRows(jobId: string, totalRows: number): Promise<void> {
  await db.update(flushJobs).set({ totalRows }).where(eq(flushJobs.id, jobId));
}

export async function completeFlushJob(jobId: string, status: "completed" | "failed" | "cancelled", errorMessage?: string, processedRows?: number): Promise<void> {
  const updates: any = { status, completedAt: new Date(), errorMessage: errorMessage || null };
  if (processedRows !== undefined) updates.processedRows = processedRows;
  await db.update(flushJobs).set(updates).where(eq(flushJobs.id, jobId));
}

export async function cancelFlushJob(jobId: string): Promise<boolean> {
  const result = await db.update(flushJobs)
    .set({ status: "cancelled", completedAt: new Date(), errorMessage: "Cancelled by user" })
    .where(and(eq(flushJobs.id, jobId), or(eq(flushJobs.status, "pending"), eq(flushJobs.status, "processing"))))
    .returning();
  return result.length > 0;
}

export async function countSubscriberDependencies(): Promise<number> {
  const result = await db.execute(sql`
    SELECT
      (SELECT COUNT(*)::int FROM campaign_sends) +
      (SELECT COUNT(*)::int FROM campaign_stats) +
      (SELECT COUNT(*)::int FROM error_logs WHERE subscriber_id IS NOT NULL) +
      (SELECT COUNT(*)::int FROM nullsink_captures) +
      (SELECT COUNT(*)::int FROM pending_tag_operations) +
      (SELECT COUNT(*)::int FROM automation_enrollments) AS total
  `);
  return parseInt(result.rows[0]?.total as string || "0", 10);
}

export async function clearSubscriberDependencies(onProgress?: (deletedInBatch: number) => void): Promise<number> {
  const batchSize = 10000;
  let deleted: number;
  let totalDeleted = 0;

  // campaign_sends and campaign_stats cascade automatically when subscribers are truncated
  const tables = [
    { query: sql`DELETE FROM error_logs WHERE subscriber_id IS NOT NULL AND ctid IN (SELECT ctid FROM error_logs WHERE subscriber_id IS NOT NULL LIMIT ${batchSize})` },
    { query: sql`DELETE FROM nullsink_captures WHERE ctid IN (SELECT ctid FROM nullsink_captures LIMIT ${batchSize})` },
    { query: sql`DELETE FROM pending_tag_operations WHERE ctid IN (SELECT ctid FROM pending_tag_operations LIMIT ${batchSize})` },
    { query: sql`DELETE FROM automation_enrollments WHERE ctid IN (SELECT ctid FROM automation_enrollments LIMIT ${batchSize})` },
  ];

  for (const table of tables) {
    do {
      const r = await db.execute(table.query);
      deleted = (r.rowCount as number) || 0;
      if (deleted > 0) {
        totalDeleted += deleted;
        onProgress?.(deleted);
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    } while (deleted > 0);
  }
  return totalDeleted;
}

export async function truncateSubscribers(): Promise<void> {
  await db.execute(sql`TRUNCATE subscribers CASCADE`);
}

export async function deleteSubscriberBatch(batchSize: number): Promise<number> {
  const result = await db.execute(sql`
    DELETE FROM subscribers WHERE id IN (SELECT id FROM subscribers LIMIT ${batchSize})
  `);
  return (result.rowCount as number) || 0;
}

export async function deleteSubscriberBatchByCtid(batchSize: number): Promise<number> {
  const result = await db.execute(sql`
    DELETE FROM subscribers WHERE ctid IN (SELECT ctid FROM subscribers LIMIT ${batchSize})
  `);
  return (result.rowCount as number) || 0;
}

export async function countAllSubscribers(): Promise<number> {
  const result = await db.execute(sql`SELECT COUNT(*) as count FROM subscribers`);
  return parseInt(result.rows[0]?.count as string || "0", 10);
}

// ═══════════════════════════════════════════════════════════════
// ERROR LOGGING
// ═══════════════════════════════════════════════════════════════

export async function logError(data: InsertErrorLog): Promise<ErrorLog> {
  const [log] = await db.insert(errorLogs).values(data).returning();
  return log;
}

export async function getErrorLogs(options?: {
  page?: number; limit?: number; type?: string; severity?: string; campaignId?: string; importJobId?: string;
}): Promise<{ logs: ErrorLog[]; total: number }> {
  const page = options?.page || 1;
  const limit = options?.limit || 50;
  const offset = (page - 1) * limit;

  const conditions = [];
  if (options?.type) conditions.push(eq(errorLogs.type, options.type));
  if (options?.severity) conditions.push(eq(errorLogs.severity, options.severity));
  if (options?.campaignId) conditions.push(eq(errorLogs.campaignId, options.campaignId));
  if (options?.importJobId) conditions.push(eq(errorLogs.importJobId, options.importJobId));

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

export async function getErrorLogStats(): Promise<{ total: number; byType: Record<string, number>; bySeverity: Record<string, number>; last24Hours: number }> {
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [[{ total }], typeStats, severityStats, [{ last24Hours }]] = await Promise.all([
    db.select({ total: sql<number>`count(*)` }).from(errorLogs),
    db.select({ type: errorLogs.type, count: sql<number>`count(*)` }).from(errorLogs).groupBy(errorLogs.type),
    db.select({ severity: errorLogs.severity, count: sql<number>`count(*)` }).from(errorLogs).groupBy(errorLogs.severity),
    db.select({ last24Hours: sql<number>`count(*)` }).from(errorLogs).where(sql`${errorLogs.timestamp} > ${yesterday}`),
  ]);
  const byType: Record<string, number> = {};
  for (const s of typeStats) byType[s.type] = Number(s.count);
  const bySeverity: Record<string, number> = {};
  for (const s of severityStats) bySeverity[s.severity] = Number(s.count);
  return { total: Number(total), byType, bySeverity, last24Hours: Number(last24Hours) };
}

export async function clearErrorLogs(beforeDate?: Date): Promise<number> {
  if (beforeDate) {
    const result = await db.delete(errorLogs).where(sql`${errorLogs.timestamp} < ${beforeDate}`);
    return result.rowCount || 0;
  }
  const result = await db.delete(errorLogs);
  return result.rowCount || 0;
}
