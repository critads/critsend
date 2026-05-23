/**
 * Async urgent-flush worker (2026-05-23).
 *
 * Context: POST /api/campaigns/:id/urgent used to run a single UPDATE on
 * up-to-N×10⁴ rows of `campaign_sends` (35 GB / 70 M rows / 12 indexes)
 * inside a single transaction. On the 2026-05-23 prod incident, a 68 354-row
 * flush kept one Neon pool slot busy for several seconds, generated a WAL
 * spike, then caused the drain worker to burst 65 k DUE-NOW rows through
 * the same shared pool — starving `connect-pg-simple` (session lookup),
 * the campaigns list endpoint, and the drain itself. The user was logged
 * out, the page crashed, and sends fell to 0.
 *
 * Redesign: the route now inserts one row in `urgent_flush_jobs`
 * (status='pending'), flips `campaigns.urgent_mode=true`, and returns
 * 202 + jobId in <100 ms. This worker (one per process, leader-elected
 * via SKIP LOCKED on the claim) picks up the job and drains the held
 * queue in chunks of `batch_size` rows per transaction, with a small
 * sleep between chunks so:
 *   • The pool is released between every batch.
 *   • WAL pressure is amortised over seconds, not concentrated in one tx.
 *   • The drain worker has time to dispatch the freshly-eligible rows
 *     instead of seeing a 65 k burst all at once.
 *
 * Concurrency model:
 *   • Every process running startUrgentFlushWorker() polls every
 *     POLL_INTERVAL_MS for a pending job.
 *   • Claim uses UPDATE … WHERE id=(SELECT id … FOR UPDATE SKIP LOCKED)
 *     so two processes never grab the same job.
 *   • While processing, the worker periodically stamps `heartbeat_at`.
 *   • An orphan-recovery sweep on each tick resets jobs whose
 *     `heartbeat_at` is older than ORPHAN_RECOVERY_MS back to 'pending'
 *     (handles PM2 reload / SIGKILL mid-flush).
 *
 * Pool isolation: we use the shared main pool but release the connection
 * between every batch (pool.query() not pool.connect()), so the worker
 * holds at most ONE connection at any instant and never for more than a
 * single batch UPDATE (~50 ms with the partial index). That's strictly
 * weaker than a dedicated pg.Pool but, combined with the batching, fully
 * eliminates the saturation pattern from the incident.
 */

import { pool } from "../db";
import { logger } from "../logger";
import type { UrgentFlushJob } from "@shared/schema";

const POLL_INTERVAL_MS = Number(process.env.URGENT_FLUSH_POLL_INTERVAL_MS || 1_000);
const SLEEP_BETWEEN_BATCHES_MS = Number(process.env.URGENT_FLUSH_SLEEP_MS || 100);
const HEARTBEAT_EVERY_N_BATCHES = 5;
const ORPHAN_RECOVERY_MS = 10 * 60 * 1000; // 10 min

let timer: NodeJS.Timeout | null = null;
let inFlight = false;

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Reset jobs stuck in 'running' for >ORPHAN_RECOVERY_MS back to 'pending'
 * so a fresh worker (post PM2 reload, post crash) picks them up where
 * they left off. `processed` is preserved so we don't re-flush the rows
 * we've already moved to DUE NOW — the per-batch UPDATE is naturally
 * idempotent (its WHERE clause filters `eligible_at > NOW()`, so already
 * flushed rows are skipped).
 */
async function recoverOrphans(): Promise<void> {
  try {
    const r = await pool.query<{ id: string }>(
      `UPDATE urgent_flush_jobs
       SET status = 'pending', heartbeat_at = NULL
       WHERE status = 'running'
         AND (heartbeat_at IS NULL OR heartbeat_at < NOW() - INTERVAL '${Math.floor(ORPHAN_RECOVERY_MS / 1000)} seconds')
       RETURNING id`,
    );
    if (r.rowCount && r.rowCount > 0) {
      logger.warn(`[URGENT_FLUSH] Recovered ${r.rowCount} orphaned job(s): ${r.rows.map((x) => x.id).join(", ")}`);
    }
  } catch (err: any) {
    logger.warn(`[URGENT_FLUSH] orphan recovery failed (non-fatal): ${err?.message || err}`);
  }
}

/**
 * Claim ONE pending job via SKIP LOCKED. Returns null if no work or if
 * another worker won the race. Atomic transition pending → running with
 * heartbeat stamp in a single statement.
 */
async function claimNextJob(): Promise<UrgentFlushJob | null> {
  try {
    const r = await pool.query<UrgentFlushJob & Record<string, any>>(
      `UPDATE urgent_flush_jobs
       SET status = 'running',
           started_at = COALESCE(started_at, NOW()),
           heartbeat_at = NOW()
       WHERE id = (
         SELECT id FROM urgent_flush_jobs
         WHERE status = 'pending'
         ORDER BY created_at ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING id, campaign_id AS "campaignId", user_id AS "userId", status,
                 total_held AS "totalHeld", processed, batch_size AS "batchSize",
                 error, created_at AS "createdAt", started_at AS "startedAt",
                 completed_at AS "completedAt", heartbeat_at AS "heartbeatAt"`,
    );
    return r.rows[0] ?? null;
  } catch (err: any) {
    logger.warn(`[URGENT_FLUSH] claim failed (non-fatal): ${err?.message || err}`);
    return null;
  }
}

/**
 * Drain ONE job to completion. Loops over batches of `batchSize` rows,
 * each batch being a single short UPDATE under its own implicit txn
 * (pool.query releases the connection on return). Sleeps
 * SLEEP_BETWEEN_BATCHES_MS between batches so the pool is fully released
 * and the drain worker has airtime to dispatch the newly-eligible rows.
 */
async function processJob(job: UrgentFlushJob): Promise<void> {
  const t0 = Date.now();
  let totalProcessed = job.processed ?? 0;
  let batchN = 0;

  logger.info(
    `[URGENT_FLUSH] Starting job ${job.id} for campaign ${job.campaignId} ` +
    `(total=${job.totalHeld}, already_processed=${totalProcessed}, batch=${job.batchSize})`,
  );

  try {
    while (true) {
      // Per-batch UPDATE. The CTE picks up to batchSize held rows under
      // SKIP LOCKED so concurrent drain workers can't deadlock with us
      // (they only ever read DUE-NOW rows, but defensive). The outer
      // UPDATE flips them to DUE NOW in one statement.
      // The WHERE `eligible_at > NOW()` filter makes this naturally
      // idempotent: re-running on the same job (after orphan recovery)
      // will simply skip already-flushed rows.
      const batchRes = await pool.query<{ cnt: number }>(
        `WITH batch AS (
           SELECT id FROM campaign_sends
           WHERE campaign_id = $1
             AND status = 'pending'
             AND eligible_at IS NOT NULL
             AND eligible_at > NOW()
           ORDER BY eligible_at ASC
           LIMIT $2
           FOR UPDATE SKIP LOCKED
         ),
         upd AS (
           UPDATE campaign_sends
           SET eligible_at = NOW()
           WHERE id IN (SELECT id FROM batch)
           RETURNING 1
         )
         SELECT COUNT(*)::int AS cnt FROM upd`,
        [job.campaignId, job.batchSize],
      );

      const updated = batchRes.rows[0]?.cnt ?? 0;
      if (updated === 0) break;

      totalProcessed += updated;
      batchN += 1;

      // Persist progress every batch so the UI poll sees forward motion.
      // Heartbeat is bundled with progress every HEARTBEAT_EVERY_N_BATCHES
      // batches to keep the orphan-recovery window honest without writing
      // an extra row per tiny batch.
      if (batchN % HEARTBEAT_EVERY_N_BATCHES === 0) {
        await pool.query(
          `UPDATE urgent_flush_jobs SET processed = $1, heartbeat_at = NOW() WHERE id = $2`,
          [totalProcessed, job.id],
        );
      } else {
        await pool.query(
          `UPDATE urgent_flush_jobs SET processed = $1 WHERE id = $2`,
          [totalProcessed, job.id],
        );
      }

      // Yield: release the event loop AND let the pool fully drain to
      // other consumers (session lookups, /api/campaigns, drain worker).
      await sleep(SLEEP_BETWEEN_BATCHES_MS);
    }

    // Done — resync the cached counter and stamp completion. We DO NOT
    // touch `campaigns.urgent_mode` here: the flag is intentionally
    // sticky across the flush and is cleared by the campaign lifecycle
    // routes (/end, completion, /retry-failed, /requeue).
    await pool.query(
      `UPDATE campaigns SET deferred_count = 0 WHERE id = $1`,
      [job.campaignId],
    );

    // Audit row: keeps the admin pressure-queue page's history accurate
    // (same shape as the synchronous /urgent's previous audit insert).
    await pool.query(
      `INSERT INTO pressure_flush_audit (campaign_id, user_id, scope, count, reason)
       VALUES ($1, $2, 'urgent', $3, $4)`,
      [
        job.campaignId,
        job.userId,
        totalProcessed,
        `URGENT MODE async flush completed — flushed ${totalProcessed} held rows to DUE NOW in ${batchN} batches (~${job.batchSize} rows/batch). CAS bypass remains active until urgent_mode is cleared.`,
      ],
    );

    await pool.query(
      `UPDATE urgent_flush_jobs
       SET status = 'completed', processed = $1, completed_at = NOW(), heartbeat_at = NOW()
       WHERE id = $2`,
      [totalProcessed, job.id],
    );

    logger.info(
      `[URGENT_FLUSH] Completed job ${job.id} for campaign ${job.campaignId}: ` +
      `flushed=${totalProcessed} in ${batchN} batches (${Date.now() - t0}ms)`,
    );
  } catch (err: any) {
    const msg = err?.message || String(err);
    logger.error(`[URGENT_FLUSH] Job ${job.id} FAILED after ${batchN} batches / ${totalProcessed} rows: ${msg}`);
    try {
      await pool.query(
        `UPDATE urgent_flush_jobs
         SET status = 'failed', processed = $1, error = $2, completed_at = NOW(), heartbeat_at = NOW()
         WHERE id = $3`,
        [totalProcessed, msg.slice(0, 1000), job.id],
      );
    } catch (e: any) {
      logger.error(`[URGENT_FLUSH] Failed to mark job ${job.id} as failed: ${e?.message || e}`);
    }
  }
}

async function tick(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    await recoverOrphans();
    const job = await claimNextJob();
    if (job) {
      await processJob(job);
    }
  } catch (err: any) {
    logger.warn(`[URGENT_FLUSH] tick error (non-fatal): ${err?.message || err}`);
  } finally {
    inFlight = false;
  }
}

export function startUrgentFlushWorker(): void {
  if (timer) return;
  logger.info(`[URGENT_FLUSH] Starting (poll=${POLL_INTERVAL_MS}ms, sleep_between=${SLEEP_BETWEEN_BATCHES_MS}ms, orphan_after=${ORPHAN_RECOVERY_MS}ms)`);
  timer = setInterval(() => { void tick(); }, POLL_INTERVAL_MS);
  timer.unref?.();
}

export function stopUrgentFlushWorker(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
