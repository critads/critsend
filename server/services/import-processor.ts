import * as readline from "readline";
import * as fs from "fs";
import * as path from "path";
import { from as copyFrom } from "pg-copy-streams";
import { sql } from "drizzle-orm";
import { importPool as pool, importDb as db } from "../import-pool";
import { IMPORT_STAGING_PURGE_LOCK_KEY } from "../lib/import-staging-lock";
import { logger } from "../logger";
import { storage as rawStorage } from "../storage";
import { jobEvents, JobProgressEvent } from "../job-events";
import { getObjectStorageService, useObjectStorageForImports, ObjectStorageTransientError } from "../storage-backends";
import { IMPORT_CONCURRENCY } from "../connection-budget";
import { withConnRetry } from "./conn-retry";
import { deleteInBatches } from "./batch-delete";

const objectStorageService = getObjectStorageService();

const CONCURRENCY = IMPORT_CONCURRENCY;

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Acquire an import-pool client with bounded transient-connection retries.
 * Rationale and classification live in server/services/conn-retry.ts.
 */
function connectWithRetry() {
  return withConnRetry(() => pool.connect(), { label: "connection acquire" });
}

/**
 * pool.query wrapper with the same transient-connection retry. EVERY import-path
 * pool.query() goes through this so a Neon pooler accept-timeout on a per-row
 * fallback (singleUpsert) or a refs/cleanup/phase query does not permanently
 * fail rows or abort a phase — it retries the acquire first.
 */
function queryWithRetry(text: string, params?: any[]) {
  return withConnRetry(
    () => (params === undefined ? pool.query(text) : pool.query(text, params)),
    { label: "query connect" },
  );
}

/**
 * importDb (drizzle) .execute wrapper with the same transient-connection retry.
 * The import processor's db.execute() calls (DROP INDEX IF EXISTS, DELETE FROM
 * import_staging, import_job_queue path/status rewrites) all run on the dedicated
 * import pool and are idempotent, so a Neon pooler accept-timeout on one of them
 * must retry the acquire rather than abort the whole job. None of these is a
 * CREATE INDEX CONCURRENTLY (that recreate runs through storage on the main pool),
 * so retry-after-reset is safe here.
 */
function execWithRetry(query: Parameters<typeof db.execute>[0]) {
  return withConnRetry(() => db.execute(query), { label: "exec connect" });
}

/**
 * Heavy bulk statements over the ~89M-row `subscribers` table (refs merge /
 * clean-existing / delete-by-refs) can legitimately run longer than the import
 * pool's default 5-min `statement_timeout` under production load. A
 * statement_timeout (PG 57014) is NOT a connection error, so the conn-retry
 * layer does not catch it — it propagates UNCAUGHT and HARD-FAILS the whole
 * import ("canceling statement due to statement timeout"). These operations are
 * idempotent and bounded, so we give them a larger, env-tunable budget via
 * `SET LOCAL statement_timeout` inside a dedicated transaction (so it never
 * leaks to other statements on the pooled connection). Connection-class blips
 * are still retried by withConnRetry; a genuine slow-statement timeout at the
 * elevated budget still fails fast — we do not loop a 30-min operation.
 */
const HEAVY_IMPORT_STATEMENT_TIMEOUT_MS = (() => {
  const parsed = Number(process.env.IMPORT_HEAVY_STATEMENT_TIMEOUT_MS);
  // Guard against invalid env (NaN / <=0 / non-finite) which would otherwise be
  // injected into `SET LOCAL statement_timeout = <n>` and raise an SQL error.
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 1_800_000; // 30 min
})();

async function runHeavyImportQuery(text: string, params?: any[]) {
  return withConnRetry(
    async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(`SET LOCAL statement_timeout = ${Math.trunc(HEAVY_IMPORT_STATEMENT_TIMEOUT_MS)}`);
        const result = params === undefined ? await client.query(text) : await client.query(text, params);
        await client.query("COMMIT");
        return result;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    { label: "heavy import query" },
  );
}

/**
 * Detect distinct refs for a staged job on the IMPORT pool (5-min
 * statement_timeout) rather than the shared MAIN pool (2-min). `unnest` over a
 * large staged set under load can exceed 2 min and HARD-FAIL Phase 1; the
 * import pool gives it the same budget as the rest of the import path. Scoped by
 * the `import_staging_job_id_idx` index.
 */
async function detectImportRefsViaImportPool(importJobId: string): Promise<string[]> {
  const result = await queryWithRetry(
    `SELECT DISTINCT unnest(refs) AS ref FROM import_staging WHERE job_id = $1 ORDER BY ref`,
    [importJobId],
  );
  return (result.rows as Array<{ ref: string }>).map((r) => r.ref);
}

/**
 * Storage methods that must NOT be auto-retried on a connection-class error.
 * `recreateSubscriberGinIndexes` issues CREATE INDEX CONCURRENTLY, which is not
 * safely retryable: a mid-flight connection reset can leave an INVALID index that
 * a retry then collides with. It already runs best-effort inside its own
 * try/catch on the import path, so leaving it un-retried is correct.
 */
const NON_RETRYABLE_STORAGE_METHODS = new Set<string>(["recreateSubscriberGinIndexes"]);

/**
 * Retrying facade over the shared `storage` layer for the import path.
 *
 * WHY (single chokepoint): the import job's metadata, heartbeat, progress and
 * status/finalization writes ALL run on the shared MAIN pool — NOT the dedicated
 * import pool. So under worker main-pool contention a transient accept timeout
 * ("timeout exceeded when trying to connect") on ANY of those calls fails the
 * entire import, and a dedicated import pool cannot protect them. Rather than
 * wrap ~40 individual call sites (and miss future ones), every `storage.*` call
 * made by this module goes through this Proxy, which retries ONLY connection-
 * class failures (timeout-when-connecting, reset sockets, 08xxx/57P01) with
 * bounded backoff; genuine SQL/data errors still fail fast.
 *
 * Retry-safety: all import status/progress writes use ABSOLUTE values (set
 * status, set committedRows/newSubscribers/etc. totals — never increments) and
 * reads are pure, so re-running after a mid-flight reset is idempotent. The one
 * non-idempotent op (CREATE INDEX CONCURRENTLY) is excluded above. Calls are
 * applied with `this` bound to the real storage instance, so a method's internal
 * `this.xxx()` calls hit the raw storage directly (no double-retry, no proxy
 * recursion).
 */
const storage: typeof rawStorage = new Proxy(rawStorage, {
  get(target, prop, receiver) {
    const orig = Reflect.get(target, prop, receiver);
    if (typeof orig !== "function") return orig;
    const name = String(prop);
    if (NON_RETRYABLE_STORAGE_METHODS.has(name)) return orig.bind(target);
    return (...args: any[]) =>
      withConnRetry(() => orig.apply(target, args), { label: `storage.${name} connect` });
  },
});

/**
 * Probe a file for read-readiness with retry. Handles the chunked-upload race
 * where the import job can be enqueued a few seconds before the chunk
 * assembler finishes writing the final CSV to disk.
 *
 * Behaviour per attempt:
 *   - fs.statSync(): authoritative existence + size check (no false negatives
 *     from existsSync on some FSes, and surfaces EACCES/EPERM vs ENOENT).
 *   - If `expectedSize` is provided and the current on-disk size is smaller,
 *     treat as "not ready yet" and keep retrying (partial chunked write).
 *
 * Defaults: 10 attempts × 3s = up to 30s. Sized to cover assembly of a 50MB
 * chunked upload on a slow disk; short enough that genuine 404s don't block
 * the worker for long.
 *
 * On final failure, emits a structured diagnostic line covering errno code,
 * dir contents, similar-name matches, cwd, pid, and uid — exactly what
 * post-mortem investigations need.
 */
async function fileExistsWithRetry(
  filePath: string,
  jobId: string,
  retries = 10,
  delayMs = 3000,
  expectedSize?: number,
): Promise<boolean> {
  let lastErrno: string | undefined;
  let lastError: string | undefined;
  let lastSize: number | undefined;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const st = fs.statSync(filePath);
      lastSize = st.size;
      // File present. If we know the expected size and the on-disk size is
      // still short, the chunk assembler hasn't finished — keep waiting.
      if (expectedSize && st.size < expectedSize) {
        if (attempt < retries) {
          logger.warn(
            `[IMPORT] ${jobId}: file present but partial (${st.size}/${expectedSize} bytes) for ${filePath} ` +
            `(attempt ${attempt}/${retries}), retrying in ${delayMs}ms...`,
          );
          await waitMs(delayMs);
          continue;
        }
        // Last attempt and still partial — fall through to error diagnostic.
        lastErrno = "EPARTIAL";
        lastError = `file size ${st.size} < expected ${expectedSize}`;
        break;
      }
      return true;
    } catch (err: any) {
      lastErrno = err?.code || "UNKNOWN";
      lastError = err?.message ?? String(err);
      if (attempt < retries) {
        logger.warn(
          `[IMPORT] ${jobId}: fs.statSync failed (${lastErrno}) for ${filePath} ` +
          `(attempt ${attempt}/${retries}), retrying in ${delayMs}ms...`,
        );
        await waitMs(delayMs);
      }
    }
  }

  // Final failure — emit rich diagnostic so the next post-mortem has answers.
  try {
    const dir = path.dirname(filePath);
    const basename = path.basename(filePath);
    const dirContents = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    const matches = dirContents.filter((f: string) => f.includes(basename.slice(0, 20)));
    let uid: number | undefined;
    let gid: number | undefined;
    try { uid = process.getuid?.(); gid = process.getgid?.(); } catch {}
    logger.error(
      `[IMPORT] ${jobId}: File not ready after ${retries} retries (~${(retries * delayMs) / 1000}s): ${filePath}`,
      {
        errno: lastErrno,
        error: lastError,
        onDiskSize: lastSize,
        expectedSize,
        dirExists: fs.existsSync(dir),
        dirFileCount: dirContents.length,
        similarFiles: matches.slice(0, 5),
        cwd: process.cwd(),
        pid: process.pid,
        uid,
        gid,
      },
    );
  } catch (diagErr: any) {
    logger.error(`[IMPORT] ${jobId}: File not ready and diagnostics failed: ${diagErr.message}`);
  }
  return false;
}

/**
 * Build a human-friendly error message for a CSV-not-found failure. Includes
 * the queue-recorded expected size so operators can immediately tell whether
 * the upload was incomplete (size mismatch) vs the file genuinely vanished.
 */
function csvNotFoundError(csvFilePath: string, expectedSize?: number): string {
  const sizeHint = expectedSize
    ? ` (queue recorded ${Math.round(expectedSize / 1024)}KB at upload)`
    : "";
  return (
    `CSV file not found or not fully written after retry: ${csvFilePath}${sizeHint}. ` +
    `This usually means the chunked upload didn't finish assembling on disk, ` +
    `or the server was restarted/redeployed between upload and processing. ` +
    `Please re-upload the file.`
  );
}

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
  const result = await queryWithRetry(`SELECT COUNT(*) AS count FROM campaigns WHERE status = 'sending'`);
  return parseInt(result.rows[0]?.count || "0", 10) > 0;
}

async function safeDropGinIndexes(importJobId: string): Promise<boolean> {
  const activeSends = await hasActiveSendingCampaigns();
  if (activeSends) {
    logger.warn(`[IMPORT] ${importJobId}: Skipping GIN index drop — active campaign sends detected. Import will proceed without index optimization.`);
    return false;
  }
  logger.info(`[IMPORT] ${importJobId}: Dropping GIN indexes for large import optimization (no active sends)`);
  await execWithRetry(sql`DROP INDEX IF EXISTS tags_gin_idx`);
  await execWithRetry(sql`DROP INDEX IF EXISTS refs_gin_idx`);
  logger.info(`[IMPORT] ${importJobId}: GIN indexes dropped`);
  return true;
}

async function copyBatchUpsert(
  rows: Array<{ email: string; tags: string[]; refs: string[]; ipAddress: string | null }>,
  tagMode: "merge" | "override"
): Promise<{ inserted: number; updated: number }> {
  const client = await connectWithRetry();
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

    const mergeResult = await client.query(`
      INSERT INTO subscribers (email, tags, refs, ip_address, import_date)
      SELECT email, tags, refs, ip_address, NOW() FROM import_staging_batch
      ON CONFLICT (email) DO UPDATE SET
        ${tagsConflict},
        ${refsConflict},
        ip_address = COALESCE(EXCLUDED.ip_address, subscribers.ip_address)
      RETURNING id, (xmax = 0) AS inserted
    `);
    const totalProcessed = mergeResult.rowCount || 0;
    const newSubscriberIds = (mergeResult.rows as Array<{ id: string; inserted: boolean }>)
      .filter(r => r.inserted)
      .map(r => r.id);
    await client.query("COMMIT");
    // Fire automation subscriber_added triggers for newly inserted subscribers.
    if (newSubscriberIds.length > 0) {
      const { dispatchSubscriberAddedTriggers } = await import("./automation-engine");
      dispatchSubscriberAddedTriggers(newSubscriberIds);
    }
    return { inserted: newSubscriberIds.length, updated: Math.max(totalProcessed - newSubscriberIds.length, 0) };
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

  const client = await connectWithRetry();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `INSERT INTO subscribers (email, tags, refs, ip_address, import_date) VALUES ${valuesClauses.join(", ")} ON CONFLICT (email) DO UPDATE SET ${tagsConflict}, ${refsConflict}, ip_address = COALESCE(EXCLUDED.ip_address, subscribers.ip_address) RETURNING id, (xmax = 0) AS inserted`,
      params
    );
    const totalProcessed = result.rowCount || 0;
    const newSubscriberIds = (result.rows as Array<{ id: string; inserted: boolean }>)
      .filter(r => r.inserted)
      .map(r => r.id);
    await client.query("COMMIT");
    if (newSubscriberIds.length > 0) {
      const { dispatchSubscriberAddedTriggers } = await import("./automation-engine");
      dispatchSubscriberAddedTriggers(newSubscriberIds);
    }
    return { inserted: newSubscriberIds.length, updated: Math.max(totalProcessed - newSubscriberIds.length, 0) };
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

  const existsResult = await queryWithRetry(`SELECT 1 FROM subscribers WHERE email = $1 LIMIT 1`, [row.email.toLowerCase()]);
  const existed = (existsResult.rowCount || 0) > 0;
  const upsertResult = await queryWithRetry(
    `INSERT INTO subscribers (email, tags, refs, ip_address, import_date) VALUES ($1, $2::text[], $3::text[], $4, NOW()) ON CONFLICT (email) DO UPDATE SET ${tagsConflict}, ${refsConflict}, ip_address = COALESCE(EXCLUDED.ip_address, subscribers.ip_address) RETURNING id, (xmax = 0) AS inserted`,
    [row.email.toLowerCase(), row.tags, row.refs, row.ipAddress]
  );
  if (!existed && upsertResult.rows[0]?.inserted) {
    const { dispatchSubscriberAddedTriggers } = await import("./automation-engine");
    dispatchSubscriberAddedTriggers([upsertResult.rows[0].id]);
  }
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

  const client = await connectWithRetry();
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
  const result = await queryWithRetry(`
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
  const client = await connectWithRetry();
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

    const mergeResult = await client.query(`
      INSERT INTO subscribers (email, refs, ip_address, import_date)
      SELECT email, refs, ip_address, NOW() FROM import_staging_batch
      ON CONFLICT (email) DO UPDATE SET
        refs = (SELECT COALESCE(array_agg(DISTINCT r), ARRAY[]::text[]) FROM unnest(subscribers.refs || EXCLUDED.refs) AS r WHERE r IS NOT NULL),
        ip_address = COALESCE(EXCLUDED.ip_address, subscribers.ip_address),
        import_date = NOW()
      RETURNING (xmax = 0) AS inserted
    `);
    const totalProcessed = mergeResult.rowCount || 0;
    const insertedCount = (mergeResult.rows as Array<{ inserted: boolean }>).filter(r => r.inserted).length;
    await client.query("COMMIT");
    return { inserted: insertedCount, updated: Math.max(totalProcessed - insertedCount, 0) };
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

  const client = await connectWithRetry();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `INSERT INTO subscribers (email, refs, ip_address, import_date) VALUES ${valuesClauses.join(", ")} ON CONFLICT (email) DO UPDATE SET refs = (SELECT COALESCE(array_agg(DISTINCT r), ARRAY[]::text[]) FROM unnest(subscribers.refs || EXCLUDED.refs) AS r WHERE r IS NOT NULL), ip_address = COALESCE(EXCLUDED.ip_address, subscribers.ip_address), import_date = NOW() RETURNING (xmax = 0) AS inserted`,
      params
    );
    const totalProcessed = result.rowCount || 0;
    const insertedCount = (result.rows as Array<{ inserted: boolean }>).filter(r => r.inserted).length;
    await client.query("COMMIT");
    return { inserted: insertedCount, updated: Math.max(totalProcessed - insertedCount, 0) };
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
  const client = await connectWithRetry();
  try {
    // Open an explicit transaction so the shared advisory lock (writer side of
    // the purge ↔ writer mutex) is held for the full duration of the COPY.
    // The nightly purge uses pg_try_advisory_xact_lock (exclusive, non-blocking)
    // and defers if any shared holder exists, so it cannot TRUNCATE import_staging
    // while we are mid-stream.  The lock is released automatically at COMMIT/ROLLBACK.
    // See server/lib/import-staging-lock.ts for the full protocol.
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock_shared($1)",
      [IMPORT_STAGING_PURGE_LOCK_KEY],
    );
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
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function cleanExistingRefsInDb(refs: string[]): Promise<number> {
  if (refs.length === 0) return 0;
  const BATCH_SIZE = 50000;
  let totalCleaned = 0;
  while (true) {
    const result = await runHeavyImportQuery(`
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
  const bckResult = await runHeavyImportQuery(
    `SELECT COUNT(*) AS count FROM subscribers WHERE refs && $1::text[] AND 'BCK' = ANY(tags)`, [refs]
  );
  const bckProtected = parseInt(bckResult.rows[0]?.count || "0");
  const BATCH_SIZE = 50000;
  let totalDeleted = 0;
  while (true) {
    const result = await runHeavyImportQuery(`
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
  const result = await runHeavyImportQuery(`
    INSERT INTO subscribers (email, refs, import_date)
    SELECT email, refs, NOW() FROM import_staging WHERE job_id = $1
    ON CONFLICT (email) DO UPDATE SET
      refs = (SELECT COALESCE(array_agg(DISTINCT r), ARRAY[]::text[]) FROM unnest(subscribers.refs || EXCLUDED.refs) AS r WHERE r IS NOT NULL),
      import_date = NOW()
    RETURNING (xmax = 0) AS inserted
  `, [importJobId]);
  const totalProcessed = result.rowCount || 0;
  const insertedCount = (result.rows as Array<{ inserted: boolean }>).filter(r => r.inserted).length;
  return { inserted: insertedCount, updated: Math.max(totalProcessed - insertedCount, 0) };
}

/**
 * Bounded batch size for ctid-keyed deletes of `import_staging`. A single
 * `DELETE FROM import_staging WHERE job_id = ...` over a large per-job set
 * (millions of rows accumulated by the append-only COPY across requeues)
 * exceeds the import pool's default statement_timeout and throws PG 57014 —
 * which is NOT connection-class, so execWithRetry/queryWithRetry never retries
 * it. The phase then HARD-FAILS *before* the real merge runs, so the import
 * "completes" without writing a single subscriber. Deleting in small ctid
 * batches keeps every statement well under the timeout and always finishes.
 */
const STAGING_DELETE_BATCH = (() => {
  const n = Number(process.env.IMPORT_STAGING_DELETE_BATCH);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 20_000;
})();

/**
 * Max batches a single orphan-sweep run will delete, so the background sweeper
 * never hogs the pool or floods WAL while it drains historic bloat over several
 * runs. Default 100 * 20k = 2M rows/run.
 */
const STAGING_SWEEP_MAX_BATCHES = (() => {
  const n = Number(process.env.IMPORT_STAGING_SWEEP_MAX_BATCHES);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 100;
})();

/**
 * Timeout-safe, idempotent cleanup of ONE job's staged rows. Loops bounded
 * ctid-keyed deletes until the job has no rows left. Safe under PgBouncer
 * transaction pooling (every statement is short and independent) and safe to
 * run concurrently with the sweeper below (ctid races simply no-op).
 */
async function cleanupStagingData(importJobId: string): Promise<void> {
  await deleteInBatches(
    async (limit) => {
      const result = await queryWithRetry(
        `DELETE FROM import_staging
           WHERE ctid IN (
             SELECT ctid FROM import_staging WHERE job_id = $1 LIMIT $2
           )`,
        [importJobId, limit],
      );
      return result.rowCount ?? 0;
    },
    { batchSize: STAGING_DELETE_BATCH, sleepMs: 20 },
  );
}

/**
 * Background sweeper that drains ORPHANED import_staging rows — rows whose job
 * is no longer live (not pending/processing/awaiting_confirmation) AND has no
 * active queue row (pending/processing). This auto-drains the historic
 * multi-million-row bloat after deploy and replaces the old single-shot startup
 * DELETE that timed out on a large table. Bounded per run (batch count) so it
 * never hogs the pool / floods WAL; intended to be called on an interval.
 * Returns rows removed this run. ctid-batched ⇒ safe under PgBouncer and safe
 * to run from more than one PM2 process concurrently.
 */
export async function sweepOrphanedImportStaging(
  maxBatches: number = STAGING_SWEEP_MAX_BATCHES,
): Promise<number> {
  return deleteInBatches(
    async (limit) => {
      const result = await queryWithRetry(
        `DELETE FROM import_staging
           WHERE ctid IN (
             SELECT s.ctid FROM import_staging s
             WHERE NOT EXISTS (
               SELECT 1 FROM import_jobs j
               WHERE j.id = s.job_id
                 AND j.status IN ('pending', 'processing', 'awaiting_confirmation')
             )
             AND NOT EXISTS (
               SELECT 1 FROM import_job_queue q
               WHERE q.import_job_id = s.job_id
                 AND q.status IN ('pending', 'processing')
             )
             LIMIT $1
           )`,
        [limit],
      );
      return result.rowCount ?? 0;
    },
    { batchSize: STAGING_DELETE_BATCH, maxBatches, sleepMs: 50 },
  );
}

async function peekCsvHasRefsColumn(csvFilePath: string): Promise<boolean> {
  const isObjectStorage = csvFilePath.startsWith("/objects/");
  let firstLine = "";

  // Helper: read first line and ALWAYS destroy the underlying stream to avoid
  // leaking file descriptors (local fs) or HTTP sockets (S3 GET response body).
  const readFirstLine = (stream: NodeJS.ReadableStream): Promise<string> =>
    new Promise<string>((resolve, reject) => {
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
      let captured = "";
      let settled = false;
      const finish = (val: string) => {
        if (settled) return;
        settled = true;
        try { rl.close(); } catch {}
        try { (stream as any).destroy?.(); } catch {}
        resolve(val);
      };
      const fail = (err: unknown) => {
        if (settled) return;
        settled = true;
        try { rl.close(); } catch {}
        try { (stream as any).destroy?.(); } catch {}
        reject(err);
      };
      rl.on("line", (line: string) => { captured = line; finish(line); });
      rl.on("error", fail);
      rl.on("close", () => finish(captured));
    });

  if (isObjectStorage) {
    const exists = await objectStorageService.objectExists(csvFilePath);
    if (!exists) return false;
    const stream = await objectStorageService.getObjectStream(csvFilePath);
    firstLine = await readFirstLine(stream);
  } else {
    if (!(await fileExistsWithRetry(csvFilePath, "peek"))) return false;
    const stream = fs.createReadStream(csvFilePath, { encoding: "utf-8", highWaterMark: 1024 });
    firstLine = await readFirstLine(stream);
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

  // Single source of truth for queue metadata (fileSizeBytes for readiness
  // detection, lastCheckpointLine for resume). Both branches below + the
  // post-readiness logic reuse this single fetch instead of round-tripping
  // the DB multiple times.
  const queueItem = await storage.getImportQueueItem(queueId);

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
    fileSizeBytes = queueItem?.fileSizeBytes || 0;
    logger.info(`[IMPORT] ${importJobId}: Using object storage, size from queue: ${Math.round(fileSizeBytes / 1024 / 1024)}MB`);
  } else {
    // Pass expected size from queue so fileExistsWithRetry can detect a
    // partial chunked-upload assembly (file present but still being written).
    const expectedSize = queueItem?.fileSizeBytes || undefined;
    if (!(await fileExistsWithRetry(csvFilePath, importJobId, 10, 3000, expectedSize))) {
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
      throw new Error(csvNotFoundError(csvFilePath, expectedSize));
    }
    const fileStat = fs.statSync(csvFilePath);
    fileSizeBytes = fileStat.size;
    fileStream = fs.createReadStream(csvFilePath, { encoding: "utf-8", highWaterMark: 256 * 1024 });
    logger.info(`[IMPORT] ${importJobId}: Using local filesystem (legacy), size: ${Math.round(fileSizeBytes / 1024 / 1024)}MB`);
  }

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
  // Leave one connection of headroom in the import pool. With MAX_INFLIGHT ===
  // IMPORT_POOL_MAX, N concurrent batches hold all N connections and any extra
  // acquisition (a COPY→INSERT fallback re-connecting, a per-row singleUpsert,
  // or connectWithRetry re-attempting) has zero free slots and waits out the
  // whole connect timeout. Reserving one slot keeps those paths unblocked.
  const MAX_INFLIGHT = Math.max(1, CONCURRENCY - 1);

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
    const countResult = await queryWithRetry("SELECT COUNT(*) AS cnt FROM subscribers");
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
            const postCountResult = await queryWithRetry("SELECT COUNT(*) AS cnt FROM subscribers");
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
    if (!(await fileExistsWithRetry(csvFilePath, importJobId))) {
      const existingJob = await storage.getImportJob(importJobId);
      if (existingJob?.status === "completed" || (existingJob && (existingJob.totalRows ?? 0) > 0 && (existingJob.processedRows ?? 0) >= (existingJob.totalRows ?? 0))) {
        logger.warn(`[IMPORT] ${importJobId}: [REFS PHASE 1] CSV missing but all rows already imported — skipping`);
        if (existingJob.status !== "completed") {
          await storage.updateImportJob(importJobId, { status: "completed", completedAt: existingJob.completedAt || new Date(), errorMessage: null });
        }
        return;
      }
      throw new Error(csvNotFoundError(csvFilePath));
    }
    fileStream = fs.createReadStream(csvFilePath, { encoding: "utf-8", highWaterMark: 256 * 1024 });
  }

  await storage.updateImportJob(importJobId, { status: "processing", startedAt: new Date() });

  // Idempotent re-stage: clear any rows left by a PRIOR attempt of THIS job
  // before staging. stageRefsToImportStaging is an append-only COPY with no
  // dedup, so without this a requeue (transient failure → recovery) re-stages
  // the entire CSV on top of the previous copy. Repeated requeues multiply the
  // job's staged rows (observed: an 80k-row CSV grew to ~30M rows), which makes
  // the end-of-phase detectImportRefs (DISTINCT unnest over the job's rows)
  // progressively slower until it breaches statement_timeout and HARD-FAILS —
  // a death spiral that also bloats import_staging and slows every other import.
  await cleanupStagingData(importJobId);

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

        const detectedRefs = await detectImportRefsViaImportPool(importJobId);
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
    const originalQueueResult = await queryWithRetry(
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
    if (!(await fileExistsWithRetry(resolvedCsvPath, importJobId))) {
      const existingJob = await storage.getImportJob(importJobId);
      if (existingJob?.status === "completed" || (existingJob && (existingJob.totalRows ?? 0) > 0 && (existingJob.processedRows ?? 0) >= (existingJob.totalRows ?? 0))) {
        logger.warn(`[IMPORT] ${importJobId}: [REFS PHASE 2] CSV missing but all rows already imported — skipping`);
        if (existingJob.status !== "completed") {
          await storage.updateImportJob(importJobId, { status: "completed", completedAt: existingJob.completedAt || new Date(), errorMessage: null });
        }
        return;
      }
      throw new Error(csvNotFoundError(resolvedCsvPath));
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

/**
 * Deferred upload (2026-05-31): the Hetzner upload was moved OFF the synchronous
 * /api/import request path INTO the worker. The request handler now enqueues the
 * LOCAL csv path; this runs as the worker's first step and
 * uploads → verifies → rewrites the queue row to the /objects/ path →
 * deletes the local temp file. It returns the path the rest of processing reads.
 *
 * Idempotent: a path already in object storage (`/objects/...`), the phase-2
 * sentinel (`phase2_merge`), or a local-disk-backend deployment is returned
 * unchanged — so a requeued or recovered job never re-uploads.
 *
 * On a transient throttle/5xx (`ObjectStorageTransientError`) it RE-THROWS so
 * the worker loop (server/workers.ts) requeues the job with backoff instead of
 * permanently failing it. The local file is left in place for the retry.
 */
async function ensureCsvUploadedToObjectStorage(
  queueId: string,
  importJobId: string,
  csvFilePath: string,
): Promise<string> {
  // Phase-2 merge has no backing file; nothing to upload.
  if (csvFilePath === "phase2_merge") return csvFilePath;
  // Already uploaded on a prior attempt (requeue / recovery) — never re-upload.
  if (csvFilePath.startsWith("/objects/")) return csvFilePath;
  // Local-disk backend: the worker reads the file directly, no upload needed.
  if (!useObjectStorageForImports()) return csvFilePath;

  // The local file must still exist. If it vanished before the worker could
  // upload it, surface a clear, non-retryable message (re-upload is the fix).
  if (!fs.existsSync(csvFilePath)) {
    throw new Error(
      `CSV file not found on local volume before upload: ${csvFilePath}. ` +
      `The file may have been removed before the worker could upload it. Please re-upload.`,
    );
  }

  const objectName = `${importJobId}.csv`;
  logger.info(`[IMPORT] ${importJobId}: Deferred upload starting → ${objectName} (queueId=${queueId})`);
  // uploadLocalFile + objectExists are already throttle-hardened (adaptive
  // retry + withTransientRetry) in the Hetzner backend. A transient error here
  // propagates as ObjectStorageTransientError → worker requeue with backoff.
  const remotePath = await objectStorageService.uploadLocalFile(csvFilePath, objectName);
  const exists = await objectStorageService.objectExists(remotePath);
  if (!exists) {
    // A post-upload verification miss is treated as transient so the worker
    // retries the whole upload rather than permanently failing the import.
    throw new ObjectStorageTransientError(
      `Object storage verification failed after upload: ${remotePath} does not exist`,
    );
  }

  // Atomically point the queue row at the uploaded object so any later requeue
  // or stuck-job recovery reads from object storage and never re-uploads.
  await execWithRetry(sql`
    UPDATE import_job_queue SET csv_file_path = ${remotePath} WHERE id = ${queueId}
  `);
  logger.info(`[IMPORT] ${importJobId}: Deferred upload complete → ${remotePath}, queue row updated`);

  // Best-effort local cleanup; the object is now the source of truth.
  try {
    fs.unlinkSync(csvFilePath);
  } catch {
    logger.warn(`[IMPORT] ${importJobId}: Failed to delete local temp after upload: ${csvFilePath}`);
  }
  return remotePath;
}

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
    await execWithRetry(sql`
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

  // Deferred upload: if the queue row still points at the local staging file
  // (remote backend), upload it to object storage now, before any processing.
  // A transient throttle re-throws → worker requeues. After this, every code
  // path below reads from `resolvedCsvPath` (the /objects/ path on success).
  const resolvedCsvPath = await ensureCsvUploadedToObjectStorage(queueId, importJobId, csvFilePath);

  if (isPhase2) {
    await processRefsImportPhase2(queueId, importJobId, resolvedCsvPath, onProgress);
  } else if (isRemoveMode) {
    logger.info(`[IMPORT] ${importJobId}: Remove mode active — bypassing refs-column detection, running direct removal`);
    await processImport(queueId, importJobId, resolvedCsvPath, onProgress);
  } else if (isForceMode) {
    logger.info(`[IMPORT] ${importJobId}: Force mode active — bypassing refs-column detection, running direct import`);
    await processImport(queueId, importJobId, resolvedCsvPath, onProgress);
  } else {
    const hasRefsColumn = await peekCsvHasRefsColumn(resolvedCsvPath);
    logger.info(`[IMPORT] ${importJobId}: Auto-detected CSV format: refs column ${hasRefsColumn ? "present" : "absent"}`);
    if (hasRefsColumn) {
      await processRefsImportPhase1(queueId, importJobId, resolvedCsvPath, onProgress);
    } else {
      await processImport(queueId, importJobId, resolvedCsvPath, onProgress);
    }
  }
}
