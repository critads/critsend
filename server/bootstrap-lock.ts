import { pool } from "./db";
import { logger } from "./logger";
import type { PoolClient } from "pg";

const ADVISORY_LOCK_KEY_TRACKING_TOKENS = 900001;
const ADVISORY_LOCK_KEY_TRACKING_BOOTSTRAP = 900002;
const ADVISORY_LOCK_KEY_ANALYTICS_BOOTSTRAP = 900003;
const ADVISORY_LOCK_KEY_TRIGRAM_INDEX = 900004;
const ADVISORY_LOCK_KEY_SEGMENT_NAME_TRGM = 900005;
const ADVISORY_LOCK_KEY_CAMPAIGN_NAME_TRGM = 900006;
const ADVISORY_LOCK_KEY_MTA_NAME_TRGM = 900007;
const ADVISORY_LOCK_KEY_SEGMENT_NAME_LOWER = 900008;
const ADVISORY_LOCK_KEY_CAMPAIGN_SUBJECT_TRGM = 900009;
const ADVISORY_LOCK_KEY_MTA_HOSTNAME_TRGM = 900010;
const ADVISORY_LOCK_KEY_CAMPAIGN_ORIGINALS_LIST = 900011;
const ADVISORY_LOCK_KEY_CAMPAIGN_EXCLUDE_SEGMENT = 900012;
const ADVISORY_LOCK_KEY_PRESSURE_GUARD = 900013;
const ADVISORY_LOCK_KEY_PRESSURE_DRAIN = 900014;
const ADVISORY_LOCK_KEY_PRESSURE_MAINTENANCE = 900015;
const ADVISORY_LOCK_KEY_PRESSURE_AUDIT_TTL = 900016;
const ADVISORY_LOCK_KEY_CAMPAIGN_SENDS_PRESSURE_HELD = 900017;
const ADVISORY_LOCK_KEY_INVALID_INDEX_REAPER = 900018;
const ADVISORY_LOCK_KEY_CAMPAIGNS_SCHEDULED_AT = 900019;
const ADVISORY_LOCK_KEY_CAMPAIGN_NAME_UNACCENT_TRGM = 900020;
const ADVISORY_LOCK_KEY_CAMPAIGNS_FIRST_SEND_AT = 900021;
const ADVISORY_LOCK_KEY_CAMPAIGN_CALENDAR_INDEXES = 900022;

export const LOCK_KEYS = {
  TRACKING_TOKENS: ADVISORY_LOCK_KEY_TRACKING_TOKENS,
  TRACKING_BOOTSTRAP: ADVISORY_LOCK_KEY_TRACKING_BOOTSTRAP,
  ANALYTICS_BOOTSTRAP: ADVISORY_LOCK_KEY_ANALYTICS_BOOTSTRAP,
  TRIGRAM_INDEX: ADVISORY_LOCK_KEY_TRIGRAM_INDEX,
  SEGMENT_NAME_TRGM: ADVISORY_LOCK_KEY_SEGMENT_NAME_TRGM,
  CAMPAIGN_NAME_TRGM: ADVISORY_LOCK_KEY_CAMPAIGN_NAME_TRGM,
  MTA_NAME_TRGM: ADVISORY_LOCK_KEY_MTA_NAME_TRGM,
  SEGMENT_NAME_LOWER: ADVISORY_LOCK_KEY_SEGMENT_NAME_LOWER,
  CAMPAIGN_SUBJECT_TRGM: ADVISORY_LOCK_KEY_CAMPAIGN_SUBJECT_TRGM,
  MTA_HOSTNAME_TRGM: ADVISORY_LOCK_KEY_MTA_HOSTNAME_TRGM,
  CAMPAIGN_ORIGINALS_LIST: ADVISORY_LOCK_KEY_CAMPAIGN_ORIGINALS_LIST,
  CAMPAIGN_EXCLUDE_SEGMENT: ADVISORY_LOCK_KEY_CAMPAIGN_EXCLUDE_SEGMENT,
  PRESSURE_GUARD: ADVISORY_LOCK_KEY_PRESSURE_GUARD,
  PRESSURE_DRAIN: ADVISORY_LOCK_KEY_PRESSURE_DRAIN,
  PRESSURE_MAINTENANCE: ADVISORY_LOCK_KEY_PRESSURE_MAINTENANCE,
  PRESSURE_AUDIT_TTL: ADVISORY_LOCK_KEY_PRESSURE_AUDIT_TTL,
  CAMPAIGN_SENDS_PRESSURE_HELD: ADVISORY_LOCK_KEY_CAMPAIGN_SENDS_PRESSURE_HELD,
  INVALID_INDEX_REAPER: ADVISORY_LOCK_KEY_INVALID_INDEX_REAPER,
  CAMPAIGNS_SCHEDULED_AT: ADVISORY_LOCK_KEY_CAMPAIGNS_SCHEDULED_AT,
  CAMPAIGN_NAME_UNACCENT_TRGM: ADVISORY_LOCK_KEY_CAMPAIGN_NAME_UNACCENT_TRGM,
  CAMPAIGNS_FIRST_SEND_AT: ADVISORY_LOCK_KEY_CAMPAIGNS_FIRST_SEND_AT,
  CAMPAIGN_CALENDAR_INDEXES: ADVISORY_LOCK_KEY_CAMPAIGN_CALENDAR_INDEXES,
} as const;

export type LockResult = "ran" | "skipped" | "error";

export async function withAdvisoryLock(
  lockKey: number,
  label: string,
  fn: (client: PoolClient) => Promise<void>,
): Promise<LockResult> {
  let client: PoolClient | null = null;
  try {
    client = await pool.connect();
    const res = await client.query<{ acquired: boolean }>(
      `SELECT pg_try_advisory_lock($1) AS acquired`,
      [lockKey],
    );
    const acquired = res.rows[0]?.acquired === true;
    if (!acquired) {
      logger.info(`[${label}] Another process is running bootstrap — skipping`);
      client.release();
      return "skipped";
    }
    try {
      await fn(client);
    } finally {
      try {
        await client.query(`SELECT pg_advisory_unlock($1)`, [lockKey]);
      } catch (unlockErr: any) {
        logger.warn(`[${label}] Failed to release advisory lock ${lockKey}: ${unlockErr?.message || unlockErr}`);
      }
      client.release();
    }
    return "ran";
  } catch (err: any) {
    logger.warn(`[${label}] Bootstrap lock error: ${err?.message || err}`);
    if (client) {
      try { client.release(); } catch {}
    }
    return "error";
  }
}

/**
 * Probe whether an index exists and is VALID (i.e. usable by the planner).
 *
 * History (2026-05-14 → 2026-05-22):
 *   v1 (auto-drop, default on): any PM2 restart during business hours
 *     could trigger a multi-minute DROP+CREATE on a hot-path index → seq
 *     scan window → pool saturation → 503s.
 *   v2 (refuse, default off): if an index was INVALID, log and bail.
 *     Operator must REINDEX manually. Sounded safer in theory, was a
 *     disaster in practice: the very first failed CREATE INDEX
 *     CONCURRENTLY (statement_timeout, lock conflict, duplicate row on
 *     UNIQUE — any reason) left an INVALID index that the planner could
 *     not use AT ALL. Result: permanent seq scan on every boot, until a
 *     human noticed and ran REINDEX during an off-hours window.
 *     Production incident 2026-05-22: 12 INVALID indexes across hot
 *     tables (campaign_sends 13GB, tracking_tokens 130GB), drain output
 *     fell to ~2 sends/h.
 *   v3 (proactive reap + auto-drop, default on — THIS VERSION): we
 *     accept the auto-drop premise but flip the conclusion: an INVALID
 *     index is ALREADY useless to the planner, so dropping it does not
 *     make things worse — and CREATE INDEX CONCURRENTLY runs in the
 *     background without blocking writes. Net effect during the rebuild
 *     window is identical to v2 (seq scans), with the critical
 *     difference that it terminates automatically.
 *
 * Reap runs once per boot via `reapInvalidIndexes()` (called from
 * web/worker/drainer entrypoints under an advisory lock). This function
 * remains the per-index probe used by `ensureXxxIndex` helpers.
 *
 * Override: `BOOTSTRAP_AUTO_DROP_INVALID_INDEXES=false` (case-insensitive)
 * disables the auto-drop behaviour and restores the v2 refuse-to-touch
 * fallback. Set this only if you know what you're doing.
 */
export async function indexExistsAndValid(indexName: string): Promise<boolean> {
  try {
    const result = await pool.query<{ valid: boolean }>(
      `SELECT i.indisvalid AS valid
       FROM pg_class c
       JOIN pg_index i ON i.indexrelid = c.oid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = $1
       LIMIT 1`,
      [indexName],
    );
    if (result.rows.length === 0) return false;
    if (!result.rows[0].valid) {
      const autoDropEnv = String(process.env.BOOTSTRAP_AUTO_DROP_INVALID_INDEXES || "").toLowerCase();
      // Default: TRUE. Only "false"/"0"/"no" disables. See history note above.
      const autoDrop = !(autoDropEnv === "false" || autoDropEnv === "0" || autoDropEnv === "no");
      if (autoDrop) {
        logger.warn(`[BOOTSTRAP_LOCK] Index ${indexName} is INVALID — auto-dropping so caller can recreate (set BOOTSTRAP_AUTO_DROP_INVALID_INDEXES=false to disable)`);
        try {
          await runIndexDdlNoTimeout(`DROP INDEX CONCURRENTLY IF EXISTS "${indexName}"`, `DROP ${indexName}`);
        } catch (err: any) {
          logger.error(`[BOOTSTRAP_LOCK] DROP of invalid index ${indexName} failed: ${err?.message || err}`);
          try {
            const { invalidIndexesGauge } = await import("./metrics");
            invalidIndexesGauge?.set({ index_name: indexName }, 1);
          } catch { /* metrics import optional */ }
          return true; // treat as present, skip CREATE
        }
        // Index is gone — bootstrap caller will CREATE it.
        try {
          const { invalidIndexesGauge } = await import("./metrics");
          invalidIndexesGauge?.set({ index_name: indexName }, 0);
        } catch { /* metrics import optional */ }
        return false;
      }
      // Disabled by operator — refuse to touch.
      logger.error(
        `[BOOTSTRAP_LOCK] Index ${indexName} is INVALID and BOOTSTRAP_AUTO_DROP_INVALID_INDEXES=false — refusing to touch. ` +
        `Operator action required: run \`REINDEX INDEX CONCURRENTLY "${indexName}"\` during a low-traffic window.`,
      );
      try {
        const { invalidIndexesGauge } = await import("./metrics");
        invalidIndexesGauge?.set({ index_name: indexName }, 1);
      } catch { /* metrics import optional */ }
      return true;
    }
    return true;
  } catch (err: any) {
    logger.warn(`[BOOTSTRAP_LOCK] Failed to check index existence for ${indexName}: ${err?.message || err}`);
    return false;
  }
}

/**
 * Proactive scan-and-reap of INVALID indexes in the public schema.
 * Indexes currently listed in pg_stat_progress_create_index are excluded:
 * CREATE INDEX CONCURRENTLY is expected to expose an INVALID catalog entry
 * while it is actively building, and dropping it at that point deadlocks the
 * builder rather than cleaning up a stale artifact.
 *
 * Runs ONCE per process boot (gated by advisory lock 900018 — only one
 * web/worker/drainer instance does the work; the others observe a
 * `skipped` result and proceed). Cleans up two categories:
 *
 *   1) `*_ccnew` / `*_ccold` suffix — unambiguous REINDEX CONCURRENTLY
 *      leftovers. ALWAYS safe to drop; not bound to any application
 *      name, never referenced by application code. Postgres creates
 *      these as transient buddies during a REINDEX and orphans them if
 *      the REINDEX session dies.
 *
 *   2) Any other INVALID index whose name ends with `_idx` or `_pkey`
 *      (our naming convention + Drizzle's). The bootstrap caller will
 *      recreate via CREATE INDEX CONCURRENTLY IF NOT EXISTS later in
 *      the boot sequence. Skips anything that doesn't match this
 *      convention so we never touch user/extension-created indexes.
 *
 * Failures are isolated per-index: a single DROP that times out does
 * not block the rest of the reap. The function is best-effort and
 * never throws — it only logs + updates the `critsend_invalid_indexes`
 * gauge so an operator can alert on residual INVALID state.
 *
 * Important: this function does NOT recreate dropped indexes itself.
 * Recreation is the responsibility of the `ensureXxxIndex` helpers
 * called later in the bootstrap chain — they will see the index is
 * missing (after our drop) and issue CREATE INDEX CONCURRENTLY with
 * `statement_timeout=0` via `runIndexDdlNoTimeout`. This keeps the
 * reaper and the schema-of-record decoupled: adding a new index to
 * the codebase requires no change here.
 */
export type ReapResult = {
  status: "ran" | "skipped" | "disabled";
  scanned: number;
  dropped: number;
  failed: number;
  ccnewDropped: number;
  byIndex: Record<string, "dropped" | "failed">;
};

export async function reapInvalidIndexes(context: string = "boot"): Promise<ReapResult> {
  const disabled = String(process.env.BOOTSTRAP_INVALID_INDEX_REAPER_DISABLED || "")
    .toLowerCase() === "true";
  if (disabled) {
    logger.warn(`[INVALID_INDEX_REAPER] (${context}) disabled via BOOTSTRAP_INVALID_INDEX_REAPER_DISABLED=true — skipping`);
    return { status: "disabled", scanned: 0, dropped: 0, failed: 0, ccnewDropped: 0, byIndex: {} };
  }

  const lockResult = await withAdvisoryLock(
    ADVISORY_LOCK_KEY_INVALID_INDEX_REAPER,
    `INVALID_INDEX_REAPER(${context})`,
    async (client) => {
      // Scan: all INVALID indexes in public schema. We filter by name
      // pattern in JS so the SQL stays simple + auditable.
      const probe = await client.query<{
        index_name: string;
        table_name: string;
        idx_size: string;
        tbl_size: string;
      }>(
        `SELECT c.relname                                    AS index_name,
                t.relname                                    AS table_name,
                pg_size_pretty(pg_relation_size(c.oid))      AS idx_size,
                pg_size_pretty(pg_relation_size(t.oid))      AS tbl_size
         FROM pg_index i
         JOIN pg_class c ON c.oid = i.indexrelid
         JOIN pg_class t ON t.oid = i.indrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public'
           AND NOT i.indisvalid
            AND NOT EXISTS (
              SELECT 1
              FROM pg_stat_progress_create_index p
              WHERE p.index_relid = c.oid
            )
         ORDER BY pg_relation_size(t.oid) DESC, c.relname`,
      );

      if (probe.rows.length === 0) {
        logger.info(`[INVALID_INDEX_REAPER] (${context}) no INVALID indexes — schema is clean`);
        return;
      }

      logger.warn(
        `[INVALID_INDEX_REAPER] (${context}) found ${probe.rows.length} INVALID index(es): ` +
        probe.rows.map(r => `${r.index_name}(${r.idx_size} on ${r.table_name}/${r.tbl_size})`).join(", "),
      );

      for (const row of probe.rows) {
        const name = row.index_name;
        // Safety: only touch indexes that match our naming conventions
        // OR are obvious REINDEX leftovers. Never touch user-created
        // or extension-created indexes (no `_idx`/`_pkey`/`_ccnew`/
        // `_ccold` suffix).
        const isCcLeftover = name.endsWith("_ccnew") || name.endsWith("_ccold");
        const isOurs = name.endsWith("_idx") || name.endsWith("_pkey") || name.endsWith("_key") || name.endsWith("_unique");
        if (!isCcLeftover && !isOurs) {
          logger.warn(`[INVALID_INDEX_REAPER] (${context}) skipping ${name} — does not match owned naming convention (won't auto-drop user/extension index)`);
          reapState.byIndex[name] = "failed";
          reapState.failed += 1;
          continue;
        }

        try {
          // Use a dedicated client with statement_timeout=0. DROP
          // CONCURRENTLY is fast on an INVALID index (it has no live
          // entries to compact) but the catalog rewrite still needs
          // an unbounded window because Neon's default 2-min cap is
          // applied to ALL statements unless reset.
          await runIndexDdlNoTimeout(
            `DROP INDEX CONCURRENTLY IF EXISTS "${name}"`,
            `REAPER DROP ${name}`,
          );
          reapState.dropped += 1;
          reapState.byIndex[name] = "dropped";
          if (isCcLeftover) reapState.ccnewDropped += 1;
          logger.info(`[INVALID_INDEX_REAPER] (${context}) ✓ dropped ${name} (${row.idx_size})`);
          try {
            const { invalidIndexesGauge } = await import("./metrics");
            invalidIndexesGauge?.set({ index_name: name }, 0);
          } catch { /* metrics import optional */ }
        } catch (err: any) {
          reapState.failed += 1;
          reapState.byIndex[name] = "failed";
          logger.error(`[INVALID_INDEX_REAPER] (${context}) ✗ DROP ${name} failed: ${err?.message || err}`);
          try {
            const { invalidIndexesGauge } = await import("./metrics");
            invalidIndexesGauge?.set({ index_name: name }, 1);
          } catch { /* metrics import optional */ }
        }
      }

      reapState.scanned = probe.rows.length;
    },
  );

  if (lockResult === "skipped") {
    logger.info(`[INVALID_INDEX_REAPER] (${context}) another process is reaping — skipping`);
    return { status: "skipped", scanned: 0, dropped: 0, failed: 0, ccnewDropped: 0, byIndex: {} };
  }
  if (lockResult === "error") {
    logger.warn(`[INVALID_INDEX_REAPER] (${context}) advisory lock acquisition errored — skipping (will retry next boot)`);
    return { status: "skipped", scanned: 0, dropped: 0, failed: 0, ccnewDropped: 0, byIndex: {} };
  }

  logger.warn(
    `[INVALID_INDEX_REAPER] (${context}) complete: scanned=${reapState.scanned} dropped=${reapState.dropped} ccnew=${reapState.ccnewDropped} failed=${reapState.failed}`,
  );
  return { status: "ran", ...reapState };
}

// Per-invocation accumulator. Reset on each call so concurrent boot
// races (which shouldn't happen given the advisory lock, but defensive)
// don't mix counters.
const reapState = {
  scanned: 0,
  dropped: 0,
  failed: 0,
  ccnewDropped: 0,
  byIndex: {} as Record<string, "dropped" | "failed">,
};
function resetReapState() {
  reapState.scanned = 0;
  reapState.dropped = 0;
  reapState.failed = 0;
  reapState.ccnewDropped = 0;
  reapState.byIndex = {};
}
// Auto-reset at module load so a re-import (test, hot-reload) starts clean.
resetReapState();

/**
 * Run `CREATE INDEX CONCURRENTLY` (or any single-statement DDL that cannot
 * live in a transaction) on a dedicated client with `statement_timeout`
 * disabled and a bounded `lock_timeout`. Required for partial/GIN indexes
 * on large tables (campaign_sends ~11GB / 60M rows, subscribers ~1.5M GIN
 * trigram) where the global 2-min Neon statement_timeout reliably aborts
 * the build mid-flight and leaves the index in the INVALID state — which
 * then poisons subsequent boots until manually dropped.
 *
 * Note: CONCURRENTLY itself cannot run inside a transaction block, so we
 * issue the SETs and the DDL as separate top-level statements on the same
 * session. `statement_timeout=0` is session-scoped and dies with the
 * client (which we release in `finally`), so it never leaks to the pool.
 */
export async function runIndexDdlNoTimeout(ddl: string, label: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`SET statement_timeout = 0`);
    await client.query(`SET lock_timeout = '5min'`);
    await client.query(ddl);
  } catch (err: any) {
    logger.warn(`[BOOTSTRAP_LOCK] ${label} DDL failed: ${err?.message || err}`);
    throw err;
  } finally {
    // Defensive: clear session-scoped SETs before returning the client to
    // the pool. node-postgres recycles clients across consumers, and we
    // don't want a leftover `statement_timeout=0` to bleed into the next
    // borrower (which could be a hot-path query that should be bounded).
    try { await client.query(`RESET statement_timeout; RESET lock_timeout`); } catch {}
    try { client.release(); } catch {}
  }
}

export async function columnHasData(table: string, column: string): Promise<boolean> {
  try {
    const result = await pool.query(
      `SELECT 1 FROM ${table} WHERE ${column} IS NOT NULL LIMIT 1`,
    );
    return (result.rows?.length ?? 0) > 0;
  } catch {
    return false;
  }
}
