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
  pressureGuardDeferredIndexSizeBytes,
} from "../metrics";
import { LOCK_KEYS } from "../bootstrap-lock";
import type { Campaign, Mta, Subscriber } from "@shared/schema";

// Bounded env parser: rejects NaN / non-finite / out-of-range values and
// falls back to the supplied default. Prevents misconfiguration from
// turning the cadenced jobs into a tight loop (e.g. PRESSURE_MAINTENANCE_INTERVAL_MS=0)
// or from disabling them silently via "abc".
function envInt(name: string, defaultValue: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return defaultValue;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < min || v > max) {
    // eslint-disable-next-line no-console
    console.warn(`[PRESSURE_GUARD_WORKER] ignoring out-of-range ${name}=${raw}; using default ${defaultValue}`);
    return defaultValue;
  }
  return Math.floor(v);
}

const POLL_INTERVAL_MS = envInt("PRESSURE_GUARD_POLL_MS", 30_000, 1_000, 24 * 60 * 60_000);
const BATCH_PER_CAMPAIGN = envInt("PRESSURE_GUARD_BATCH", 200, 1, 100_000);
const MAX_CAMPAIGNS_PER_TICK = envInt("PRESSURE_GUARD_MAX_CAMPAIGNS", 5, 1, 1_000);
// Task #145 R3: refresh the index-size gauge hourly, but only run the
// expensive VACUUM (ANALYZE) + REINDEX policy once per day during the
// configured off-peak hour (default 03:00 server-local). Min 60s
// prevents tight-loop storms; max 7d caps gauge staleness.
const MAINTENANCE_INTERVAL_MS = envInt("PRESSURE_MAINTENANCE_INTERVAL_MS", 60 * 60_000, 60_000, 7 * 24 * 60 * 60_000);
const MAINTENANCE_OFFPEAK_HOUR = envInt("PRESSURE_MAINTENANCE_OFFPEAK_HOUR", 3, 0, 23);
let lastHeavyMaintenanceDay: string | null = null;
// Task #145 R15: audit TTL — drop pressure_flush_audit rows older than
// PRESSURE_FLUSH_AUDIT_RETENTION_DAYS (default 365).
const AUDIT_TTL_INTERVAL_MS = envInt("PRESSURE_AUDIT_TTL_INTERVAL_MS", 24 * 60 * 60_000, 60 * 60_000, 7 * 24 * 60 * 60_000);
const AUDIT_RETENTION_DAYS = envInt("PRESSURE_FLUSH_AUDIT_RETENTION_DAYS", 365, 1, 3650);

let pollInterval: NodeJS.Timeout | null = null;
let maintenanceInterval: NodeJS.Timeout | null = null;
let auditTtlInterval: NodeJS.Timeout | null = null;
let isPolling = false;

export function startPressureGuardWorker() {
  if (pollInterval) return;
  logger.info(`[PRESSURE_GUARD_WORKER] Starting (poll=${POLL_INTERVAL_MS}ms, batch=${BATCH_PER_CAMPAIGN}, max-campaigns=${MAX_CAMPAIGNS_PER_TICK}, window=${PRESSURE_WINDOW_HOURS}h)`);
  pollInterval = setInterval(pollDeferredQueue, POLL_INTERVAL_MS);
  // Kick off after a short delay to let bootstrap run first.
  setTimeout(pollDeferredQueue, 5_000);
  // R3 + R15 cadenced background jobs (also leader-elected).
  maintenanceInterval = setInterval(runMaintenanceTick, MAINTENANCE_INTERVAL_MS);
  auditTtlInterval = setInterval(runAuditTtlTick, AUDIT_TTL_INTERVAL_MS);
  setTimeout(runMaintenanceTick, 30_000);
  setTimeout(runAuditTtlTick, 60_000);
}

export function stopPressureGuardWorker() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
  if (maintenanceInterval) {
    clearInterval(maintenanceInterval);
    maintenanceInterval = null;
  }
  if (auditTtlInterval) {
    clearInterval(auditTtlInterval);
    auditTtlInterval = null;
  }
  logger.info("[PRESSURE_GUARD_WORKER] Stopped");
}

/**
 * Try to claim a session-level advisory lock for the duration of `fn`.
 * Returns the result of `fn` if acquired, or `null` if another node owns
 * the lock. The lock is released even on failure. Used to single-flight
 * the drain poll across multiple worker processes (Task #145 R5).
 */
async function withSessionLock<T>(lockKey: number, label: string, fn: () => Promise<T>): Promise<T | null> {
  const client = await pool.connect();
  try {
    const r = await client.query<{ acquired: boolean }>(`SELECT pg_try_advisory_lock($1) AS acquired`, [lockKey]);
    if (!r.rows[0]?.acquired) return null;
    try {
      return await fn();
    } finally {
      try { await client.query(`SELECT pg_advisory_unlock($1)`, [lockKey]); } catch (e: any) {
        logger.warn(`[${label}] failed to release lock ${lockKey}: ${e?.message || e}`);
      }
    }
  } finally {
    client.release();
  }
}

async function pollDeferredQueue() {
  if (isPolling) return;
  if (getPressureGuardBootstrapState() !== "ready") return;
  isPolling = true;
  try {
    // R5: leader election. When multiple worker processes run (split web
    // + worker mode, multi-replica), only one node should drain a tick;
    // others bail immediately so we never double-claim under SKIP LOCKED
    // *and* never burn duplicate gauge resets.
    const ran = await withSessionLock(LOCK_KEYS.PRESSURE_DRAIN, "PRESSURE_DRAIN", async () => {
      await pollDeferredQueueInner();
      return true;
    });
    if (ran === null) return;
  } catch (err: any) {
    logger.error(`[PRESSURE_GUARD_WORKER] poll error: ${err?.message || err}`);
  } finally {
    isPolling = false;
  }
}

async function pollDeferredQueueInner() {
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
    logger.error(`[PRESSURE_GUARD_WORKER] poll inner error: ${err?.message || err}`);
  }
}

/**
 * Task #145 R3: refresh `critsend_pressure_deferred_index_size_bytes`
 * and, when bloat exceeds `PRESSURE_REINDEX_BLOAT_BYTES` (default 256 MB),
 * run REINDEX CONCURRENTLY on the partial deferred index. Both read and
 * REINDEX are guarded by a session-level advisory lock so multi-replica
 * deployments only ever issue the REINDEX from one node.
 */
async function runMaintenanceTick() {
  if (getPressureGuardBootstrapState() !== "ready") return;
  await withSessionLock(LOCK_KEYS.PRESSURE_MAINTENANCE, "PRESSURE_MAINTENANCE", async () => {
    try {
      const r = await pool.query<{ size_bytes: string | null }>(
        `SELECT pg_relation_size('campaign_sends_pressure_deferred_idx')::bigint AS size_bytes`,
      );
      const sizeBytes = Number(r.rows[0]?.size_bytes ?? 0);
      pressureGuardDeferredIndexSizeBytes.set(sizeBytes);

      // Heavy ops (VACUUM/REINDEX) only run once per day during the
      // configured off-peak hour, and only when bloat actually warrants it.
      const now = new Date();
      const today = now.toISOString().slice(0, 10);
      const inOffPeakWindow = now.getHours() === MAINTENANCE_OFFPEAK_HOUR;
      const alreadyRanToday = lastHeavyMaintenanceDay === today;
      if (inOffPeakWindow && !alreadyRanToday) {
        lastHeavyMaintenanceDay = today;
        const bloatThreshold = Number(process.env.PRESSURE_REINDEX_BLOAT_BYTES ?? 256 * 1024 * 1024);
        if (sizeBytes >= bloatThreshold) {
          logger.warn(
            `[PRESSURE_MAINTENANCE] off-peak: deferred index size ${sizeBytes}B >= threshold ${bloatThreshold}B — running REINDEX CONCURRENTLY`,
          );
          try {
            await pool.query(`REINDEX INDEX CONCURRENTLY campaign_sends_pressure_deferred_idx`);
            logger.info(`[PRESSURE_MAINTENANCE] REINDEX CONCURRENTLY completed`);
          } catch (err: any) {
            logger.warn(`[PRESSURE_MAINTENANCE] REINDEX failed (non-fatal): ${err?.message || err}`);
          }
        }
        // Daily VACUUM (ANALYZE) keeps planner stats fresh so the partial
        // indexes added in R6/R7/R8 stay selective. VACUUM (no FULL) is
        // online and never blocks readers/writers.
        try {
          await pool.query(`VACUUM (ANALYZE) campaign_sends`);
          logger.info(`[PRESSURE_MAINTENANCE] off-peak VACUUM (ANALYZE) campaign_sends completed`);
        } catch (err: any) {
          logger.warn(`[PRESSURE_MAINTENANCE] VACUUM (ANALYZE) failed (non-fatal): ${err?.message || err}`);
        }
      }
    } catch (err: any) {
      // pg_relation_size throws if the relation doesn't exist — boot race,
      // index still building. Treat as a soft no-op.
      logger.warn(`[PRESSURE_MAINTENANCE] tick failed (non-fatal): ${err?.message || err}`);
    }
  });
}

/**
 * Task #145 R15: enforce a 12-month TTL on pressure_flush_audit so the
 * table doesn't grow unbounded for long-lived deployments. Runs daily,
 * leader-elected.
 */
async function runAuditTtlTick() {
  if (getPressureGuardBootstrapState() !== "ready") return;
  await withSessionLock(LOCK_KEYS.PRESSURE_AUDIT_TTL, "PRESSURE_AUDIT_TTL", async () => {
    try {
      const r = await pool.query(
        `DELETE FROM pressure_flush_audit
         WHERE created_at < NOW() - ($1::int || ' days')::interval`,
        [AUDIT_RETENTION_DAYS],
      );
      if ((r.rowCount ?? 0) > 0) {
        logger.info(`[PRESSURE_AUDIT_TTL] Deleted ${r.rowCount} pressure_flush_audit row(s) older than ${AUDIT_RETENTION_DAYS} days`);
      }
    } catch (err: any) {
      logger.warn(`[PRESSURE_AUDIT_TTL] tick failed (non-fatal): ${err?.message || err}`);
    }
  });
}

// Exported for tests: drives a single drain wave for `campaignId`. Tests
// can call this directly to assert FIFO cascade and unsubscribe-during-
// window behavior without spinning up the full poll interval.
export async function drainCampaign(campaignId: string): Promise<void> {
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
  // R4: increment deferred_count by the number of rows ACTUALLY mutated
  // (RETURNING) — never by losers.length — so re-runs of a partially-applied
  // batch (transient DB errors, retries) don't double-count.
  if (losers.length > 0) {
    await db.transaction(async (tx) => {
      const upd = await tx.execute(sql`
        UPDATE campaign_sends cs
        SET status = 'pending',
            eligible_at = COALESCE(s.last_sent_at, NOW()) + (${PRESSURE_WINDOW_HOURS}::numeric || ' hours')::interval
        FROM subscribers s
        WHERE cs.campaign_id = ${campaignId}
          AND cs.subscriber_id = ANY(${losers}::text[])
          AND s.id = cs.subscriber_id
          AND cs.status = 'attempting'
        RETURNING cs.subscriber_id
      `);
      const mutated = upd.rows.length;
      if (mutated > 0) {
        await tx.execute(sql`
          UPDATE campaigns SET deferred_count = deferred_count + ${mutated} WHERE id = ${campaignId}
        `);
      }
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

  // Post-drain completion check (Task #144): the campaign-sender held the
  // status at 'sending' while deferred rows were outstanding. Once the
  // pressure-guard worker drains the last deferred row, flip the campaign
  // to 'completed' here so downstream workflows (follow-up scheduling,
  // dashboards, jobEvents listeners) advance correctly.
  try {
    const remaining = await db.execute(sql`
      SELECT COUNT(*)::int AS n FROM campaign_sends
      WHERE campaign_id = ${campaignId}
        AND status IN ('pending', 'attempting')
    `);
    const n = Number((remaining.rows[0] as { n?: number } | undefined)?.n ?? 0);
    if (n === 0) {
      const flipped = await storage.updateCampaignStatusAtomic(campaignId, "completed", "sending");
      if (flipped) {
        await storage.updateCampaign(campaignId, { completedAt: new Date(), pendingCount: 0 });
        logger.info(`[PRESSURE_GUARD_WORKER] Campaign ${campaignId} marked completed (deferred queue drained)`);
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`[PRESSURE_GUARD_WORKER] post-drain completion check failed for ${campaignId}: ${msg}`);
  }
}
