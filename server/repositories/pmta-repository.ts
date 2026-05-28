/**
 * Repository for PMTA queue monitoring snapshots (Task #193).
 * Pure data access — collector logic lives in services/pmta-collector.ts.
 */
import { pmtaQueueSnapshots, pmtaServers, type PmtaQueueSnapshot, type PmtaServer } from "@shared/schema";
import { db } from "../db";
import { sql, eq, and } from "drizzle-orm";

export async function insertPmtaSnapshot(row: {
  serverId: string | null;
  domain: string;
  pendingCount: number;
  errorCount: number;
  status: string;
  errorMessage?: string | null;
  errorLines: string[];
  rawExcerpt?: string | null;
}): Promise<void> {
  await db.insert(pmtaQueueSnapshots).values({
    serverId: row.serverId,
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
 * Idempotently upsert a PMTA server row keyed on (host, port). Returns the
 * server id. v1 uses this once at collector startup to seed exactly one row
 * from PMTA_SSH_* env values so future multi-server support is a pure
 * additive change (no migration needed on snapshots — they already carry
 * `server_id`).
 */
export async function upsertPmtaServer(s: {
  host: string;
  port: number;
  username: string;
  sshKeySecretRef?: string;
}): Promise<string> {
  const existing = await db
    .select({ id: pmtaServers.id })
    .from(pmtaServers)
    .where(and(eq(pmtaServers.host, s.host), eq(pmtaServers.port, s.port)))
    .limit(1);
  if (existing.length > 0) {
    await db
      .update(pmtaServers)
      .set({
        username: s.username,
        sshKeySecretRef: s.sshKeySecretRef ?? "PMTA_SSH_PRIVATE_KEY",
        enabled: true,
      })
      .where(eq(pmtaServers.id, existing[0].id));
    return existing[0].id;
  }
  const [row] = await db
    .insert(pmtaServers)
    .values({
      host: s.host,
      port: s.port,
      username: s.username,
      sshKeySecretRef: s.sshKeySecretRef ?? "PMTA_SSH_PRIVATE_KEY",
      enabled: true,
    })
    .returning({ id: pmtaServers.id });
  return row.id;
}

/**
 * Cross-domain "Queues with delivery errors" feed — the latest snapshot per
 * domain, filtered to those whose latest tick captured at least one matched
 * error line. Used by the dedicated errors section on the PMTA page.
 */
export async function getPmtaErrorQueues(): Promise<PmtaQueueSnapshot[]> {
  const all = await getLatestPmtaSnapshots();
  return all.filter((s) => (s.errorCount ?? 0) > 0 || s.status !== "ok");
}

/**
 * Latest snapshot per domain. Uses a window function so one SQL call returns
 * the freshest row for every distinct domain.
 */
export async function getLatestPmtaSnapshots(): Promise<PmtaQueueSnapshot[]> {
  const result = await db.execute(sql`
    SELECT id, server_id, domain, captured_at, pending_count, error_count,
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
    serverId: r.server_id ?? null,
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
    SELECT id, server_id, domain, captured_at, pending_count, error_count,
           status, error_message, error_lines, raw_excerpt
      FROM pmta_queue_snapshots
     WHERE domain = ${domain}
     ORDER BY captured_at DESC
     LIMIT ${limit}
  `);
  return (result.rows as any[]).map((r) => ({
    id: r.id,
    serverId: r.server_id ?? null,
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
