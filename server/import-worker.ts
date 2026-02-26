import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import * as readline from "readline";
import * as fs from "fs";
import { from as copyFrom } from "pg-copy-streams";
import { ObjectStorageService } from "./replit_integrations/object_storage/objectStorage";

const { Pool } = pg;

const connectionString = process.env.NEON_DATABASE_URL || process.env.DATABASE_URL;
if (!connectionString) {
  sendIpc("error", { message: "NEON_DATABASE_URL or DATABASE_URL must be set", stack: "" });
  process.exit(1);
}

const isExternalDb = connectionString.includes("neon.tech") || process.env.DB_SSL === "true";
const maskedUrl = connectionString.replace(/\/\/([^:]+):([^@]+)@/, "//$1:***@");
log("info", `Worker DB connection: ${maskedUrl.substring(0, 80)}...`, { isExternalDb });

const CONCURRENCY = 4;
const importPoolMax = Number(process.env.PG_IMPORT_POOL_MAX || 4);

const pool = new Pool({
  connectionString,
  max: importPoolMax,
  min: 1,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 30000,
  statement_timeout: 300000,
  ...(isExternalDb ? { ssl: { rejectUnauthorized: false } } : {}),
});

pool.on("error", (err) => {
  log("error", "Unexpected DB pool error on idle client", { error: err.message });
});

pool.on("connect", (client) => {
  if (isExternalDb) {
    client.query("SET search_path TO public").catch(() => {});
  }
});

const db = drizzle(pool);

async function ensureDbConnection(maxRetries = 3): Promise<void> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const client = await pool.connect();
      await client.query("SELECT 1");
      client.release();
      log("info", `DB connection established on attempt ${attempt}`);
      return;
    } catch (err: any) {
      log("warn", `DB connection attempt ${attempt}/${maxRetries} failed: ${err.message}`);
      if (attempt < maxRetries) {
        const delay = attempt * 3000;
        await new Promise((r) => setTimeout(r, delay));
      } else {
        throw new Error(`Failed to connect to database after ${maxRetries} attempts: ${err.message}`);
      }
    }
  }
}

const objectStorageService = new ObjectStorageService();

type LogLevel = "debug" | "info" | "warn" | "error" | "fatal";

function log(level: LogLevel, msg: string, extra?: Record<string, any>) {
  const timestamp = new Date().toISOString();
  const extraStr = extra && Object.keys(extra).length > 0 ? " " + JSON.stringify(extra) : "";
  const formatted = `${timestamp} [${level.toUpperCase()}] ${msg}${extraStr}`;

  if (level === "error" || level === "fatal") {
    console.error(formatted);
  } else if (level === "warn") {
    console.warn(formatted);
  } else {
    console.log(formatted);
  }

  sendIpc("log", { level, message: msg, extra });
}

function sendIpc(type: string, data: any) {
  if (process.send) {
    try {
      process.send({ type, data });
    } catch (_) {}
  }
}

interface ImportQueueItem {
  id: string;
  importJobId: string;
  csvFilePath: string;
  totalLines: number;
  processedLines: number;
  fileSizeBytes: number;
  processedBytes: number;
  lastCheckpointLine: number;
  status: string;
}

interface ImportJob {
  id: string;
  filename: string;
  totalRows: number;
  processedRows: number;
  newSubscribers: number;
  updatedSubscribers: number;
  failedRows: number;
  status: string;
  tagMode: string;
  importTarget: string;
  detectedRefs: string[];
  cleanExistingRefs: boolean;
  deleteExistingRefs: boolean;
  errorMessage: string | null;
}

async function getImportQueueItem(queueId: string): Promise<ImportQueueItem | null> {
  const result = await db.execute(sql`SELECT * FROM import_job_queue WHERE id = ${queueId}`);
  if (result.rows.length === 0) return null;
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
  };
}

async function getImportJob(importJobId: string): Promise<ImportJob | null> {
  const result = await db.execute(sql`SELECT * FROM import_jobs WHERE id = ${importJobId}`);
  if (result.rows.length === 0) return null;
  const row = result.rows[0] as any;
  return {
    id: row.id,
    filename: row.filename,
    totalRows: row.total_rows,
    processedRows: row.processed_rows,
    newSubscribers: row.new_subscribers,
    updatedSubscribers: row.updated_subscribers,
    failedRows: row.failed_rows,
    status: row.status,
    tagMode: row.tag_mode || "merge",
    importTarget: row.import_target || "tags",
    detectedRefs: row.detected_refs || [],
    cleanExistingRefs: row.clean_existing_refs || false,
    deleteExistingRefs: row.delete_existing_refs || false,
    errorMessage: row.error_message,
  };
}

async function updateImportJob(importJobId: string, data: Record<string, any>): Promise<void> {
  const setClauses: string[] = [];
  const params: any[] = [];
  let paramIdx = 1;

  if (data.status !== undefined) {
    setClauses.push(`status = $${paramIdx++}`);
    params.push(data.status);
  }
  if (data.processedRows !== undefined) {
    setClauses.push(`processed_rows = $${paramIdx++}`);
    params.push(data.processedRows);
  }
  if (data.newSubscribers !== undefined) {
    setClauses.push(`new_subscribers = $${paramIdx++}`);
    params.push(data.newSubscribers);
  }
  if (data.updatedSubscribers !== undefined) {
    setClauses.push(`updated_subscribers = $${paramIdx++}`);
    params.push(data.updatedSubscribers);
  }
  if (data.failedRows !== undefined) {
    setClauses.push(`failed_rows = $${paramIdx++}`);
    params.push(data.failedRows);
  }
  if (data.errorMessage !== undefined) {
    setClauses.push(`error_message = $${paramIdx++}`);
    params.push(data.errorMessage);
  }
  if (data.startedAt !== undefined) {
    setClauses.push(`started_at = $${paramIdx++}`);
    params.push(data.startedAt);
  }
  if (data.completedAt !== undefined) {
    setClauses.push(`completed_at = $${paramIdx++}`);
    params.push(data.completedAt);
  }
  if (data.detectedRefs !== undefined) {
    setClauses.push(`detected_refs = $${paramIdx++}::text[]`);
    params.push(data.detectedRefs);
  }

  if (setClauses.length === 0) return;
  params.push(importJobId);
  await pool.query(`UPDATE import_jobs SET ${setClauses.join(", ")} WHERE id = $${paramIdx}`, params);
}

async function updateImportQueueHeartbeat(queueId: string): Promise<void> {
  await db.execute(sql`UPDATE import_job_queue SET heartbeat = NOW() WHERE id = ${queueId}`);
}

async function updateImportQueueProgress(queueId: string, processedRows: number): Promise<void> {
  await db.execute(sql`
    UPDATE import_job_queue
    SET processed_lines = ${processedRows}, heartbeat = NOW()
    WHERE id = ${queueId}
  `);
}

async function updateImportQueueProgressWithCheckpoint(
  queueId: string,
  processedRows: number,
  processedBytes: number,
  checkpointLine: number
): Promise<void> {
  await db.execute(sql`
    UPDATE import_job_queue
    SET processed_lines = ${processedRows},
        processed_bytes = ${processedBytes},
        last_checkpoint_line = ${checkpointLine},
        heartbeat = NOW()
    WHERE id = ${queueId}
  `);
}

async function dropSubscriberGinIndexes(): Promise<void> {
  log("info", "Dropping GIN indexes for large tag import optimization");
  await db.execute(sql`DROP INDEX IF EXISTS tags_gin_idx`);
  await db.execute(sql`DROP INDEX IF EXISTS refs_gin_idx`);
  log("info", "GIN indexes dropped (tags_gin_idx, refs_gin_idx)");
}

async function recreateSubscriberGinIndexes(): Promise<void> {
  log("info", "Recreating GIN indexes after import");
  try {
    await db.execute(sql`CREATE INDEX CONCURRENTLY IF NOT EXISTS tags_gin_idx ON subscribers USING gin (tags)`);
  } catch (err: any) {
    log("info", "CONCURRENTLY failed for tags_gin_idx, trying regular CREATE INDEX");
    await db.execute(sql`CREATE INDEX IF NOT EXISTS tags_gin_idx ON subscribers USING gin (tags)`);
  }
  try {
    await db.execute(sql`CREATE INDEX CONCURRENTLY IF NOT EXISTS refs_gin_idx ON subscribers USING gin (refs)`);
  } catch (err: any) {
    log("info", "CONCURRENTLY failed for refs_gin_idx, trying regular CREATE INDEX");
    await db.execute(sql`CREATE INDEX IF NOT EXISTS refs_gin_idx ON subscribers USING gin (refs)`);
  }
  log("info", "GIN indexes recreated (tags_gin_idx, refs_gin_idx)");
}

async function areGinIndexesPresent(): Promise<boolean> {
  const result = await db.execute(sql`
    SELECT COUNT(*) as count
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'subscribers'
      AND indexname IN ('tags_gin_idx', 'refs_gin_idx')
  `);
  const count = parseInt((result.rows[0] as any)?.count || "0", 10);
  return count >= 2;
}

async function logError(data: {
  type: string;
  severity: string;
  message: string;
  importJobId?: string;
  details?: string;
}): Promise<void> {
  try {
    await db.execute(sql`
      INSERT INTO error_logs (type, severity, message, import_job_id, details)
      VALUES (${data.type}, ${data.severity}, ${data.message}, ${data.importJobId || null}, ${data.details || null})
    `);
  } catch (_) {}
}

function getImportConfig() {
  return { batchSize: 25000 };
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

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

async function copyBatchUpsert(
  rows: Array<{ email: string; tags: string[]; refs: string[]; ipAddress: string | null }>,
  tagMode: "merge" | "override"
): Promise<{ inserted: number; updated: number }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(`
      CREATE TEMP TABLE import_staging_batch (
        email TEXT NOT NULL,
        tags TEXT[] NOT NULL,
        refs TEXT[] NOT NULL,
        ip_address TEXT
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
      : `tags = COALESCE(
          (SELECT array_agg(DISTINCT t) FROM unnest(subscribers.tags || EXCLUDED.tags) AS t WHERE t IS NOT NULL),
          ARRAY[]::text[]
        )`;

    const refsConflict = `refs = COALESCE(
          (SELECT array_agg(DISTINCT r) FROM unnest(subscribers.refs || EXCLUDED.refs) AS r WHERE r IS NOT NULL),
          ARRAY[]::text[]
        )`;

    const mergeResult = await client.query(`
      WITH upserted AS (
        INSERT INTO subscribers (email, tags, refs, ip_address, import_date)
        SELECT email, tags, refs, ip_address, NOW()
        FROM import_staging_batch
        ON CONFLICT (email) DO UPDATE SET
          ${tagsConflict},
          ${refsConflict},
          ip_address = COALESCE(EXCLUDED.ip_address, subscribers.ip_address)
        RETURNING (xmax = 0) AS is_insert
      )
      SELECT
        COUNT(*) FILTER (WHERE is_insert = true) AS inserted,
        COUNT(*) FILTER (WHERE is_insert = false) AS updated
      FROM upserted
    `);

    await client.query("COMMIT");

    return {
      inserted: parseInt(mergeResult.rows[0]?.inserted || "0"),
      updated: parseInt(mergeResult.rows[0]?.updated || "0"),
    };
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
    : `tags = COALESCE(
        (SELECT array_agg(DISTINCT t) FROM unnest(subscribers.tags || EXCLUDED.tags) AS t WHERE t IS NOT NULL),
        ARRAY[]::text[]
      )`;

  const refsConflict = `refs = COALESCE(
        (SELECT array_agg(DISTINCT r) FROM unnest(subscribers.refs || EXCLUDED.refs) AS r WHERE r IS NOT NULL),
        ARRAY[]::text[]
      )`;

  const query = `
    WITH upserted AS (
      INSERT INTO subscribers (email, tags, refs, ip_address, import_date)
      VALUES ${valuesClauses.join(", ")}
      ON CONFLICT (email) DO UPDATE SET
        ${tagsConflict},
        ${refsConflict},
        ip_address = COALESCE(EXCLUDED.ip_address, subscribers.ip_address)
      RETURNING (xmax = 0) AS is_insert
    )
    SELECT
      COUNT(*) FILTER (WHERE is_insert = true) AS inserted,
      COUNT(*) FILTER (WHERE is_insert = false) AS updated
    FROM upserted
  `;

  const result = await pool.query(query, params);
  return {
    inserted: parseInt(result.rows[0]?.inserted || "0"),
    updated: parseInt(result.rows[0]?.updated || "0"),
  };
}

async function singleUpsert(
  row: { email: string; tags: string[]; refs: string[]; ipAddress: string | null },
  tagMode: "merge" | "override"
): Promise<"inserted" | "updated"> {
  const tagsConflict = tagMode === "override"
    ? `tags = EXCLUDED.tags`
    : `tags = COALESCE(
        (SELECT array_agg(DISTINCT t) FROM unnest(subscribers.tags || EXCLUDED.tags) AS t WHERE t IS NOT NULL),
        ARRAY[]::text[]
      )`;

  const refsConflict = `refs = COALESCE(
        (SELECT array_agg(DISTINCT r) FROM unnest(subscribers.refs || EXCLUDED.refs) AS r WHERE r IS NOT NULL),
        ARRAY[]::text[]
      )`;

  const result = await pool.query(
    `INSERT INTO subscribers (email, tags, refs, ip_address, import_date)
     VALUES ($1, $2::text[], $3::text[], $4, NOW())
     ON CONFLICT (email) DO UPDATE SET
       ${tagsConflict},
       ${refsConflict},
       ip_address = COALESCE(EXCLUDED.ip_address, subscribers.ip_address)
     RETURNING (xmax = 0) AS is_insert`,
    [row.email.toLowerCase(), row.tags, row.refs, row.ipAddress]
  );
  return result.rows[0]?.is_insert ? "inserted" : "updated";
}

async function insertFallbackUpsert(
  rows: Array<{ email: string; tags: string[]; refs: string[]; ipAddress: string | null; lineNumber: number }>,
  tagMode: "merge" | "override" = "merge"
): Promise<{ inserted: number; updated: number; failed: number }> {
  if (rows.length === 0) return { inserted: 0, updated: 0, failed: 0 };

  const CHUNK_SIZE = 500;
  let totalInserted = 0;
  let totalUpdated = 0;
  let totalFailed = 0;

  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    const chunk = rows.slice(i, i + CHUNK_SIZE);
    try {
      const result = await directBatchUpsert(chunk, tagMode);
      totalInserted += result.inserted;
      totalUpdated += result.updated;
    } catch (err: any) {
      log("error", `Batch upsert chunk failed: ${err.message}`);
      for (const row of chunk) {
        try {
          const result = await singleUpsert(row, tagMode);
          if (result === "inserted") totalInserted++;
          else totalUpdated++;
        } catch (individualErr: any) {
          totalFailed++;
          log("error", `Individual insert failed for ${row.email}: ${individualErr.message}`);
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
    log("warn", `COPY batch failed, falling back to INSERT: ${err.message}`);
    return await insertFallbackUpsert(rows, tagMode);
  }
}

async function copyBatchUpsertRefs(
  rows: Array<{ email: string; refs: string[]; ipAddress: string | null }>,
): Promise<{ inserted: number; updated: number }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(`
      CREATE TEMP TABLE import_staging_batch (
        email TEXT NOT NULL,
        refs TEXT[] NOT NULL,
        ip_address TEXT
      ) ON COMMIT DROP
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

    const mergeResult = await client.query(`
      WITH upserted AS (
        INSERT INTO subscribers (email, refs, ip_address, import_date)
        SELECT email, refs, ip_address, NOW()
        FROM import_staging_batch
        ON CONFLICT (email) DO UPDATE SET
          refs = (
            SELECT COALESCE(array_agg(DISTINCT r), ARRAY[]::text[])
            FROM unnest(subscribers.refs || EXCLUDED.refs) AS r
            WHERE r IS NOT NULL
          ),
          ip_address = COALESCE(EXCLUDED.ip_address, subscribers.ip_address),
          import_date = NOW()
        RETURNING (xmax = 0) AS is_insert
      )
      SELECT
        COUNT(*) FILTER (WHERE is_insert = true) AS inserted,
        COUNT(*) FILTER (WHERE is_insert = false) AS updated
      FROM upserted
    `);

    await client.query("COMMIT");

    return {
      inserted: parseInt(mergeResult.rows[0]?.inserted || "0"),
      updated: parseInt(mergeResult.rows[0]?.updated || "0"),
    };
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

  const query = `
    WITH upserted AS (
      INSERT INTO subscribers (email, refs, ip_address, import_date)
      VALUES ${valuesClauses.join(", ")}
      ON CONFLICT (email) DO UPDATE SET
        refs = (
          SELECT COALESCE(array_agg(DISTINCT r), ARRAY[]::text[])
          FROM unnest(subscribers.refs || EXCLUDED.refs) AS r
          WHERE r IS NOT NULL
        ),
        ip_address = COALESCE(EXCLUDED.ip_address, subscribers.ip_address),
        import_date = NOW()
      RETURNING (xmax = 0) AS is_insert
    )
    SELECT
      COUNT(*) FILTER (WHERE is_insert = true) AS inserted,
      COUNT(*) FILTER (WHERE is_insert = false) AS updated
    FROM upserted
  `;

  const result = await pool.query(query, params);
  return {
    inserted: parseInt(result.rows[0]?.inserted || "0"),
    updated: parseInt(result.rows[0]?.updated || "0"),
  };
}

async function bulkUpsertSubscribersRefs(
  rows: Array<{ email: string; refs: string[]; ipAddress: string | null; lineNumber: number }>,
): Promise<{ inserted: number; updated: number; failed: number }> {
  if (rows.length === 0) return { inserted: 0, updated: 0, failed: 0 };

  try {
    const result = await copyBatchUpsertRefs(rows);
    return { ...result, failed: 0 };
  } catch (err: any) {
    log("warn", `COPY refs batch failed, falling back to INSERT: ${err.message}`);
    const CHUNK_SIZE = 500;
    let totalInserted = 0;
    let totalUpdated = 0;
    let totalFailed = 0;

    for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
      const chunk = rows.slice(i, i + CHUNK_SIZE);
      try {
        const result = await directBatchUpsertRefs(chunk);
        totalInserted += result.inserted;
        totalUpdated += result.updated;
      } catch (chunkErr: any) {
        log("error", `Refs batch upsert chunk failed: ${chunkErr.message}`);
        totalFailed += chunk.length;
      }
    }
    return { inserted: totalInserted, updated: totalUpdated, failed: totalFailed };
  }
}

async function detectImportRefsFromStaging(importJobId: string): Promise<string[]> {
  const result = await db.execute(sql`
    SELECT DISTINCT unnest(refs) AS ref
    FROM import_staging
    WHERE job_id = ${importJobId}
    ORDER BY ref
  `);
  return (result.rows as any[]).map((r: any) => r.ref);
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
      UPDATE subscribers
      SET refs = (
        SELECT COALESCE(array_agg(r), ARRAY[]::text[])
        FROM unnest(refs) AS r
        WHERE r != ALL($1::text[])
      )
      WHERE id IN (
        SELECT id FROM subscribers
        WHERE refs && $1::text[]
        LIMIT $2
      )
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
    `SELECT COUNT(*) AS count FROM subscribers WHERE refs && $1::text[] AND 'BCK' = ANY(tags)`,
    [refs]
  );
  const bckProtected = parseInt(bckResult.rows[0]?.count || "0");

  const BATCH_SIZE = 50000;
  let totalDeleted = 0;

  while (true) {
    const result = await pool.query(`
      DELETE FROM subscribers
      WHERE id IN (
        SELECT id FROM subscribers
        WHERE refs && $1::text[]
          AND NOT ('BCK' = ANY(tags))
        LIMIT $2
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
  const result = await pool.query(`
    WITH upserted AS (
      INSERT INTO subscribers (email, refs, import_date)
      SELECT email, refs, NOW()
      FROM import_staging WHERE job_id = $1
      ON CONFLICT (email) DO UPDATE SET
        refs = (
          SELECT COALESCE(array_agg(DISTINCT r), ARRAY[]::text[])
          FROM unnest(subscribers.refs || EXCLUDED.refs) AS r
          WHERE r IS NOT NULL
        ),
        import_date = NOW()
      RETURNING (xmax = 0) AS is_insert
    )
    SELECT
      COUNT(*) FILTER (WHERE is_insert = true) AS inserted,
      COUNT(*) FILTER (WHERE is_insert = false) AS updated
    FROM upserted
  `, [importJobId]);

  return {
    inserted: parseInt(result.rows[0]?.inserted || "0"),
    updated: parseInt(result.rows[0]?.updated || "0"),
  };
}

async function cleanupStagingData(importJobId: string): Promise<void> {
  await db.execute(sql`DELETE FROM import_staging WHERE job_id = ${importJobId}`);
}

async function processImport(queueId: string, importJobId: string, csvFilePath: string) {
  log("info", `Processing job ${importJobId} from file: ${csvFilePath}`);

  await ensureDbConnection();

  const isObjectStorage = csvFilePath.startsWith("/objects/");
  let fileSizeBytes: number;
  let fileStream: NodeJS.ReadableStream;

  if (isObjectStorage) {
    const exists = await objectStorageService.objectExists(csvFilePath);
    if (!exists) {
      throw new Error(
        `CSV file not found in object storage: ${csvFilePath}. This can happen if the file was deleted or never uploaded. Please re-upload the file.`
      );
    }
    fileStream = await objectStorageService.getObjectStream(csvFilePath);
    const queueItemForSize = await getImportQueueItem(queueId);
    fileSizeBytes = queueItemForSize?.fileSizeBytes || 0;
    log("info", `${importJobId}: Using object storage, size from queue: ${Math.round(fileSizeBytes / 1024 / 1024)}MB`);
  } else {
    if (!fs.existsSync(csvFilePath)) {
      throw new Error(
        `CSV file not found: ${csvFilePath}. This can happen if the server was restarted or redeployed after uploading the file. Please re-upload the file.`
      );
    }
    const fileStat = fs.statSync(csvFilePath);
    fileSizeBytes = fileStat.size;
    fileStream = fs.createReadStream(csvFilePath, {
      encoding: "utf-8",
      highWaterMark: 256 * 1024,
    });
    log("info", `${importJobId}: Using local filesystem (legacy), size: ${Math.round(fileSizeBytes / 1024 / 1024)}MB`);
  }

  const queueItem = await getImportQueueItem(queueId);
  const resumeFromLine = queueItem?.lastCheckpointLine || 0;

  const importJob = await getImportJob(importJobId);
  const tagMode = (importJob?.tagMode as "merge" | "override") || "merge";

  log("info", `${importJobId}: File size: ${Math.round(fileSizeBytes / 1024 / 1024)}MB, tag mode: ${tagMode}, resume from line: ${resumeFromLine}`);

  await updateImportJob(importJobId, { status: "processing", startedAt: new Date() });

  const importConfig = getImportConfig();
  const BATCH_SIZE = importConfig.batchSize;
  const PROGRESS_UPDATE_INTERVAL_MS = 2000;
  const HEARTBEAT_INTERVAL = 30000;
  const CHECKPOINT_INTERVAL = 100000;
  const LARGE_IMPORT_THRESHOLD = 100000;

  const MAX_INFLIGHT = CONCURRENCY;
  let inflightCount = 0;
  let inflightResolvers: Array<() => void> = [];

  function waitForSlot(): Promise<void> {
    if (inflightCount < MAX_INFLIGHT) return Promise.resolve();
    return new Promise<void>((resolve) => {
      inflightResolvers.push(resolve);
    });
  }

  function releaseSlot() {
    inflightCount--;
    if (inflightResolvers.length > 0) {
      const resolve = inflightResolvers.shift()!;
      resolve();
    }
  }

  function waitForAllInflight(): Promise<void> {
    if (inflightCount === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const check = () => {
        if (inflightCount === 0) resolve();
        else setTimeout(check, 50);
      };
      check();
    });
  }

  log("info", `${importJobId}: Import config - batch: ${BATCH_SIZE}, concurrency: ${MAX_INFLIGHT}`);

  const totalLines = queueItem?.totalLines || 0;
  const isLargeImport = totalLines > LARGE_IMPORT_THRESHOLD;
  let ginIndexesDropped = false;

  if (isLargeImport && resumeFromLine === 0) {
    try {
      log("info", `${importJobId}: Large import detected (${totalLines} rows), dropping GIN indexes for faster processing`);
      await dropSubscriberGinIndexes();
      ginIndexesDropped = true;
    } catch (err: any) {
      log("error", `${importJobId}: Failed to drop GIN indexes: ${err.message}`);
    }
  }

  let newSubscribers = resumeFromLine > 0 ? (importJob?.newSubscribers || 0) : 0;
  let updatedSubscribers = resumeFromLine > 0 ? (importJob?.updatedSubscribers || 0) : 0;
  let failedRows = resumeFromLine > 0 ? (importJob?.failedRows || 0) : 0;
  let committedRows = resumeFromLine > 0 ? (newSubscribers + updatedSubscribers + failedRows) : 0;
  let parsedRows = committedRows;
  let lastHeartbeat = Date.now();
  let lastCheckpointLine = resumeFromLine;
  let processedBytes = queueItem?.processedBytes || 0;

  if (resumeFromLine > 0) {
    log("info", `${importJobId}: Resuming from line ${resumeFromLine}, committed rows: ${committedRows} (new: ${newSubscribers}, updated: ${updatedSubscribers}, failed: ${failedRows})`);
  }

  let header: string[] = [];
  let emailIdx = -1;
  let tagsIdx = -1;
  let refsIdx = -1;
  let ipIdx = -1;
  let headerParsed = false;
  let hasRefsColumn = false;

  let batchRows: Array<{ email: string; tags: string[]; refs: string[]; ipAddress: string | null; lineNumber: number }> = [];
  let currentLineNumber = 0;
  let batchNumber = 0;
  const startTime = Date.now();

  let isCancelled = false;

  async function checkCancellation(): Promise<boolean> {
    try {
      const job = await getImportJob(importJobId);
      if (job?.status === "cancelled") {
        log("info", `${importJobId}: Job cancelled by user, stopping processing`);
        isCancelled = true;
        return true;
      }
    } catch (_) {}
    return false;
  }

  let batchError: Error | null = null;

  interface BatchResult {
    inserted: number;
    updated: number;
    failed: number;
    batchSize: number;
    durationMs: number;
    batchNumber: number;
  }

  const pendingResults: BatchResult[] = [];

  function submitBatch(): void {
    if (batchRows.length === 0) return;

    batchNumber++;
    const batch = batchRows;
    const thisBatchNumber = batchNumber;
    batchRows = [];
    inflightCount++;

    const batchStart = Date.now();
    bulkUpsertSubscribers(batch, tagMode)
      .then((result) => {
        pendingResults.push({
          inserted: result.inserted,
          updated: result.updated,
          failed: result.failed,
          batchSize: batch.length,
          durationMs: Date.now() - batchStart,
          batchNumber: thisBatchNumber,
        });
      })
      .catch((err) => {
        log("error", `${importJobId}: Batch ${thisBatchNumber} failed critically: ${err.message}`);
        batchError = err;
        pendingResults.push({
          inserted: 0,
          updated: 0,
          failed: batch.length,
          batchSize: batch.length,
          durationMs: Date.now() - batchStart,
          batchNumber: thisBatchNumber,
        });
      })
      .finally(() => {
        releaseSlot();
      });
  }

  function drainResults(): void {
    while (pendingResults.length > 0) {
      const r = pendingResults.shift()!;
      newSubscribers += r.inserted;
      updatedSubscribers += r.updated;
      failedRows += r.failed;
      committedRows += r.inserted + r.updated + r.failed;

      const rowsPerSecond = r.batchSize / (r.durationMs / 1000);
      log("info", `${importJobId}: Batch ${r.batchNumber} (${r.batchSize} rows) in ${r.durationMs}ms (${Math.round(rowsPerSecond)}/s)`);
    }
  }

  async function flushProgress(): Promise<void> {
    drainResults();

    const now = Date.now();
    if (now - lastHeartbeat > HEARTBEAT_INTERVAL) {
      await updateImportQueueHeartbeat(queueId);
      lastHeartbeat = now;
    }

    await updateImportQueueProgress(queueId, committedRows);
    await updateImportJob(importJobId, {
      processedRows: committedRows,
      newSubscribers,
      updatedSubscribers,
      failedRows,
    });

    if (committedRows - lastCheckpointLine >= CHECKPOINT_INTERVAL) {
      await updateImportQueueProgressWithCheckpoint(queueId, committedRows, processedBytes, currentLineNumber);
      lastCheckpointLine = committedRows;
      log("info", `${importJobId}: Checkpoint at line ${currentLineNumber}, ${committedRows.toLocaleString()} rows committed`);
    }

    const elapsedSec = (now - startTime) / 1000;
    const commitRate = committedRows / elapsedSec;
    log("info", `${importJobId}: Progress - committed: ${committedRows.toLocaleString()} (${Math.round(commitRate)}/s), new: ${newSubscribers.toLocaleString()}, updated: ${updatedSubscribers.toLocaleString()}, failed: ${failedRows.toLocaleString()}`);

    sendIpc("progress", { committedRows, newSubscribers, updatedSubscribers, failedRows, parsedRows });
  }

  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  const progressUpdateTimer = setInterval(async () => {
    try {
      drainResults();

      const now = Date.now();
      if (now - lastHeartbeat > HEARTBEAT_INTERVAL) {
        await updateImportQueueHeartbeat(queueId);
        lastHeartbeat = now;
      }

      await updateImportQueueProgress(queueId, committedRows);
      await updateImportJob(importJobId, {
        processedRows: committedRows,
        newSubscribers,
        updatedSubscribers,
        failedRows,
      });

      const elapsedSec = (now - startTime) / 1000;
      const commitRate = committedRows / elapsedSec;
      const parseRate = parsedRows / elapsedSec;
      log("info", `${importJobId}: Timer progress - parsed: ${parsedRows.toLocaleString()} (${Math.round(parseRate)}/s), committed: ${committedRows.toLocaleString()} (${Math.round(commitRate)}/s)`);

      sendIpc("progress", { committedRows, newSubscribers, updatedSubscribers, failedRows, parsedRows });
    } catch (err: any) {
      log("error", `${importJobId}: Progress update failed: ${err.message}`);
    }
  }, PROGRESS_UPDATE_INTERVAL_MS);

  return new Promise<void>((resolve, reject) => {
    let hasSettled = false;
    const safeReject = (err: any) => {
      if (hasSettled) return;
      hasSettled = true;
      clearInterval(progressUpdateTimer);
      if (ginIndexesDropped) {
        recreateSubscriberGinIndexes()
          .then(() => log("info", `${importJobId}: GIN indexes recovered after error`))
          .catch((indexErr) => log("error", `${importJobId}: Failed to recover GIN indexes: ${indexErr}`));
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

          log("info", `${importJobId}: Header columns: ${header.join(", ")} (refs column: ${hasRefsColumn ? "yes" : "no"})`);

          if (emailIdx === -1) {
            rl.close();
            await updateImportJob(importJobId, {
              status: "failed",
              errorMessage: "CSV must have an 'email' column",
            });
            safeReject(new Error("CSV must have an 'email' column"));
            return;
          }

          headerParsed = true;
          return;
        }

        if (currentLineNumber <= resumeFromLine) {
          return;
        }

        if (!line.trim()) {
          return;
        }

        try {
          const cols = line.split(";").map((c) => c.trim());
          const email = cols[emailIdx]?.toLowerCase();

          if (!email || !email.includes("@")) {
            failedRows++;
            parsedRows++;
            committedRows++;
            return;
          }

          const tags =
            tagsIdx >= 0 && cols[tagsIdx]
              ? cols[tagsIdx]
                  .split(",")
                  .map((t) => t.trim().toUpperCase())
                  .filter(Boolean)
              : [];
          const refs =
            refsIdx >= 0 && cols[refsIdx]
              ? cols[refsIdx]
                  .split("-")
                  .map((r) => r.trim().toLowerCase())
                  .filter(Boolean)
              : [];
          const ipAddress = ipIdx >= 0 ? cols[ipIdx] || null : null;

          batchRows.push({ email, tags, refs, ipAddress, lineNumber: currentLineNumber });
          parsedRows++;

          if (batchRows.length >= BATCH_SIZE) {
            rl.pause();

            if (await checkCancellation()) {
              rl.close();
              return;
            }

            if (batchError) {
              rl.close();
              safeReject(batchError);
              return;
            }

            await waitForSlot();
            submitBatch();
            await flushProgress();

            rl.resume();
          }
        } catch (parseErr) {
          failedRows++;
          parsedRows++;
          committedRows++;
        }
      } catch (err) {
        log("error", `Error processing line ${currentLineNumber}: ${err}`);
        failedRows++;
        parsedRows++;
        committedRows++;
      }
    });

    rl.on("close", async () => {
      clearInterval(progressUpdateTimer);

      try {
        if (batchRows.length > 0 && !isCancelled) {
          await waitForSlot();
          submitBatch();
        }

        await waitForAllInflight();
        await flushProgress();

        if (batchError && !isCancelled) {
          throw batchError;
        }

        const currentJob = await getImportJob(importJobId);
        const wasExternallyCancelled = currentJob?.status === "cancelled";

        if (isCancelled || wasExternallyCancelled) {
          log("info", `${importJobId}: Processing stopped due to cancellation at line ${currentLineNumber} (committed: ${committedRows}, parsed: ${parsedRows})`);

          await updateImportJob(importJobId, {
            processedRows: committedRows,
            newSubscribers,
            updatedSubscribers,
            failedRows,
          });

          try {
            if (isObjectStorage) {
              await objectStorageService.deleteStorageObject(csvFilePath);
              log("info", `${importJobId}: Cleaned up CSV file from object storage after cancellation`);
            } else {
              fs.unlinkSync(csvFilePath);
              log("info", `${importJobId}: Cleaned up CSV file from local filesystem after cancellation`);
            }
          } catch (cleanupErr) {
            log("error", `Failed to clean up CSV file after cancellation: ${csvFilePath}`);
          }

          if (ginIndexesDropped) {
            try {
              log("info", `${importJobId}: Recreating GIN indexes after cancelled import`);
              await recreateSubscriberGinIndexes();
            } catch (indexErr) {
              log("error", `${importJobId}: Failed to recreate GIN indexes after cancellation`);
            }
          }

          safeResolve();
          return;
        }

        await updateImportJob(importJobId, {
          status: "completed",
          completedAt: new Date(),
          processedRows: committedRows,
          newSubscribers,
          updatedSubscribers,
          failedRows,
        });

        await updateImportQueueProgressWithCheckpoint(queueId, committedRows, processedBytes, currentLineNumber);

        if (isLargeImport) {
          try {
            const indexesPresent = await areGinIndexesPresent();
            if (!indexesPresent) {
              log("info", `${importJobId}: GIN indexes missing (dropped=${ginIndexesDropped}), recreating after import`);
              await recreateSubscriberGinIndexes();
            } else if (ginIndexesDropped) {
              log("info", `${importJobId}: GIN indexes already present despite being dropped this run`);
            }
          } catch (indexErr: any) {
            log("error", `${importJobId}: Failed to recreate GIN indexes: ${indexErr.message}`);
            await logError({
              type: "index_recreation_failed",
              severity: "warning",
              message: `Failed to recreate GIN indexes after import: ${indexErr.message}`,
              importJobId,
              details: indexErr?.stack || String(indexErr),
            });
          }
        }

        try {
          if (isObjectStorage) {
            const deleted = await objectStorageService.deleteStorageObject(csvFilePath);
            if (deleted) {
              log("info", `${importJobId}: Cleaned up CSV file from object storage`);
            } else {
              log("error", `${importJobId}: Failed to delete CSV file from object storage: ${csvFilePath}`);
            }
          } else {
            fs.unlinkSync(csvFilePath);
            log("info", `${importJobId}: Cleaned up CSV file from local filesystem`);
          }
        } catch (err) {
          log("error", `Failed to clean up CSV file: ${csvFilePath}`);
        }

        const totalDuration = (Date.now() - startTime) / 1000;
        const finalRowsPerSecond = committedRows / totalDuration;
        log("info", `${importJobId}: Complete in ${Math.round(totalDuration)}s (${Math.round(finalRowsPerSecond)}/s) - committed: ${committedRows}, new: ${newSubscribers}, updated: ${updatedSubscribers}, failed: ${failedRows}`);

        sendIpc("complete", {
          committedRows,
          newSubscribers,
          updatedSubscribers,
          failedRows,
          duration: totalDuration,
        });

        safeResolve();
      } catch (err) {
        safeReject(err);
      }
    });

    rl.on("error", (err) => {
      log("error", `Stream error: ${err}`);
      safeReject(err);
    });

    fileStream.on("error", (err) => {
      log("error", `File stream error: ${err}`);
      safeReject(err);
    });
  });
}

async function processRefsImportPhase1(queueId: string, importJobId: string, csvFilePath: string) {
  log("info", `[REFS PHASE 1] Staging refs for job ${importJobId} from file: ${csvFilePath}`);

  await ensureDbConnection();

  const isObjectStorage = csvFilePath.startsWith("/objects/");
  let fileStream: NodeJS.ReadableStream;

  if (isObjectStorage) {
    const exists = await objectStorageService.objectExists(csvFilePath);
    if (!exists) {
      throw new Error(`CSV file not found in object storage: ${csvFilePath}`);
    }
    fileStream = await objectStorageService.getObjectStream(csvFilePath);
  } else {
    if (!fs.existsSync(csvFilePath)) {
      throw new Error(`CSV file not found: ${csvFilePath}`);
    }
    fileStream = fs.createReadStream(csvFilePath, { encoding: "utf-8", highWaterMark: 256 * 1024 });
  }

  await updateImportJob(importJobId, { status: "processing", startedAt: new Date() });

  const BATCH_SIZE = 25000;
  let header: string[] = [];
  let emailIdx = -1;
  let tagsIdx = -1;
  let refsColIdx = -1;
  let ipIdx = -1;
  let headerParsed = false;
  let useRefsColumn = false;
  let currentLineNumber = 0;
  let parsedRows = 0;
  let failedRows = 0;

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

          log("info", `[REFS PHASE 1] Header: ${header.join(", ")} (refs column: ${useRefsColumn ? "yes, using refs column" : "no, falling back to tags column"})`);

          if (emailIdx === -1) {
            rl.close();
            await updateImportJob(importJobId, { status: "failed", errorMessage: "CSV must have an 'email' column" });
            safeReject(new Error("CSV must have an 'email' column"));
            return;
          }

          headerParsed = true;
          return;
        }

        if (!line.trim()) return;

        const cols = line.split(";").map((c) => c.trim());
        const email = cols[emailIdx]?.toLowerCase();

        if (!email || !email.includes("@")) {
          failedRows++;
          parsedRows++;
          return;
        }

        const refsSource = useRefsColumn ? refsColIdx : tagsIdx;
        const refs =
          refsSource >= 0 && cols[refsSource]
            ? cols[refsSource]
                .split("-")
                .map((r) => r.trim().toLowerCase())
                .filter(Boolean)
            : [];
        const ipAddress = ipIdx >= 0 ? cols[ipIdx] || null : null;

        batchRows.push({ email, refs, ipAddress });
        parsedRows++;

        if (batchRows.length >= BATCH_SIZE) {
          rl.pause();
          await stageRefsToImportStaging(importJobId, batchRows);
          batchRows = [];
          await updateImportQueueHeartbeat(queueId);
          rl.resume();
        }
      } catch (err) {
        log("error", `[REFS PHASE 1] Error processing line ${currentLineNumber}: ${err}`);
        failedRows++;
        parsedRows++;
      }
    });

    rl.on("close", async () => {
      try {
        if (batchRows.length > 0) {
          await stageRefsToImportStaging(importJobId, batchRows);
          batchRows = [];
        }

        const detectedRefs = await detectImportRefsFromStaging(importJobId);
        log("info", `[REFS PHASE 1] Detected ${detectedRefs.length} refs: ${detectedRefs.join(", ")}`);

        if (detectedRefs.length === 0) {
          await cleanupStagingData(importJobId);
          await updateImportJob(importJobId, {
            status: "failed",
            errorMessage: "No refs detected in CSV. Ensure the CSV has a 'refs' column (or 'tags' column) with dash-separated ref codes (e.g. 2ag-3cb-5df).",
            failedRows,
          });
          sendIpc("error", { message: "No refs detected in CSV" });
          safeResolve();
          return;
        }

        await updateImportJob(importJobId, {
          status: "awaiting_confirmation",
          detectedRefs,
          processedRows: parsedRows,
          failedRows,
        });

        log("info", `[REFS PHASE 1] Job ${importJobId} staged ${parsedRows} rows, awaiting confirmation`);

        sendIpc("awaiting_confirmation", {
          importJobId,
          detectedRefs,
          parsedRows,
          failedRows,
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

async function processRefsImportPhase2(queueId: string, importJobId: string, csvFilePath?: string) {
  log("info", `[REFS PHASE 2] Processing unified import for job ${importJobId}`);

  await ensureDbConnection();

  const importJob = await getImportJob(importJobId);
  if (!importJob) throw new Error(`Import job ${importJobId} not found`);

  const detectedRefs = importJob.detectedRefs || [];
  const cleanExisting = importJob.cleanExistingRefs;
  const deleteExisting = importJob.deleteExistingRefs;
  const tagMode = (importJob as any).tagMode || "merge";

  await updateImportJob(importJobId, { status: "processing" });

  if (deleteExisting && detectedRefs.length > 0) {
    log("info", `[REFS PHASE 2] Deleting subscribers with refs: ${detectedRefs.join(", ")}`);
    const { deleted, bckProtected } = await deleteSubscribersByRefsInDb(detectedRefs);
    log("info", `[REFS PHASE 2] Deleted ${deleted} subscribers (${bckProtected} BCK-protected skipped)`);
  } else if (cleanExisting && detectedRefs.length > 0) {
    log("info", `[REFS PHASE 2] Cleaning existing refs: ${detectedRefs.join(", ")}`);
    const cleaned = await cleanExistingRefsInDb(detectedRefs);
    log("info", `[REFS PHASE 2] Cleaned ${cleaned} subscribers`);
  }

  let resolvedCsvPath = csvFilePath;
  if (!resolvedCsvPath || resolvedCsvPath === "phase2_merge") {
    const originalQueueResult = await pool.query(
      `SELECT csv_file_path FROM import_job_queue
       WHERE import_job_id = $1 AND csv_file_path != 'phase2_merge'
       ORDER BY created_at ASC LIMIT 1`,
      [importJobId]
    );
    resolvedCsvPath = originalQueueResult.rows[0]?.csv_file_path;
  }

  if (!resolvedCsvPath || resolvedCsvPath === "phase2_merge") {
    log("warn", `[REFS PHASE 2] No CSV path found, falling back to staging merge only`);
    const mergeResult = await mergeRefsFromStaging(importJobId);
    await cleanupStagingData(importJobId);

    await updateImportJob(importJobId, {
      status: "completed",
      completedAt: new Date(),
      newSubscribers: mergeResult.inserted,
      updatedSubscribers: mergeResult.updated,
    });

    sendIpc("complete", {
      committedRows: mergeResult.inserted + mergeResult.updated,
      newSubscribers: mergeResult.inserted,
      updatedSubscribers: mergeResult.updated,
      failedRows: importJob.failedRows || 0,
      duration: 0,
    });

    log("info", `[REFS PHASE 2] Job ${importJobId} completed (staging merge only)`);
    return;
  }

  await cleanupStagingData(importJobId);

  log("info", `[REFS PHASE 2] Re-reading CSV for full import: ${resolvedCsvPath}`);

  const isObjectStorage = resolvedCsvPath.startsWith("/objects/");
  let fileStream: NodeJS.ReadableStream;

  if (isObjectStorage) {
    const exists = await objectStorageService.objectExists(resolvedCsvPath);
    if (!exists) throw new Error(`CSV file not found in object storage: ${resolvedCsvPath}`);
    fileStream = await objectStorageService.getObjectStream(resolvedCsvPath);
  } else {
    if (!fs.existsSync(resolvedCsvPath)) throw new Error(`CSV file not found: ${resolvedCsvPath}`);
    fileStream = fs.createReadStream(resolvedCsvPath, { encoding: "utf-8", highWaterMark: 256 * 1024 });
  }

  const BATCH_SIZE = 25000;
  let header: string[] = [];
  let emailIdx = -1;
  let tagsIdx = -1;
  let refsIdx = -1;
  let ipIdx = -1;
  let headerParsed = false;
  let currentLineNumber = 0;
  let newSubscribers = 0;
  let updatedSubscribers = 0;
  let failedRows = 0;
  let parsedRows = 0;

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

          if (emailIdx === -1) {
            rl.close();
            safeReject(new Error("CSV must have an 'email' column"));
            return;
          }

          headerParsed = true;
          return;
        }

        if (!line.trim()) return;

        const cols = line.split(";").map(c => c.trim());
        const email = cols[emailIdx]?.toLowerCase();

        if (!email || !email.includes("@")) {
          failedRows++;
          parsedRows++;
          return;
        }

        const tags = tagsIdx >= 0 && cols[tagsIdx]
          ? cols[tagsIdx].split(",").map(t => t.trim().toUpperCase()).filter(Boolean)
          : [];
        const refs = refsIdx >= 0 && cols[refsIdx]
          ? cols[refsIdx].split("-").map(r => r.trim().toLowerCase()).filter(Boolean)
          : [];
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
          await updateImportQueueHeartbeat(queueId);
          rl.resume();
        }
      } catch (err) {
        log("error", `[REFS PHASE 2] Error processing line ${currentLineNumber}: ${err}`);
        failedRows++;
        parsedRows++;
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

        await updateImportJob(importJobId, {
          status: "completed",
          completedAt: new Date(),
          newSubscribers,
          updatedSubscribers,
          failedRows,
          processedRows: parsedRows,
        });

        sendIpc("complete", {
          committedRows: newSubscribers + updatedSubscribers,
          newSubscribers,
          updatedSubscribers,
          failedRows,
          duration: 0,
        });

        log("info", `[REFS PHASE 2] Job ${importJobId} completed: ${newSubscribers} new, ${updatedSubscribers} updated, ${failedRows} failed`);
        safeResolve();
      } catch (err) {
        safeReject(err);
      }
    });

    rl.on("error", (err) => safeReject(err));
    fileStream.on("error", (err) => safeReject(err));
  });
}

let isShuttingDown = false;

async function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  log("info", "Import worker shutting down...");
  try {
    await pool.end();
  } catch (_) {}
  process.exit(0);
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

process.on("message", async (msg: any) => {
  if (msg?.type === "start") {
    const { queueId, importJobId, csvFilePath, phase } = msg.data || msg;
    try {
      if (phase === "refs_merge") {
        await processRefsImportPhase2(queueId, importJobId, csvFilePath);
      } else {
        const hasRefsColumn = await peekCsvHasRefsColumn(csvFilePath);
        log("info", `${importJobId}: Auto-detected CSV format: refs column ${hasRefsColumn ? "present" : "absent"}`);

        if (hasRefsColumn) {
          await processRefsImportPhase1(queueId, importJobId, csvFilePath);
        } else {
          await processImport(queueId, importJobId, csvFilePath);
        }
      }
    } catch (err: any) {
      log("error", `Import failed: ${err.message}`, { stack: err.stack });
      sendIpc("error", { message: err.message, stack: err.stack });

      try {
        await updateImportJob(importJobId, {
          status: "failed",
          errorMessage: err.message || "Unknown error",
        });
      } catch (_) {}

      try {
        await logError({
          type: "import_failed",
          severity: "error",
          message: `Import job failed: ${err.message || "Unknown error"}`,
          importJobId,
          details: err?.stack || String(err),
        });
      } catch (_) {}
    } finally {
      try {
        await pool.end();
      } catch (_) {}
      process.exit(0);
    }
  }
});

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

process.on("uncaughtException", (err) => {
  log("fatal", `Uncaught exception in import worker: ${err.message}`, { stack: err.stack });
  sendIpc("error", { message: err.message, stack: err.stack });
  pool.end().catch(() => {});
  process.exit(1);
});

process.on("unhandledRejection", (reason: any) => {
  const message = reason?.message || String(reason);
  const stack = reason?.stack || "";
  log("fatal", `Unhandled rejection in import worker: ${message}`, { stack });
  sendIpc("error", { message, stack });
  pool.end().catch(() => {});
  process.exit(1);
});

log("info", "Import worker started, waiting for job...");
