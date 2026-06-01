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
 *   COPY_BATCH_SIZE   rows per keyset batch (default 20000)
 */
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
const COPY_BATCH_SIZE = Number(process.env.COPY_BATCH_SIZE || 20000);
const DAY_MS = 24 * 60 * 60 * 1000;

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

async function cmdCopy() {
  if (!(await isTrackingTokensPartitioned(pool))) {
    throw new Error(`${ACTIVE_TABLE} is not partitioned — run prepare + swap first.`);
  }
  if (!(await relationExists(pool, LEGACY_TABLE))) {
    throw new Error(`${LEGACY_TABLE} does not exist — nothing to copy.`);
  }

  const cutoff = copyCutoff();
  log(`Copying rows with created_at >= ${cutoff.toISOString()} from ${LEGACY_TABLE} -> ${ACTIVE_TABLE} (batch ${COPY_BATCH_SIZE}) ...`);

  let cursor: { ca: Date; tok: string } | null = null;
  let totalScanned = 0;
  let batches = 0;
  const startedAt = Date.now();

  for (;;) {
    const params: any[] = [cutoff];
    let keyset = "";
    if (cursor) {
      keyset = `AND (created_at, token) > ($2, $3)`;
      params.push(cursor.ca, cursor.tok);
    }
    const limitIdx = params.length + 1;
    params.push(COPY_BATCH_SIZE);

    const sel = await pool.query(
      `SELECT token, type, campaign_id, subscriber_id, link_id, created_at
       FROM ${LEGACY_TABLE}
       WHERE created_at >= $1 ${keyset}
       ORDER BY created_at, token
       LIMIT $${limitIdx}`,
      params,
    );
    if (sel.rows.length === 0) break;

    const tokens = sel.rows.map((r) => r.token);
    const types = sel.rows.map((r) => r.type);
    const camps = sel.rows.map((r) => r.campaign_id);
    const subs = sel.rows.map((r) => r.subscriber_id);
    const links = sel.rows.map((r) => r.link_id ?? null);
    const cas = sel.rows.map((r) => r.created_at);

    await pool.query(
      `INSERT INTO ${ACTIVE_TABLE} (token, type, campaign_id, subscriber_id, link_id, created_at)
       SELECT * FROM unnest(
         $1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::timestamptz[]
       )
       ON CONFLICT DO NOTHING`,
      [tokens, types, camps, subs, links, cas],
    );

    const last = sel.rows[sel.rows.length - 1];
    cursor = { ca: last.created_at, tok: last.token };
    totalScanned += sel.rows.length;
    batches++;

    if (batches % 20 === 0) {
      const rate = Math.round(totalScanned / ((Date.now() - startedAt) / 1000));
      log(`  ... ${totalScanned.toLocaleString()} rows processed (${batches} batches, ~${rate.toLocaleString()}/s), cursor=${cursor.ca.toISOString()}`);
    }

    if (sel.rows.length < COPY_BATCH_SIZE) break;
  }

  log(`COPY done: ${totalScanned.toLocaleString()} legacy rows processed in ${batches} batches (${Math.round((Date.now() - startedAt) / 1000)}s).`);
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
