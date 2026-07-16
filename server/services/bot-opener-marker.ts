/**
 * Bot-opener DEL marker (Task #216).
 *
 * A robot IP (195.154.17.225, Scaleway) fabricates opens at scale. This
 * service periodically appends the `DEL` ref to every subscriber whose
 * engagement over the rolling window is essentially bot-generated:
 *
 *   opened >= BOT_OPENER_MIN_OPENED emails (campaign_stats type='open',
 *   DISTINCT campaign_id) AND at least BOT_OPENER_OPEN_RATIO of those
 *   opened emails were opened via a BOT_OPENER_IPS address.
 *
 * Hard rules:
 *   1. Idempotent: `DEL` is appended at most once (guarded array_append),
 *      existing refs are NEVER overwritten. Re-running after a crash yields
 *      the same end state.
 *   2. Singleton scheduling across PM2 processes (web + worker + drainer)
 *      uses a lease-table leader election (`bot_opener_leader`), NEVER
 *      session-level pg_try_advisory_lock (leaks on transaction-pooled
 *      backends — same architectural rule as pmta-collector / pressure guard).
 *   3. The candidate query is heavy (30-day aggregate over campaign_stats).
 *      The pass runs once a day, anchored at BOT_OPENER_RUN_HOUR (default
 *      01:00) Europe/Paris — same off-peak slot as the tracking_tokens
 *      purge — plus a due-gated catch-up pass shortly after boot (covers
 *      the retroactive first pass and a VM down at the scheduled hour).
 *      It executes inside a transaction with SET LOCAL statement_timeout so
 *      it can exceed the pool's 120s default without polluting the
 *      connection.
 *   4. Updates are batched (BOT_OPENER_UPDATE_BATCH ids per UPDATE) so the
 *      pass never holds the pool hostage.
 *   5. Every NEWLY marked subscriber gets a timestamped audit row in
 *      `bot_opener_marks` (written atomically with the refs UPDATE via a
 *      data-modifying CTE). This table feeds the /analytics time series
 *      (new marks per day/month) and answers "how many uniques did the
 *      retroactive pass affect" (the first pass's rows).
 *
 * Observability: one summary log line per pass (candidates / matched /
 * newly-marked / already-marked / duration), a Prometheus counter
 * (critsend_bot_opener_marked_total) and last-run gauge, plus a persisted
 * audit row per pass in `bot_opener_runs`.
 */
import os from "node:os";
import { pool } from "../db";
import { logger } from "../logger";
import { msUntilNextHourInTz } from "../lib/daily-schedule";
import {
  BOT_OPENER_IPS,
  BOT_OPENER_MIN_OPENED,
  BOT_OPENER_OPEN_RATIO,
  BOT_OPENER_WINDOW_DAYS,
  BOT_OPENER_REF,
} from "../config/suppression";
import { botOpenerMarkedTotal, botOpenerLastRunTimestamp } from "../metrics";

const LOCK_KEY = "global";

// The daily pass is anchored to a fixed wall-clock hour (default 01:00
// Europe/Paris — same off-peak slot as the tracking_tokens purge). Every PM2
// process arms the timer; the lease election + due gate ensure a single
// cluster-wide pass.
const RUN_AT_HOUR = (() => {
  const parsed = Number(process.env.BOT_OPENER_RUN_HOUR);
  const hour = Number.isFinite(parsed) ? Math.trunc(parsed) : 1;
  return Math.min(Math.max(hour, 0), 23);
})();
const SCHEDULE_TZ = "Europe/Paris";

// Retry cadence after a FAILED pass (completed_at stays NULL so the due gate
// keeps the pass eligible). Bounded by the due gate: once a pass succeeds,
// retries stop until the next daily fire.
const RETRY_INTERVAL_MS = Math.max(
  Number(process.env.BOT_OPENER_CHECK_INTERVAL_MS) || 60 * 60 * 1000,
  5 * 60 * 1000,
);

// Minimum spacing between two completed passes (daily by default). The due
// gate uses this minus a 2h slack so the fixed-hour fires (spaced exactly
// 24h — or 23h once a year on the spring DST switch) always qualify, while
// the boot catch-up pass can't double-run a day that already ran.
const RUN_INTERVAL_MS = Math.max(
  Number(process.env.BOT_OPENER_RUN_INTERVAL_MS) || 24 * 60 * 60 * 1000,
  60 * 60 * 1000,
);
const DUE_AFTER_MS = Math.max(RUN_INTERVAL_MS - 2 * 60 * 60 * 1000, RUN_INTERVAL_MS / 2);

// Lease TTL must comfortably exceed the longest plausible pass duration so a
// second process can't start a concurrent pass mid-run, yet expire fast
// enough that a crashed leader doesn't block the next daily run.
const LEASE_TTL_MS = Math.max(
  Number(process.env.BOT_OPENER_LEASE_TTL_MS) || 2 * 60 * 60 * 1000,
  10 * 60 * 1000,
);

// Deferred first check after boot — avoids piling a heavy aggregate onto the
// startup storm (same rationale as WORKER_STARTUP_DELAY_MS for analytics).
const STARTUP_DELAY_MS = Math.max(
  Number(process.env.BOT_OPENER_STARTUP_DELAY_MS) || 2 * 60 * 1000,
  0,
);

// Per-query budget for the candidate aggregate (SET LOCAL, transaction-scoped).
const CANDIDATE_STATEMENT_TIMEOUT_MS = Math.max(
  Number(process.env.BOT_OPENER_STATEMENT_TIMEOUT_MS) || 10 * 60 * 1000,
  60 * 1000,
);

const UPDATE_BATCH_SIZE = Math.min(
  Math.max(Number(process.env.BOT_OPENER_UPDATE_BATCH) || 1000, 100),
  10_000,
);

let dailyTimer: NodeJS.Timeout | null = null;
let retryTimer: NodeJS.Timeout | null = null;
let firstRunTimer: NodeJS.Timeout | null = null;
let markerStarted = false;
let passRunning = false;

function holderId(): string {
  return `${os.hostname()}:${process.pid}`;
}

/**
 * Pure eligibility predicate — single source of truth for the threshold
 * math. The SQL pass only pre-filters (>=1 bot open, >= min opened); the
 * final ratio decision is made HERE so tests and production share one
 * implementation.
 *
 * @param totalOpened      distinct campaigns opened in the window (any IP)
 * @param botOpenedCampaigns distinct campaigns opened via a bot IP
 */
export function qualifiesAsBotOpener(
  totalOpened: number,
  botOpenedCampaigns: number,
  opts?: { minOpened?: number; openRatio?: number },
): boolean {
  const minOpened = opts?.minOpened ?? BOT_OPENER_MIN_OPENED;
  const openRatio = opts?.openRatio ?? BOT_OPENER_OPEN_RATIO;
  if (!Number.isFinite(totalOpened) || totalOpened < minOpened) return false;
  if (!Number.isFinite(botOpenedCampaigns) || botOpenedCampaigns <= 0) return false;
  return botOpenedCampaigns / totalOpened >= openRatio;
}

/** Split ids into UPDATE batches. Exported for test coverage. */
export function chunkIds<T>(ids: T[], size: number = UPDATE_BATCH_SIZE): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < ids.length; i += size) {
    out.push(ids.slice(i, i + size));
  }
  return out;
}

async function ensureBotOpenerTables(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bot_opener_leader (
      lock_key TEXT PRIMARY KEY,
      holder TEXT NOT NULL,
      acquired_at TIMESTAMP NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMP NOT NULL
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bot_opener_runs (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      started_at TIMESTAMP NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMP,
      window_days INTEGER NOT NULL,
      candidates INTEGER,
      matched INTEGER,
      marked INTEGER,
      error TEXT
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS bot_opener_runs_completed_idx ON bot_opener_runs(completed_at)`,
  );
  // One row per subscriber the FIRST time this mechanism marks them.
  // marked_at feeds the /analytics "new bot-openers per day/month" series;
  // the first pass's rows ARE the retroactive count.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bot_opener_marks (
      subscriber_id VARCHAR PRIMARY KEY,
      marked_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS bot_opener_marks_marked_at_idx ON bot_opener_marks(marked_at)`,
  );
}

/**
 * Lease-table leader election — identical contract to pmta_collector_leader.
 * Returns true when this process holds the lease (fresh or renewed).
 */
async function tryAcquireLeader(): Promise<boolean> {
  const me = holderId();
  const ttlSec = Math.ceil(LEASE_TTL_MS / 1000);
  const result = await pool.query(
    `INSERT INTO bot_opener_leader (lock_key, holder, acquired_at, expires_at)
       VALUES ($1, $2, NOW(), NOW() + ($3 || ' seconds')::interval)
     ON CONFLICT (lock_key) DO UPDATE
       SET holder = EXCLUDED.holder,
           acquired_at = EXCLUDED.acquired_at,
           expires_at  = EXCLUDED.expires_at
       WHERE bot_opener_leader.expires_at <= NOW()
          OR bot_opener_leader.holder = EXCLUDED.holder
     RETURNING holder`,
    [LOCK_KEY, me, String(ttlSec)],
  );
  return (result.rowCount ?? 0) > 0 && result.rows[0].holder === me;
}

/** A pass is due when no completed run exists within DUE_AFTER_MS. */
async function isRunDue(): Promise<boolean> {
  const result = await pool.query<{ completed_at: Date }>(
    `SELECT completed_at
       FROM bot_opener_runs
      WHERE completed_at IS NOT NULL
      ORDER BY completed_at DESC
      LIMIT 1`,
  );
  const last = result.rows[0]?.completed_at;
  if (!last) return true;
  return Date.now() - new Date(last).getTime() >= DUE_AFTER_MS;
}

interface CandidateRow {
  id: string;
  total_opened: number;
  bot_opened: number;
}

/**
 * Set-based candidate selection. Starts from the (small) set of subscribers
 * with >=1 open via a bot IP in the window, then counts, for those
 * subscribers only, the distinct campaigns they opened (any IP) and the
 * distinct campaigns they opened via a bot IP. Opens via other IPs count in
 * the denominator (total_opened) but never in the numerator (bot_opened —
 * the FILTER clause is IP-restricted).
 *
 * Runs inside a transaction so SET LOCAL statement_timeout cannot leak to
 * other pool users (and stays PgBouncer-transaction-pooling safe).
 */
async function selectCandidates(): Promise<CandidateRow[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL statement_timeout = '${CANDIDATE_STATEMENT_TIMEOUT_MS}ms'`);
    const result = await client.query<CandidateRow>(
      `WITH bot_subs AS (
         SELECT DISTINCT subscriber_id
           FROM campaign_stats
          WHERE type = 'open'
            AND ip_address = ANY($1::text[])
            AND "timestamp" >= NOW() - make_interval(days => $2)
       )
       SELECT cs.subscriber_id AS id,
              COUNT(DISTINCT cs.campaign_id)::int AS total_opened,
              COUNT(DISTINCT cs.campaign_id)
                FILTER (WHERE cs.ip_address = ANY($1::text[]))::int AS bot_opened
         FROM campaign_stats cs
         JOIN bot_subs b ON b.subscriber_id = cs.subscriber_id
        WHERE cs.type = 'open'
          AND cs."timestamp" >= NOW() - make_interval(days => $2)
        GROUP BY cs.subscriber_id
       HAVING COUNT(DISTINCT cs.campaign_id) >= $3`,
      [BOT_OPENER_IPS as string[], BOT_OPENER_WINDOW_DAYS, BOT_OPENER_MIN_OPENED],
    );
    await client.query("COMMIT");
    return result.rows;
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch { /* best-effort */ }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Batched idempotent ref append + timestamped audit row, in ONE atomic
 * statement per batch (data-modifying CTE): the refs UPDATE only touches
 * rows missing the ref (re-runs are no-ops, COALESCE keeps legacy NULL
 * arrays safe), and every row it DID touch gets a bot_opener_marks row
 * stamping WHEN this mechanism first marked it. Returns the number of
 * NEWLY marked subscribers.
 */
async function markSubscribers(ids: string[]): Promise<number> {
  let marked = 0;
  for (const batch of chunkIds(ids)) {
    const result = await pool.query<{ marked: number }>(
      `WITH upd AS (
         UPDATE subscribers
            SET refs = array_append(COALESCE(refs, ARRAY[]::text[]), $2)
          WHERE id = ANY($1::varchar[])
            AND NOT ($2 = ANY(COALESCE(refs, ARRAY[]::text[])))
         RETURNING id
       ),
       ins AS (
         INSERT INTO bot_opener_marks (subscriber_id)
         SELECT id FROM upd
         ON CONFLICT (subscriber_id) DO NOTHING
       )
       SELECT COUNT(*)::int AS marked FROM upd`,
      [batch, BOT_OPENER_REF],
    );
    marked += Number(result.rows[0]?.marked ?? 0);
  }
  return marked;
}

/**
 * Runs one marking pass if this process is (or can become) the lease leader
 * and a pass is due. `force=true` skips the due check (manual/ops trigger)
 * but NEVER bypasses leader election.
 */
export async function runBotOpenerMarkPassOnce(opts?: { force?: boolean }): Promise<{
  ran: boolean;
  matched: number;
  marked: number;
  skipped?: string;
}> {
  if (passRunning) {
    return { ran: false, matched: 0, marked: 0, skipped: "already_running" };
  }
  if (!opts?.force && !(await isRunDue())) {
    return { ran: false, matched: 0, marked: 0, skipped: "not_due" };
  }
  const won = await tryAcquireLeader();
  if (!won) {
    return { ran: false, matched: 0, marked: 0, skipped: "not_leader" };
  }
  // Re-check after winning the lease: another process may have completed a
  // pass between our due check and the lease upsert.
  if (!opts?.force && !(await isRunDue())) {
    return { ran: false, matched: 0, marked: 0, skipped: "not_due" };
  }

  passRunning = true;
  const startedAt = Date.now();
  let runId: string | null = null;
  try {
    const runInsert = await pool.query<{ id: string }>(
      `INSERT INTO bot_opener_runs (window_days) VALUES ($1) RETURNING id`,
      [BOT_OPENER_WINDOW_DAYS],
    );
    runId = runInsert.rows[0]?.id ?? null;

    const candidates = await selectCandidates();
    const matchedIds = candidates
      .filter((c) => qualifiesAsBotOpener(Number(c.total_opened), Number(c.bot_opened)))
      .map((c) => c.id);

    const marked = await markSubscribers(matchedIds);
    const alreadyMarked = matchedIds.length - marked;
    const durationMs = Date.now() - startedAt;

    if (runId) {
      await pool.query(
        `UPDATE bot_opener_runs
            SET completed_at = NOW(), candidates = $2, matched = $3, marked = $4
          WHERE id = $1`,
        [runId, candidates.length, matchedIds.length, marked],
      );
    }

    botOpenerMarkedTotal.inc(marked);
    botOpenerLastRunTimestamp.set(Math.floor(Date.now() / 1000));
    logger.info(
      `[BOT_OPENER] pass complete: candidates=${candidates.length} matched=${matchedIds.length} ` +
      `newlyMarked=${marked} alreadyMarked=${alreadyMarked} windowDays=${BOT_OPENER_WINDOW_DAYS} ` +
      `ips=${BOT_OPENER_IPS.length} minOpened=${BOT_OPENER_MIN_OPENED} ` +
      `ratio=${BOT_OPENER_OPEN_RATIO} durationMs=${durationMs}`,
    );
    return { ran: true, matched: matchedIds.length, marked };
  } catch (err: any) {
    const msg = String(err?.message ?? err).slice(0, 1000);
    logger.error(`[BOT_OPENER] pass failed: ${msg}`);
    if (runId) {
      // Leave completed_at NULL so the failed run never satisfies the due
      // check — the next tick retries.
      await pool
        .query(`UPDATE bot_opener_runs SET error = $2 WHERE id = $1`, [runId, msg])
        .catch(() => { /* best-effort audit */ });
    }
    return { ran: true, matched: 0, marked: 0, skipped: "error" };
  } finally {
    passRunning = false;
  }
}

/**
 * One scheduled attempt: run the pass (due-gated + lease-elected), then
 * always re-arm the next daily 01:00 fire. If the pass FAILED (its
 * bot_opener_runs row keeps completed_at NULL, so it stays due), arm a
 * bounded hourly retry so a transient error doesn't push the pass to the
 * next day; the due gate stops retries as soon as any process succeeds.
 */
async function runScheduledPass(trigger: string): Promise<void> {
  let failed = false;
  try {
    const result = await runBotOpenerMarkPassOnce();
    failed = result.skipped === "error";
  } catch (err: any) {
    // runBotOpenerMarkPassOnce catches pass errors itself; this guards the
    // pre-pass queries (due check / lease upsert) against connection blips.
    failed = true;
    logger.error(`[BOT_OPENER] scheduled attempt (${trigger}) failed: ${err?.message || err}`);
  }
  if (trigger === "daily") scheduleNextDailyPass();
  if (failed && markerStarted && !retryTimer) {
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void runScheduledPass("retry");
    }, RETRY_INTERVAL_MS);
    retryTimer.unref?.();
    logger.warn(
      `[BOT_OPENER] pass failed — retrying in ${Math.round(RETRY_INTERVAL_MS / 60000)} min`,
    );
  }
}

function scheduleNextDailyPass(): void {
  if (!markerStarted) return;
  if (dailyTimer) {
    clearTimeout(dailyTimer);
    dailyTimer = null;
  }
  // Small jitter so the PM2 processes don't race the lease upsert at
  // exactly 01:00:00.
  const jitter = Math.floor(Math.random() * 30_000);
  const ms = msUntilNextHourInTz(RUN_AT_HOUR, SCHEDULE_TZ) + jitter;
  logger.info(
    `[BOT_OPENER] next daily pass in ${Math.round(ms / 60000)} min ` +
    `(next ${String(RUN_AT_HOUR).padStart(2, "0")}:00 ${SCHEDULE_TZ})`,
  );
  dailyTimer = setTimeout(() => {
    dailyTimer = null;
    void runScheduledPass("daily");
  }, ms);
  dailyTimer.unref?.();
}

/**
 * Starts the marker: a deferred catch-up pass shortly after boot (only runs
 * if due — covers the retroactive first pass AND a VM that was down at the
 * scheduled hour), then a daily pass anchored at RUN_AT_HOUR (default 01:00)
 * Europe/Paris. Safe to call from BOTH the web and worker processes: the
 * lease table + due gate guarantee a single pass per day cluster-wide.
 */
export async function startBotOpenerMarker(): Promise<void> {
  if (markerStarted) return;
  if (BOT_OPENER_IPS.length === 0) {
    logger.info("[BOT_OPENER] disabled — empty bot IP list");
    return;
  }
  try {
    await ensureBotOpenerTables();
  } catch (err: any) {
    logger.error(`[BOT_OPENER] failed to ensure schema — marker will not start: ${err?.message || err}`);
    return;
  }
  markerStarted = true;
  logger.info(
    `[BOT_OPENER] starting (dailyAt=${String(RUN_AT_HOUR).padStart(2, "0")}:00 ${SCHEDULE_TZ}, ` +
    `windowDays=${BOT_OPENER_WINDOW_DAYS}, ips=[${BOT_OPENER_IPS.join(", ")}], ` +
    `minOpened=${BOT_OPENER_MIN_OPENED}, ratio=${BOT_OPENER_OPEN_RATIO}, ` +
    `firstCheckIn=${Math.round(STARTUP_DELAY_MS / 1000)}s)`,
  );
  // Stagger the boot catch-up pass: fixed deferral to stay out of the boot
  // storm + jitter so the PM2 processes don't race the lease upsert. The due
  // gate makes it a no-op when the last completed pass is recent.
  const jitter = Math.floor(Math.random() * 30_000);
  firstRunTimer = setTimeout(() => {
    firstRunTimer = null;
    void runScheduledPass("boot");
  }, STARTUP_DELAY_MS + jitter);
  firstRunTimer.unref?.();

  scheduleNextDailyPass();
}

export function stopBotOpenerMarker(): void {
  markerStarted = false;
  if (firstRunTimer) {
    clearTimeout(firstRunTimer);
    firstRunTimer = null;
  }
  if (dailyTimer) {
    clearTimeout(dailyTimer);
    dailyTimer = null;
  }
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
}
