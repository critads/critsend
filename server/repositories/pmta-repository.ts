/**
 * Repository for PMTA queue monitoring snapshots (Task #193).
 * Pure data access — collector logic lives in services/pmta-collector.ts.
 */
import { pmtaQueueSnapshots, type PmtaQueueSnapshot } from "@shared/schema";
import { db } from "../db";
import { sql } from "drizzle-orm";

export async function insertPmtaSnapshot(row: {
  domain: string;
  pendingCount: number;
  errorCount: number;
  status: string;
  errorMessage?: string | null;
  errorLines: string[];
  rawExcerpt?: string | null;
}): Promise<void> {
  await db.insert(pmtaQueueSnapshots).values({
    domain: row.domain,
    pendingCount: row.pendingCount,
    errorCount: row.errorCount,
    status: row.status,
    errorMessage: row.errorMessage ?? null,
    errorLines: row.errorLines as any,
    rawExcerpt: row.rawExcerpt ?? null,
  });
}

/**
 * Latest snapshot per domain. Uses a window function so one SQL call returns
 * the freshest row for every distinct domain.
 */
export async function getLatestPmtaSnapshots(): Promise<PmtaQueueSnapshot[]> {
  const result = await db.execute(sql`
    SELECT id, domain, captured_at, pending_count, error_count,
           status, error_message, error_lines, raw_excerpt
      FROM (
        SELECT *,
               ROW_NUMBER() OVER (PARTITION BY domain ORDER BY captured_at DESC) AS rn
          FROM pmta_queue_snapshots
      ) t
     WHERE rn = 1
     ORDER BY domain ASC
  `);
  // drizzle's execute returns rows with snake_case keys
  return (result.rows as any[]).map((r) => ({
    id: r.id,
    domain: r.domain,
    capturedAt: r.captured_at,
    pendingCount: Number(r.pending_count),
    errorCount: Number(r.error_count),
    status: r.status,
    errorMessage: r.error_message,
    errorLines: r.error_lines ?? [],
    rawExcerpt: r.raw_excerpt,
  })) as PmtaQueueSnapshot[];
}

/**
 * History for a single domain (most recent first). Used by the UI to render
 * a sparkline of pending count over the last N snapshots.
 */
export async function getPmtaSnapshotHistory(
  domain: string,
  limit: number = 50,
): Promise<PmtaQueueSnapshot[]> {
  const result = await db.execute(sql`
    SELECT id, domain, captured_at, pending_count, error_count,
           status, error_message, error_lines, raw_excerpt
      FROM pmta_queue_snapshots
     WHERE domain = ${domain}
     ORDER BY captured_at DESC
     LIMIT ${limit}
  `);
  return (result.rows as any[]).map((r) => ({
    id: r.id,
    domain: r.domain,
    capturedAt: r.captured_at,
    pendingCount: Number(r.pending_count),
    errorCount: Number(r.error_count),
    status: r.status,
    errorMessage: r.error_message,
    errorLines: r.error_lines ?? [],
    rawExcerpt: r.raw_excerpt,
  })) as PmtaQueueSnapshot[];
}
