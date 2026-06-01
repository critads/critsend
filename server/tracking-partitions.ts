/**
 * tracking_tokens partition management
 * ------------------------------------
 * `tracking_tokens` is RANGE-partitioned by `created_at`, one partition per UTC
 * day, named deterministically `tracking_tokens_pYYYYMMDD`. Retention is enforced
 * by DROPping whole day-partitions (instant, no WAL bloat) instead of running a
 * multi-hour DELETE that never returns disk on Neon.
 *
 * These helpers are deliberately self-contained and accept any pg `Queryable`
 * (Pool or PoolClient) so the same logic is shared by:
 *   - the bootstrap DDL (server/repositories/campaign-repository.ts)
 *   - the daily 01:00 Paris maintenance job (server/workers.ts)
 *   - the one-time cutover script (scripts/migrate-tracking-tokens-partitioning.ts)
 *
 * Partition bounds are pinned to UTC (`... 00:00:00+00`) so the day boundaries are
 * deterministic regardless of the server/session timezone.
 */

import { logger } from "./logger";

export interface Queryable {
  query(text: string, params?: any[]): Promise<{ rows: any[]; rowCount?: number | null }>;
}

export const TRACKING_TOKENS_TABLE = "tracking_tokens";
const PARTITION_PREFIX = "tracking_tokens_p";
const PARTITION_NAME_RE = /^tracking_tokens_p(\d{8})$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Truncate a Date to the start of its UTC day. */
function utcDayStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** Format a UTC day as `YYYY-MM-DD`. */
function utcDateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Partition name for the UTC day containing `d`, e.g. tracking_tokens_p20260601. */
export function trackingPartitionName(d: Date): string {
  return PARTITION_PREFIX + utcDateStr(utcDayStart(d)).replace(/-/g, "");
}

/** Parse the UTC day a partition covers from its name, or null if not a partition. */
export function parsePartitionDate(name: string): Date | null {
  const m = PARTITION_NAME_RE.exec(name);
  if (!m) return null;
  const s = m[1];
  const y = Number(s.slice(0, 4));
  const mo = Number(s.slice(4, 6));
  const da = Number(s.slice(6, 8));
  const d = new Date(Date.UTC(y, mo - 1, da));
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * True if `tracking_tokens` exists AND is a partitioned table (relkind 'p').
 * Returns false for a plain table (pre-migration) or if the table is absent.
 */
export async function isTrackingTokensPartitioned(client: Queryable): Promise<boolean> {
  const res = await client.query(
    `SELECT c.relkind::text AS relkind
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relname = $1 AND n.nspname = 'public'`,
    [TRACKING_TOKENS_TABLE],
  );
  return res.rows.length > 0 && res.rows[0].relkind === "p";
}

/** True if a relation with the given name exists in the public schema. */
export async function relationExists(client: Queryable, relname: string): Promise<boolean> {
  const res = await client.query(
    `SELECT 1
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relname = $1 AND n.nspname = 'public'
     LIMIT 1`,
    [relname],
  );
  return res.rows.length > 0;
}

/** List existing day-partitions of `tracking_tokens` with their UTC day. */
export async function listTrackingTokenPartitions(
  client: Queryable,
  parentTable: string = TRACKING_TOKENS_TABLE,
): Promise<Array<{ name: string; day: Date }>> {
  const res = await client.query(
    `SELECT c.relname AS name
     FROM pg_inherits i
     JOIN pg_class c ON c.oid = i.inhrelid
     JOIN pg_class p ON p.oid = i.inhparent
     JOIN pg_namespace n ON n.oid = p.relnamespace
     WHERE p.relname = $1 AND n.nspname = 'public'`,
    [parentTable],
  );
  const out: Array<{ name: string; day: Date }> = [];
  for (const row of res.rows) {
    const day = parsePartitionDate(row.name);
    if (day) out.push({ name: row.name, day });
  }
  out.sort((a, b) => a.day.getTime() - b.day.getTime());
  return out;
}

function createPartitionSql(day: Date, parentTable: string = TRACKING_TOKENS_TABLE): { name: string; sql: string } {
  const start = utcDayStart(day);
  const end = new Date(start.getTime() + DAY_MS);
  // Canonical child name (tracking_tokens_pYYYYMMDD) regardless of parent, so a
  // partition created on tracking_tokens_new during the migration is recognised by
  // listTrackingTokenPartitions() (and retention) after the parent is renamed.
  const name = trackingPartitionName(start);
  const sql = `CREATE TABLE IF NOT EXISTS ${name}
     PARTITION OF ${parentTable}
     FOR VALUES FROM ('${utcDateStr(start)} 00:00:00+00') TO ('${utcDateStr(end)} 00:00:00+00')`;
  return { name, sql };
}

/**
 * Ensure day-partitions exist for the window [today-daysBehind .. today+daysAhead]
 * (UTC). Idempotent (CREATE TABLE IF NOT EXISTS by deterministic name). A generous
 * `daysAhead` buffer guarantees inserts never hit a missing partition even if the
 * daily maintenance job is delayed for several days.
 *
 * Returns the names of partitions that were newly created.
 */
export async function ensureTrackingTokenPartitions(
  client: Queryable,
  opts: { daysAhead?: number; daysBehind?: number; now?: Date; parentTable?: string } = {},
): Promise<string[]> {
  const daysAhead = opts.daysAhead ?? 7;
  const daysBehind = opts.daysBehind ?? 1;
  const now = opts.now ?? new Date();
  const parentTable = opts.parentTable ?? TRACKING_TOKENS_TABLE;
  const today = utcDayStart(now);

  const existing = new Set((await listTrackingTokenPartitions(client, parentTable)).map((p) => p.name));
  const created: string[] = [];

  for (let offset = -daysBehind; offset <= daysAhead; offset++) {
    const day = new Date(today.getTime() + offset * DAY_MS);
    const { name, sql } = createPartitionSql(day, parentTable);
    if (existing.has(name)) continue;
    await client.query(sql);
    created.push(name);
  }

  if (created.length > 0) {
    logger.info(`[TRACKING-PARTITIONS] Ensured partitions, created ${created.length}: ${created.join(", ")}`);
  }
  return created;
}

/**
 * DROP day-partitions whose UTC day is strictly older than (today - retentionDays).
 * Each DROP is instant and reclaims the partition's storage immediately.
 *
 * Returns the names of partitions that were dropped.
 */
export async function dropExpiredTrackingTokenPartitions(
  client: Queryable,
  retentionDays: number,
  opts: { now?: Date } = {},
): Promise<string[]> {
  const now = opts.now ?? new Date();
  const today = utcDayStart(now);
  const cutoff = new Date(today.getTime() - retentionDays * DAY_MS);

  const partitions = await listTrackingTokenPartitions(client);
  const dropped: string[] = [];

  for (const p of partitions) {
    // Keep a partition whose day is >= cutoff. The partition covers [day, day+1),
    // so dropping when day < cutoff means its entire range is older than the
    // retention horizon.
    if (p.day.getTime() < cutoff.getTime()) {
      await client.query(`DROP TABLE IF EXISTS ${p.name}`);
      dropped.push(p.name);
    }
  }

  if (dropped.length > 0) {
    logger.info(
      `[TRACKING-PARTITIONS] Retention ${retentionDays}d (cutoff ${utcDateStr(cutoff)} UTC): dropped ${dropped.length} partitions: ${dropped.join(", ")}`,
    );
  }
  return dropped;
}

/**
 * Full DDL to create the partitioned parent table (no partitions). Used by the
 * bootstrap path on a fresh install and by the migration's `prepare` step (with a
 * different table name). Indexes mirror the historical non-partitioned schema:
 *   - PK (token, created_at)            — token lookups scan ≤retention partitions
 *   - logical idx (type,campaign,subscriber,COALESCE(link_id,'')) — re-fetch path
 *   - campaign_id idx, subscriber_id idx
 * Note: the logical index is intentionally NON-unique. On a partitioned table a
 * UNIQUE index must include the partition key (created_at), which would no longer
 * enforce cross-time logical uniqueness anyway — so we drop the pretense and avoid
 * the write cost of a unique check that never fires.
 */
export function buildPartitionedTableDDL(tableName: string): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS ${tableName} (
       token varchar(8) NOT NULL,
       type varchar(11) NOT NULL,
       campaign_id varchar NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
       subscriber_id varchar NOT NULL,
       link_id varchar REFERENCES campaign_links(id) ON DELETE CASCADE,
       created_at timestamptz NOT NULL DEFAULT now(),
       PRIMARY KEY (token, created_at)
     ) PARTITION BY RANGE (created_at)`,
    `CREATE INDEX IF NOT EXISTS ${tableName}_logical_idx
       ON ${tableName} (type, campaign_id, subscriber_id, COALESCE(link_id, ''))`,
    `CREATE INDEX IF NOT EXISTS ${tableName}_campaign_idx ON ${tableName} (campaign_id)`,
    `CREATE INDEX IF NOT EXISTS ${tableName}_subscriber_idx ON ${tableName} (subscriber_id)`,
  ];
}

/**
 * Dual-read fallback during the partition migration.
 * --------------------------------------------------
 * The cutover renames the old non-partitioned table to `tracking_tokens_legacy`
 * and swaps an (initially empty) partitioned table into its place. Until the last
 * 14 days are copied over, recent tokens still live only in the legacy table, so a
 * token lookup that MISSES the primary table must fall back to the legacy table to
 * avoid losing any opens/clicks. Once the migration drops the legacy table the
 * fallback self-disables.
 *
 * We cache the legacy table's existence with a short TTL (instead of a permanent
 * "gone" latch) because the latch could otherwise be set BEFORE the migration ever
 * creates the legacy table (pre-migration there is no legacy table → every miss
 * would otherwise permanently disable the fallback). The TTL re-discovers the
 * legacy table when the migration creates it, and `noteLegacyTokensTableGone()`
 * (called on a 42P01 from a legacy read) flips it off immediately after the drop.
 */
export const LEGACY_TOKENS_TABLE = "tracking_tokens_legacy";
const LEGACY_EXISTS_TTL_MS = 60_000;
let legacyExistsCache: boolean | null = null;
let legacyExistsCheckedAt = 0;

export async function legacyTokensTableExists(client: Queryable): Promise<boolean> {
  const now = Date.now();
  if (legacyExistsCache !== null && now - legacyExistsCheckedAt < LEGACY_EXISTS_TTL_MS) {
    return legacyExistsCache;
  }
  try {
    legacyExistsCache = await relationExists(client, LEGACY_TOKENS_TABLE);
  } catch {
    legacyExistsCache = false;
  }
  legacyExistsCheckedAt = now;
  return legacyExistsCache;
}

/** Force the legacy-existence cache to "gone" (called when a read sees 42P01). */
export function noteLegacyTokensTableGone(): void {
  legacyExistsCache = false;
  legacyExistsCheckedAt = Date.now();
  logger.info("[tracking_tokens] legacy table no longer exists — dual-read fallback disabled");
}
