/**
 * Orphaned-sends reconciler (Task #160, extended after 2026-05-18 incident).
 *
 * Background sweep that closes out two distinct orphaned-row patterns:
 *
 *   (A) status='attempting' for more than ORPHANED_ATTEMPTING_GRACE_HOURS
 *       — ALWAYS marked failed, REGARDLESS of parent campaign status.
 *       Why: an `attempting` row means the sender/drainer has already
 *       claimed it (UPDATE status='pending' → 'attempting'). A normal
 *       SMTP dispatch finalises in < 60 s; anything still 'attempting'
 *       hours later is the result of a crash between claim and finalize
 *       (SIGKILL, OOM, host reboot, network partition). The campaign
 *       being still `sending` does NOT mean the row will be retried —
 *       the drain/send claim filter is `status='pending'`, so an
 *       orphaned 'attempting' row is invisible to every code path and
 *       the subscriber simply never receives the email.
 *       Pre-fix bug: the original WHERE filter required the parent
 *       campaign to be in ('completed','paused','cancelled'), which
 *       meant 12 562 rows orphaned during the 2026-05-14 drainer crash
 *       stayed stuck for 4 days because their campaigns were still
 *       `sending` (drains take days on multi-million subscriber audiences).
 *
 *   (B) status='pending' for more than ORPHANED_SENDS_GRACE_HOURS
 *       AND parent campaign IS terminal ('completed','paused','cancelled')
 *       — original behaviour, untouched. A `pending` row on a terminal
 *       campaign will never be claimed, so we close it for counter-drift
 *       reconciliation and queue-gauge accuracy.
 *
 * Risk of (A): if the SMTP RTT genuinely exceeded the grace period
 * (e.g. relay holding the connection open during a slow handshake),
 * we could mark a successful send as failed. Mitigations:
 *   - Default grace is 1 h, far above any reasonable SMTP RTT (the
 *     campaign-sender timeout is typically 30 s, drainer 60 s).
 *   - Marking failed is bookkeeping-only: it does NOT re-enqueue the
 *     subscriber, so there is no risk of duplicate send.
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
const ATTEMPTING_GRACE_HOURS = Math.max(
  1,
  Number(process.env.ORPHANED_ATTEMPTING_GRACE_HOURS || 1),
);

export async function reconcileOrphanedSends(): Promise<{
  updated: number;
  attempting_closed: number;
  pending_closed: number;
}> {
  // Pass A: attempting rows orphaned by a sender/drainer crash.
  // Unconditional on campaign status — see file header for rationale.
  const attemptingRes = await pool.query(
    `UPDATE campaign_sends
        SET status = 'failed'
      WHERE status = 'attempting'
        AND sent_at < NOW() - ($1 || ' hours')::interval`,
    [String(ATTEMPTING_GRACE_HOURS)],
  );
  const attemptingClosed = attemptingRes.rowCount ?? 0;

  // Pass B: pending rows on terminal campaigns (original behaviour).
  const pendingRes = await pool.query(
    `UPDATE campaign_sends
        SET status = 'failed'
      WHERE status = 'pending'
        AND sent_at < NOW() - ($1 || ' hours')::interval
        AND campaign_id IN (
          SELECT id FROM campaigns
          WHERE status IN ('completed', 'paused', 'cancelled')
        )`,
    [String(RECONCILE_GRACE_HOURS)],
  );
  const pendingClosed = pendingRes.rowCount ?? 0;

  const updated = attemptingClosed + pendingClosed;
  if (updated > 0) {
    try {
      orphanedSendsReconciledTotal.inc(updated);
    } catch {
      /* metric increment is non-fatal */
    }
    logger.warn(
      `[ORPHANED_SENDS_RECONCILER] Closed ${updated} orphaned campaign_sends rows (attempting=${attemptingClosed} grace=${ATTEMPTING_GRACE_HOURS}h, pending_terminal=${pendingClosed} grace=${RECONCILE_GRACE_HOURS}h)`,
    );
  }
  return {
    updated,
    attempting_closed: attemptingClosed,
    pending_closed: pendingClosed,
  };
}

let timer: NodeJS.Timeout | null = null;

export function startOrphanedSendsReconciler(): void {
  if (timer) return;
  logger.info(
    `[ORPHANED_SENDS_RECONCILER] Starting (interval=${RECONCILE_INTERVAL_MS}ms, pending_grace=${RECONCILE_GRACE_HOURS}h, attempting_grace=${ATTEMPTING_GRACE_HOURS}h)`,
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
