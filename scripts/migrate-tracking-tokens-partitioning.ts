/**
 * scripts/migrate-tracking-tokens-partitioning.ts
 * ===============================================
 * One-time, staged migration that converts the single non-partitioned
 * `tracking_tokens` table into a RANGE-partitioned table (one partition per UTC
 * day on created_at). Retention then becomes an instant `DROP TABLE <partition>`
 * instead of a multi-hour DELETE that never returns disk on Neon.
 *
 * Strategy (FAST variant — copy only the last N days, then drop the old table):
 *
 *   prepare       Create an empty partitioned `tracking_tokens_new` + day-partitions
 *                 covering [today-COPY_DAYS .. today+7]. Non-destructive, idempotent.
 *
 *   swap   [--yes]  In ONE transaction:
 *                     ALTER TABLE tracking_tokens      RENAME TO tracking_tokens_legacy
 *                     ALTER TABLE tracking_tokens_new  RENAME TO tracking_tokens
 *                 After this, writes go to the (initially empty) partitioned table
 *                 and reads fall back to tracking_tokens_legacy via the app's
 *                 dual-read path — so NO tracking is lost while copy runs.
 *
 *   copy          Copy the last COPY_DAYS of rows from tracking_tokens_legacy into
 *                 the partitioned tracking_tokens, batched keyset pagination on
 *                 (created_at, token), ON CONFLICT DO NOTHING. Resumable/idempotent.
 *
 *   verify        Compare windowed row counts (legacy vs new) + show partition list
 *                 and table sizes.
 *
 *   drop-legacy [--yes]  DROP TABLE tracking_tokens_legacy — instant space reclaim.
 *
 *   status        Print current state (relkind, sizes, partitions, presence of
 *                 _new / _legacy) without changing anything.
 *
 * Usage:
 *   npx tsx scripts/migrate-tracking-tokens-partitioning.ts status
 *   npx tsx scripts/migrate-tracking-tokens-partitioning.ts prepare
 *   npx tsx scripts/migrate-tracking-tokens-partitioning.ts swap --yes
 *   npx tsx scripts/migrate-tracking-tokens-partitioning.ts copy
 *   npx tsx scripts/migrate-tracking-tokens-partitioning.ts verify
 *   npx tsx scripts/migrate-tracking-tokens-partitioning.ts drop-legacy --yes
 *
 * Env:
 *   COPY_DAYS         days of history to copy (default 14)
 */
import pg from "pg";
import { pool } from "../server/db";
import {
  buildPartitionedTableDDL,
  ensureTrackingTokenPartitions,
  isTrackingTokensPartitioned,
  relationExists,
  listTrackingTokenPartitions,
} from "../server/tracking-partitions";

const NEW_TABLE = "tracking_tokens_new";
const LEGACY_TABLE = "tracking_tokens_legacy";
const ACTIVE_TABLE = "tracking_tokens";

const COPY_DAYS = Number(process.env.COPY_DAYS || 14);
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Build a DEDICATED, DIRECT (unpooled) pool for the heavy copy.
 *
 * The app's shared `pool` (server/db) connects through Neon's PgBouncer pooled
 * endpoint (transaction pooling). Short DDL/queries are fine through it, but a
 * long-held `INSERT..SELECT` either (a) gets capped by the connect-time
 * statement_timeout PgBouncer can't reliably let us override, or (b) starves
 * waiting for a PgBouncer server-backend slot under heavy live send load — with
 * NO client-visible error, so the Node await hangs forever. Neon's own guidance
 * (see server/db.ts) is to use an UNPOOLED connection for exactly this.
 *
 * The direct host is the pooled host without the "-pooler" infix. On a direct
 * session-mode connection `statement_timeout = 0` actually sticks, so multi-
 * minute set-based chunks run to completion. Keep `max` tiny (a couple of direct
 * backends) so we never threaten the app's own connection budget.
 */
function createCopyPool(): pg.Pool {
  const raw = process.env.NEON_DATABASE_URL || process.env.DATABASE_URL || "";
  if (!raw) throw new Error("NEON_DATABASE_URL or DATABASE_URL must be set");
  const direct = raw.replace("-pooler.", ".");
  return new pg.Pool({
    connectionString: direct,
    max: 2,
    ssl: { rejectUnauthorized: false },
    statement_timeout: 0,
    // keepAlive: during a multi-minute INSERT the client socket sits idle waiting
    // for the result; without TCP keepalive a NAT/Neon-proxy idle-timeout silently
    // drops it (server keeps running, client awaits forever). The app pool sets
    // this for the same reason (server/db.ts).
    keepAlive: true,
    keepAliveInitialDelayMillis: 10000,
    // Fail fast if establishing a backend hangs (Neon cold-start/network) so the
    // retry loop in copyChunk reconnects instead of awaiting connect() forever —
    // connect() is NOT covered by the per-query watchdog.
    connectionTimeoutMillis: 15000,
    // Keep an established backend warm between chunks so we rarely reconnect.
    idleTimeoutMillis: 60000,
    application_name: "tracking-migration-copy",
  });
}

function utcDayStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** Start of the oldest UTC day we copy/partition (aligned to a partition boundary). */
function copyCutoff(now = new Date()): Date {
  return new Date(utcDayStart(now).getTime() - COPY_DAYS * DAY_MS);
}

function log(msg: string) {
  console.log(`[migrate-tracking-tokens] ${msg}`);
}

async function relkind(rel: string): Promise<string | null> {
  const r = await pool.query(
    `SELECT c.relkind::text AS k
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relname = $1 AND n.nspname = 'public'`,
    [rel],
  );
  return r.rows.length ? r.rows[0].k : null;
}

async function tableSize(rel: string): Promise<string | null> {
  try {
    const r = await pool.query(
      `SELECT pg_size_pretty(pg_total_relation_size($1::regclass)) AS s`,
      [`public.${rel}`],
    );
    return r.rows[0]?.s ?? null;
  } catch {
    return null;
  }
}

async function cmdStatus() {
  const active = await relkind(ACTIVE_TABLE);
  const partitioned = active === "p";
  log(`${ACTIVE_TABLE}: ${active === null ? "MISSING" : active === "p" ? "PARTITIONED" : `plain (relkind=${active})`} size=${await tableSize(ACTIVE_TABLE)}`);
  log(`${NEW_TABLE}: ${(await relationExists(pool, NEW_TABLE)) ? `exists (relkind=${await relkind(NEW_TABLE)}) size=${await tableSize(NEW_TABLE)}` : "absent"}`);
  log(`${LEGACY_TABLE}: ${(await relationExists(pool, LEGACY_TABLE)) ? `exists size=${await tableSize(LEGACY_TABLE)}` : "absent"}`);

  if (partitioned) {
    const parts = await listTrackingTokenPartitions(pool, ACTIVE_TABLE);
    log(`active partitions (${parts.length}): ${parts.map((p) => p.name.replace("tracking_tokens_", "")).join(", ")}`);
  }
  const newParts = (await relationExists(pool, NEW_TABLE)) ? await listTrackingTokenPartitions(pool, NEW_TABLE) : [];
  if (newParts.length) {
    log(`${NEW_TABLE} partitions (${newParts.length}): ${newParts.map((p) => p.name.replace("tracking_tokens_", "")).join(", ")}`);
  }
  log(`COPY_DAYS=${COPY_DAYS} cutoff=${copyCutoff().toISOString()}`);
}

async function cmdPrepare() {
  if (await isTrackingTokensPartitioned(pool)) {
    log(`${ACTIVE_TABLE} is ALREADY partitioned — migration appears done. Nothing to prepare.`);
    return;
  }
  if (await relationExists(pool, NEW_TABLE) && (await relkind(NEW_TABLE)) !== "p") {
    throw new Error(`${NEW_TABLE} exists but is not partitioned — manual cleanup required.`);
  }

  log(`Creating partitioned ${NEW_TABLE} ...`);
  for (const ddl of buildPartitionedTableDDL(NEW_TABLE)) {
    await pool.query(ddl);
  }
  // daysBehind = COPY_DAYS + 1 so boundary rows always land in an existing
  // partition; daysAhead = 7 so live writes after the swap are covered.
  const created = await ensureTrackingTokenPartitions(pool, {
    parentTable: NEW_TABLE,
    daysBehind: COPY_DAYS + 1,
    daysAhead: 7,
  });
  log(`Prepared ${NEW_TABLE} with ${created.length} new partition(s). Ready for swap.`);
}

async function cmdSwap(confirmed: boolean) {
  if (await isTrackingTokensPartitioned(pool)) {
    log(`${ACTIVE_TABLE} is already partitioned — swap already done. Skipping.`);
    return;
  }
  if (!(await relationExists(pool, NEW_TABLE))) {
    throw new Error(`${NEW_TABLE} does not exist — run 'prepare' first.`);
  }
  if (await relationExists(pool, LEGACY_TABLE)) {
    throw new Error(`${LEGACY_TABLE} already exists — a previous swap may have partially run. Inspect before continuing.`);
  }
  if (!confirmed) {
    log(`DESTRUCTIVE: this renames ${ACTIVE_TABLE} -> ${LEGACY_TABLE} and ${NEW_TABLE} -> ${ACTIVE_TABLE}.`);
    log(`Re-run with --yes to proceed.`);
    return;
  }

  // Re-ensure partition coverage at swap-time. `prepare` may have run hours/days
  // earlier, so its forward buffer could be stale; without this, a live insert
  // right after the rename could hit "no partition found for row" and drop a
  // tracking event. ensure is idempotent (CREATE IF NOT EXISTS by canonical name).
  const ensured = await ensureTrackingTokenPartitions(pool, {
    parentTable: NEW_TABLE,
    daysBehind: COPY_DAYS + 1,
    daysAhead: 7,
  });
  log(`Re-ensured partition coverage on ${NEW_TABLE} before swap (created ${ensured.length} new).`);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`ALTER TABLE ${ACTIVE_TABLE} RENAME TO ${LEGACY_TABLE}`);
    await client.query(`ALTER TABLE ${NEW_TABLE} RENAME TO ${ACTIVE_TABLE}`);
    await client.query("COMMIT");
    log(`SWAP complete: ${ACTIVE_TABLE} is now partitioned; old data preserved in ${LEGACY_TABLE}.`);
    log(`Reads now dual-read from ${LEGACY_TABLE} until 'copy' completes and 'drop-legacy' runs.`);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Copy a single [start,end) window with a FRESH connection from the direct
// (unpooled) copy pool. Each chunk is a single autocommit INSERT..SELECT — on a
// direct session-mode backend `statement_timeout = 0` (set on the pool) sticks,
// so multi-minute chunks run to completion. A JS watchdog still guards the rare
// case where a backend goes silent (no socket error): it rejects and the client
// is destroyed (not returned to the pool) so the next attempt reconnects.
// Idempotent via ON CONFLICT DO NOTHING, so retrying a partial/unknown failure
// is always safe.
async function copyChunk(copyPool: pg.Pool, start: Date, end: Date): Promise<number> {
  const MAX_ATTEMPTS = 6;
  const WATCHDOG_MS = 8 * 60 * 1000; // chunks observed <=~75s; ample margin, fast recovery
  let lastErr: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let client: any;
    let timer: NodeJS.Timeout | undefined;
    try {
      client = await copyPool.connect();
      const q = client.query(
        `INSERT INTO ${ACTIVE_TABLE} (token, type, campaign_id, subscriber_id, link_id, created_at)
         SELECT token, type, campaign_id, subscriber_id, link_id, created_at
         FROM ${LEGACY_TABLE}
         WHERE created_at >= $1 AND created_at < $2
         ON CONFLICT DO NOTHING`,
        [start, end],
      );
      q.catch(() => {}); // swallow a late rejection if the watchdog wins the race
      const watchdog = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`watchdog ${WATCHDOG_MS}ms exceeded`));
        }, WATCHDOG_MS);
      });
      const res: any = await Promise.race([q, watchdog]);
      if (timer) clearTimeout(timer);
      client.release();
      return res.rowCount ?? 0;
    } catch (err) {
      lastErr = err;
      if (timer) clearTimeout(timer);
      if (client) client.release(err as Error); // destroy: backend may be busy/dead
      if (attempt >= MAX_ATTEMPTS) break;
      const backoff = Math.min(30000, 1000 * 2 ** (attempt - 1));
      log(
        `  ! chunk ${start.toISOString()} attempt ${attempt} failed (${(err as Error).message}); retrying in ${backoff}ms`,
      );
      await sleep(backoff);
    }
  }
  throw new Error(
    `copyChunk ${start.toISOString()}..${end.toISOString()} failed after ${MAX_ATTEMPTS} attempts: ${(lastErr as Error)?.message}`,
  );
}

async function cmdCopy() {
  if (!(await isTrackingTokensPartitioned(pool))) {
    throw new Error(`${ACTIVE_TABLE} is not partitioned — run prepare + swap first.`);
  }
  if (!(await relationExists(pool, LEGACY_TABLE))) {
    throw new Error(`${LEGACY_TABLE} does not exist — nothing to copy.`);
  }

  const cutoff = copyCutoff();
  log(`Copying rows with created_at >= ${cutoff.toISOString()} from ${LEGACY_TABLE} -> ${ACTIVE_TABLE} (direct unpooled connection, server-side INSERT..SELECT, 10-min chunks) ...`);

  // Server-side set-based copy: each INSERT..SELECT runs entirely inside the DB
  // (no rows shipped to this client), using tracking_tokens_created_at_idx for the
  // range scan and partition routing on insert. Runs over a DEDICATED DIRECT
  // (unpooled) pool (see createCopyPool) so statement_timeout=0 sticks and the
  // long set-based chunks don't starve on PgBouncer. ON CONFLICT DO NOTHING keeps
  // every chunk idempotent and resumable.
  const copyPool = createCopyPool();
  const CHUNK_MS = 10 * 60 * 1000; // 10 minutes
  let start = new Date(Math.floor(cutoff.getTime() / CHUNK_MS) * CHUNK_MS);
  // Copy through the boundary after "now" so any legacy row written right up to
  // the swap is included (live post-swap rows already land in the new table).
  const end = new Date(Math.ceil((Date.now() + CHUNK_MS) / CHUNK_MS) * CHUNK_MS);

  let totalInserted = 0;
  let chunks = 0;
  const startedAt = Date.now();

  try {
    while (start < end) {
      const chunkEnd = new Date(start.getTime() + CHUNK_MS);
      const t0 = Date.now();
      const n = await copyChunk(copyPool, start, chunkEnd);
      totalInserted += n;
      chunks++;
      if (n > 0 || chunks % 36 === 0) {
        log(
          `  ${start.toISOString()} -> +${n.toLocaleString()} (total ${totalInserted.toLocaleString()}, ${Math.round((Date.now() - t0) / 1000)}s)`,
        );
      }
      start = chunkEnd;
    }
  } finally {
    await copyPool.end().catch(() => {});
  }

  log(`COPY done: ${totalInserted.toLocaleString()} rows inserted in ${chunks} chunks (${Math.round((Date.now() - startedAt) / 1000)}s).`);
}

async function cmdVerify() {
  const cutoff = copyCutoff();
  log(`Verifying windowed counts (created_at >= ${cutoff.toISOString()}) ...`);

  const newCountP = pool.query(
    `SELECT count(*)::bigint AS c FROM ${ACTIVE_TABLE} WHERE created_at >= $1`,
    [cutoff],
  );
  const legacyExists = await relationExists(pool, LEGACY_TABLE);
  const legacyCountP = legacyExists
    ? pool.query(`SELECT count(*)::bigint AS c FROM ${LEGACY_TABLE} WHERE created_at >= $1`, [cutoff])
    : Promise.resolve({ rows: [{ c: "0" }] } as any);

  const [newRes, legacyRes] = await Promise.all([newCountP, legacyCountP]);
  const newCount = Number(newRes.rows[0].c);
  const legacyCount = Number(legacyRes.rows[0].c);
  const diff = legacyCount - newCount;
  const pct = legacyCount > 0 ? ((diff / legacyCount) * 100).toFixed(4) : "0";

  log(`  ${ACTIVE_TABLE} (windowed): ${newCount.toLocaleString()}`);
  log(`  ${LEGACY_TABLE} (windowed): ${legacyCount.toLocaleString()}${legacyExists ? "" : " (legacy absent)"}`);
  log(`  missing in new: ${diff.toLocaleString()} (${pct}%) — expected to be small (token-collision conflicts skipped via ON CONFLICT DO NOTHING).`);

  const parts = await listTrackingTokenPartitions(pool, ACTIVE_TABLE);
  log(`  ${ACTIVE_TABLE} partitions (${parts.length}): ${parts.map((p) => p.name.replace("tracking_tokens_", "")).join(", ")}`);
  log(`  ${ACTIVE_TABLE} size=${await tableSize(ACTIVE_TABLE)}${legacyExists ? ` ${LEGACY_TABLE} size=${await tableSize(LEGACY_TABLE)}` : ""}`);

  if (diff < 0) {
    log(`  NOTE: new has MORE rows than legacy window — fine if live writes accrued after swap.`);
  }
}

async function cmdDropLegacy(confirmed: boolean) {
  if (!(await relationExists(pool, LEGACY_TABLE))) {
    log(`${LEGACY_TABLE} does not exist — nothing to drop.`);
    return;
  }
  if (!(await isTrackingTokensPartitioned(pool))) {
    throw new Error(`SAFETY: ${ACTIVE_TABLE} is not partitioned — refusing to drop ${LEGACY_TABLE} (swap may not have run).`);
  }
  if (!confirmed) {
    log(`DESTRUCTIVE: this permanently drops ${LEGACY_TABLE} (size=${await tableSize(LEGACY_TABLE)}).`);
    log(`Ensure 'copy' + 'verify' look correct first. Re-run with --yes to proceed.`);
    return;
  }
  log(`Dropping ${LEGACY_TABLE} ...`);
  await pool.query(`DROP TABLE IF EXISTS ${LEGACY_TABLE}`);
  log(`${LEGACY_TABLE} dropped. Space reclaimed. Migration complete.`);
}

async function main() {
  const cmd = process.argv[2];
  const confirmed = process.argv.includes("--yes");

  switch (cmd) {
    case "status": await cmdStatus(); break;
    case "prepare": await cmdPrepare(); break;
    case "swap": await cmdSwap(confirmed); break;
    case "copy": await cmdCopy(); break;
    case "verify": await cmdVerify(); break;
    case "drop-legacy": await cmdDropLegacy(confirmed); break;
    default:
      console.log("Usage: npx tsx scripts/migrate-tracking-tokens-partitioning.ts <status|prepare|swap|copy|verify|drop-legacy> [--yes]");
      process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error("[migrate-tracking-tokens] FAILED:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => {});
    // server/db.ts arms non-unref'd timers (pool-stats + keepalive) that keep the
    // event loop alive; force a clean exit once our work + pool teardown are done.
    process.exit(process.exitCode ?? 0);
  });
