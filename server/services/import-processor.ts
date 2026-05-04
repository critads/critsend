import * as readline from "readline";
import * as fs from "fs";
import { from as copyFrom } from "pg-copy-streams";
import { sql } from "drizzle-orm";
import { importPool as pool, importDb as db } from "../import-pool";
import { logger } from "../logger";
import { storage } from "../storage";
import { jobEvents, JobProgressEvent } from "../job-events";
import { ObjectStorageService } from "../replit_integrations/object_storage/objectStorage";
import { IMPORT_CONCURRENCY } from "../connection-budget";

const objectStorageService = new ObjectStorageService();

const CONCURRENCY = IMPORT_CONCURRENCY;

// ─── Pure helpers ─────────────────────────────────────────────────────────────

function escapeCopyValue(val: string): string {
  return val.replace(/\\/g, "\\\\").replace(/\t/g, "\\t").replace(/\n/g, "\\n").replace(/\r/g, "\\r");
}

function formatPgArray(arr: string[]): string {
  if (arr.length === 0) return "{}";
  const escaped = arr.map(t => {
    let s = t.replace(/[\t\n\r]/g, " ").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    if (s.includes(",") || s.includes("{") || s.includes("}") || s.includes(" ") || s.includes('"')) {
      return '"' + s + '"';
    }
    return s;
  });
  return "{" + escaped.join(",") + "}";
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

// ─── DB helpers (use shared pool directly for COPY operations) ────────────────

async function hasActiveSendingCampaigns(): Promise<boolean> {
  const result = await pool.query(`SELECT COUNT(*) AS count FROM campaigns WHERE status = 'sending'`);
  return parseInt(result.rows[0]?.count || "0", 10) > 0;
}

async function safeDropGinIndexes(importJobId: string): Promise<boolean> {
  const activeSends = await hasActiveSendingCampaigns();
  if (activeSends) {
    logger.warn(`[IMPORT] ${importJobId}: Skipping GIN index drop — active campaign sends detected. Import will proceed without index optimization.`);
    return false;
  }
  logger.info(`[IMPORT] ${importJobId}: Dropping GIN indexes for large import optimization (no active sends)`);
  await db.execute(sql`DROP INDEX IF EXISTS tags_gin_idx`);
  await db.execute(sql`DROP INDEX IF EXISTS refs_gin_idx`);
  logger.info(`[IMPORT] ${importJobId}: GIN indexes dropped`);
  return true;
}

async function copyBatchUpsert(
  rows: Array<{ email: string; tags: string[]; refs: string[]; ipAddress: string | null }>,
  tagMode: "merge" | "override"
): Promise<{ inserted: number; updated: number }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`
      CREATE TEMP TABLE import_staging_batch (
        email TEXT NOT NULL, tags TEXT[] NOT NULL, refs TEXT[] NOT NULL, ip_address TEXT
      ) ON COMMIT DROP
    `);

    const copyStream = client.query(copyFrom(
      "COPY import_staging_batch (email, tags, refs, ip_address) FROM STDIN WITH (FORMAT text)"
    ));

    for (const row of rows) {
      const email = escapeCopyValue(row.email);
      const tagsLiteral = formatPgArray(row.tags);
      const refsLiteral = formatPgArray(row.refs);
      const ip = row.ipAddress ? escapeCopyValue(row.ipAddress) : "\\N";
      copyStream.write(`${email}\t${tagsLiteral}\t${refsLiteral}\t${ip}\n`);
    }

    await new Promise<void>((resolve, reject) => {
      copyStream.on("finish", resolve);
      copyStream.on("error", reject);
      copyStream.end();
    });

    const tagsConflict = tagMode === "override"
      ? `tags = EXCLUDED.tags`
      : `tags = COALESCE((SELECT array_agg(DISTINCT t) FROM unnest(subscribers.tags || EXCLUDED.tags) AS t WHERE t IS NOT NULL), ARRAY[]::text[])`;

    const refsConflict = `refs = COALESCE((SELECT array_agg(DISTINCT r) FROM unnest(subscribers.refs || EXCLUDED.refs) AS r WHERE r IS NOT NULL), ARRAY[]::text[])`;

    const existingResult = await client.query(`SELECT COUNT(DISTINCT s.email) AS cnt FROM subscribers s INNER JOIN import_staging_batch b ON s.email = b.email`);
    const preExisting = parseInt(existingResult.rows[0]?.cnt || "0");

    const mergeResult = await client.query(`
      INSERT INTO subscribers (email, tags, refs, ip_address, import_date)
      SELECT email, tags, refs, ip_address, NOW() FROM import_staging_batch
      ON CONFLICT (email) DO UPDATE SET
        ${tagsConflict},
        ${refsConflict},
        ip_address = COALESCE(EXCLUDED.ip_address, subscribers.ip_address)
    `);
    const totalProcessed = mergeResult.rowCount || 0;
    await client.query("COMMIT");
    return { inserted: Math.max(totalProcessed - preExisting, 0), updated: Math.min(preExisting, totalProcessed) };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function directBatchUpsert(
  rows: Array<{ email: string; tags: string[]; refs: string[]; ipAddress: string | null }>,
  tagMode: "merge" | "override"
): Promise<{ inserted: number; updated: number }> {
  const valuesClauses: string[] = [];
  const params: any[] = [];
  let paramIdx = 1;

  for (const row of rows) {
    valuesClauses.push(`($${paramIdx}, $${paramIdx + 1}::text[], $${paramIdx + 2}::text[], $${paramIdx + 3}, NOW())`);
    params.push(row.email.toLowerCase(), row.tags, row.refs, row.ipAddress);
    paramIdx += 4;
  }

  const tagsConflict = tagMode === "override"
    ? `tags = EXCLUDED.tags`
    : `tags = COALESCE((SELECT array_agg(DISTINCT t) FROM unnest(subscribers.tags || EXCLUDED.tags) AS t WHERE t IS NOT NULL), ARRAY[]::text[])`;
  const refsConflict = `refs = COALESCE((SELECT array_agg(DISTINCT r) FROM unnest(subscribers.refs || EXCLUDED.refs) AS r WHERE r IS NOT NULL), ARRAY[]::text[])`;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const emails = rows.map(r => r.email.toLowerCase());
    const existingResult = await client.query(`SELECT COUNT(*) AS cnt FROM subscribers WHERE email = ANY($1)`, [emails]);
    const preExisting = parseInt(existingResult.rows[0]?.cnt || "0");
    const result = await client.query(
      `INSERT INTO subscribers (email, tags, refs, ip_address, import_date) VALUES ${valuesClauses.join(", ")} ON CONFLICT (email) DO UPDATE SET ${tagsConflict}, ${refsConflict}, ip_address = COALESCE(EXCLUDED.ip_address, subscribers.ip_address)`,
      params
    );
    const totalProcessed = result.rowCount || 0;
    await client.query("COMMIT");
    return { inserted: Math.max(totalProcessed - preExisting, 0), updated: Math.min(preExisting, totalProcessed) };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function singleUpsert(
  row: { email: string; tags: string[]; refs: string[]; ipAddress: string | null },
  tagMode: "merge" | "override"
): Promise<"inserted" | "updated"> {
  const tagsConflict = tagMode === "override"
    ? `tags = EXCLUDED.tags`
    : `tags = COALESCE((SELECT array_agg(DISTINCT t) FROM unnest(subscribers.tags || EXCLUDED.tags) AS t WHERE t IS NOT NULL), ARRAY[]::text[])`;
  const refsConflict = `refs = COALESCE((SELECT array_agg(DISTINCT r) FROM unnest(subscribers.refs || EXCLUDED.refs) AS r WHERE r IS NOT NULL), ARRAY[]::text[])`;

  const existsResult = await pool.query(`SELECT 1 FROM subscribers WHERE email = $1 LIMIT 1`, [row.email.toLowerCase()]);
  const existed = (existsResult.rowCount || 0) > 0;
  await pool.query(
    `INSERT INTO subscribers (email, tags, refs, ip_address, import_date) VALUES ($1, $2::text[], $3::text[], $4, NOW()) ON CONFLICT (email) DO UPDATE SET ${tagsConflict}, ${refsConflict}, ip_address = COALESCE(EXCLUDED.ip_address, subscribers.ip_address)`,
    [row.email.toLowerCase(), row.tags, row.refs, row.ipAddress]
  );
  return existed ? "updated" : "inserted";
}

async function insertFallbackUpsert(
  rows: Array<{ email: string; tags: string[]; refs: string[]; ipAddress: string | null; lineNumber: number }>,
  tagMode: "merge" | "override" = "merge"
): Promise<{ inserted: number; updated: number; failed: number }> {
  if (rows.length === 0) return { inserted: 0, updated: 0, failed: 0 };
  const CHUNK_SIZE = 500;
  let totalInserted = 0, totalUpdated = 0, totalFailed = 0;

  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    const chunk = rows.slice(i, i + CHUNK_SIZE);
    try {
      const result = await directBatchUpsert(chunk, tagMode);
      totalInserted += result.inserted;
      totalUpdated += result.updated;
    } catch (err: any) {
      logger.error(`[IMPORT] Batch upsert chunk failed: ${err.message}`);
      for (const row of chunk) {
        try {
          const result = await singleUpsert(row, tagMode);
          if (result === "inserted") totalInserted++;
          else totalUpdated++;
        } catch (individualErr: any) {
          totalFailed++;
          logger.error(`[IMPORT] Individual insert failed for ${row.email}: ${individualErr.message}`);
        }
      }
    }
  }
  return { inserted: totalInserted, updated: totalUpdated, failed: totalFailed };
}

async function bulkUpsertSubscribers(
  rows: Array<{ email: string; tags: string[]; refs: string[]; ipAddress: string | null; lineNumber: number }>,
  tagMode: "merge" | "override" = "merge"
): Promise<{ inserted: number; updated: number; failed: number }> {
  if (rows.length === 0) return { inserted: 0, updated: 0, failed: 0 };
  try {
    const result = await copyBatchUpsert(rows, tagMode);
    return { ...result, failed: 0 };
  } catch (err: any) {
    logger.warn(`[IMPORT] COPY batch failed, falling back to INSERT: ${err.message}`);
    return await insertFallbackUpsert(rows, tagMode);
  }
}

async function directBatchRemoveTagsRefs(
  rows: Array<{ email: string; tags: string[]; refs: string[]; ipAddress: string | null }>,
): Promise<{ inserted: number; updated: number }> {
  if (rows.length === 0) return { inserted: 0, updated: 0 };
  const emails = rows.map(r => r.email.toLowerCase());
  const emailToTags = new Map<string, string[]>();
  const emailToRefs = new Map<string, string[]>();
  for (const row of rows) {
    const e = row.email.toLowerCase();
    const existingTags = emailToTags.get(e) || [];
    const existingRefs = emailToRefs.get(e) || [];
    emailToTags.set(e, [...new Set([...existingTags, ...row.tags])]);
    emailToRefs.set(e, [...new Set([...existingRefs, ...row.refs])]);
  }
  const uniqueEmails = [...emailToTags.keys()];

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`
      CREATE TEMP TABLE remove_staging (
        email TEXT NOT NULL, tags_to_remove TEXT[] NOT NULL, refs_to_remove TEXT[] NOT NULL
      ) ON COMMIT DROP
    `);
    const valuesClauses: string[] = [];
    const params: any[] = [];
    let paramIdx = 1;
    for (const email of uniqueEmails) {
      valuesClauses.push(`($${paramIdx}, $${paramIdx + 1}::text[], $${paramIdx + 2}::text[])`);
      params.push(email, emailToTags.get(email) || [], emailToRefs.get(email) || []);
      paramIdx += 3;
    }
    await client.query(
      `INSERT INTO remove_staging (email, tags_to_remove, refs_to_remove) VALUES ${valuesClauses.join(", ")}`,
      params
    );
    const result = await client.query(`
      UPDATE subscribers s
      SET
        tags = (
          SELECT COALESCE(array_agg(t), ARRAY[]::text[])
          FROM unnest(s.tags) AS t
          WHERE t != ALL(r.tags_to_remove)
        ),
        refs = (
          SELECT COALESCE(array_agg(rf), ARRAY[]::text[])
          FROM unnest(s.refs) AS rf
          WHERE rf != ALL(r.refs_to_remove)
        )
      FROM remove_staging r
      WHERE s.email = r.email
        AND (s.tags && r.tags_to_remove OR s.refs && r.refs_to_remove)
    `);
    const updated = result.rowCount || 0;
    await client.query("COMMIT");
    return { inserted: 0, updated };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function singleRemoveTagsRefs(
  row: { email: string; tags: string[]; refs: string[]; ipAddress: string | null },
): Promise<"updated" | "skipped"> {
  if (row.tags.length === 0 && row.refs.length === 0) return "skipped";
  const result = await pool.query(`
    UPDATE subscribers
    SET
      tags = (
        SELECT COALESCE(array_agg(t), ARRAY[]::text[])
        FROM unnest(tags) AS t
        WHERE t != ALL($2::text[])
      ),
      refs = (
        SELECT COALESCE(array_agg(r), ARRAY[]::text[])
        FROM unnest(refs) AS r
        WHERE r != ALL($3::text[])
      )
    WHERE email = $1
      AND (tags && $2::text[] OR refs && $3::text[])
  `, [row.email.toLowerCase(), row.tags, row.refs]);
  return (result.rowCount || 0) > 0 ? "updated" : "skipped";
}

async function bulkRemoveTagsRefs(
  rows: Array<{ email: string; tags: string[]; refs: string[]; ipAddress: string | null; lineNumber: number }>,
): Promise<{ inserted: number; updated: number; failed: number }> {
  if (rows.length === 0) return { inserted: 0, updated: 0, failed: 0 };
  const CHUNK_SIZE = 500;
  let totalUpdated = 0;
  let totalFailed = 0;

  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    const chunk = rows.slice(i, i + CHUNK_SIZE);
    try {
      const result = await directBatchRemoveTagsRefs(chunk);
      totalUpdated += result.updated;
    } catch (err: any) {
      logger.warn(`[IMPORT] Remove batch chunk failed, falling back to single: ${err.message}`);
      for (const row of chunk) {
        try {
          const result = await singleRemoveTagsRefs(row);
          if (result === "updated") totalUpdated++;
        } catch (individualErr: any) {
          totalFailed++;
          logger.error(`[IMPORT] Individual remove failed for ${row.email}: ${individualErr.message}`);
        }
      }
    }
  }
  return { inserted: 0, updated: totalUpdated, failed: totalFailed };
}

async function copyBatchUpsertRefs(
  rows: Array<{ email: string; refs: string[]; ipAddress: string | null }>,
): Promise<{ inserted: number; updated: number }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`
      CREATE TEMP TABLE import_staging_batch (email TEXT NOT NULL, refs TEXT[] NOT NULL, ip_address TEXT) ON COMMIT DROP
    `);

    const copyStream = client.query(copyFrom(
      "COPY import_staging_batch (email, refs, ip_address) FROM STDIN WITH (FORMAT text)"
    ));

    for (const row of rows) {
      const email = escapeCopyValue(row.email);
      const refsLiteral = formatPgArray(row.refs);
      const ip = row.ipAddress ? escapeCopyValue(row.ipAddress) : "\\N";
      copyStream.write(`${email}\t${refsLiteral}\t${ip}\n`);
    }

    await new Promise<void>((resolve, reject) => {
      copyStream.on("finish", resolve);
      copyStream.on("error", reject);
      copyStream.end();
    });

    const existingResult = await client.query(`SELECT COUNT(DISTINCT s.email) AS cnt FROM subscribers s INNER JOIN import_staging_batch b ON s.email = b.email`);
    const preExisting = parseInt(existingResult.rows[0]?.cnt || "0");

    const mergeResult = await client.query(`
      INSERT INTO subscribers (email, refs, ip_address, import_date)
      SELECT email, refs, ip_address, NOW() FROM import_staging_batch
      ON CONFLICT (email) DO UPDATE SET
        refs = (SELECT COALESCE(array_agg(DISTINCT r), ARRAY[]::text[]) FROM unnest(subscribers.refs || EXCLUDED.refs) AS r WHERE r IS NOT NULL),
        ip_address = COALESCE(EXCLUDED.ip_address, subscribers.ip_address),
        import_date = NOW()
    `);
    const totalProcessed = mergeResult.rowCount || 0;
    await client.query("COMMIT");
    return { inserted: Math.max(totalProcessed - preExisting, 0), updated: Math.min(preExisting, totalProcessed) };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function directBatchUpsertRefs(
  rows: Array<{ email: string; refs: string[]; ipAddress: string | null }>,
): Promise<{ inserted: number; updated: number }> {
  const valuesClauses: string[] = [];
  const params: any[] = [];
  let paramIdx = 1;

  for (const row of rows) {
    valuesClauses.push(`($${paramIdx}, $${paramIdx + 1}::text[], $${paramIdx + 2}, NOW())`);
    params.push(row.email.toLowerCase(), row.refs, row.ipAddress);
    paramIdx += 3;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const emails = rows.map(r => r.email.toLowerCase());
    const existingResult = await client.query(`SELECT COUNT(*) AS cnt FROM subscribers WHERE email = ANY($1)`, [emails]);
    const preExisting = parseInt(existingResult.rows[0]?.cnt || "0");
    const result = await client.query(
      `INSERT INTO subscribers (email, refs, ip_address, import_date) VALUES ${valuesClauses.join(", ")} ON CONFLICT (email) DO UPDATE SET refs = (SELECT COALESCE(array_agg(DISTINCT r), ARRAY[]::text[]) FROM unnest(subscribers.refs || EXCLUDED.refs) AS r WHERE r IS NOT NULL), ip_address = COALESCE(EXCLUDED.ip_address, subscribers.ip_address), import_date = NOW()`,
      params
    );
    const totalProcessed = result.rowCount || 0;
    await client.query("COMMIT");
    return { inserted: Math.max(totalProcessed - preExisting, 0), updated: Math.min(preExisting, totalProcessed) };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function bulkUpsertSubscribersRefs(
  rows: Array<{ email: string; refs: string[]; ipAddress: string | null; lineNumber: number }>,
): Promise<{ inserted: number; updated: number; failed: number }> {
  if (rows.length === 0) return { inserted: 0, updated: 0, failed: 0 };
  try {
    const result = await copyBatchUpsertRefs(rows);
    return { ...result, failed: 0 };
  } catch (err: any) {
    logger.warn(`[IMPORT] COPY refs batch failed, falling back to INSERT: ${err.message}`);
    const CHUNK_SIZE = 500;
    let totalInserted = 0, totalUpdated = 0, totalFailed = 0;
    for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
      const chunk = rows.slice(i, i + CHUNK_SIZE);
      try {
        const result = await directBatchUpsertRefs(chunk);
        totalInserted += result.inserted;
        totalUpdated += result.updated;
      } catch (chunkErr: any) {
        logger.error(`[IMPORT] Refs batch upsert chunk failed: ${chunkErr.message}`);
        totalFailed += chunk.length;
      }
    }
    return { inserted: totalInserted, updated: totalUpdated, failed: totalFailed };
  }
}

async function stageRefsToImportStaging(
  importJobId: string,
  rows: Array<{ email: string; refs: string[]; ipAddress: string | null }>
): Promise<void> {
  if (rows.length === 0) return;
  const client = await pool.connect();
  try {
    const copyStream = client.query(copyFrom(
      "COPY import_staging (job_id, email, refs, ip_address, line_number) FROM STDIN WITH (FORMAT text)"
    ));
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const email = escapeCopyValue(row.email.toLowerCase());
      const refsLiteral = formatPgArray(row.refs);
      const ip = row.ipAddress ? escapeCopyValue(row.ipAddress) : "\\N";
      copyStream.write(`${escapeCopyValue(importJobId)}\t${email}\t${refsLiteral}\t${ip}\t${i + 1}\n`);
    }
    await new Promise<void>((resolve, reject) => {
      copyStream.on("finish", resolve);
      copyStream.on("error", reject);
      copyStream.end();
    });
  } finally {
    client.release();
  }
}

async function cleanExistingRefsInDb(refs: string[]): Promise<number> {
  if (refs.length === 0) return 0;
  const BATCH_SIZE = 50000;
  let totalCleaned = 0;
  while (true) {
    const result = await pool.query(`
      UPDATE subscribers SET refs = (SELECT COALESCE(array_agg(r), ARRAY[]::text[]) FROM unnest(refs) AS r WHERE r != ALL($1::text[]))
      WHERE id IN (SELECT id FROM subscribers WHERE refs && $1::text[] LIMIT $2)
    `, [refs, BATCH_SIZE]);
    const affected = result.rowCount || 0;
    totalCleaned += affected;
    if (affected === 0) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  return totalCleaned;
}

async function deleteSubscribersByRefsInDb(refs: string[]): Promise<{ deleted: number; bckProtected: number }> {
  if (refs.length === 0) return { deleted: 0, bckProtected: 0 };
  const bckResult = await pool.query(
    `SELECT COUNT(*) AS count FROM subscribers WHERE refs && $1::text[] AND 'BCK' = ANY(tags)`, [refs]
  );
  const bckProtected = parseInt(bckResult.rows[0]?.count || "0");
  const BATCH_SIZE = 50000;
  let totalDeleted = 0;
  while (true) {
    const result = await pool.query(`
      DELETE FROM subscribers WHERE id IN (
        SELECT id FROM subscribers WHERE refs && $1::text[] AND NOT ('BCK' = ANY(tags)) LIMIT $2
      )
    `, [refs, BATCH_SIZE]);
    const affected = result.rowCount || 0;
    totalDeleted += affected;
    if (affected === 0) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  return { deleted: totalDeleted, bckProtected };
}

async function mergeRefsFromStaging(importJobId: string): Promise<{ inserted: number; updated: number }> {
  const existingResult = await pool.query(`
    SELECT COUNT(DISTINCT s.email) AS cnt FROM subscribers s
    INNER JOIN import_staging st ON s.email = st.email WHERE st.job_id = $1
  `, [importJobId]);
  const preExisting = parseInt(existingResult.rows[0]?.cnt || "0");
  const result = await pool.query(`
    INSERT INTO subscribers (email, refs, import_date)
    SELECT email, refs, NOW() FROM import_staging WHERE job_id = $1
    ON CONFLICT (email) DO UPDATE SET
      refs = (SELECT COALESCE(array_agg(DISTINCT r), ARRAY[]::text[]) FROM unnest(subscribers.refs || EXCLUDED.refs) AS r WHERE r IS NOT NULL),
      import_date = NOW()
  `, [importJobId]);
  const totalProcessed = result.rowCount || 0;
  return { inserted: Math.max(totalProcessed - preExisting, 0), updated: Math.min(preExisting, totalProcessed) };
}

async function cleanupStagingData(importJobId: string): Promise<void> {
  await db.execute(sql`DELETE FROM import_staging WHERE job_id = ${importJobId}`);
}

async function peekCsvHasRefsColumn(csvFilePath: string): Promise<boolean> {
  const isObjectStorage = csvFilePath.startsWith("/objects/");
  let firstLine = "";

  if (isObjectStorage) {
    const exists = await objectStorageService.objectExists(csvFilePath);
    if (!exists) return false;
    const stream = await objectStorageService.getObjectStream(csvFilePath);
    firstLine = await new Promise<string>((resolve, reject) => {
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
      rl.on("line", (line: string) => { rl.close(); resolve(line); });
      rl.on("error", reject);
      rl.on("close", () => resolve(firstLine));
    });
  } else {
    if (!fs.existsSync(csvFilePath)) return false;
    const stream = fs.createReadStream(csvFilePath, { encoding: "utf-8", highWaterMark: 1024 });
    firstLine = await new Promise<string>((resolve, reject) => {
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
      rl.on("line", (line: string) => { rl.close(); resolve(line); });
      rl.on("error", reject);
      rl.on("close", () => resolve(firstLine));
    });
  }

  const headers = firstLine.split(";").map(h => h.trim().toLowerCase());
  return headers.includes("refs");
}

// ─── Core import functions ─────────────────────────────────────────────────────

async function processImport(
  queueId: string,
  importJobId: string,
  csvFilePath: string,
  onProgress: (data: Partial<JobProgressEvent>) => void
): Promise<void> {
  logger.info(`[IMPORT] ${importJobId}: Processing from file: ${csvFilePath}`);

  const isObjectStorage = csvFilePath.startsWith("/objects/");
  let fileSizeBytes: number;
  let fileStream: NodeJS.ReadableStream;

  if (isObjectStorage) {
    const exists = await objectStorageService.objectExists(csvFilePath);
    if (!exists) {
      const existingJob = await storage.getImportJob(importJobId);
      if (existingJob?.status === "completed") {
        logger.info(`[IMPORT] ${importJobId}: CSV file already cleaned up from previous successful run — skipping re-processing`);
        return;
      }
      if (existingJob && (existingJob.totalRows ?? 0) > 0 && (existingJob.processedRows ?? 0) >= (existingJob.totalRows ?? 0)) {
        logger.warn(`[IMPORT] ${importJobId}: CSV file missing but all ${existingJob.processedRows} rows were imported — marking completed`);
        await storage.updateImportJob(importJobId, {
          status: "completed",
          completedAt: existingJob.completedAt || new Date(),
          errorMessage: null,
        });
        return;
      }
      throw new Error(
        `CSV file not found in object storage: ${csvFilePath}. This can happen if the file was deleted or never uploaded. Please re-upload the file.`
      );
    }
    fileStream = await objectStorageService.getObjectStream(csvFilePath);
    const queueItemForSize = await storage.getImportQueueItem(queueId);
    fileSizeBytes = queueItemForSize?.fileSizeBytes || 0;
    logger.info(`[IMPORT] ${importJobId}: Using object storage, size from queue: ${Math.round(fileSizeBytes / 1024 / 1024)}MB`);
  } else {
    if (!fs.existsSync(csvFilePath)) {
      const existingJob = await storage.getImportJob(importJobId);
      if (existingJob?.status === "completed") {
        logger.info(`[IMPORT] ${importJobId}: CSV file already cleaned up from previous successful run — skipping re-processing`);
        return;
      }
      if (existingJob && (existingJob.totalRows ?? 0) > 0 && (existingJob.processedRows ?? 0) >= (existingJob.totalRows ?? 0)) {
        logger.warn(`[IMPORT] ${importJobId}: CSV file missing but all ${existingJob.processedRows} rows were imported — marking completed`);
        await storage.updateImportJob(importJobId, {
          status: "completed",
          completedAt: existingJob.completedAt || new Date(),
          errorMessage: null,
        });
        return;
      }
      throw new Error(
        `CSV file not found: ${csvFilePath}. This can happen if the server was restarted or redeployed after uploading the file. Please re-upload the file.`
      );
    }
    const fileStat = fs.statSync(csvFilePath);
    fileSizeBytes = fileStat.size;
    fileStream = fs.createReadStream(csvFilePath, { encoding: "utf-8", highWaterMark: 256 * 1024 });
    logger.info(`[IMPORT] ${importJobId}: Using local filesystem (legacy), size: ${Math.round(fileSizeBytes / 1024 / 1024)}MB`);
  }

  const queueItem = await storage.getImportQueueItem(queueId);
  const resumeFromLine = queueItem?.lastCheckpointLine || 0;
  const importJob = await storage.getImportJob(importJobId);
  const tagMode = (importJob?.tagMode as "merge" | "override") || "merge";
  const forcedTags: string[] = importJob?.forcedTags ?? [];
  const forcedRefs: string[] = importJob?.forcedRefs ?? [];
  const forceMode = forcedTags.length > 0 || forcedRefs.length > 0;
  const removeMode = importJob?.removeMode === true;

  logger.info(`[IMPORT] ${importJobId}: File size: ${Math.round(fileSizeBytes / 1024 / 1024)}MB, tag mode: ${tagMode}, removeMode: ${removeMode}, forceMode: ${forceMode}, forcedTags: [${forcedTags.join(",")}], forcedRefs: [${forcedRefs.join(",")}], resume from line: ${resumeFromLine}`);

  await storage.updateImportJob(importJobId, { status: "processing", startedAt: new Date() });

  const BATCH_SIZE = 25000;
  const PROGRESS_UPDATE_INTERVAL_MS = 2000;
  const HEARTBEAT_INTERVAL = 30000;
  const CHECKPOINT_INTERVAL = 100000;
  const LARGE_IMPORT_THRESHOLD = 100000;
  const MAX_INFLIGHT = CONCURRENCY;

  let inflightCount = 0;
  let inflightResolvers: Array<() => void> = [];

  function waitForSlot(): Promise<void> {
    if (inflightCount < MAX_INFLIGHT) return Promise.resolve();
    return new Promise<void>((resolve) => { inflightResolvers.push(resolve); });
  }

  function releaseSlot() {
    inflightCount--;
    if (inflightResolvers.length > 0) {
      inflightResolvers.shift()!();
    }
  }

  function waitForAllInflight(timeoutMs = 300000): Promise<void> {
    if (inflightCount === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const start = Date.now();
      const check = () => {
        if (inflightCount === 0) {
          resolve();
        } else if (Date.now() - start > timeoutMs) {
          logger.error(`[IMPORT] ${importJobId}: waitForAllInflight timed out after ${timeoutMs / 1000}s with ${inflightCount} batches still in-flight`);
          resolve();
        } else {
          setTimeout(check, 50);
        }
      };
      check();
    });
  }

  const totalLines = queueItem?.totalLines || 0;
  const isLargeImport = totalLines > LARGE_IMPORT_THRESHOLD;
  let ginIndexesDropped = false;

  if (isLargeImport && resumeFromLine === 0 && !removeMode) {
    try {
      logger.info(`[IMPORT] ${importJobId}: Large import detected (${totalLines} rows), attempting GIN index drop`);
      const beforeDrop = await storage.areGinIndexesPresent();
      ginIndexesDropped = await safeDropGinIndexes(importJobId);
      if (!ginIndexesDropped && beforeDrop) {
        logger.info(`[IMPORT] ${importJobId}: GIN indexes were kept (active campaigns protect sends)`);
      }
    } catch (err: any) {
      logger.error(`[IMPORT] ${importJobId}: Failed to drop GIN indexes: ${err.message}`);
    }
  }

  const totalRows = importJob?.totalRows || 0;
  let newSubscribers = resumeFromLine > 0 ? (importJob?.newSubscribers || 0) : 0;
  let updatedSubscribers = resumeFromLine > 0 ? (importJob?.updatedSubscribers || 0) : 0;
  let failedRows = resumeFromLine > 0 ? (importJob?.failedRows || 0) : 0;
  let committedRows = resumeFromLine > 0 ? (newSubscribers + updatedSubscribers + failedRows) : 0;

  let preImportSubscriberCount = 0;
  try {
    const countResult = await pool.query("SELECT COUNT(*) AS cnt FROM subscribers");
    preImportSubscriberCount = parseInt(countResult.rows[0]?.cnt || "0", 10);
    logger.info(`[IMPORT] ${importJobId}: Pre-import subscriber count: ${preImportSubscriberCount.toLocaleString()}`);
  } catch (err: any) {
    logger.warn(`[IMPORT] ${importJobId}: Failed to get pre-import subscriber count: ${err.message}`);
  }

  if (resumeFromLine > 0 && totalRows > 0 && committedRows > totalRows) {
    logger.warn(`[IMPORT] ${importJobId}: Resume sanity check — committedRows (${committedRows}) exceeds totalRows (${totalRows}), capping`);
    const excess = committedRows - totalRows;
    failedRows = Math.max(0, failedRows - excess);
    committedRows = newSubscribers + updatedSubscribers + failedRows;
  }

  const resumeCommittedOffset = committedRows;
  let parsedRows = committedRows;
  let skippedRows = 0;
  let lastHeartbeat = Date.now();
  let lastCheckpointLine = resumeFromLine;
  let processedBytes = queueItem?.processedBytes || 0;
  const failureReasons: Record<string, number> = {};
  const sampleFailures: Record<string, string> = {};
  const MAX_SAMPLE_FAILURES = 10;

  if (resumeFromLine > 0) {
    logger.info(`[IMPORT] ${importJobId}: Resuming from line ${resumeFromLine}, committed rows: ${committedRows} (new: ${newSubscribers}, updated: ${updatedSubscribers}, failed: ${failedRows})`);
  }

  let header: string[] = [];
  let emailIdx = -1, tagsIdx = -1, refsIdx = -1, ipIdx = -1;
  let headerParsed = false;
  let hasRefsColumn = false;

  interface BatchResult {
    inserted: number; updated: number; failed: number;
    batchSize: number; durationMs: number; batchNumber: number;
    crossBatchDups: number; withinBatchDups: number; batchEndLine: number;
  }

  let batchRows: Array<{ email: string; tags: string[]; refs: string[]; ipAddress: string | null; lineNumber: number }> = [];
  let currentLineNumber = 0;
  let batchNumber = 0;
  const startTime = Date.now();
  const seenEmails = new Set<string>();
  let duplicatesInFile = 0;
  let isCancelled = false;
  let batchError: Error | null = null;
  const pendingResults: BatchResult[] = [];
  let maxCommittedLine = resumeFromLine;

  async function checkCancellation(): Promise<boolean> {
    try {
      const job = await storage.getImportJob(importJobId);
      if (job?.status === "cancelled") {
        logger.info(`[IMPORT] ${importJobId}: Job cancelled by user`);
        isCancelled = true;
        return true;
      }
    } catch (err: any) {
      logger.warn(`[IMPORT] ${importJobId}: Cancellation check failed: ${err?.message || err}`);
    }
    return false;
  }

  function deduplicateBatch(
    batch: Array<{ email: string; tags: string[]; refs: string[]; ipAddress: string | null; lineNumber: number }>
  ): { dedupedRows: typeof batch; withinBatchDups: number; crossBatchDups: number } {
    const emailMap = new Map<string, typeof batch[0]>();
    let withinBatchDups = 0;
    for (const row of batch) {
      const existing = emailMap.get(row.email);
      if (existing) {
        withinBatchDups++;
        existing.tags = [...new Set([...existing.tags, ...row.tags])];
        existing.refs = [...new Set([...existing.refs, ...row.refs])];
        if (row.ipAddress && !existing.ipAddress) existing.ipAddress = row.ipAddress;
      } else {
        emailMap.set(row.email, { ...row });
      }
    }
    let crossBatchDups = 0;
    const dedupedRows: typeof batch = [];
    for (const [email, row] of emailMap) {
      if (seenEmails.has(email)) crossBatchDups++;
      seenEmails.add(email);
      dedupedRows.push(row);
    }
    return { dedupedRows, withinBatchDups, crossBatchDups };
  }

  function drainResults(): void {
    while (pendingResults.length > 0) {
      const r = pendingResults.shift()!;
      newSubscribers += r.inserted;
      updatedSubscribers += r.updated;
      failedRows += r.failed;
      duplicatesInFile += r.crossBatchDups;
      committedRows += r.batchSize;
      if (r.batchEndLine > maxCommittedLine) maxCommittedLine = r.batchEndLine;
      const rowsPerSecond = r.batchSize / (r.durationMs / 1000);
      logger.info(`[IMPORT] ${importJobId}: Batch ${r.batchNumber} (${r.batchSize} rows, ${r.withinBatchDups + r.crossBatchDups} dups) in ${r.durationMs}ms (${Math.round(rowsPerSecond)}/s)`);
    }
  }

  let lastProgressEmitTime = 0;
  let lastProgressEmitCommitted = -1;
  let isFlushingProgress = false;

  async function flushProgress(): Promise<void> {
    drainResults();
    const now = Date.now();
    const committedChanged = committedRows !== lastProgressEmitCommitted;
    if (!committedChanged && now - lastProgressEmitTime < 2000) return;

    lastProgressEmitTime = now;
    lastProgressEmitCommitted = committedRows;

    onProgress({
      status: "processing",
      processedRows: committedRows,
      totalRows,
      newSubscribers,
      updatedSubscribers,
      failedRows,
      duplicatesInFile,
    });

    const elapsedSec = (now - startTime) / 1000;
    const commitRate = committedRows / elapsedSec;
    logger.info(`[IMPORT] ${importJobId}: Progress — committed: ${committedRows.toLocaleString()} (${Math.round(commitRate)}/s), new: ${newSubscribers.toLocaleString()}, updated: ${updatedSubscribers.toLocaleString()}, dups: ${duplicatesInFile.toLocaleString()}, failed: ${failedRows.toLocaleString()}`);

    if (isFlushingProgress) return;
    isFlushingProgress = true;
    try {
      if (now - lastHeartbeat > HEARTBEAT_INTERVAL) {
        await storage.updateImportQueueHeartbeat(queueId);
        lastHeartbeat = now;
      }
      await storage.updateImportQueueProgress(queueId, committedRows);
      const allReasons: Record<string, any> = { ...failureReasons };
      if (duplicatesInFile > 0) allReasons["duplicate_in_file"] = duplicatesInFile;
      if (Object.keys(sampleFailures).length > 0) allReasons["_sample_failures"] = sampleFailures;
      await storage.updateImportJob(importJobId, {
        processedRows: committedRows,
        newSubscribers,
        updatedSubscribers,
        failedRows,
        failureReasons: Object.keys(allReasons).length > 0 ? allReasons : undefined,
        skippedRows,
      });

      if (committedRows - lastCheckpointLine >= CHECKPOINT_INTERVAL) {
        const checkpointLine = Math.max(maxCommittedLine, currentLineNumber);
        await storage.updateImportQueueProgressWithCheckpoint(queueId, committedRows, processedBytes, checkpointLine);
        lastCheckpointLine = committedRows;
        logger.info(`[IMPORT] ${importJobId}: Checkpoint at line ${checkpointLine}, ${committedRows.toLocaleString()} rows committed`);
      }
    } catch (dbErr: any) {
      logger.warn(`[IMPORT] ${importJobId}: DB progress update skipped (pool busy): ${dbErr.message}`);
    } finally {
      isFlushingProgress = false;
    }
  }

  function submitBatch(): void {
    if (batchRows.length === 0) return;
    batchNumber++;
    const rawBatch = batchRows;
    const thisBatchNumber = batchNumber;
    const batchEndLine = currentLineNumber;
    batchRows = [];

    const { dedupedRows, withinBatchDups, crossBatchDups } = deduplicateBatch(rawBatch);
    duplicatesInFile += withinBatchDups;

    if (dedupedRows.length === 0) {
      duplicatesInFile += crossBatchDups;
      committedRows += rawBatch.length;
      return;
    }

    inflightCount++;
    const batchStart = Date.now();
    const batchOp = removeMode
      ? bulkRemoveTagsRefs(dedupedRows)
      : bulkUpsertSubscribers(dedupedRows, tagMode);
    batchOp
      .then((result) => {
        pendingResults.push({
          inserted: result.inserted,
          updated: Math.max(0, result.updated - crossBatchDups),
          failed: result.failed,
          batchSize: rawBatch.length,
          durationMs: Date.now() - batchStart,
          batchNumber: thisBatchNumber,
          crossBatchDups,
          withinBatchDups,
          batchEndLine,
        });
      })
      .catch((err) => {
        logger.error(`[IMPORT] ${importJobId}: Batch ${thisBatchNumber} failed critically: ${err.message}`);
        batchError = err;
        pendingResults.push({
          inserted: 0, updated: 0, failed: dedupedRows.length,
          batchSize: rawBatch.length, durationMs: Date.now() - batchStart,
          batchNumber: thisBatchNumber, crossBatchDups: 0, withinBatchDups,
          batchEndLine,
        });
      })
      .finally(() => { releaseSlot(); });
  }

  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  const progressUpdateTimer = setInterval(() => {
    try {
      drainResults();
      const now = Date.now();
      const elapsedSec = (now - startTime) / 1000;
      const commitRate = committedRows / elapsedSec;
      const parseRate = parsedRows / elapsedSec;
      logger.info(`[IMPORT] ${importJobId}: Timer progress — parsed: ${parsedRows.toLocaleString()} (${Math.round(parseRate)}/s), committed: ${committedRows.toLocaleString()} (${Math.round(commitRate)}/s)`);
      onProgress({ status: "processing", processedRows: committedRows, totalRows, newSubscribers, updatedSubscribers, failedRows, duplicatesInFile });
    } catch (err: any) {
      logger.error(`[IMPORT] ${importJobId}: Timer progress emit failed: ${err.message}`);
    }
  }, PROGRESS_UPDATE_INTERVAL_MS);

  return new Promise<void>((resolve, reject) => {
    let hasSettled = false;
    const safeReject = (err: any) => {
      if (hasSettled) return;
      hasSettled = true;
      clearInterval(progressUpdateTimer);
      if (ginIndexesDropped) {
        storage.recreateSubscriberGinIndexes()
          .then(() => logger.info(`[IMPORT] ${importJobId}: GIN indexes recovered after error`))
          .catch((indexErr: any) => logger.error(`[IMPORT] ${importJobId}: Failed to recover GIN indexes: ${indexErr}`));
      }
      reject(err);
    };
    const safeResolve = () => {
      if (hasSettled) return;
      hasSettled = true;
      resolve();
    };

    rl.on("line", async (line: string) => {
      try {
        currentLineNumber++;
        processedBytes += Buffer.byteLength(line, "utf-8") + 1;

        if (!headerParsed && currentLineNumber === 1) {
          header = line.split(";").map((h) => h.trim().toLowerCase());
          emailIdx = header.indexOf("email");
          tagsIdx = header.indexOf("tags");
          refsIdx = header.indexOf("refs");
          ipIdx = header.indexOf("ip_address");
          hasRefsColumn = refsIdx >= 0;
          logger.info(`[IMPORT] ${importJobId}: Header columns: ${header.join(", ")} (refs column: ${hasRefsColumn ? "yes" : "no"})`);
          if (emailIdx === -1) {
            rl.close();
            await storage.updateImportJob(importJobId, { status: "failed", errorMessage: "CSV must have an 'email' column" });
            safeReject(new Error("CSV must have an 'email' column"));
            return;
          }
          headerParsed = true;
          return;
        }

        if (currentLineNumber <= resumeFromLine) return;
        if (!line.trim()) { skippedRows++; return; }

        let rowParsedOk = false;
        try {
          const cols = line.split(";").map((c) => c.trim());
          const email = cols[emailIdx]?.toLowerCase();

          if (!email) {
            failedRows++; parsedRows++; committedRows++;
            failureReasons["empty_email"] = (failureReasons["empty_email"] || 0) + 1;
            if (Object.keys(sampleFailures).length < MAX_SAMPLE_FAILURES) sampleFailures[`line_${currentLineNumber}`] = line.substring(0, 200);
            return;
          }
          if (!email.includes("@") || email.length < 3) {
            failedRows++; parsedRows++; committedRows++;
            failureReasons["invalid_email"] = (failureReasons["invalid_email"] || 0) + 1;
            if (Object.keys(sampleFailures).length < MAX_SAMPLE_FAILURES) sampleFailures[`line_${currentLineNumber}`] = line.substring(0, 200);
            return;
          }
          const atIdx = email.indexOf("@");
          const localPart = email.substring(0, atIdx);
          const domainPart = email.substring(atIdx + 1);
          if (!localPart || !domainPart || !domainPart.includes(".") || domainPart.endsWith(".") || domainPart.startsWith(".")) {
            failedRows++; parsedRows++; committedRows++;
            failureReasons["invalid_email"] = (failureReasons["invalid_email"] || 0) + 1;
            if (Object.keys(sampleFailures).length < MAX_SAMPLE_FAILURES) sampleFailures[`line_${currentLineNumber}`] = line.substring(0, 200);
            return;
          }

          const csvTags = tagsIdx >= 0 && cols[tagsIdx]
            ? cols[tagsIdx].split(",").map((t) => t.trim().toUpperCase()).filter(Boolean) : [];
          const csvRefs = refsIdx >= 0 && cols[refsIdx]
            ? cols[refsIdx].split(",").map((r) => r.trim().toUpperCase()).filter(Boolean) : [];
          const tags = forceMode ? forcedTags : csvTags;
          const refs = forceMode ? forcedRefs : csvRefs;
          const ipAddress = ipIdx >= 0 ? cols[ipIdx] || null : null;

          batchRows.push({ email, tags, refs, ipAddress, lineNumber: currentLineNumber });
          parsedRows++;
          rowParsedOk = true;
        } catch (parseErr: any) {
          failedRows++; parsedRows++; committedRows++;
          failureReasons["malformed_csv_row"] = (failureReasons["malformed_csv_row"] || 0) + 1;
          if (Object.keys(sampleFailures).length < MAX_SAMPLE_FAILURES) sampleFailures[`line_${currentLineNumber}`] = line.substring(0, 200);
        }

        if (rowParsedOk && batchRows.length >= BATCH_SIZE) {
          rl.pause();
          if (await checkCancellation()) { rl.close(); return; }
          if (batchError) { rl.close(); safeReject(batchError); return; }
          try {
            await waitForSlot();
            submitBatch();
          } catch (batchErr: any) {
            logger.error(`[IMPORT] ${importJobId}: Batch submission error at line ${currentLineNumber}: ${batchErr.message}`);
            const lostRows = batchRows.length;
            failedRows += lostRows; committedRows += lostRows; batchRows = [];
            failureReasons["batch_processing_error"] = (failureReasons["batch_processing_error"] || 0) + lostRows;
          }
          try { await flushProgress(); } catch (err: any) { logger.warn(`[IMPORT] ${importJobId}: flushProgress failed: ${err?.message || err}`); }
          rl.resume();
        }
      } catch (err) {
        logger.error(`[IMPORT] Error processing line ${currentLineNumber}: ${err}`);
        failedRows++; parsedRows++; committedRows++;
        failureReasons["processing_error"] = (failureReasons["processing_error"] || 0) + 1;
      }
    });

    rl.on("close", async () => {
      clearInterval(progressUpdateTimer);
      const finalizationHeartbeat = setInterval(() => {
        logger.debug(`[IMPORT] ${importJobId}: Finalization in progress...`);
        storage.updateImportQueueHeartbeat(queueId).catch((err: any) =>
          logger.warn(`[IMPORT] ${importJobId}: Finalization heartbeat DB update failed: ${err.message}`)
        );
      }, 30000);

      try {
        if (batchRows.length > 0 && !isCancelled) {
          await waitForSlot();
          submitBatch();
        }
        await waitForAllInflight();
        await flushProgress();

        if (batchError && !isCancelled) throw batchError;

        const currentJob = await storage.getImportJob(importJobId);
        const wasExternallyCancelled = currentJob?.status === "cancelled";

        if (isCancelled || wasExternallyCancelled) {
          logger.info(`[IMPORT] ${importJobId}: Cancelled at line ${currentLineNumber} (committed: ${committedRows})`);
          const cancelReasons: Record<string, any> = { ...failureReasons };
          if (duplicatesInFile > 0) cancelReasons["duplicate_in_file"] = duplicatesInFile;
          if (Object.keys(sampleFailures).length > 0) cancelReasons["_sample_failures"] = sampleFailures;
          await storage.updateImportJob(importJobId, { processedRows: committedRows, newSubscribers, updatedSubscribers, failedRows, failureReasons: Object.keys(cancelReasons).length > 0 ? cancelReasons : undefined, skippedRows });

          try {
            if (isObjectStorage) await objectStorageService.deleteStorageObject(csvFilePath);
            else fs.unlinkSync(csvFilePath);
          } catch (_) { logger.error(`[IMPORT] Failed to clean up CSV file after cancellation: ${csvFilePath}`); }

          if (ginIndexesDropped) {
            try { await storage.recreateSubscriberGinIndexes(); } catch (_) { logger.error(`[IMPORT] ${importJobId}: Failed to recreate GIN indexes after cancellation`); }
          }
          clearInterval(finalizationHeartbeat);
          safeResolve();
          return;
        }

        const batchAccumulatedNew = newSubscribers;
        const batchAccumulatedUpdated = updatedSubscribers;

        if (removeMode) {
          newSubscribers = 0;
          logger.info(`[IMPORT] ${importJobId}: Remove mode — no new subscribers, updated: ${updatedSubscribers}`);
        } else if (resumeFromLine === 0) {
          try {
            const postCountResult = await pool.query("SELECT COUNT(*) AS cnt FROM subscribers");
            const postImportSubscriberCount = parseInt(postCountResult.rows[0]?.cnt || "0", 10);
            const rawNew = postImportSubscriberCount - preImportSubscriberCount;
            const maxPossibleNew = Math.max(0, committedRows - failedRows - duplicatesInFile);
            const actualNew = Math.max(0, Math.min(rawNew, maxPossibleNew));
            const actualUpdated = Math.max(0, committedRows - actualNew - failedRows - duplicatesInFile);
            logger.info(`[IMPORT] ${importJobId}: Before/after count correction — pre: ${preImportSubscriberCount}, post: ${postImportSubscriberCount}, rawNew: ${rawNew}, cappedNew: ${actualNew}, actualUpdated: ${actualUpdated} (batch accumulated: new=${batchAccumulatedNew}, updated=${batchAccumulatedUpdated})`);
            newSubscribers = actualNew;
            updatedSubscribers = actualUpdated;
          } catch (err: any) {
            logger.warn(`[IMPORT] ${importJobId}: Failed post-import count, using batch-accumulated values: ${err.message}`);
          }
        } else {
          logger.info(`[IMPORT] ${importJobId}: Resume run — skipping before/after correction, using batch-accumulated values`);
        }

        if (resumeFromLine > 0 && totalRows > 0) {
          const totalAccounted = newSubscribers + updatedSubscribers + failedRows + duplicatesInFile + skippedRows;
          if (totalAccounted > totalRows) {
            const excess = totalAccounted - totalRows;
            const reduction = Math.min(excess, updatedSubscribers);
            logger.info(`[IMPORT] ${importJobId}: Resume overlap correction: reducing updatedSubscribers by ${reduction}`);
            updatedSubscribers -= reduction;
            committedRows = newSubscribers + updatedSubscribers + failedRows;
          }
        }

        const finalReasons: Record<string, any> = { ...failureReasons };
        if (duplicatesInFile > 0) finalReasons["duplicate_in_file"] = duplicatesInFile;
        if (Object.keys(sampleFailures).length > 0) finalReasons["_sample_failures"] = sampleFailures;

        const expectedTotal = newSubscribers + updatedSubscribers + failedRows + duplicatesInFile + skippedRows;
        if (Math.abs(expectedTotal - totalRows) > 1) {
          logger.warn(`[IMPORT] ${importJobId}: Count integrity mismatch — expected ${totalRows} data rows, got new(${newSubscribers})+updated(${updatedSubscribers})+failed(${failedRows})+dups(${duplicatesInFile})+skipped(${skippedRows})=${expectedTotal}`);
          finalReasons["_count_discrepancy"] = { expected: totalRows, actual: expectedTotal };
        }

        const finalProcessedRows = totalRows > 0 ? Math.min(committedRows, totalRows) : committedRows;

        const totalDuration = (Date.now() - startTime) / 1000;
        logger.info(`[IMPORT] ${importJobId}: All rows committed in ${Math.round(totalDuration)}s — committed: ${committedRows}, new: ${newSubscribers}, updated: ${updatedSubscribers}, dups: ${duplicatesInFile}, failed: ${failedRows}`);

        // Mark as "completed" and fire the SSE event IMMEDIATELY once all rows are in the DB.
        // GIN index recreation and CSV cleanup happen after — they are background housekeeping
        // and must not delay the status transition that the UI depends on.
        let completedWritten = false;
        for (let attempt = 1; attempt <= 5; attempt++) {
          try {
            await storage.updateImportJob(importJobId, {
              status: "completed",
              completedAt: new Date(),
              processedRows: finalProcessedRows,
              newSubscribers,
              updatedSubscribers,
              failedRows,
              failureReasons: Object.keys(finalReasons).length > 0 ? finalReasons : undefined,
              skippedRows,
            });
            completedWritten = true;
            break;
          } catch (dbErr: any) {
            logger.warn(`[IMPORT] ${importJobId}: Final DB write attempt ${attempt}/5 failed: ${dbErr.message}`);
            if (attempt < 5) await new Promise(r => setTimeout(r, 1000 * attempt));
          }
        }

        if (!completedWritten) {
          // All 5 retries exhausted — surface as an error so workers.ts safety-net can handle it
          throw new Error(`[IMPORT] ${importJobId}: Could not persist 'completed' status after 5 attempts — all rows are in the DB`);
        }

        await storage.updateImportQueueProgressWithCheckpoint(queueId, committedRows, processedBytes, currentLineNumber)
          .catch((err: any) => logger.warn(`[IMPORT] ${importJobId}: Checkpoint update failed (non-fatal): ${err.message}`));

        // Emit SSE "completed" event so the UI transitions immediately
        onProgress({
          status: "completed",
          processedRows: finalProcessedRows,
          totalRows,
          newSubscribers,
          updatedSubscribers,
          failedRows,
          duplicatesInFile,
        });

        // Background housekeeping: GIN index recreation (can take several minutes on large imports)
        if (isLargeImport) {
          try {
            const indexesPresent = await storage.areGinIndexesPresent();
            if (!indexesPresent) {
              logger.info(`[IMPORT] ${importJobId}: GIN indexes missing, recreating after import`);
              await storage.recreateSubscriberGinIndexes();
            }
          } catch (indexErr: any) {
            logger.error(`[IMPORT] ${importJobId}: Failed to recreate GIN indexes: ${indexErr.message}`);
            await storage.logError({ type: "index_recreation_failed", severity: "warning", message: `Failed to recreate GIN indexes after import: ${indexErr.message}`, importJobId, details: indexErr?.stack || String(indexErr) });
          }
        }

        try {
          if (isObjectStorage) await objectStorageService.deleteStorageObject(csvFilePath);
          else fs.unlinkSync(csvFilePath);
          logger.info(`[IMPORT] ${importJobId}: Cleaned up CSV file`);
        } catch (_) { logger.error(`[IMPORT] ${importJobId}: Failed to clean up CSV file: ${csvFilePath}`); }

        logger.info(`[IMPORT] ${importJobId}: Finalization complete in ${Math.round((Date.now() - startTime) / 1000)}s total`);

        clearInterval(finalizationHeartbeat);
        safeResolve();
      } catch (err) {
        clearInterval(finalizationHeartbeat);
        safeReject(err);
      }
    });

    rl.on("error", (err) => { logger.error(`[IMPORT] ${importJobId}: Stream error: ${err}`); safeReject(err); });
    fileStream.on("error", (err) => { logger.error(`[IMPORT] ${importJobId}: File stream error: ${err}`); safeReject(err); });
  });
}

async function processRefsImportPhase1(
  queueId: string,
  importJobId: string,
  csvFilePath: string,
  onProgress: (data: Partial<JobProgressEvent>) => void
): Promise<void> {
  logger.info(`[IMPORT] ${importJobId}: [REFS PHASE 1] Staging refs from file: ${csvFilePath}`);

  const isObjectStorage = csvFilePath.startsWith("/objects/");
  let fileStream: NodeJS.ReadableStream;

  if (isObjectStorage) {
    const exists = await objectStorageService.objectExists(csvFilePath);
    if (!exists) {
      const existingJob = await storage.getImportJob(importJobId);
      if (existingJob?.status === "completed" || (existingJob && (existingJob.totalRows ?? 0) > 0 && (existingJob.processedRows ?? 0) >= (existingJob.totalRows ?? 0))) {
        logger.warn(`[IMPORT] ${importJobId}: [REFS PHASE 1] CSV missing but all rows already imported — skipping`);
        if (existingJob.status !== "completed") {
          await storage.updateImportJob(importJobId, { status: "completed", completedAt: existingJob.completedAt || new Date(), errorMessage: null });
        }
        return;
      }
      throw new Error(`CSV file not found in object storage: ${csvFilePath}`);
    }
    fileStream = await objectStorageService.getObjectStream(csvFilePath);
  } else {
    if (!fs.existsSync(csvFilePath)) {
      const existingJob = await storage.getImportJob(importJobId);
      if (existingJob?.status === "completed" || (existingJob && (existingJob.totalRows ?? 0) > 0 && (existingJob.processedRows ?? 0) >= (existingJob.totalRows ?? 0))) {
        logger.warn(`[IMPORT] ${importJobId}: [REFS PHASE 1] CSV missing but all rows already imported — skipping`);
        if (existingJob.status !== "completed") {
          await storage.updateImportJob(importJobId, { status: "completed", completedAt: existingJob.completedAt || new Date(), errorMessage: null });
        }
        return;
      }
      throw new Error(`CSV file not found: ${csvFilePath}`);
    }
    fileStream = fs.createReadStream(csvFilePath, { encoding: "utf-8", highWaterMark: 256 * 1024 });
  }

  await storage.updateImportJob(importJobId, { status: "processing", startedAt: new Date() });

  const BATCH_SIZE = 25000;
  let header: string[] = [];
  let emailIdx = -1, tagsIdx = -1, refsColIdx = -1, ipIdx = -1;
  let headerParsed = false, useRefsColumn = false;
  let currentLineNumber = 0, parsedRows = 0, failedRows = 0;
  let batchRows: Array<{ email: string; refs: string[]; ipAddress: string | null }> = [];

  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  return new Promise<void>((resolve, reject) => {
    let hasSettled = false;
    const safeReject = (err: any) => { if (!hasSettled) { hasSettled = true; reject(err); } };
    const safeResolve = () => { if (!hasSettled) { hasSettled = true; resolve(); } };

    rl.on("line", async (line: string) => {
      try {
        currentLineNumber++;

        if (!headerParsed && currentLineNumber === 1) {
          header = line.split(";").map((h) => h.trim().toLowerCase());
          emailIdx = header.indexOf("email");
          tagsIdx = header.indexOf("tags");
          refsColIdx = header.indexOf("refs");
          ipIdx = header.indexOf("ip_address");
          useRefsColumn = refsColIdx >= 0;
          logger.info(`[IMPORT] ${importJobId}: [REFS PHASE 1] Header: ${header.join(", ")} (refs column: ${useRefsColumn ? "yes" : "no, falling back to tags"})`);
          if (emailIdx === -1) {
            rl.close();
            await storage.updateImportJob(importJobId, { status: "failed", errorMessage: "CSV must have an 'email' column" });
            safeReject(new Error("CSV must have an 'email' column"));
            return;
          }
          headerParsed = true;
          return;
        }

        if (!line.trim()) return;

        const cols = line.split(";").map((c) => c.trim());
        const email = cols[emailIdx]?.toLowerCase();
        if (!email || !email.includes("@")) { failedRows++; parsedRows++; return; }

        const refsSource = useRefsColumn ? refsColIdx : tagsIdx;
        const refs = refsSource >= 0 && cols[refsSource]
          ? cols[refsSource].split(",").map((r) => r.trim().toUpperCase()).filter(Boolean) : [];
        const ipAddress = ipIdx >= 0 ? cols[ipIdx] || null : null;

        batchRows.push({ email, refs, ipAddress });
        parsedRows++;

        if (batchRows.length >= BATCH_SIZE) {
          rl.pause();
          await stageRefsToImportStaging(importJobId, batchRows);
          batchRows = [];
          await storage.updateImportQueueHeartbeat(queueId);
          rl.resume();
        }
      } catch (err) {
        logger.error(`[IMPORT] ${importJobId}: [REFS PHASE 1] Error processing line ${currentLineNumber}: ${err}`);
        failedRows++; parsedRows++;
      }
    });

    rl.on("close", async () => {
      try {
        if (batchRows.length > 0) {
          await stageRefsToImportStaging(importJobId, batchRows);
          batchRows = [];
        }

        const detectedRefs = await storage.detectImportRefs(importJobId);
        logger.info(`[IMPORT] ${importJobId}: [REFS PHASE 1] Detected ${detectedRefs.length} refs: ${detectedRefs.join(", ")}`);

        if (detectedRefs.length === 0) {
          await cleanupStagingData(importJobId);
          await storage.updateImportJob(importJobId, {
            status: "failed",
            errorMessage: "No refs detected in CSV. Ensure the CSV has a 'refs' column (or 'tags' column) with ref codes.",
            failedRows,
          });
          throw new Error("No refs detected in CSV");
        }

        await storage.updateImportJob(importJobId, {
          status: "awaiting_confirmation",
          detectedRefs,
          processedRows: parsedRows,
          failedRows,
        });

        logger.info(`[IMPORT] ${importJobId}: [REFS PHASE 1] Staged ${parsedRows} rows, awaiting confirmation`);

        onProgress({
          status: "awaiting_confirmation",
          processedRows: parsedRows,
          totalRows: parsedRows,
        });

        safeResolve();
      } catch (err) {
        safeReject(err);
      }
    });

    rl.on("error", (err) => safeReject(err));
    fileStream.on("error", (err) => safeReject(err));
  });
}

async function processRefsImportPhase2(
  queueId: string,
  importJobId: string,
  csvFilePath: string | undefined,
  onProgress: (data: Partial<JobProgressEvent>) => void
): Promise<void> {
  logger.info(`[IMPORT] ${importJobId}: [REFS PHASE 2] Processing unified import`);

  const importJob = await storage.getImportJob(importJobId);
  if (!importJob) throw new Error(`Import job ${importJobId} not found`);

  const detectedRefs = importJob.detectedRefs || [];
  const cleanExisting = importJob.cleanExistingRefs;
  const deleteExisting = importJob.deleteExistingRefs;
  const tagMode = (importJob as any).tagMode || "merge";
  const p2ForcedTags: string[] = importJob.forcedTags ?? [];
  const p2ForcedRefs: string[] = importJob.forcedRefs ?? [];
  const p2ForceMode = p2ForcedTags.length > 0 || p2ForcedRefs.length > 0;
  logger.info(`[IMPORT] ${importJobId}: [REFS PHASE 2] forceMode: ${p2ForceMode}, forcedTags: [${p2ForcedTags.join(",")}], forcedRefs: [${p2ForcedRefs.join(",")}]`);

  await storage.updateImportJob(importJobId, {
    status: "processing",
    newSubscribers: 0,
    updatedSubscribers: 0,
    failedRows: 0,
    processedRows: 0,
  });

  if (deleteExisting && detectedRefs.length > 0) {
    logger.info(`[IMPORT] ${importJobId}: [REFS PHASE 2] Deleting subscribers with refs: ${detectedRefs.join(", ")}`);
    const { deleted, bckProtected } = await deleteSubscribersByRefsInDb(detectedRefs);
    logger.info(`[IMPORT] ${importJobId}: [REFS PHASE 2] Deleted ${deleted} subscribers (${bckProtected} BCK-protected skipped)`);
  } else if (cleanExisting && detectedRefs.length > 0) {
    logger.info(`[IMPORT] ${importJobId}: [REFS PHASE 2] Cleaning existing refs: ${detectedRefs.join(", ")}`);
    const cleaned = await cleanExistingRefsInDb(detectedRefs);
    logger.info(`[IMPORT] ${importJobId}: [REFS PHASE 2] Cleaned ${cleaned} subscribers`);
  }

  let resolvedCsvPath = csvFilePath;
  if (!resolvedCsvPath || resolvedCsvPath === "phase2_merge") {
    const originalQueueResult = await pool.query(
      `SELECT csv_file_path FROM import_job_queue WHERE import_job_id = $1 AND csv_file_path != 'phase2_merge' ORDER BY created_at ASC LIMIT 1`,
      [importJobId]
    );
    resolvedCsvPath = originalQueueResult.rows[0]?.csv_file_path;
  }

  if (!resolvedCsvPath || resolvedCsvPath === "phase2_merge") {
    logger.warn(`[IMPORT] ${importJobId}: [REFS PHASE 2] No CSV path found, falling back to staging merge only`);
    const mergeResult = await mergeRefsFromStaging(importJobId);
    await cleanupStagingData(importJobId);
    await storage.updateImportJob(importJobId, {
      status: "completed",
      completedAt: new Date(),
      newSubscribers: mergeResult.inserted,
      updatedSubscribers: mergeResult.updated,
    });
    onProgress({
      status: "completed",
      processedRows: mergeResult.inserted + mergeResult.updated,
      totalRows: mergeResult.inserted + mergeResult.updated,
      newSubscribers: mergeResult.inserted,
      updatedSubscribers: mergeResult.updated,
      failedRows: importJob.failedRows || 0,
    });
    logger.info(`[IMPORT] ${importJobId}: [REFS PHASE 2] Completed (staging merge only)`);
    return;
  }

  await cleanupStagingData(importJobId);
  logger.info(`[IMPORT] ${importJobId}: [REFS PHASE 2] Re-reading CSV for full import: ${resolvedCsvPath}`);

  const isObjectStorage = resolvedCsvPath.startsWith("/objects/");
  let fileStream: NodeJS.ReadableStream;

  if (isObjectStorage) {
    const exists = await objectStorageService.objectExists(resolvedCsvPath);
    if (!exists) {
      const existingJob = await storage.getImportJob(importJobId);
      if (existingJob?.status === "completed" || (existingJob && (existingJob.totalRows ?? 0) > 0 && (existingJob.processedRows ?? 0) >= (existingJob.totalRows ?? 0))) {
        logger.warn(`[IMPORT] ${importJobId}: [REFS PHASE 2] CSV missing but all rows already imported — skipping`);
        if (existingJob.status !== "completed") {
          await storage.updateImportJob(importJobId, { status: "completed", completedAt: existingJob.completedAt || new Date(), errorMessage: null });
        }
        return;
      }
      throw new Error(`CSV file not found in object storage: ${resolvedCsvPath}`);
    }
    fileStream = await objectStorageService.getObjectStream(resolvedCsvPath);
  } else {
    if (!fs.existsSync(resolvedCsvPath)) {
      const existingJob = await storage.getImportJob(importJobId);
      if (existingJob?.status === "completed" || (existingJob && (existingJob.totalRows ?? 0) > 0 && (existingJob.processedRows ?? 0) >= (existingJob.totalRows ?? 0))) {
        logger.warn(`[IMPORT] ${importJobId}: [REFS PHASE 2] CSV missing but all rows already imported — skipping`);
        if (existingJob.status !== "completed") {
          await storage.updateImportJob(importJobId, { status: "completed", completedAt: existingJob.completedAt || new Date(), errorMessage: null });
        }
        return;
      }
      throw new Error(`CSV file not found: ${resolvedCsvPath}`);
    }
    fileStream = fs.createReadStream(resolvedCsvPath, { encoding: "utf-8", highWaterMark: 256 * 1024 });
  }

  const BATCH_SIZE = 25000;
  let header: string[] = [];
  let emailIdx = -1, tagsIdx = -1, refsIdx = -1, ipIdx = -1;
  let headerParsed = false, currentLineNumber = 0;
  let newSubscribers = 0, updatedSubscribers = 0, failedRows = 0, parsedRows = 0;
  let batchRows: Array<{ email: string; tags: string[]; refs: string[]; ipAddress: string | null; lineNumber: number }> = [];
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  await new Promise<void>((resolve, reject) => {
    let hasSettled = false;
    const safeReject = (err: any) => { if (!hasSettled) { hasSettled = true; reject(err); } };
    const safeResolve = () => { if (!hasSettled) { hasSettled = true; resolve(); } };

    rl.on("line", async (line: string) => {
      try {
        currentLineNumber++;
        if (!headerParsed && currentLineNumber === 1) {
          header = line.split(";").map(h => h.trim().toLowerCase());
          emailIdx = header.indexOf("email");
          tagsIdx = header.indexOf("tags");
          refsIdx = header.indexOf("refs");
          ipIdx = header.indexOf("ip_address");
          if (emailIdx === -1) { rl.close(); safeReject(new Error("CSV must have an 'email' column")); return; }
          headerParsed = true;
          return;
        }
        if (!line.trim()) return;
        const cols = line.split(";").map(c => c.trim());
        const email = cols[emailIdx]?.toLowerCase();
        if (!email || !email.includes("@")) { failedRows++; parsedRows++; return; }

        const p2CsvTags = tagsIdx >= 0 && cols[tagsIdx] ? cols[tagsIdx].split(",").map(t => t.trim().toUpperCase()).filter(Boolean) : [];
        const p2CsvRefs = refsIdx >= 0 && cols[refsIdx] ? cols[refsIdx].split(",").map(r => r.trim().toUpperCase()).filter(Boolean) : [];
        const tags = p2ForceMode ? p2ForcedTags : p2CsvTags;
        const refs = p2ForceMode ? p2ForcedRefs : p2CsvRefs;
        const ipAddress = ipIdx >= 0 ? cols[ipIdx] || null : null;

        batchRows.push({ email, tags, refs, ipAddress, lineNumber: currentLineNumber });
        parsedRows++;

        if (batchRows.length >= BATCH_SIZE) {
          rl.pause();
          const result = await bulkUpsertSubscribers(batchRows, tagMode);
          newSubscribers += result.inserted;
          updatedSubscribers += result.updated;
          failedRows += result.failed;
          batchRows = [];
          await storage.updateImportQueueHeartbeat(queueId);
          rl.resume();
        }
      } catch (err) {
        logger.error(`[IMPORT] ${importJobId}: [REFS PHASE 2] Error processing line ${currentLineNumber}: ${err}`);
        failedRows++; parsedRows++;
      }
    });

    rl.on("close", async () => {
      try {
        if (batchRows.length > 0) {
          const result = await bulkUpsertSubscribers(batchRows, tagMode);
          newSubscribers += result.inserted;
          updatedSubscribers += result.updated;
          failedRows += result.failed;
          batchRows = [];
        }
        await storage.updateImportJob(importJobId, {
          status: "completed",
          completedAt: new Date(),
          newSubscribers,
          updatedSubscribers,
          failedRows,
          processedRows: parsedRows,
        });
        onProgress({
          status: "completed",
          processedRows: parsedRows,
          totalRows: parsedRows,
          newSubscribers,
          updatedSubscribers,
          failedRows,
        });
        logger.info(`[IMPORT] ${importJobId}: [REFS PHASE 2] Completed: ${newSubscribers} new, ${updatedSubscribers} updated, ${failedRows} failed`);
        safeResolve();
      } catch (err) {
        safeReject(err);
      }
    });

    rl.on("error", (err) => safeReject(err));
    fileStream.on("error", (err) => safeReject(err));
  });
}

// ─── Public entry point ────────────────────────────────────────────────────────

export async function processImportJob(
  queueId: string,
  importJobId: string,
  onProgress: (data: Partial<JobProgressEvent>) => void
): Promise<void> {
  const queueItem = await storage.getImportQueueItem(queueId);
  if (!queueItem) throw new Error(`Import queue item ${queueId} not found`);

  const csvFilePath = queueItem.csvFilePath;
  const isPhase2 = csvFilePath === "phase2_merge";

  // Early exit: if this import_job is already completed, close the queue item and return.
  // This breaks the re-run cycle that occurs when recoverStuckImportJobs resets a finished
  // import's queue item back to 'pending' (e.g. after a PM2 restart during GIN recreation).
  //
  // WHY only 'completed' and not 'failed'/'cancelled':
  //   The workers.ts .then() finalization contains a safety-net that forces any non-cancelled
  //   job with status !== 'completed' to 'completed'. If we returned early for 'failed' here,
  //   that safety-net would overwrite the failure with 'completed', corrupting the audit trail.
  //   'failed' and 'cancelled' stray queue items are instead closed by the startup recovery in
  //   workers.ts (alreadyFailedResult query) so they are never re-claimed after a PM2 restart.
  const importJobCheck = await storage.getImportJob(importJobId);
  if (importJobCheck?.status === 'completed') {
    logger.info(`[IMPORT] ${importJobId}: already completed, closing re-queued queue item without re-processing`);
    await db.execute(sql`
      UPDATE import_job_queue SET status = 'completed', completed_at = NOW()
      WHERE import_job_id = ${importJobId} AND status IN ('pending', 'processing')
    `);
    return;
  }

  // Check force mode: if either forced list is non-empty, bypass refs detection entirely
  const importJob = await storage.getImportJob(importJobId);
  const forcedTagsJob: string[] = importJob?.forcedTags ?? [];
  const forcedRefsJob: string[] = importJob?.forcedRefs ?? [];
  const isForceMode = forcedTagsJob.length > 0 || forcedRefsJob.length > 0;

  const isRemoveMode = importJob?.removeMode === true;

  logger.info(`[IMPORT] ${importJobId}: Starting — queueId=${queueId}, csvFilePath=${csvFilePath}, phase2=${isPhase2}, forceMode=${isForceMode}, removeMode=${isRemoveMode}`);

  if (isPhase2) {
    await processRefsImportPhase2(queueId, importJobId, csvFilePath, onProgress);
  } else if (isRemoveMode) {
    logger.info(`[IMPORT] ${importJobId}: Remove mode active — bypassing refs-column detection, running direct removal`);
    await processImport(queueId, importJobId, csvFilePath, onProgress);
  } else if (isForceMode) {
    logger.info(`[IMPORT] ${importJobId}: Force mode active — bypassing refs-column detection, running direct import`);
    await processImport(queueId, importJobId, csvFilePath, onProgress);
  } else {
    const hasRefsColumn = await peekCsvHasRefsColumn(csvFilePath);
    logger.info(`[IMPORT] ${importJobId}: Auto-detected CSV format: refs column ${hasRefsColumn ? "present" : "absent"}`);
    if (hasRefsColumn) {
      await processRefsImportPhase1(queueId, importJobId, csvFilePath, onProgress);
    } else {
      await processImport(queueId, importJobId, csvFilePath, onProgress);
    }
  }
}
