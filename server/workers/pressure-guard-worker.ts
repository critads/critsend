/**
 * Pressure-guard deferred-drain worker (Task #144).
 *
 * Polls every 30s for campaign_sends rows where:
 *   status='pending' AND eligible_at IS NOT NULL AND eligible_at <= NOW()
 *
 * Rows are claimed FOR UPDATE SKIP LOCKED, ordered by campaigns.started_at
 * ASC NULLS FIRST (so the oldest campaign's deferred queue drains first —
 * FIFO across the whole platform), grouped by campaign, and re-CAS'd against
 * subscribers.last_sent_at. Winners are sent via the existing
 * sendEmailWithNullsink path; losers have their eligible_at bumped forward
 * by another window. Cascades infinitely (never gives up; no max_defer).
 *
 * Re-checks unsubscribe / suppression at dispatch time: if the contact has
 * the campaign's unsubscribeTag, the configured bounce tag ("BCK"), or
 * suppressed_until > NOW(), the row is force-failed instead of sent.
 */

import { sql } from "drizzle-orm";
import { db, pool } from "../db";
import { logger } from "../logger";
import { storage } from "../storage";
import { sendEmailWithNullsink } from "../email-service";
import { PRESSURE_WINDOW_HOURS, getPressureGuardBootstrapState } from "../services/pressure-guard";
import {
  pressureGuardSentAfterDeferTotal,
  pressureGuardPendingDeferred,
} from "../metrics";
import type { Campaign, Mta, Subscriber } from "@shared/schema";

const POLL_INTERVAL_MS = Number(process.env.PRESSURE_GUARD_POLL_MS ?? 30_000);
const BATCH_PER_CAMPAIGN = Number(process.env.PRESSURE_GUARD_BATCH ?? 200);
const MAX_CAMPAIGNS_PER_TICK = Number(process.env.PRESSURE_GUARD_MAX_CAMPAIGNS ?? 5);

let pollInterval: NodeJS.Timeout | null = null;
let isPolling = false;

export function startPressureGuardWorker() {
  if (pollInterval) return;
  logger.info(`[PRESSURE_GUARD_WORKER] Starting (poll=${POLL_INTERVAL_MS}ms, batch=${BATCH_PER_CAMPAIGN}, max-campaigns=${MAX_CAMPAIGNS_PER_TICK}h, window=${PRESSURE_WINDOW_HOURS}h)`);
  pollInterval = setInterval(pollDeferredQueue, POLL_INTERVAL_MS);
  // Kick off after a short delay to let bootstrap run first.
  setTimeout(pollDeferredQueue, 5_000);
}

export function stopPressureGuardWorker() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
    logger.info("[PRESSURE_GUARD_WORKER] Stopped");
  }
}

async function pollDeferredQueue() {
  if (isPolling) return;
  if (getPressureGuardBootstrapState() !== "ready") return;
  isPolling = true;
  try {
    // Refresh the per-campaign gauge regardless of whether we have work.
    try {
      const g = await db.execute(sql`
        SELECT campaign_id, COUNT(*)::int AS n
        FROM campaign_sends
        WHERE status = 'pending' AND eligible_at IS NOT NULL
        GROUP BY campaign_id
      `);
      pressureGuardPendingDeferred.reset();
      for (const row of g.rows) {
        pressureGuardPendingDeferred.set(
          { campaign_id: (row as any).campaign_id as string },
          Number((row as any).n ?? 0),
        );
      }
    } catch {}

    // Pick the next N campaigns that have eligible deferred rows, ordered FIFO.
    const campaignsRes = await db.execute(sql`
      SELECT DISTINCT cs.campaign_id, c.started_at
      FROM campaign_sends cs
      JOIN campaigns c ON c.id = cs.campaign_id
      WHERE cs.status = 'pending'
        AND cs.eligible_at IS NOT NULL
        AND cs.eligible_at <= NOW()
        AND c.status = 'sending'
      ORDER BY c.started_at ASC NULLS FIRST
      LIMIT ${MAX_CAMPAIGNS_PER_TICK}
    `);

    for (const row of campaignsRes.rows) {
      const campaignId = (row as any).campaign_id as string;
      try {
        await drainCampaign(campaignId);
      } catch (err: any) {
        logger.error(`[PRESSURE_GUARD_WORKER] drainCampaign(${campaignId}) failed: ${err?.message || err}`);
      }
    }
  } catch (err: any) {
    logger.error(`[PRESSURE_GUARD_WORKER] poll error: ${err?.message || err}`);
  } finally {
    isPolling = false;
  }
}

async function drainCampaign(campaignId: string): Promise<void> {
  const campaign: Campaign | undefined = await storage.getCampaign(campaignId);
  if (!campaign) return;
  const mta: Mta | undefined = campaign.mtaId ? await storage.getMta(campaign.mtaId) : undefined;
  if (!mta) {
    logger.warn(`[PRESSURE_GUARD_WORKER] Campaign ${campaignId} has no MTA; skipping`);
    return;
  }

  // Claim a batch under SKIP LOCKED so concurrent workers don't double-pick.
  // We use a dedicated client for the row-level lock + atomic transition.
  const client = await pool.connect();
  let claimedSubIds: string[] = [];
  try {
    await client.query("BEGIN");
    const claim = await client.query(
      `SELECT subscriber_id FROM campaign_sends
       WHERE campaign_id = $1
         AND status = 'pending' AND eligible_at IS NOT NULL AND eligible_at <= NOW()
       ORDER BY eligible_at ASC
       LIMIT $2
       FOR UPDATE SKIP LOCKED`,
      [campaignId, BATCH_PER_CAMPAIGN],
    );
    claimedSubIds = claim.rows.map((r) => r.subscriber_id as string);
    if (claimedSubIds.length === 0) {
      await client.query("ROLLBACK");
      return;
    }
    // Bump status='attempting' on the locked rows so other workers + the
    // orphan-recovery sweep treat them as in-flight.
    await client.query(
      `UPDATE campaign_sends SET status = 'attempting'
       WHERE campaign_id = $1 AND subscriber_id = ANY($2::text[]) AND status = 'pending'`,
      [campaignId, claimedSubIds],
    );
    await client.query("COMMIT");
  } catch (err: any) {
    try { await client.query("ROLLBACK"); } catch {}
    logger.error(`[PRESSURE_GUARD_WORKER] claim failed: ${err?.message || err}`);
    return;
  } finally {
    client.release();
  }

  // Run the global pressure CAS on subscribers.last_sent_at to honour the
  // 6h gap across all campaigns. Winners get last_sent_at = NOW().
  const casRes = await db.execute(sql`
    UPDATE subscribers s
    SET last_sent_at = NOW()
    WHERE s.id = ANY(${claimedSubIds}::text[])
      AND (s.last_sent_at IS NULL OR s.last_sent_at + (${PRESSURE_WINDOW_HOURS}::numeric || ' hours')::interval <= NOW())
    RETURNING s.id, s.last_sent_at
  `);
  const winnerIds = new Set(casRes.rows.map((r) => (r as any).id as string));
  const losers = claimedSubIds.filter((id) => !winnerIds.has(id));

  // Losers: bump eligible_at forward and revert status back to pending.
  // Wrap the campaign_sends update + deferred_count bump in a single txn so
  // the audit counter never drifts from the row state, even on crash. We
  // intentionally do NOT touch pending_count (see pressureGuardReserveSendSlots).
  if (losers.length > 0) {
    await db.transaction(async (tx) => {
      await tx.execute(sql`
        UPDATE campaign_sends cs
        SET status = 'pending',
            eligible_at = COALESCE(s.last_sent_at, NOW()) + (${PRESSURE_WINDOW_HOURS}::numeric || ' hours')::interval
        FROM subscribers s
        WHERE cs.campaign_id = ${campaignId}
          AND cs.subscriber_id = ANY(${losers}::text[])
          AND s.id = cs.subscriber_id
          AND cs.status = 'attempting'
      `);
      await tx.execute(sql`
        UPDATE campaigns SET deferred_count = deferred_count + ${losers.length} WHERE id = ${campaignId}
      `);
    });
  }

  if (winnerIds.size === 0) return;

  // Re-check unsubscribe / suppression / bounce flags for winners.
  const subs = await db.execute(sql`
    SELECT id, email, tags, refs, ip_address, import_date, suppressed_until, last_engaged_at, last_sent_at
    FROM subscribers WHERE id = ANY(${Array.from(winnerIds)}::text[])
  `);
  const eligibleSubs: Subscriber[] = [];
  const dropIds: string[] = [];
  const unsubTag = (campaign as any).unsubscribeTag as string | null;
  for (const r of subs.rows) {
    const row = r as any;
    const tags: string[] = Array.isArray(row.tags) ? row.tags : [];
    const suppressed = row.suppressed_until && new Date(row.suppressed_until) > new Date();
    const bounced = tags.includes("BCK");
    const unsubbed = unsubTag ? tags.includes(unsubTag) : false;
    if (suppressed || bounced || unsubbed) {
      dropIds.push(row.id);
    } else {
      eligibleSubs.push({
        id: row.id,
        email: row.email,
        tags,
        refs: Array.isArray(row.refs) ? row.refs : [],
        ipAddress: row.ip_address,
        importDate: row.import_date,
        suppressedUntil: row.suppressed_until,
        lastEngagedAt: row.last_engaged_at,
        lastSentAt: row.last_sent_at,
      } as Subscriber);
    }
  }

  if (dropIds.length > 0) {
    await db.execute(sql`
      UPDATE campaign_sends SET status = 'failed', eligible_at = NULL
      WHERE campaign_id = ${campaignId} AND subscriber_id = ANY(${dropIds}::text[]) AND status = 'attempting'
    `);
    await db.execute(sql`
      UPDATE campaigns
      SET failed_count = failed_count + ${dropIds.length},
          pending_count = GREATEST(pending_count - ${dropIds.length}, 0)
      WHERE id = ${campaignId}
    `);
    logger.info(`[PRESSURE_GUARD_WORKER] Campaign ${campaignId}: dropped ${dropIds.length} unsub/suppressed at dispatch`);
  }

  if (eligibleSubs.length === 0) return;

  // Send. Tracking tokens use HMAC fallback (no batch token cache here — the
  // deferred path is intentionally simpler than the bulk sender hot-path).
  const trackingOpts = {
    trackOpens: campaign.trackOpens,
    trackClicks: campaign.trackClicks,
    linkMap: new Map<string, string>(),
  } as any;
  const customHeadersMap = new Map<string, string>();

  const successIds: string[] = [];
  const failedIds: string[] = [];
  for (const sub of eligibleSubs) {
    try {
      const result = await sendEmailWithNullsink(mta as any, sub, campaign, trackingOpts, customHeadersMap);
      if (result.success) successIds.push(sub.id);
      else failedIds.push(sub.id);
    } catch (err: any) {
      logger.warn(`[PRESSURE_GUARD_WORKER] send failed for ${sub.email}: ${err?.message || err}`);
      failedIds.push(sub.id);
    }
  }

  // Finalize: status attempting → sent/failed + clear eligible_at.
  await db.transaction(async (tx) => {
    if (successIds.length > 0) {
      await tx.execute(sql`
        UPDATE campaign_sends SET status = 'sent', eligible_at = NULL, sent_at = NOW()
        WHERE campaign_id = ${campaignId} AND subscriber_id = ANY(${successIds}::text[]) AND status = 'attempting'
      `);
    }
    if (failedIds.length > 0) {
      await tx.execute(sql`
        UPDATE campaign_sends SET status = 'failed', eligible_at = NULL
        WHERE campaign_id = ${campaignId} AND subscriber_id = ANY(${failedIds}::text[]) AND status = 'attempting'
      `);
    }
    await tx.execute(sql`
      UPDATE campaigns SET
        sent_count = sent_count + ${successIds.length},
        failed_count = failed_count + ${failedIds.length},
        pending_count = GREATEST(pending_count - ${successIds.length + failedIds.length}, 0)
      WHERE id = ${campaignId}
    `);
  });

  if (successIds.length > 0) {
    try { pressureGuardSentAfterDeferTotal.inc({ campaign_id: campaignId }, successIds.length); } catch {}
  }
  logger.info(`[PRESSURE_GUARD_WORKER] Campaign ${campaignId} drained: sent=${successIds.length}, failed=${failedIds.length}, deferred=${losers.length}, dropped=${dropIds.length}`);
}
