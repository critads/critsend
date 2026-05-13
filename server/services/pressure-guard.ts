/**
 * Marketing Pressure Guard — Task #144
 *
 * Enforces a hard 6h gap between any two emails to the same contact across
 * ALL campaigns. Implementation contract:
 *
 *   1. Atomic CAS (`pressureGuardReserveSendSlots`):
 *      Single SQL statement that updates `subscribers.last_sent_at = NOW()`
 *      for every `id` in the batch *iff* the contact is currently eligible
 *      (`last_sent_at IS NULL OR last_sent_at + 6h <= NOW()`). Returns the
 *      winners. Losers are written into `campaign_sends` with
 *      `status='pending'` and `eligible_at = last_sent_at + 6h` so the
 *      deferred-drain worker can retry them later. Cumulative
 *      `campaigns.deferred_count` is bumped per defer event.
 *
 *   2. Bootstrap (`runPressureGuardBootstrap`):
 *      Adds the new columns + audit table + indexes under an advisory lock.
 *      Idempotent: every statement is `IF NOT EXISTS`. Indexes use
 *      `CREATE INDEX CONCURRENTLY` so we never block live sends.
 *
 *   3. Window override (`PRESSURE_WINDOW_HOURS` env, default 6):
 *      Used ONLY for the nullsink concurrency test (set to 0 / very large)
 *      and ops drills. Production code paths must always use the default.
 */

import { pool, db } from "../db";
import { sql } from "drizzle-orm";
import { logger } from "../logger";
import { withAdvisoryLock, LOCK_KEYS, indexExistsAndValid } from "../bootstrap-lock";
import { pressureGuardDeferredTotal } from "../metrics";

export const PRESSURE_WINDOW_HOURS = (() => {
  const raw = process.env.PRESSURE_WINDOW_HOURS;
  if (!raw) return 6;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return 6;
  return parsed;
})();

let bootstrapState: "pending" | "ready" | "deferred" = "pending";
export function getPressureGuardBootstrapState() {
  return bootstrapState;
}

export async function runPressureGuardBootstrap(): Promise<"ready" | "deferred"> {
  let outcome: "ready" | "deferred" = "ready";
  const result = await withAdvisoryLock(
    LOCK_KEYS.PRESSURE_GUARD,
    "PRESSURE_GUARD",
    async (client) => {
      try {
        await client.query(`ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS last_sent_at timestamp`);
        await client.query(`ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS deferred_count integer NOT NULL DEFAULT 0`);
        await client.query(`ALTER TABLE campaign_sends ADD COLUMN IF NOT EXISTS eligible_at timestamp`);
        await client.query(`
          CREATE TABLE IF NOT EXISTS pressure_flush_audit (
            id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
            campaign_id varchar,
            user_id varchar,
            scope text NOT NULL,
            count integer NOT NULL DEFAULT 0,
            reason text NOT NULL DEFAULT '',
            created_at timestamp NOT NULL DEFAULT NOW()
          )
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS pressure_flush_audit_campaign_idx ON pressure_flush_audit(campaign_id)`);
        await client.query(`CREATE INDEX IF NOT EXISTS pressure_flush_audit_created_idx ON pressure_flush_audit(created_at)`);

        // Partial index for the deferred-drain poll. CONCURRENTLY can't run
        // inside the lock client (which is in an implicit txn after errors).
        // We close the txn first via a no-op COMMIT; pg_try_advisory_lock is
        // session-level so the lock is preserved.
      } catch (err: any) {
        logger.error(`[PRESSURE_GUARD] DDL failed: ${err?.message || err}`);
        bootstrapState = "deferred";
        outcome = "deferred";
        return;
      }
    },
  );

  // Build the partial index outside the advisory lock client (CREATE INDEX
  // CONCURRENTLY can't run in a transaction block).
  if (result === "ran" || result === "skipped") {
    try {
      const exists = await indexExistsAndValid("campaign_sends_pressure_deferred_idx");
      if (!exists) {
        await pool.query(`
          CREATE INDEX CONCURRENTLY IF NOT EXISTS campaign_sends_pressure_deferred_idx
          ON campaign_sends (eligible_at)
          WHERE status = 'pending' AND eligible_at IS NOT NULL
        `);
        logger.info("[PRESSURE_GUARD] Created partial index campaign_sends_pressure_deferred_idx");
      }
    } catch (err: any) {
      logger.warn(`[PRESSURE_GUARD] CONCURRENTLY index build failed (non-fatal): ${err?.message || err}`);
    }
  }

  if (outcome === "ready") {
    bootstrapState = "ready";
    logger.info(`[PRESSURE_GUARD] Bootstrap ready (window=${PRESSURE_WINDOW_HOURS}h)`);
  }
  return outcome;
}

/**
 * Atomic reserve. Returns the subscriber IDs that won the CAS race AND have
 * been inserted into campaign_sends with status='pending', eligible_at=NULL.
 * Losers are inserted with status='pending' AND eligible_at=last_sent_at+6h
 * for the deferred-drain worker to pick up. Already-existing campaign_sends
 * rows (re-run, retry pass) are returned as winners only when they are
 * currently in 'pending' or 'attempting' status — we do NOT defer them.
 */
export async function pressureGuardReserveSendSlots(
  campaignId: string,
  subscriberIds: string[],
  windowHours: number = PRESSURE_WINDOW_HOURS,
): Promise<string[]> {
  if (subscriberIds.length === 0) return [];

  const CHUNK_SIZE = 1000;
  const winners: string[] = [];
  let totalDeferred = 0;

  for (let i = 0; i < subscriberIds.length; i += CHUNK_SIZE) {
    const chunk = subscriberIds.slice(i, i + CHUNK_SIZE);

    const result = await db.execute(sql`
      WITH input(id) AS (
        SELECT unnest(${chunk}::text[])
      ),
      cas AS (
        UPDATE subscribers s
        SET last_sent_at = NOW()
        FROM input i
        WHERE s.id = i.id
          AND (s.last_sent_at IS NULL OR s.last_sent_at + (${windowHours}::numeric || ' hours')::interval <= NOW())
        RETURNING s.id
      ),
      reserved AS (
        INSERT INTO campaign_sends (id, campaign_id, subscriber_id, status, sent_at, eligible_at)
        SELECT gen_random_uuid(), ${campaignId}, cas.id, 'pending', NOW(), NULL
        FROM cas
        ON CONFLICT (campaign_id, subscriber_id) DO NOTHING
        RETURNING subscriber_id
      ),
      losers AS (
        SELECT s.id, s.last_sent_at
        FROM subscribers s
        JOIN input i ON i.id = s.id
        WHERE s.id NOT IN (SELECT id FROM cas)
      ),
      deferred_ins AS (
        INSERT INTO campaign_sends (id, campaign_id, subscriber_id, status, sent_at, eligible_at)
        SELECT
          gen_random_uuid(),
          ${campaignId},
          l.id,
          'pending',
          NOW(),
          COALESCE(l.last_sent_at, NOW()) + (${windowHours}::numeric || ' hours')::interval
        FROM losers l
        ON CONFLICT (campaign_id, subscriber_id) DO NOTHING
        RETURNING subscriber_id
      ),
      defer_count AS (
        SELECT COUNT(*)::int AS n FROM deferred_ins
      )
      SELECT
        (SELECT array_agg(subscriber_id) FROM reserved) AS winners,
        (SELECT n FROM defer_count) AS deferred_n
    `);

    const row = result.rows[0] as any;
    const winChunk: string[] = Array.isArray(row?.winners) ? row.winners : [];
    const deferredN = Number(row?.deferred_n ?? 0);

    if (winChunk.length) winners.push(...winChunk);
    if (deferredN > 0) {
      totalDeferred += deferredN;
      // `campaigns.pending_count` is initialized to the full audience size
      // by the campaign-sender BEFORE the first CAS batch (see
      // server/services/campaign-sender.ts updateCampaign({ pendingCount: total })).
      // Deferred rows therefore already live inside `pending_count` — we MUST NOT
      // re-increment it here or progress bars and "campaign complete" detection
      // will overflow. Only the cumulative audit counter `deferred_count` and
      // the Prometheus gauge are bumped per defer event.
      await db.execute(sql`
        UPDATE campaigns
        SET deferred_count = deferred_count + ${deferredN}
        WHERE id = ${campaignId}
      `);
      try { pressureGuardDeferredTotal.inc({ campaign_id: campaignId }, deferredN); } catch {}
    }
  }

  if (totalDeferred > 0) {
    logger.info(`[PRESSURE_GUARD] Campaign ${campaignId}: reserved ${winners.length}, deferred ${totalDeferred}`);
  }
  return winners;
}

/**
 * Force-fail a set of deferred (status='pending', eligible_at IS NOT NULL)
 * sends. Used by the /campaigns/:id/queue/flush endpoint and the
 * /admin/pressure-queue bulk flush. Returns the number of rows actually
 * transitioned to 'failed'. Counter mutations (failed_count++,
 * pending_count--) are folded into the same UPDATE for atomicity.
 */
export async function flushDeferredSends(opts: {
  campaignId?: string;
  subscriberIds?: string[];
  scope: "selected" | "campaign-all" | "global-all";
  reason: string;
  userId?: string | null;
}): Promise<number> {
  const { campaignId, subscriberIds, scope, reason, userId } = opts;

  let conditions = sql`status = 'pending' AND eligible_at IS NOT NULL`;
  if (campaignId) conditions = sql`${conditions} AND campaign_id = ${campaignId}`;
  if (subscriberIds && subscriberIds.length > 0) {
    conditions = sql`${conditions} AND subscriber_id = ANY(${subscriberIds}::text[])`;
  } else if (scope === "selected") {
    return 0; // No selection → nothing to do
  }

  // Per-campaign counter rollups must run in the same txn so totals stay
  // consistent. We capture the affected campaigns from the UPDATE result and
  // then issue one counter bump per campaign.
  let totalFailed = 0;
  await db.transaction(async (tx) => {
    const updated = await tx.execute(sql`
      UPDATE campaign_sends
      SET status = 'failed',
          eligible_at = NULL
      WHERE ${conditions}
      RETURNING campaign_id
    `);
    totalFailed = updated.rows.length;
    if (totalFailed === 0) return;

    const perCampaign = new Map<string, number>();
    for (const r of updated.rows) {
      const cid = (r as any).campaign_id as string;
      perCampaign.set(cid, (perCampaign.get(cid) ?? 0) + 1);
    }
    for (const [cid, n] of perCampaign) {
      await tx.execute(sql`
        UPDATE campaigns
        SET failed_count = failed_count + ${n},
            pending_count = GREATEST(pending_count - ${n}, 0)
        WHERE id = ${cid}
      `);
    }

    await tx.execute(sql`
      INSERT INTO pressure_flush_audit (campaign_id, user_id, scope, count, reason)
      VALUES (${campaignId ?? null}, ${userId ?? null}, ${scope}, ${totalFailed}, ${reason ?? ""})
    `);
  });

  logger.info(`[PRESSURE_GUARD] Flushed ${totalFailed} deferred send(s) (scope=${scope}, campaign=${campaignId ?? "ALL"})`);
  return totalFailed;
}
