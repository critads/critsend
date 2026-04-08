import {
  importJobs,
  importJobQueue,
  type ImportJob,
  type InsertImportJob,
  type ImportJobQueueItem,
  type ImportJobQueueStatus,
} from "@shared/schema";
import { db } from "../db";
import { eq, desc, and, or, sql } from "drizzle-orm";
import { logger } from "../logger";
import { importQueue } from "../queues";

const USE_BULLMQ = process.env.USE_BULLMQ === "true";

function mapQueueRow(row: any): ImportJobQueueItem {
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

// ═══════════════════════════════════════════════════════════════
// IMPORT JOB MANAGEMENT
// ═══════════════════════════════════════════════════════════════

export async function getImportJobs(): Promise<ImportJob[]> {
  return db.select().from(importJobs).orderBy(desc(importJobs.createdAt));
}

export async function getImportJob(id: string): Promise<ImportJob | undefined> {
  const [job] = await db.select().from(importJobs).where(eq(importJobs.id, id));
  return job;
}

export async function createImportJob(data: InsertImportJob): Promise<ImportJob> {
  const [job] = await db.insert(importJobs).values(data).returning();
  return job;
}

export async function updateImportJob(id: string, data: Partial<ImportJob>): Promise<ImportJob | undefined> {
  const [job] = await db.update(importJobs).set(data).where(eq(importJobs.id, id)).returning();
  return job;
}

// ═══════════════════════════════════════════════════════════════
// IMPORT JOB QUEUE
// ═══════════════════════════════════════════════════════════════

export async function enqueueImportJob(importJobId: string, csvFilePath: string, totalLines: number, fileSizeBytes: number = 0): Promise<ImportJobQueueItem> {
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
  if (USE_BULLMQ && importQueue) {
    await importQueue.add("import", { jobId: job.id, importJobId }, { jobId: `import-${job.id}` }).catch((err: any) =>
      logger.warn("[BullMQ] Failed to enqueue import job:", err.message)
    );
  }
  return job;
}

export async function claimNextImportJob(workerId: string): Promise<ImportJobQueueItem | null> {
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
  if (result.rows.length === 0) return null;
  return mapQueueRow(result.rows[0]);
}

export async function updateImportQueueProgress(queueId: string, processedLines: number): Promise<void> {
  await db.execute(sql`
    UPDATE import_job_queue SET processed_lines = ${processedLines}, heartbeat = NOW()
    WHERE id = ${queueId}
  `);
}

export async function updateImportQueueProgressWithCheckpoint(
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

export async function getImportQueueItem(queueId: string): Promise<ImportJobQueueItem | null> {
  const result = await db.execute(sql`SELECT * FROM import_job_queue WHERE id = ${queueId}`);
  if (result.rows.length === 0) return null;
  return mapQueueRow(result.rows[0]);
}

export async function updateImportQueueHeartbeat(queueId: string): Promise<void> {
  await db.execute(sql`UPDATE import_job_queue SET heartbeat = NOW() WHERE id = ${queueId}`);
}

export async function cancelImportJob(importJobId: string): Promise<boolean> {
  const queueResult = await db.execute(sql`
    UPDATE import_job_queue
    SET status = 'cancelled', completed_at = NOW(), error_message = 'Cancelled by user'
    WHERE import_job_id = ${importJobId} AND status IN ('pending', 'processing')
    RETURNING id
  `);
  const jobResult = await db.execute(sql`
    UPDATE import_jobs
    SET status = 'cancelled', error_message = 'Cancelled by user', completed_at = NOW()
    WHERE id = ${importJobId} AND status IN ('pending', 'processing')
    RETURNING id
  `);
  return queueResult.rows.length > 0 || jobResult.rows.length > 0;
}

export async function completeImportQueueJob(jobId: string, status: "completed" | "failed", errorMessage?: string): Promise<void> {
  await db.execute(sql`
    UPDATE import_job_queue
    SET status = ${status}, completed_at = NOW(), error_message = ${errorMessage || null}
    WHERE id = ${jobId} AND status != 'cancelled'
  `);
}

export async function getImportJobQueueStatus(importJobId: string): Promise<ImportJobQueueStatus | null> {
  const [result] = await db.select({ status: importJobQueue.status })
    .from(importJobQueue)
    .where(and(
      eq(importJobQueue.importJobId, importJobId),
      or(eq(importJobQueue.status, "pending"), eq(importJobQueue.status, "processing"))
    ))
    .orderBy(desc(importJobQueue.createdAt))
    .limit(1);
  return result ? (result.status as ImportJobQueueStatus) : null;
}

export async function cleanupStaleImportJobs(maxAgeMinutes: number = 30): Promise<number> {
  const result = await db.execute(sql`
    UPDATE import_job_queue
    SET status = 'failed', completed_at = NOW(), error_message = 'Job timed out - no heartbeat received'
    WHERE status = 'processing'
      AND (heartbeat IS NULL OR heartbeat < NOW() - INTERVAL '1 minute' * ${maxAgeMinutes})
    RETURNING id
  `);
  return result.rows.length;
}

export async function recoverStuckImportJobs(): Promise<number> {
  const failedResult = await db.execute(sql`
    UPDATE import_job_queue q
    SET status = 'failed', completed_at = NOW(),
        error_message = 'Import failed after multiple retries - possible memory issue. Try importing a smaller file or splitting the CSV.'
    WHERE q.status = 'processing'
      AND (q.heartbeat IS NULL OR q.heartbeat < NOW() - INTERVAL '10 minutes')
      AND q.retry_count >= 2
    RETURNING q.import_job_id
  `);
  for (const row of failedResult.rows as any[]) {
    await db.execute(sql`
      UPDATE import_jobs SET status = 'failed',
        error_message = 'Import failed after multiple retries - possible memory issue. Try importing a smaller file or splitting the CSV.',
        completed_at = NOW()
      WHERE id = ${row.import_job_id}
    `);
    logger.warn(`[IMPORT] Job ${row.import_job_id} permanently failed after exceeding retry limit`);
  }

  const queueResult = await db.execute(sql`
    UPDATE import_job_queue q
    SET status = 'pending', started_at = NULL, heartbeat = NULL, worker_id = NULL, retry_count = retry_count + 1
    WHERE q.status = 'processing'
      AND (q.heartbeat IS NULL OR q.heartbeat < NOW() - INTERVAL '10 minutes')
      AND q.retry_count < 2
      AND NOT EXISTS (
        SELECT 1 FROM import_jobs j WHERE j.id = q.import_job_id AND j.status = 'cancelled'
      )
    RETURNING q.import_job_id
  `);
  for (const row of queueResult.rows as any[]) {
    await db.execute(sql`
      UPDATE import_jobs SET status = 'pending'
      WHERE id = ${row.import_job_id} AND status = 'processing'
    `);
  }
  return queueResult.rows.length + failedResult.rows.length;
}

// ═══════════════════════════════════════════════════════════════
// SEGMENT IMPORT (REFS) OPERATIONS
// ═══════════════════════════════════════════════════════════════

export async function detectImportRefs(jobId: string): Promise<string[]> {
  const result = await db.execute(sql`
    SELECT DISTINCT unnest(refs) AS ref FROM import_staging WHERE job_id = ${jobId} ORDER BY ref
  `);
  return (result.rows as any[]).map(r => r.ref);
}

export async function countAffectedSubscribers(refs: string[]): Promise<number> {
  if (refs.length === 0) return 0;
  const result = await db.execute(sql`SELECT COUNT(*) AS count FROM subscribers WHERE refs && ${refs}::text[]`);
  return parseInt((result.rows as any[])[0]?.count || "0");
}

export async function countBckProtectedSubscribers(refs: string[]): Promise<number> {
  if (refs.length === 0) return 0;
  const result = await db.execute(sql`
    SELECT COUNT(*) AS count FROM subscribers WHERE refs && ${refs}::text[] AND 'BCK' = ANY(tags)
  `);
  return parseInt((result.rows as any[])[0]?.count || "0");
}

export async function cleanExistingRefs(refs: string[]): Promise<number> {
  if (refs.length === 0) return 0;
  const BATCH_SIZE = 50000;
  let totalCleaned = 0;
  while (true) {
    const result = await db.execute(sql`
      UPDATE subscribers
      SET refs = (SELECT COALESCE(array_agg(r), ARRAY[]::text[]) FROM unnest(refs) AS r WHERE r != ALL(${refs}::text[]))
      WHERE id IN (SELECT id FROM subscribers WHERE refs && ${refs}::text[] LIMIT ${BATCH_SIZE})
    `);
    const affected = (result as any).rowCount || 0;
    totalCleaned += affected;
    if (affected === 0) break;
    await new Promise(r => setTimeout(r, 20));
  }
  return totalCleaned;
}

export async function deleteSubscribersByRefs(refs: string[]): Promise<{ deleted: number; bckProtected: number }> {
  if (refs.length === 0) return { deleted: 0, bckProtected: 0 };
  const bckProtected = await countBckProtectedSubscribers(refs);
  const BATCH_SIZE = 50000;
  let totalDeleted = 0;
  while (true) {
    const result = await db.execute(sql`
      DELETE FROM subscribers WHERE id IN (
        SELECT id FROM subscribers WHERE refs && ${refs}::text[] AND NOT ('BCK' = ANY(tags)) LIMIT ${BATCH_SIZE}
      )
    `);
    const affected = (result as any).rowCount || 0;
    totalDeleted += affected;
    if (affected === 0) break;
    await new Promise(r => setTimeout(r, 20));
  }
  return { deleted: totalDeleted, bckProtected };
}

export async function confirmImportJob(jobId: string, cleanExistingRefs: boolean, deleteExistingRefs?: boolean): Promise<ImportJob | undefined> {
  const [job] = await db.update(importJobs)
    .set({ cleanExistingRefs, deleteExistingRefs: deleteExistingRefs || false, status: "processing" })
    .where(and(eq(importJobs.id, jobId), eq(importJobs.status, "awaiting_confirmation")))
    .returning();
  return job;
}

export async function expireAbandonedImports(): Promise<number> {
  const result = await db.execute(sql`
    UPDATE import_jobs
    SET status = 'failed', error_message = 'Confirmation timeout (2h)', completed_at = NOW()
    WHERE status = 'awaiting_confirmation' AND created_at < NOW() - INTERVAL '2 hours'
    RETURNING id
  `);
  const expiredIds = (result.rows as any[]).map(r => r.id);
  for (const id of expiredIds) {
    await db.execute(sql`DELETE FROM import_staging WHERE job_id = ${id}`);
    logger.info(`[IMPORT] Expired abandoned import ${id} and cleaned staging data`);
  }
  return expiredIds.length;
}
