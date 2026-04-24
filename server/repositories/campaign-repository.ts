import {
  campaigns,
  campaignStats,
  campaignSends,
  campaignJobs,
  nullsinkCaptures,
  errorLogs,
  importJobs,
  type Campaign,
  type InsertCampaign,
  type CampaignStat,
  type CampaignSend,
  type NullsinkCapture,
  type InsertNullsinkCapture,
} from "@shared/schema";
import { db, pool } from "../db";
import { eq, desc, and, sql } from "drizzle-orm";
import crypto from "crypto";
import { logger } from "../logger";
import { campaignQueue } from "../queues";
import { mapWithConcurrency } from "../utils";
import { classifyDbError, isDiskFullError } from "../db-errors";

const USE_BULLMQ = process.env.USE_BULLMQ === "true";

// ═══════════════════════════════════════════════════════════════
// CAMPAIGN MANAGEMENT
// ═══════════════════════════════════════════════════════════════

export async function getCampaigns(): Promise<Campaign[]> {
  return db.select().from(campaigns).orderBy(desc(campaigns.createdAt));
}

export async function getCampaign(id: string): Promise<Campaign | undefined> {
  const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, id));
  return campaign;
}

export async function getCampaignStatus(id: string): Promise<string | null> {
  const result = await db.execute(sql`SELECT status FROM campaigns WHERE id = ${id} LIMIT 1`);
  return result.rows.length > 0 ? (result.rows[0] as any).status : null;
}

export async function getCampaignsByPauseReason(reason: string): Promise<Campaign[]> {
  return db.select().from(campaigns)
    .where(and(eq(campaigns.status, "paused"), eq(campaigns.pauseReason, reason)));
}

export async function createCampaign(data: InsertCampaign): Promise<Campaign> {
  const [campaign] = await db.insert(campaigns).values(data).returning();
  return campaign;
}

export async function updateCampaign(id: string, data: Partial<Campaign>): Promise<Campaign | undefined> {
  const [campaign] = await db.update(campaigns).set(data).where(eq(campaigns.id, id)).returning();
  return campaign;
}

export async function deleteCampaign(id: string): Promise<void> {
  await db.delete(nullsinkCaptures).where(eq(nullsinkCaptures.campaignId, id));
  // campaign_sends and campaign_stats cascade from campaign FK
  await db.delete(campaignJobs).where(eq(campaignJobs.campaignId, id));
  await db.delete(errorLogs).where(eq(errorLogs.campaignId, id));
  await db.execute(sql`DELETE FROM pending_tag_operations WHERE campaign_id = ${id}`);
  await db.execute(sql`DELETE FROM analytics_daily WHERE campaign_id = ${id}`);
  await db.delete(campaigns).where(eq(campaigns.id, id));
}

export async function copyCampaign(id: string): Promise<Campaign | undefined> {
  const original = await getCampaign(id);
  if (!original) return undefined;
  // Strip identity, timing, counters, AND follow-up linkage. A copy is a
  // brand-new original — never inherit parent/child references because the
  // partial-unique index on parent_campaign_id would block the insert if
  // the parent already had its single child spawned.
  const {
    id: _,
    createdAt,
    startedAt,
    completedAt,
    sentCount,
    pendingCount,
    failedCount,
    parentCampaignId: _p,
    followUpCampaignId: _fc,
    followUpScheduledAt: _fs,
    ...copyData
  } = original;
  return createCampaign({
    ...copyData,
    name: `${original.name} (Copy)`,
    status: "draft",
    sendingSpeed: original.sendingSpeed as "drip" | "very_slow" | "slow" | "medium" | "fast" | "godzilla",
  });
}

// ═══════════════════════════════════════════════════════════════
// AUTO-RESEND TO OPENERS — Task #56 helpers
// ═══════════════════════════════════════════════════════════════

/**
 * Stamp followUpScheduledAt = now() + delayHours on the parent. Called from
 * campaign-sender.ts when the parent transitions to "completed". Idempotent:
 * only stamps if the column is currently NULL so a manual rerun cannot
 * accidentally double-trigger the spawner.
 */
export async function markFollowUpScheduled(parentCampaignId: string, delayHours: number): Promise<void> {
  await db.execute(sql`
    UPDATE campaigns
    SET follow_up_scheduled_at = NOW() + (${delayHours} || ' hours')::interval
    WHERE id = ${parentCampaignId}
      AND follow_up_enabled = true
      AND follow_up_campaign_id IS NULL
      AND follow_up_scheduled_at IS NULL
  `);
}

/**
 * Returns parents whose follow-up should be SPAWNED (not yet sent — the
 * spawn happens immediately after the parent completes). The child is
 * created in `scheduled` state with scheduledAt = parent.completedAt +
 * delayHours so it lives in the campaigns list for the entire delay
 * window and the user can pause / edit / cancel it through the standard
 * scheduled-campaign controls. Promotion to `sending` is then handled by
 * `pollScheduledCampaigns` when the scheduled time arrives.
 *
 * We deliberately DO NOT require `follow_up_scheduled_at <= NOW()` — that
 * would defer creation until the very moment of send and rob users of
 * the ability to interact with the queued follow-up beforehand.
 *
 * Caps at `limit` so a massive backlog (e.g. after a multi-day worker
 * outage) drains over time rather than overwhelming the queue in one tick.
 */
export async function findFollowUpCandidates(limit: number = 25): Promise<Campaign[]> {
  return db.select().from(campaigns).where(
    and(
      eq(campaigns.followUpEnabled, true),
      sql`${campaigns.followUpCampaignId} IS NULL`,
      sql`${campaigns.followUpScheduledAt} IS NOT NULL`,
      // Only originals — a child cannot itself spawn a follow-up.
      sql`${campaigns.parentCampaignId} IS NULL`,
      // Parent must have FINISHED sending. We refuse to follow-up a
      // paused/aborted parent because openers would be a partial sample.
      sql`${campaigns.status} IN ('completed', 'sent')`,
    ),
  ).limit(limit);
}

/**
 * Spawn the follow-up child campaign for `parent`. The child is created in
 * "draft" state and linked back via `followUpCampaignId`. Audience iteration
 * for the child is handled by the sender (see parentCampaignId branch in
 * campaign-sender.ts). Returns the new child, or undefined when the parent
 * already has a child (race-safe via the partial-unique index on
 * parent_campaign_id).
 */
export async function spawnFollowUpCampaign(
  parent: Campaign,
  options: { openerCount?: number } = {},
): Promise<Campaign | undefined> {
  // Build the child from parent's settings using the REAL campaigns schema
  // columns. Per spec, the child is created in 'scheduled' state with
  // scheduled_at = parent.completedAt + delayHours so the user can pause /
  // edit / cancel via existing scheduled-campaign controls. The standard
  // pollScheduledCampaigns worker promotes scheduled→sending at the right
  // time, exactly the same path as a normally-scheduled campaign.
  //
  // IMPORTANT: We do NOT short-circuit to status='completed' for zero-opener
  // parents at spawn time. Spawn happens immediately at parent completion,
  // but openers can (and do) keep arriving for the entire delay window —
  // late-loading email clients, prefetchers, mobile devices coming online,
  // etc. Marking the child completed at spawn would permanently suppress
  // legitimate follow-up sends for those late openers. Instead, we always
  // create the child as 'scheduled' and let the sender evaluate the actual
  // opener audience at send time (campaign-sender.ts already does this via
  // countOpenersForParentCampaign at line ~123); it can mark the child
  // completed at execution if total openers is genuinely 0 by then.
  //
  // Schedule source-of-truth = parent.followUpScheduledAt. That column is
  // stamped to NOW() + delayHours at completion (see markFollowUpScheduled),
  // so the child's send time is fully determined by the parent's COMPLETION,
  // not by when the spawner happens to wake up. If the column is somehow
  // missing (very old campaigns or partial restore) fall back to
  // completedAt + delay, then now + delay as a last-ditch safety net so we
  // never silently push the schedule out by an extra full window.
  void options; // openerCount accepted for API compat but no longer used at spawn
  const delayMs = (parent.followUpDelayHours ?? 36) * 60 * 60 * 1000;
  const scheduledAt =
    parent.followUpScheduledAt ??
    (parent.completedAt ? new Date(parent.completedAt.getTime() + delayMs) : new Date(Date.now() + delayMs));

  const child = {
    name: `${parent.name} (Follow-up)`,
    mtaId: parent.mtaId,
    segmentId: parent.segmentId, // copied for display only — sender ignores
    fromName: parent.fromName,
    fromEmail: parent.fromEmail,
    replyEmail: parent.replyEmail ?? null,
    subject: parent.followUpSubject ?? parent.subject,
    preheader: parent.preheader ?? null,
    htmlContent: parent.htmlContent,
    trackOpens: parent.trackOpens,
    trackClicks: parent.trackClicks,
    unsubscribeText: parent.unsubscribeText ?? "Unsubscribe",
    companyAddress: parent.companyAddress ?? null,
    sendingSpeed: parent.sendingSpeed,
    openTag: parent.openTag ?? null,
    clickTag: parent.clickTag ?? null,
    unsubscribeTag: parent.unsubscribeTag ?? null,
    parentCampaignId: parent.id,
    followUpEnabled: false,
    followUpDelayHours: 36,
    scheduledAt: zeroAudience ? null : scheduledAt,
    status: zeroAudience ? "completed" : "scheduled",
    completedAt: zeroAudience ? new Date() : null,
  } as typeof campaigns.$inferInsert;

  // Atomic spawn + parent-link. We do the INSERT and the parent UPDATE in a
  // single transaction so we never end up with an orphan child + unset
  // parent.followUpCampaignId (which would deadlock subsequent polls because
  // the partial unique index on parent_campaign_id would block re-spawn).
  try {
    return await db.transaction(async (tx) => {
      const [created] = await tx.insert(campaigns).values(child).returning();
      await tx.execute(sql`
        UPDATE campaigns
        SET follow_up_campaign_id = ${created.id}
        WHERE id = ${parent.id} AND follow_up_campaign_id IS NULL
      `);
      return created;
    });
  } catch (err: any) {
    // Unique-violation on the partial index = another worker already
    // spawned the child. Find the existing child and ensure the parent
    // link points to it (defensive: heals a stale partial-failure state).
    if (err?.code === "23505") {
      logger.warn(`[FOLLOWUP] Child already exists for parent=${parent.id}, healing link`);
      const [existing] = await db
        .select()
        .from(campaigns)
        .where(eq(campaigns.parentCampaignId, parent.id))
        .limit(1);
      if (existing) {
        await db.execute(sql`
          UPDATE campaigns
          SET follow_up_campaign_id = ${existing.id}
          WHERE id = ${parent.id} AND follow_up_campaign_id IS NULL
        `);
        return existing;
      }
      return undefined;
    }
    throw err;
  }
}

/**
 * For a given campaign, return its linked counterpart (parent if this is a
 * child, child if this is a parent). Used by the campaign-detail UI.
 */
export async function getLinkedFollowUp(campaignId: string): Promise<{ parent: Campaign | null; child: Campaign | null }> {
  const c = await getCampaign(campaignId);
  if (!c) return { parent: null, child: null };
  let parent: Campaign | null = null;
  let child: Campaign | null = null;
  if (c.parentCampaignId) {
    parent = (await getCampaign(c.parentCampaignId)) ?? null;
  }
  if (c.followUpCampaignId) {
    child = (await getCampaign(c.followUpCampaignId)) ?? null;
  }
  return { parent, child };
}

// ═══════════════════════════════════════════════════════════════
// CAMPAIGN SENDING & TRACKING
// ═══════════════════════════════════════════════════════════════

export interface TrackingContext {
  ipAddress?: string;
  userAgent?: string;
  country?: string;
  city?: string;
  deviceType?: string;
  browser?: string;
  os?: string;
}

export async function addCampaignStat(campaignId: string, subscriberId: string, type: string, link?: string, ctx?: TrackingContext): Promise<void> {
  await db.insert(campaignStats).values({
    campaignId,
    subscriberId,
    type,
    link,
    ...(ctx ?? {}),
  });
}

export async function getCampaignStats(campaignId: string): Promise<CampaignStat[]> {
  return db.select().from(campaignStats).where(eq(campaignStats.campaignId, campaignId)).orderBy(desc(campaignStats.timestamp));
}

export async function recordCampaignSend(_campaignId: string, _subscriberId: string, _status: string = "sent"): Promise<boolean> {
  throw new Error("DEPRECATED: recordCampaignSend() is no longer supported. Use reserveSendSlot() + finalizeSend() for proper two-phase send.");
}

export async function wasEmailSent(campaignId: string, subscriberId: string): Promise<boolean> {
  const [result] = await db.select({ count: sql<number>`count(*)` })
    .from(campaignSends)
    .where(and(eq(campaignSends.campaignId, campaignId), eq(campaignSends.subscriberId, subscriberId)));
  return Number(result.count) > 0;
}

export async function getCampaignSendCount(campaignId: string): Promise<number> {
  const [result] = await db.select({ count: sql<number>`count(*)` })
    .from(campaignSends).where(eq(campaignSends.campaignId, campaignId));
  return Number(result.count);
}

export async function incrementCampaignSentCount(campaignId: string, increment: number = 1): Promise<void> {
  await db.execute(sql`UPDATE campaigns SET sent_count = sent_count + ${increment} WHERE id = ${campaignId}`);
}

export async function incrementCampaignFailedCount(campaignId: string, increment: number = 1): Promise<void> {
  await db.execute(sql`UPDATE campaigns SET failed_count = failed_count + ${increment} WHERE id = ${campaignId}`);
}

export async function decrementCampaignPendingCount(campaignId: string, decrement: number = 1): Promise<void> {
  await db.execute(sql`UPDATE campaigns SET pending_count = GREATEST(pending_count - ${decrement}, 0) WHERE id = ${campaignId}`);
}

export async function updateCampaignStatusAtomic(campaignId: string, newStatus: string, expectedStatus?: string): Promise<boolean> {
  let result;
  if (expectedStatus) {
    result = await db.execute(sql`
      UPDATE campaigns SET status = ${newStatus}
      WHERE id = ${campaignId} AND status = ${expectedStatus}
      RETURNING id
    `);
  } else {
    result = await db.execute(sql`
      UPDATE campaigns SET status = ${newStatus} WHERE id = ${campaignId} RETURNING id
    `);
  }
  return result.rows.length > 0;
}

export async function reserveSendSlot(campaignId: string, subscriberId: string): Promise<boolean> {
  const result = await db.execute(sql`
    INSERT INTO campaign_sends (id, campaign_id, subscriber_id, status, sent_at)
    VALUES (gen_random_uuid(), ${campaignId}, ${subscriberId}, 'pending', NOW())
    ON CONFLICT (campaign_id, subscriber_id) DO NOTHING
    RETURNING id
  `);
  return result.rows.length > 0;
}

export async function finalizeSend(campaignId: string, subscriberId: string, success: boolean): Promise<void> {
  const result = await db.execute(sql`
    WITH updated_send AS (
      UPDATE campaign_sends SET status = ${success ? 'sent' : 'failed'}
      WHERE campaign_id = ${campaignId} AND subscriber_id = ${subscriberId} AND status = 'pending'
      RETURNING id
    ),
    counter_update AS (
      UPDATE campaigns SET
        sent_count = CASE WHEN ${success} THEN sent_count + 1 ELSE sent_count END,
        failed_count = CASE WHEN NOT ${success} THEN failed_count + 1 ELSE failed_count END,
        pending_count = GREATEST(pending_count - 1, 0)
      WHERE id = ${campaignId} AND (SELECT COUNT(*) FROM updated_send) > 0
      RETURNING id
    )
    SELECT (SELECT COUNT(*) FROM updated_send) as updated_count
  `);
  const updatedCount = Number(result.rows[0]?.updated_count ?? 0);
  if (updatedCount === 0) {
    throw new Error(`finalizeSend invariant violation: No pending row found for campaign=${campaignId}, subscriber=${subscriberId}.`);
  }
}

export async function recordSendAndUpdateCounters(campaignId: string, subscriberId: string, success: boolean): Promise<boolean> {
  const reserved = await reserveSendSlot(campaignId, subscriberId);
  if (!reserved) return false;
  await finalizeSend(campaignId, subscriberId, success);
  return true;
}

export async function recoverOrphanedPendingSends(campaignId: string, maxAgeMinutes: number = 5): Promise<number> {
  const result = await db.execute(sql`
    WITH orphaned AS (
      UPDATE campaign_sends SET status = 'failed'
      WHERE campaign_id = ${campaignId} AND status = 'pending'
        AND sent_at < NOW() - INTERVAL '1 minute' * ${maxAgeMinutes}
      RETURNING id
    ),
    counter_update AS (
      UPDATE campaigns SET
        failed_count = failed_count + (SELECT COUNT(*) FROM orphaned),
        pending_count = GREATEST(pending_count - (SELECT COUNT(*) FROM orphaned), 0)
      WHERE id = ${campaignId} AND (SELECT COUNT(*) FROM orphaned) > 0
      RETURNING id
    )
    SELECT (SELECT COUNT(*) FROM orphaned) as recovered_count
  `);
  const recoveredCount = Number(result.rows[0]?.recovered_count ?? 0);
  if (recoveredCount > 0) logger.info('Recovered orphaned pending sends', { recoveredCount, campaignId });
  return recoveredCount;
}

/**
 * Atomically reset all failed sends to pending, flip the campaign back to 'sending',
 * clear retryUntil (so campaign-sender sets a fresh 12-hour window), increment
 * autoRetryCount, and insert a new campaign_job (skipped if one is already queued).
 * Returns true when the new job was enqueued, false when there were no failed rows.
 */
export async function autoRequeueCampaignFailed(campaignId: string, newAutoRetryCount: number): Promise<boolean> {
  const result = await db.execute(sql`
    WITH reset AS (
      UPDATE campaign_sends
      SET status = 'pending',
          retry_count = retry_count + 1,
          last_retry_at = NOW(),
          sent_at = NOW()
      WHERE campaign_id = ${campaignId} AND status = 'failed'
      RETURNING id
    ),
    campaign_update AS (
      UPDATE campaigns
      SET status = 'sending',
          failed_count = 0,
          retry_until = NULL,
          auto_retry_count = ${newAutoRetryCount}
      WHERE id = ${campaignId} AND (SELECT COUNT(*) FROM reset) > 0
      RETURNING id
    ),
    job_insert AS (
      INSERT INTO campaign_jobs (id, campaign_id, status)
      SELECT gen_random_uuid(), ${campaignId}, 'pending'
      WHERE EXISTS (SELECT 1 FROM campaign_update)
        AND NOT EXISTS (
          SELECT 1 FROM campaign_jobs
          WHERE campaign_id = ${campaignId} AND status IN ('pending', 'processing')
        )
      RETURNING id
    )
    SELECT (SELECT COUNT(*) FROM reset) AS reset_count
  `);
  const resetCount = Number(result.rows[0]?.reset_count ?? 0);
  return resetCount > 0;
}

export async function resetOrphanedFailedSends(campaignId: string): Promise<number> {
  const result = await db.execute(sql`
    WITH orphaned AS (
      DELETE FROM campaign_sends
      WHERE campaign_id = ${campaignId} AND status = 'failed'
        AND retry_count = 0 AND first_open_at IS NULL AND first_click_at IS NULL
      RETURNING id
    ),
    counter_update AS (
      UPDATE campaigns
      SET failed_count = GREATEST(failed_count - (SELECT COUNT(*) FROM orphaned), 0)
      WHERE id = ${campaignId} AND (SELECT COUNT(*) FROM orphaned) > 0
      RETURNING id
    )
    SELECT (SELECT COUNT(*) FROM orphaned) as reset_count
  `);
  const resetCount = Number(result.rows[0]?.reset_count ?? 0);
  if (resetCount > 0) logger.info(`[RESUME] Deleted ${resetCount} orphaned failed sends for campaign ${campaignId}`);
  return resetCount;
}

export async function forceFailPendingSend(campaignId: string, subscriberId: string): Promise<boolean> {
  const result = await db.execute(sql`
    WITH updated AS (
      UPDATE campaign_sends SET status = 'failed'
      WHERE campaign_id = ${campaignId} AND subscriber_id = ${subscriberId} AND status = 'pending'
      RETURNING id
    ),
    counter_update AS (
      UPDATE campaigns SET
        failed_count = failed_count + 1,
        pending_count = GREATEST(pending_count - 1, 0)
      WHERE id = ${campaignId} AND (SELECT COUNT(*) FROM updated) > 0
      RETURNING id
    )
    SELECT (SELECT COUNT(*) FROM updated) as updated_count
  `);
  return Number(result.rows[0]?.updated_count ?? 0) > 0;
}

export async function bulkReserveSendSlots(campaignId: string, subscriberIds: string[]): Promise<string[]> {
  if (subscriberIds.length === 0) return [];
  const CHUNK_SIZE = 1000;
  const allReserved: string[] = [];
  for (let i = 0; i < subscriberIds.length; i += CHUNK_SIZE) {
    const chunk = subscriberIds.slice(i, i + CHUNK_SIZE);
    const arrayLiteral = `{${chunk.map(id => `"${id}"`).join(',')}}`;
    const result = await db.execute(sql`
      INSERT INTO campaign_sends (id, campaign_id, subscriber_id, status, sent_at)
      SELECT gen_random_uuid(), ${campaignId}, unnest_id, 'pending', NOW()
      FROM unnest(${arrayLiteral}::text[]) AS unnest_id
      ON CONFLICT (campaign_id, subscriber_id) DO NOTHING
      RETURNING subscriber_id
    `);
    for (const r of result.rows) allReserved.push((r as any).subscriber_id);
  }
  return allReserved;
}

export async function bulkInsertCampaignSendAttempts(campaignId: string, subscriberIds: string[]): Promise<void> {
  if (subscriberIds.length === 0) return;
  const CHUNK_SIZE = 1000;
  for (let i = 0; i < subscriberIds.length; i += CHUNK_SIZE) {
    const chunk = subscriberIds.slice(i, i + CHUNK_SIZE);
    const arrayLiteral = `{${chunk.map(id => `"${id}"`).join(',')}}`;
    await db.execute(sql`
      INSERT INTO campaign_sends (id, campaign_id, subscriber_id, status, sent_at)
      SELECT gen_random_uuid(), ${campaignId}, unnest_id, 'attempting', NOW()
      FROM unnest(${arrayLiteral}::text[]) AS unnest_id
      ON CONFLICT (campaign_id, subscriber_id) DO UPDATE
        SET status = 'attempting'
        WHERE campaign_sends.status = 'pending'
    `);
  }
}

export async function bulkFinalizeSends(campaignId: string, successIds: string[], failedIds: string[]): Promise<void> {
  const sentCount = successIds.length;
  const failCount = failedIds.length;
  const totalProcessed = sentCount + failCount;
  if (totalProcessed === 0) return;

  const CHUNK_SIZE = 1000;
  await db.transaction(async (tx) => {
    if (successIds.length > 0) {
      for (let i = 0; i < successIds.length; i += CHUNK_SIZE) {
        const chunk = successIds.slice(i, i + CHUNK_SIZE);
        const arr = `{${chunk.map(id => `"${id}"`).join(',')}}`;
        await tx.execute(sql`
          UPDATE campaign_sends SET status = 'sent'
          WHERE campaign_id = ${campaignId} AND subscriber_id = ANY(${arr}::text[]) AND status IN ('pending', 'attempting')
        `);
      }
    }
    if (failedIds.length > 0) {
      for (let i = 0; i < failedIds.length; i += CHUNK_SIZE) {
        const chunk = failedIds.slice(i, i + CHUNK_SIZE);
        const arr = `{${chunk.map(id => `"${id}"`).join(',')}}`;
        await tx.execute(sql`
          UPDATE campaign_sends SET status = 'failed'
          WHERE campaign_id = ${campaignId} AND subscriber_id = ANY(${arr}::text[]) AND status IN ('pending', 'attempting')
        `);
      }
    }
    await tx.execute(sql`
      UPDATE campaigns SET
        sent_count = sent_count + ${sentCount},
        failed_count = failed_count + ${failCount},
        pending_count = GREATEST(pending_count - ${totalProcessed}, 0)
      WHERE id = ${campaignId}
    `);
  });
}

export async function heartbeatJob(jobId: string): Promise<void> {
  await db.execute(sql`
    UPDATE campaign_jobs SET started_at = NOW() WHERE id = ${jobId} AND status = 'processing'
  `);
}

export async function getCampaignSend(campaignId: string, subscriberId: string): Promise<CampaignSend | undefined> {
  const [send] = await db.select().from(campaignSends)
    .where(and(eq(campaignSends.campaignId, campaignId), eq(campaignSends.subscriberId, subscriberId)));
  return send;
}

export async function recordFirstOpen(campaignId: string, subscriberId: string): Promise<boolean> {
  const result = await db.execute(sql`
    UPDATE campaign_sends SET first_open_at = NOW()
    WHERE campaign_id = ${campaignId} AND subscriber_id = ${subscriberId} AND first_open_at IS NULL
    RETURNING id
  `);
  return result.rows.length > 0;
}

export async function recordFirstClick(campaignId: string, subscriberId: string): Promise<boolean> {
  const result = await db.execute(sql`
    UPDATE campaign_sends SET first_click_at = NOW()
    WHERE campaign_id = ${campaignId} AND subscriber_id = ${subscriberId} AND first_click_at IS NULL
    RETURNING id
  `);
  return result.rows.length > 0;
}

export async function getUniqueOpenCount(campaignId: string): Promise<number> {
  const result = await db.execute(sql`
    SELECT COUNT(*) as count FROM campaign_sends WHERE campaign_id = ${campaignId} AND first_open_at IS NOT NULL
  `);
  return Number((result.rows[0] as any)?.count || 0);
}

export async function getUniqueClickCount(campaignId: string): Promise<number> {
  const result = await db.execute(sql`
    SELECT COUNT(*) as count FROM campaign_sends WHERE campaign_id = ${campaignId} AND first_click_at IS NOT NULL
  `);
  return Number((result.rows[0] as any)?.count || 0);
}

export async function getCampaignSendCounts(campaignId: string): Promise<{total: number, sent: number, failed: number, pending: number, attempting: number}> {
  const result = await db.execute(sql`
    SELECT
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE status = 'sent') as sent,
      COUNT(*) FILTER (WHERE status = 'failed') as failed,
      COUNT(*) FILTER (WHERE status = 'pending' OR status = 'reserved') as pending,
      COUNT(*) FILTER (WHERE status = 'attempting') as attempting
    FROM campaign_sends WHERE campaign_id = ${campaignId}
  `);
  const row = result.rows[0] as any;
  return {
    total: Number(row?.total || 0),
    sent: Number(row?.sent || 0),
    failed: Number(row?.failed || 0),
    pending: Number(row?.pending || 0),
    attempting: Number(row?.attempting || 0),
  };
}

// ═══════════════════════════════════════════════════════════════
// NULLSINK
// ═══════════════════════════════════════════════════════════════

export async function createNullsinkCapture(data: InsertNullsinkCapture): Promise<NullsinkCapture> {
  const [capture] = await db.insert(nullsinkCaptures).values(data).returning();
  return capture;
}

export async function bulkCreateNullsinkCaptures(data: InsertNullsinkCapture[]): Promise<void> {
  if (data.length === 0) return;
  const CHUNK_SIZE = 500;
  for (let i = 0; i < data.length; i += CHUNK_SIZE) {
    await db.insert(nullsinkCaptures).values(data.slice(i, i + CHUNK_SIZE));
  }
}

export async function getNullsinkCaptures(options?: {
  campaignId?: string; limit?: number; offset?: number;
}): Promise<{ captures: NullsinkCapture[]; total: number }> {
  const limit = options?.limit || 100;
  const offset = options?.offset || 0;
  const whereClause = options?.campaignId ? eq(nullsinkCaptures.campaignId, options.campaignId) : undefined;

  const [captures, [{ count }]] = await Promise.all([
    whereClause
      ? db.select().from(nullsinkCaptures).where(whereClause).orderBy(desc(nullsinkCaptures.timestamp)).limit(limit).offset(offset)
      : db.select().from(nullsinkCaptures).orderBy(desc(nullsinkCaptures.timestamp)).limit(limit).offset(offset),
    whereClause
      ? db.select({ count: sql<number>`count(*)` }).from(nullsinkCaptures).where(whereClause)
      : db.select({ count: sql<number>`count(*)` }).from(nullsinkCaptures),
  ]);
  return { captures, total: Number(count) };
}

export async function getNullsinkMetrics(campaignId?: string): Promise<{
  totalEmails: number; successfulEmails: number; failedEmails: number;
  avgHandshakeTimeMs: number; avgTotalTimeMs: number; emailsPerSecond: number;
}> {
  const whereClause = campaignId ? sql`WHERE campaign_id = ${campaignId}` : sql``;
  const result = await db.execute(sql`
    SELECT
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE status = 'captured') as successful,
      COUNT(*) FILTER (WHERE status = 'simulated_failure') as failed,
      COALESCE(AVG(handshake_time_ms), 0) as avg_handshake,
      COALESCE(AVG(total_time_ms), 0) as avg_total,
      COALESCE(COUNT(*) / NULLIF(EXTRACT(EPOCH FROM (MAX(timestamp) - MIN(timestamp))), 0), 0) as emails_per_second
    FROM nullsink_captures
    ${whereClause}
  `);
  const row = result.rows[0] as any;
  return {
    totalEmails: Number(row?.total || 0),
    successfulEmails: Number(row?.successful || 0),
    failedEmails: Number(row?.failed || 0),
    avgHandshakeTimeMs: Number(row?.avg_handshake || 0),
    avgTotalTimeMs: Number(row?.avg_total || 0),
    emailsPerSecond: Number(row?.emails_per_second || 0),
  };
}

export async function clearNullsinkCaptures(campaignId?: string): Promise<number> {
  if (campaignId) {
    const result = await db.delete(nullsinkCaptures).where(eq(nullsinkCaptures.campaignId, campaignId));
    return result.rowCount || 0;
  }
  const result = await db.delete(nullsinkCaptures);
  return result.rowCount || 0;
}

// ═══════════════════════════════════════════════════════════════
// CAMPAIGN LINKS (opaque token registry for click tracking)
// ═══════════════════════════════════════════════════════════════

/**
 * Batch-insert missing links and return a Map<destinationUrl, linkId> for all provided URLs.
 * Uses ON CONFLICT DO NOTHING so this is fully idempotent.
 */
export async function batchGetOrCreateCampaignLinks(
  campaignId: string,
  urls: string[]
): Promise<Map<string, string>> {
  if (urls.length === 0) return new Map();

  // Deduplicate before hitting the DB
  const uniqueUrls = [...new Set(urls)];

  // Insert any new links; existing ones are silently skipped
  await pool.query(
    `INSERT INTO campaign_links (id, campaign_id, destination_url)
     SELECT gen_random_uuid(), $1, unnest($2::text[])
     ON CONFLICT (campaign_id, destination_url) DO NOTHING`,
    [campaignId, uniqueUrls]
  );

  // Fetch all (existing + newly created) rows for this campaign + url set
  const result = await pool.query(
    `SELECT id, destination_url FROM campaign_links
     WHERE campaign_id = $1 AND destination_url = ANY($2::text[])`,
    [campaignId, uniqueUrls]
  );

  const map = new Map<string, string>();
  for (const row of result.rows) {
    map.set(row.destination_url, row.id);
  }
  return map;
}

/**
 * Look up the destination URL for a given link ID.
 * Returns null if the link does not exist (e.g. corrupted token).
 */
export async function getCampaignLinkDestination(linkId: string): Promise<string | null> {
  const result = await pool.query(
    `SELECT destination_url FROM campaign_links WHERE id = $1`,
    [linkId]
  );
  return result.rows.length > 0 ? result.rows[0].destination_url : null;
}

// ═══════════════════════════════════════════════════════════════
// DASHBOARD & ANALYTICS (campaign-scoped, no subscriber-repo dep)
// ═══════════════════════════════════════════════════════════════

export async function getDashboardStats() {
  // Single combined query against campaign_stats with FILTER aggregates —
  // halves the work compared with two separate full-table COUNT scans.
  const [
    subCountResult,
    [{ campaignCount }],
    statsResult,
    recentCampaigns,
    recentImports,
  ] = await Promise.all([
    db.execute(sql`SELECT COUNT(*) as count FROM subscribers`),
    db.select({ campaignCount: sql<number>`count(*)` }).from(campaigns),
    db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE type = 'open')::int  AS open_count,
        COUNT(*) FILTER (WHERE type = 'click')::int AS click_count
      FROM campaign_stats
    `),
    db.select().from(campaigns).orderBy(desc(campaigns.createdAt)).limit(5),
    db.select().from(importJobs).orderBy(desc(importJobs.createdAt)).limit(5),
  ]);
  const statsRow = statsResult.rows[0] as any;
  return {
    totalSubscribers: Number((subCountResult.rows[0] as any)?.count || 0),
    totalCampaigns: Number(campaignCount),
    totalOpens: Number(statsRow?.open_count || 0),
    totalClicks: Number(statsRow?.click_count || 0),
    recentCampaigns,
    recentImports,
  };
}

// ═══════════════════════════════════════════════════════════════
// TRACKING TOKENS  (short branded /c/ and /u/ URLs)
// ═══════════════════════════════════════════════════════════════

// ─── Ensure tracking_tokens table exists (idempotent bootstrap) ─────────────
// Called once on module load.  drizzle-kit push silently no-ops on complex
// expression indexes, so we manage this table entirely via raw SQL.
//
// If the database is short on disk (53100 disk_full / "could not write" /
// "Disk quota exceeded"), the bootstrap is *deferred* rather than fatal:
// we log a warning, expose the deferred state, and let the rest of the
// web server come up so unrelated reads (e.g. /api/campaigns) keep
// serving. The migration is re-runnable via runTrackingTokensBootstrap().
let trackingTokensBootstrapState: "pending" | "ready" | "deferred" = "pending";
let trackingTokensBootstrapDeferReason: string | null = null;

export function getTrackingTokensBootstrapState(): {
  state: "pending" | "ready" | "deferred";
  deferReason: string | null;
} {
  return {
    state: trackingTokensBootstrapState,
    deferReason: trackingTokensBootstrapDeferReason,
  };
}

export async function runTrackingTokensBootstrap(): Promise<"ready" | "deferred"> {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tracking_tokens (
        token       varchar(8)   PRIMARY KEY,
        type        varchar(11)  NOT NULL CHECK (type IN ('click', 'unsubscribe')),
        campaign_id varchar      NOT NULL REFERENCES campaigns(id)       ON DELETE CASCADE,
        subscriber_id varchar    NOT NULL,
        link_id     varchar      NULL     REFERENCES campaign_links(id)  ON DELETE CASCADE,
        created_at  timestamptz  NOT NULL DEFAULT now()
      )
    `);
    // Unique expression index required for ON CONFLICT … DO NOTHING below.
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS tracking_tokens_unique_idx
        ON tracking_tokens (type, campaign_id, subscriber_id, COALESCE(link_id, ''))
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS tracking_tokens_campaign_idx   ON tracking_tokens (campaign_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS tracking_tokens_subscriber_idx ON tracking_tokens (subscriber_id)`);
    // created_at index powers the retention purge job (DELETE … WHERE created_at < cutoff).
    // Without it, batched deletes on a 300M-row table do a sequential scan and are unusable.
    // CREATE INDEX CONCURRENTLY runs on its own connection (autocommit per pool.query),
    // so it does not block live writes; on a fresh DB it returns instantly via IF NOT EXISTS.
    // CONCURRENTLY only — a blocking CREATE INDEX on a 300M+ row table would
    // lock writes for many minutes and stall live tracking. If it fails (e.g.
    // a previous attempt left an INVALID index behind), drop and let the next
    // process restart retry. Never fall back to a blocking CREATE INDEX here.
    try {
      await pool.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS tracking_tokens_created_at_idx ON tracking_tokens (created_at)`);
    } catch (idxErr: any) {
      if (isDiskFullError(idxErr)) {
        const reason = `Disk pressure during created_at index build: ${idxErr?.message || idxErr}`;
        logger.warn(
          `[tracking_tokens] Bootstrap deferred (created_at index): ${reason}. ` +
          `Web server will continue starting; rerun reclamation (see docs/reclaim-tracking-tokens.md), ` +
          `then restart or call runTrackingTokensBootstrap() to retry.`
        );
        trackingTokensBootstrapState = "deferred";
        trackingTokensBootstrapDeferReason = reason;
        return "deferred";
      }
      logger.warn(`[tracking_tokens] CONCURRENTLY created_at index build failed, will retry on next start: ${idxErr?.message || idxErr}`);
      try {
        await pool.query(`DROP INDEX CONCURRENTLY IF EXISTS tracking_tokens_created_at_idx`);
      } catch { /* ignore */ }
    }
    trackingTokensBootstrapState = "ready";
    trackingTokensBootstrapDeferReason = null;
    return "ready";
  } catch (err: any) {
    const classified = classifyDbError(err);
    if (classified.kind === "disk_full") {
      const reason = `Database is out of disk space: ${classified.message}`;
      logger.warn(
        `[tracking_tokens] Bootstrap deferred — database disk pressure. ` +
        `code=${classified.code ?? "n/a"} reason="${classified.message}". ` +
        `Web server will continue starting; reclaim tracking_tokens space ` +
        `(see docs/reclaim-tracking-tokens.md) and restart, or call ` +
        `runTrackingTokensBootstrap() to retry without a restart.`
      );
      trackingTokensBootstrapState = "deferred";
      trackingTokensBootstrapDeferReason = reason;
      return "deferred";
    }
    logger.error('[tracking_tokens] Table bootstrap failed:', err.message);
    trackingTokensBootstrapState = "deferred";
    trackingTokensBootstrapDeferReason = err?.message || String(err);
    return "deferred";
  }
}

// Fire-and-forget bootstrap on module load. Errors never crash the boot —
// runTrackingTokensBootstrap() always resolves, even when it has to defer.
void runTrackingTokensBootstrap();

const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function generateToken(): string {
  const bytes = crypto.randomBytes(8);
  return Array.from(bytes).map(b => BASE62[b % 62]).join('');
}

const MAX_UNNEST_ROWS = 50000;

/**
 * Batch-create click tokens for all (subscriberId × linkId) pairs.
 * Returns Map<subscriberId, Map<linkId, token>>.
 * Idempotent: ON CONFLICT DO NOTHING, then re-fetch existing tokens.
 */
export async function batchCreateClickTokens(
  campaignId: string,
  subscriberIds: string[],
  linkIds: string[]
): Promise<Map<string, Map<string, string>>> {
  if (subscriberIds.length === 0 || linkIds.length === 0) return new Map();

  const allTokens: string[] = [];
  const allTypes: string[] = [];
  const allCampaigns: string[] = [];
  const allSubscribers: string[] = [];
  const allLinks: string[] = [];

  for (const sid of subscriberIds) {
    for (const lid of linkIds) {
      allTokens.push(generateToken());
      allTypes.push('click');
      allCampaigns.push(campaignId);
      allSubscribers.push(sid);
      allLinks.push(lid);
    }
  }

  // Chunk inserts to avoid huge unnest payloads
  for (let i = 0; i < allTokens.length; i += MAX_UNNEST_ROWS) {
    const chunk = allTokens.slice(i, i + MAX_UNNEST_ROWS);
    const types = allTypes.slice(i, i + MAX_UNNEST_ROWS);
    const camps = allCampaigns.slice(i, i + MAX_UNNEST_ROWS);
    const subs = allSubscribers.slice(i, i + MAX_UNNEST_ROWS);
    const links = allLinks.slice(i, i + MAX_UNNEST_ROWS);
    await pool.query(
      `INSERT INTO tracking_tokens (token, type, campaign_id, subscriber_id, link_id)
       SELECT unnest($1::text[]), unnest($2::text[]), unnest($3::text[]), unnest($4::text[]), unnest($5::text[])
       ON CONFLICT (type, campaign_id, subscriber_id, COALESCE(link_id, '')) DO NOTHING`,
      [chunk, types, camps, subs, links]
    );
  }

  const result = await pool.query(
    `SELECT token, subscriber_id, link_id
     FROM tracking_tokens
     WHERE type = 'click'
       AND campaign_id = $1
       AND subscriber_id = ANY($2::text[])
       AND link_id = ANY($3::text[])`,
    [campaignId, subscriberIds, linkIds]
  );

  const map = new Map<string, Map<string, string>>();
  for (const row of result.rows) {
    if (!map.has(row.subscriber_id)) map.set(row.subscriber_id, new Map());
    map.get(row.subscriber_id)!.set(row.link_id, row.token);
  }
  return map;
}

/**
 * Batch-create unsubscribe tokens for a list of subscribers.
 * Returns Map<subscriberId, token>.
 */
export async function batchCreateUnsubscribeTokens(
  campaignId: string,
  subscriberIds: string[]
): Promise<Map<string, string>> {
  if (subscriberIds.length === 0) return new Map();

  const tokens = subscriberIds.map(() => generateToken());
  const types = subscriberIds.map(() => 'unsubscribe');
  const camps = subscriberIds.map(() => campaignId);

  for (let i = 0; i < tokens.length; i += MAX_UNNEST_ROWS) {
    const chunk = tokens.slice(i, i + MAX_UNNEST_ROWS);
    const typChunk = types.slice(i, i + MAX_UNNEST_ROWS);
    const campChunk = camps.slice(i, i + MAX_UNNEST_ROWS);
    const subChunk = subscriberIds.slice(i, i + MAX_UNNEST_ROWS);
    await pool.query(
      `INSERT INTO tracking_tokens (token, type, campaign_id, subscriber_id)
       SELECT unnest($1::text[]), unnest($2::text[]), unnest($3::text[]), unnest($4::text[])
       ON CONFLICT (type, campaign_id, subscriber_id, COALESCE(link_id, '')) DO NOTHING`,
      [chunk, typChunk, campChunk, subChunk]
    );
  }

  const result = await pool.query(
    `SELECT token, subscriber_id
     FROM tracking_tokens
     WHERE type = 'unsubscribe'
       AND campaign_id = $1
       AND subscriber_id = ANY($2::text[])`,
    [campaignId, subscriberIds]
  );

  const map = new Map<string, string>();
  for (const row of result.rows) {
    map.set(row.subscriber_id, row.token);
  }
  return map;
}

/**
 * Resolve a short token to its campaign/subscriber/link metadata.
 * Returns null if the token does not exist.
 */
export async function resolveTrackingToken(token: string): Promise<{
  type: string;
  campaignId: string;
  subscriberId: string;
  linkId: string | null;
} | null> {
  const result = await pool.query(
    `SELECT type, campaign_id, subscriber_id, link_id
     FROM tracking_tokens WHERE token = $1`,
    [token]
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    type: row.type,
    campaignId: row.campaign_id,
    subscriberId: row.subscriber_id,
    linkId: row.link_id ?? null,
  };
}

export async function getOverallAnalytics() {
  // Pull the 10 most recent completed campaigns first, then aggregate their
  // unique opens / unique clicks in a SINGLE GROUP BY query — no per-campaign
  // round-trips. Combined opens/clicks totals also collapse into one query.
  const [statsResult, allCampaigns] = await Promise.all([
    db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE type = 'open')::int  AS open_count,
        COUNT(*) FILTER (WHERE type = 'click')::int AS click_count
      FROM campaign_stats
    `),
    db.select().from(campaigns)
      .where(eq(campaigns.status, "completed"))
      .orderBy(desc(campaigns.completedAt))
      .limit(10),
  ]);
  const statsRow = statsResult.rows[0] as any;
  const openCount = Number(statsRow?.open_count || 0);
  const clickCount = Number(statsRow?.click_count || 0);

  let campaignMetrics: Array<{
    id: string; name: string; sentCount: number; openRate: number; clickRate: number;
  }> = [];

  if (allCampaigns.length > 0) {
    const ids = allCampaigns.map((c) => c.id);
    const aggResult = await db.execute(sql`
      SELECT
        campaign_id,
        COUNT(*) FILTER (WHERE first_open_at IS NOT NULL)::int  AS unique_opens,
        COUNT(*) FILTER (WHERE first_click_at IS NOT NULL)::int AS unique_clicks
      FROM campaign_sends
      WHERE campaign_id = ANY(${ids}::text[])
      GROUP BY campaign_id
    `);
    const byId = new Map<string, { uo: number; uc: number }>();
    for (const row of aggResult.rows as any[]) {
      byId.set(row.campaign_id, {
        uo: Number(row.unique_opens || 0),
        uc: Number(row.unique_clicks || 0),
      });
    }
    campaignMetrics = allCampaigns.map((c) => {
      const agg = byId.get(c.id) || { uo: 0, uc: 0 };
      return {
        id: c.id,
        name: c.name,
        sentCount: c.sentCount,
        openRate: c.sentCount > 0 ? (agg.uo / c.sentCount) * 100 : 0,
        clickRate: c.sentCount > 0 ? (agg.uc / c.sentCount) * 100 : 0,
      };
    });
  }

  const avgOpenRate = campaignMetrics.length > 0
    ? campaignMetrics.reduce((a, c) => a + c.openRate, 0) / campaignMetrics.length : 0;
  const avgClickRate = campaignMetrics.length > 0
    ? campaignMetrics.reduce((a, c) => a + c.clickRate, 0) / campaignMetrics.length : 0;

  return {
    totalOpens: openCount,
    totalClicks: clickCount,
    totalCampaigns: allCampaigns.length,
    avgOpenRate,
    avgClickRate,
    recentCampaigns: campaignMetrics,
  };
}

export async function getCampaignBatchOpenStats(
  campaignId: string,
  batchSize: number = 10000
): Promise<Array<{
  batchNum: number;
  sent: number;
  opened: number;
  openRate: number;
  batchStart: string;
  batchEnd: string;
}>> {
  type BatchRow = {
    batch_num: string | number;
    sent: string | number;
    opened: string | number;
    open_rate: string | number;
    batch_start: Date | string;
    batch_end: Date | string;
  };
  const result = await db.execute(sql`
    SELECT
      batch_num,
      COUNT(*)::int AS sent,
      COUNT(first_open_at)::int AS opened,
      ROUND(COUNT(first_open_at)::numeric / NULLIF(COUNT(*), 0) * 100, 2)::float AS open_rate,
      MIN(sent_at) AS batch_start,
      MAX(sent_at) AS batch_end
    FROM (
      SELECT
        first_open_at,
        sent_at,
        CEIL(ROW_NUMBER() OVER (ORDER BY sent_at) / ${batchSize}::float)::int AS batch_num
      FROM campaign_sends
      WHERE campaign_id = ${campaignId}
        AND status IN ('sent', 'bounced', 'failed')
    ) batched
    GROUP BY batch_num
    ORDER BY batch_num
  `);
  return (result.rows as BatchRow[]).map((row) => ({
    batchNum: Number(row.batch_num),
    sent: Number(row.sent),
    opened: Number(row.opened),
    openRate: Number(row.open_rate),
    batchStart: row.batch_start instanceof Date ? row.batch_start.toISOString() : String(row.batch_start),
    batchEnd: row.batch_end instanceof Date ? row.batch_end.toISOString() : String(row.batch_end),
  }));
}
