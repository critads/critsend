/**
 * Orphaned-sends reconciler (Task #160).
 *
 * Background sweep: marks campaign_sends rows that are stuck in
 * status IN ('pending','attempting') for more than ORPHANED_SENDS_GRACE_HOURS
 * AS 'failed' WHEN their parent campaign is already 'completed' / 'paused' /
 * 'cancelled'.
 *
 * Why: the drain worker normally finalises every claim it makes, but a
 * process kill mid-claim (SIGKILL, OOM, host reboot) can leave rows
 * locked in 'pending' or 'attempting' forever. Once the parent campaign
 * is no longer sending, those rows should never succeed, so we close them
 * out so the campaign counters reconcile cleanly and the deferred-queue
 * gauge stops over-reporting.
 */
import { pool } from "../db";
import { logger } from "../logger";
import { orphanedSendsReconciledTotal } from "../metrics";

const RECONCILE_INTERVAL_MS = Number(
  process.env.ORPHANED_SENDS_RECONCILE_INTERVAL_MS || 60 * 60_000,
);
const RECONCILE_GRACE_HOURS = Math.max(
  1,
  Number(process.env.ORPHANED_SENDS_GRACE_HOURS || 1),
);

export async function reconcileOrphanedSends(): Promise<{ updated: number }> {
  const r = await pool.query(
    `UPDATE campaign_sends
        SET status = 'failed'
      WHERE status IN ('pending', 'attempting')
        AND sent_at < NOW() - ($1 || ' hours')::interval
        AND campaign_id IN (
          SELECT id FROM campaigns
          WHERE status IN ('completed', 'paused', 'cancelled')
        )`,
    [String(RECONCILE_GRACE_HOURS)],
  );
  const updated = r.rowCount ?? 0;
  if (updated > 0) {
    try {
      orphanedSendsReconciledTotal.inc(updated);
    } catch {
      /* metric increment is non-fatal */
    }
    logger.warn(
      `[ORPHANED_SENDS_RECONCILER] Marked ${updated} orphaned campaign_sends rows as failed (grace=${RECONCILE_GRACE_HOURS}h)`,
    );
  }
  return { updated };
}

let timer: NodeJS.Timeout | null = null;

export function startOrphanedSendsReconciler(): void {
  if (timer) return;
  logger.info(
    `[ORPHANED_SENDS_RECONCILER] Starting (interval=${RECONCILE_INTERVAL_MS}ms, grace=${RECONCILE_GRACE_HOURS}h)`,
  );
  // Initial delay 5 minutes — avoid running during startup spikes when
  // the queue genuinely has fresh in-flight rows.
  setTimeout(() => {
    reconcileOrphanedSends().catch((err) =>
      logger.error(
        `[ORPHANED_SENDS_RECONCILER] initial run failed: ${err?.message || err}`,
      ),
    );
  }, 5 * 60_000).unref();
  timer = setInterval(() => {
    reconcileOrphanedSends().catch((err) =>
      logger.error(`[ORPHANED_SENDS_RECONCILER] tick failed: ${err?.message || err}`),
    );
  }, RECONCILE_INTERVAL_MS);
  timer.unref();
}

export function stopOrphanedSendsReconciler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
