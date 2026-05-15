/**
 * Marketing Pressure Guard routes (Task #144).
 *
 *   GET  /api/campaigns/:id/queue
 *        Returns counters + a paginated slice of campaign_sends rows for
 *        the given campaign, with optional ?status filter and ?bucket=true
 *        to also receive an histogram of eligible_at by hour.
 *
 *   POST /api/campaigns/:id/queue/flush
 *        Force-fail deferred sends. Body:
 *          { scope: "selected" | "all", subscriberIds?: string[], reason: string }
 *
 *   GET  /api/admin/pressure-queue
 *        Cross-campaign view of currently-pending deferred sends, grouped
 *        by campaign, ordered by next eligible_at.
 *
 *   GET  /api/subscribers/:id/pressure
 *        Returns { lastSentAt, nextEligibleAt, hoursUntilEligible } for
 *        the inspected contact.
 *
 *   POST /api/admin/pressure-queue/flush
 *        Bulk-flush deferred sends across the whole platform.
 *
 * All endpoints require an authenticated session (req.session.userId).
 */

import type { Express, Request, Response } from "express";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db, pool } from "../db";
import { LOCK_KEYS } from "../bootstrap-lock";
import { logger } from "../logger";
import {
  PRESSURE_WINDOW_HOURS,
  flushDeferredSends,
} from "../services/pressure-guard";

// Task #145 R11: discriminated union for the per-campaign flush body.
// Discriminator is the `kind` field on each shape (mapped from the
// presence of `campaignSendIds` vs. `scope` in the raw body via a
// pre-transform). Three valid shapes:
//   { kind: "all" }          — flush every deferred row on the campaign
//   { kind: "selected", campaignSendIds: string[] }
//   { kind: "legacy",  scope, subscriberIds? }   (deprecated)
const flushReason = z.string().trim().min(3, "reason (>=3 chars) is required");
const flushAllShape = z.object({
  kind: z.literal("all"),
  reason: flushReason,
});
const flushSelectedShape = z.object({
  kind: z.literal("selected"),
  campaignSendIds: z.array(z.string().min(1)).min(1),
  reason: flushReason,
});
const flushLegacyShape = z.object({
  kind: z.literal("legacy"),
  scope: z.enum(["selected", "all", "campaign-all"]),
  subscriberIds: z.array(z.string().min(1)).optional(),
  reason: flushReason,
});
const campaignFlushBodySchema = z.preprocess(
  (raw) => {
    const v = (raw ?? {}) as Record<string, unknown>;
    if (v.campaignSendIds === "all") return { kind: "all", reason: v.reason };
    if (Array.isArray(v.campaignSendIds)) return { kind: "selected", campaignSendIds: v.campaignSendIds, reason: v.reason };
    if (typeof v.scope === "string") return { kind: "legacy", scope: v.scope, subscriberIds: v.subscriberIds, reason: v.reason };
    return v;
  },
  z.discriminatedUnion("kind", [flushAllShape, flushSelectedShape, flushLegacyShape]),
);
const adminFlushBodySchema = z.object({ reason: flushReason });

// Tiny in-memory TTL cache for the admin /curve and /top-contacts
// endpoints (R6/R7/R8 mitigation): both queries scan large slices of
// campaign_sends and are polled by the dashboard every 30-60s. Caching
// for 30s (top) and 5min (curve) shields the DB from refresh storms.
type CacheEntry<T> = { value: T; expiresAt: number };
const cache = new Map<string, CacheEntry<any>>();
function cacheGet<T>(key: string): T | null {
  const e = cache.get(key);
  if (!e) return null;
  if (e.expiresAt <= Date.now()) { cache.delete(key); return null; }
  return e.value as T;
}
function cacheSet<T>(key: string, value: T, ttlMs: number): T {
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
  return value;
}

function requireAuth(req: Request, res: Response): boolean {
  if (!req.session?.userId) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

/**
 * Per-campaign ownership guard. Confirms the authenticated user owns the
 * campaign before exposing/allowing mutation of its pressure queue. Without
 * this check, any authenticated user could read or flush another tenant's
 * deferred queue (IDOR). Admins (per ADMIN_USER_IDS) bypass the check so
 * support can intervene cross-tenant.
 */
async function requireCampaignOwnership(req: Request, res: Response, campaignId: string): Promise<boolean> {
  if (!requireAuth(req, res)) return false;
  const uid = req.session.userId as string;
  if (await isAdminUser(uid)) return true;
  try {
    const r = await db.execute(sql<{ user_id: string | null }>`SELECT user_id FROM campaigns WHERE id = ${campaignId}`);
    if (r.rows.length === 0) {
      res.status(404).json({ error: "Campaign not found" });
      return false;
    }
    const ownerRow = r.rows[0] as { user_id: string | null };
    const ownerId = ownerRow.user_id;
    if (ownerId && ownerId !== uid) {
      res.status(403).json({ error: "Forbidden" });
      return false;
    }
    return true;
  } catch (err: any) {
    logger.error(`[PRESSURE_QUEUE] ownership check failed for ${campaignId}: ${err?.message || err}`);
    res.status(500).json({ error: "Internal error" });
    return false;
  }
}

/**
 * Admin-scope guard (Task #145 R13).
 *
 * Resolution order:
 *   1. `users.is_admin = true` for the authenticated user (DB column,
 *      managed by ops; survives env-var loss).
 *   2. Env-var fallback: `ADMIN_USER_IDS` (comma-separated user IDs).
 *      Kept for first-deployment ergonomics so a fresh DB without any
 *      `is_admin=true` row can still seed the first admin via env.
 *   3. Non-production NODE_ENV with NEITHER configured: treat the
 *      session as admin so dev/test workflows aren't blocked.
 *   4. Production with NEITHER configured: fail closed and log loudly.
 */
async function isAdminUser(uid: string): Promise<boolean> {
  // (1) DB-backed admin column is the source of truth.
  let dbAdminExists = false;
  let dbErrorIsMissingColumn = false;
  let dbHadRuntimeError = false;
  try {
    const me = await db.execute(sql<{ is_admin: boolean | null }>`SELECT is_admin FROM users WHERE id = ${uid}`);
    const row = me.rows[0] as { is_admin: boolean | null } | undefined;
    if (row && row.is_admin === true) return true;
    // Detect whether ANY admin row exists; this gates the env-var fallback
    // so ADMIN_USER_IDS is strictly bootstrap-only.
    const any = await db.execute(sql`SELECT 1 FROM users WHERE is_admin = true LIMIT 1`);
    dbAdminExists = any.rows.length > 0;
  } catch (err: any) {
    // Postgres "undefined_column" (42703) — schema bootstrap hasn't yet
    // added users.is_admin. Tolerate that one specific case so first-boot
    // env fallback still works. ANY other DB error is treated as a
    // runtime failure: in production we MUST fail closed (do not let a
    // stale env allowlist silently bypass DB-first authz when the DB is
    // flapping).
    const code = err?.code ?? err?.cause?.code;
    if (code === "42703") dbErrorIsMissingColumn = true;
    else dbHadRuntimeError = true;
    if (dbHadRuntimeError && process.env.NODE_ENV === "production") {
      logger.warn(`[ADMIN_GATE] DB error during admin check (${err?.message || err}) — failing closed`);
      return false;
    }
  }
  // (2) env-var fallback ONLY while no DB admin exists yet (bootstrap),
  // OR while the schema column is genuinely missing on first-boot.
  if (!dbAdminExists || dbErrorIsMissingColumn) {
    const allowlist = (process.env.ADMIN_USER_IDS ?? "")
      .split(",").map((s) => s.trim()).filter(Boolean);
    if (allowlist.includes(uid)) return true;
    // (3) dev/test ergonomics: no env, no DB row, not production → admin.
    if (allowlist.length === 0 && process.env.NODE_ENV !== "production") return true;
  }
  return false;
}

function requireAdmin(req: Request, res: Response): Promise<boolean> {
  return (async () => {
    if (!requireAuth(req, res)) return false;
    const uid = req.session.userId as string;
    if (await isAdminUser(uid)) return true;
    // Only emit the "no admin configured" misconfiguration log when the
    // installation truly has no admin path: empty env allowlist AND no
    // users.is_admin=true row in the DB. Otherwise this is just a
    // routine 403 from a non-admin caller and should not pollute logs.
    const allowlist = (process.env.ADMIN_USER_IDS ?? "")
      .split(",").map((s) => s.trim()).filter(Boolean);
    if (allowlist.length === 0 && process.env.NODE_ENV === "production") {
      try {
        const any = await db.execute(sql`SELECT 1 FROM users WHERE is_admin = true LIMIT 1`);
        if (any.rows.length === 0) {
          logger.error("[PRESSURE_QUEUE] No admin configured (ADMIN_USER_IDS unset, no users.is_admin=true) in production — blocking admin access");
          res.status(403).json({ error: "Admin access disabled (set ADMIN_USER_IDS or grant users.is_admin)" });
          return false;
        }
      } catch {
        // DB hiccup — fall through to the generic 403 below.
      }
    }
    res.status(403).json({ error: "Forbidden: admin role required" });
    return false;
  })();
}

export function registerPressureRoutes(app: Express): void {
  // ── Drain healthcheck (Task #160) ───────────────────────────────────
  // GET /api/admin/pressure-drain/health
  // Reports cross-process drain liveness by reading the leader-lease row
  // (pressure_guard_leader). Works whether the drain runs embedded in
  // web/worker OR in the dedicated `critsend-drainer` PM2 process — the
  // lease row is the single source of truth and the drain heartbeats
  // into it on every tick (see server/workers/pressure-guard-worker.ts).
  //
  // healthy=true requires:
  //   • a fresh leader lease (expires_at > NOW())
  //   • a recent heartbeat (last_tick_at < drainHealthMaxAgeSeconds ago)
  //
  // Operators alert on healthy=false; a sustained false means the drain
  // process is dead or stuck and the deferred queue will grow unbounded.
  app.get("/api/admin/pressure-drain/health", async (req: Request, res: Response) => {
    if (!(await requireAdmin(req, res))) return;
    const maxAgeSeconds = Math.max(
      10,
      Math.min(3600, parseInt((req.query.maxAge as string) ?? "60", 10) || 60),
    );
    try {
      const lockKey = `pressure_guard:${LOCK_KEYS.PRESSURE_DRAIN}`;
      const r = await pool.query<{
        holder_id: string | null;
        expires_at: Date | null;
        last_tick_at: Date | null;
        last_tick_drained: number | null;
        last_tick_errors: number | null;
        last_tick_eligible: number | null;
        now: Date;
      }>(
        `SELECT l.holder_id, l.expires_at, l.last_tick_at,
                l.last_tick_drained, l.last_tick_errors, l.last_tick_eligible,
                NOW() AS now
         FROM pressure_guard_leader l
         WHERE l.lock_key = $1`,
        [lockKey],
      );
      const row = r.rows[0];
      const nowMs = (row?.now ?? new Date()).getTime();
      const expiresAtMs = row?.expires_at ? new Date(row.expires_at).getTime() : null;
      const lastTickAtMs = row?.last_tick_at ? new Date(row.last_tick_at).getTime() : null;
      const leaseAlive = expiresAtMs != null && expiresAtMs > nowMs;
      const lastTickAgeS = lastTickAtMs != null ? Math.max(0, (nowMs - lastTickAtMs) / 1000) : null;
      const leaseExpiresInS = expiresAtMs != null ? (expiresAtMs - nowMs) / 1000 : null;
      const tickFresh = lastTickAgeS != null && lastTickAgeS < maxAgeSeconds;

      // Cross-cutting deferred backlog snapshot (one cheap aggregate).
      const backlog = await pool.query<{
        deferred_pending: string;
        deferred_due: string;
        sends_5m: string;
      }>(
        `SELECT
           (SELECT COUNT(*)::text FROM campaign_sends
              WHERE status='pending' AND eligible_at IS NOT NULL) AS deferred_pending,
           (SELECT COUNT(*)::text FROM campaign_sends
              WHERE status='pending' AND eligible_at IS NOT NULL AND eligible_at <= NOW()) AS deferred_due,
           (SELECT COUNT(*)::text FROM campaign_sends
              WHERE status='sent' AND sent_at > NOW() - INTERVAL '5 min') AS sends_5m`,
      );
      const b = backlog.rows[0];

      const healthy = leaseAlive && tickFresh;
      res.json({
        healthy,
        last_tick_age_s: lastTickAgeS,
        last_tick_at: row?.last_tick_at ?? null,
        leader_holder_id: row?.holder_id ?? null,
        leader_expires_in_s: leaseExpiresInS,
        last_tick_drained: row?.last_tick_drained ?? 0,
        last_tick_errors: row?.last_tick_errors ?? 0,
        last_tick_eligible: row?.last_tick_eligible ?? 0,
        deferred_pending_total: Number(b?.deferred_pending ?? 0),
        deferred_due_total: Number(b?.deferred_due ?? 0),
        sends_5m: Number(b?.sends_5m ?? 0),
        max_age_seconds: maxAgeSeconds,
        reasons: {
          lease_alive: leaseAlive,
          tick_fresh: tickFresh,
          has_lease_row: !!row,
        },
      });
    } catch (err: any) {
      logger.error(`[PRESSURE_DRAIN_HEALTH] query failed: ${err?.message || err}`);
      res.status(500).json({ healthy: false, error: String(err?.message || err) });
    }
  });

  // ── Per-campaign queue view ─────────────────────────────────────────
  app.get("/api/campaigns/:id/queue", async (req: Request, res: Response) => {
    const campaignId = req.params.id;
    if (!(await requireCampaignOwnership(req, res, campaignId))) return;
    const page = Math.max(1, parseInt((req.query.page as string) ?? "1", 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt((req.query.limit as string) ?? "50", 10) || 50));
    const offset = (page - 1) * limit;
    const status = (req.query.status as string) ?? "deferred"; // deferred|sent|failed|pending|all

    try {
      const counts = await db.execute(sql`
        SELECT
          COUNT(*) FILTER (WHERE status = 'sent') AS sent,
          COUNT(*) FILTER (WHERE status = 'failed') AS failed,
          COUNT(*) FILTER (WHERE status = 'pending' AND eligible_at IS NOT NULL) AS deferred,
          COUNT(*) FILTER (WHERE status = 'pending' AND eligible_at IS NOT NULL AND eligible_at <= NOW()) AS deferred_due,
          COUNT(*) FILTER (WHERE status = 'pending' AND eligible_at IS NULL) AS pending,
          COUNT(*) FILTER (WHERE status = 'attempting') AS attempting
        FROM campaign_sends WHERE campaign_id = ${campaignId}
      `);

      const campaignRow = await db.execute(sql`
        SELECT id, name, deferred_count, sent_count, pending_count, failed_count, started_at, status
        FROM campaigns WHERE id = ${campaignId}
      `);
      if (campaignRow.rows.length === 0) {
        return res.status(404).json({ error: "Campaign not found" });
      }

      let whereStatus = sql`TRUE`;
      if (status === "deferred") whereStatus = sql`cs.status = 'pending' AND cs.eligible_at IS NOT NULL`;
      else if (status === "pending") whereStatus = sql`cs.status = 'pending' AND cs.eligible_at IS NULL`;
      else if (status !== "all") whereStatus = sql`cs.status = ${status}`;

      // Per-row "blocked_by_campaign": for each deferred row, the campaign
      // currently holding the slot is the campaign whose campaign_send for
      // the same subscriber has the most recent sent_at AND eligible_at IS NULL
      // (the immediate winner). LEFT JOIN keeps non-deferred rows working.
      const rows = await db.execute(sql`
        SELECT
          cs.id, cs.subscriber_id, s.email, cs.status, cs.sent_at, cs.eligible_at, s.last_sent_at,
          blocker.campaign_id AS blocked_by_campaign_id,
          bc.name AS blocked_by_campaign_name
        FROM campaign_sends cs
        LEFT JOIN subscribers s ON s.id = cs.subscriber_id
        LEFT JOIN LATERAL (
          SELECT cs2.campaign_id
          FROM campaign_sends cs2
          WHERE cs2.subscriber_id = cs.subscriber_id
            AND cs2.eligible_at IS NULL
            AND cs2.campaign_id <> cs.campaign_id
            AND cs2.status IN ('sent','attempting','pending')
          ORDER BY cs2.sent_at DESC
          LIMIT 1
        ) blocker ON cs.eligible_at IS NOT NULL
        LEFT JOIN campaigns bc ON bc.id = blocker.campaign_id
        WHERE cs.campaign_id = ${campaignId} AND ${whereStatus}
        ORDER BY cs.eligible_at ASC NULLS LAST, cs.sent_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `);

      // Optional histogram of upcoming deferred load, bucketed by hour.
      // Triggered with ?bucket=true. We bucket the next 72h of deferred
      // eligible_at; anything older than NOW() is folded into the "0h" bin
      // (= overdue / drainable on next worker tick).
      let bucket: any[] | undefined;
      if (req.query.bucket === "true" || req.query.bucket === "1") {
        const b = await db.execute(sql`
          SELECT
            date_trunc('hour', GREATEST(eligible_at, NOW())) AS bucket_at,
            COUNT(*) AS n
          FROM campaign_sends
          WHERE campaign_id = ${campaignId}
            AND status = 'pending'
            AND eligible_at IS NOT NULL
            AND eligible_at < NOW() + interval '72 hours'
          GROUP BY 1
          ORDER BY 1 ASC
          LIMIT 96
        `);
        bucket = b.rows as any[];
      }

      res.json({
        campaign: campaignRow.rows[0],
        windowHours: PRESSURE_WINDOW_HOURS,
        counts: counts.rows[0],
        page,
        limit,
        rows: rows.rows,
        bucket,
      });
    } catch (err: any) {
      logger.error(`[PRESSURE_QUEUE] GET /campaigns/${campaignId}/queue failed: ${err?.message || err}`);
      res.status(500).json({ error: err?.message || "Internal error" });
    }
  });

  // ── Per-campaign flush ──────────────────────────────────────────────
  app.post("/api/campaigns/:id/queue/flush", async (req: Request, res: Response) => {
    const campaignId = req.params.id;
    if (!(await requireCampaignOwnership(req, res, campaignId))) return;

    // R11: validate the body up-front through the discriminated union;
    // fall back to the legacy unwrapped path if neither variant matches.
    const parsed = campaignFlushBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        error: "Invalid flush body",
        details: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      });
    }
    const body = parsed.data;
    const reason = body.reason;
    const userId = req.session.userId ?? null;

    try {
      let count = 0;
      if (body.kind === "all") {
        count = await flushDeferredSends({
          campaignId, campaignSendIds: "all", scope: "campaign-all", reason, userId,
        });
      } else if (body.kind === "selected") {
        count = await flushDeferredSends({
          campaignId, campaignSendIds: body.campaignSendIds, scope: "selected", reason, userId,
        });
      } else {
        // R11: legacy {scope, subscriberIds} still works but is deprecated;
        // emit a one-line warning so callers can migrate to the new shape.
        logger.warn(
          `[PRESSURE_QUEUE] DEPRECATED legacy flush body shape ({scope, subscriberIds}) used by user=${userId} campaign=${campaignId}; migrate to {campaignSendIds, reason} — sunset 2026-12-31`,
        );
        if (body.scope === "all" || body.scope === "campaign-all") {
          count = await flushDeferredSends({
            campaignId, campaignSendIds: "all", scope: "campaign-all", reason, userId,
          });
        } else {
          if (!body.subscriberIds || body.subscriberIds.length === 0) {
            return res.status(400).json({ error: "scope='selected' requires non-empty subscriberIds" });
          }
          count = await flushDeferredSends({
            campaignId, subscriberIds: body.subscriberIds, scope: "selected", reason, userId,
          });
        }
      }
      res.json({ ok: true, reprogrammed: count, flushed: count });
    } catch (err: any) {
      logger.error(`[PRESSURE_QUEUE] flush(${campaignId}) failed: ${err?.message || err}`);
      res.status(500).json({ error: err?.message || "Internal error" });
    }
  });

  // ── Cross-campaign admin view ───────────────────────────────────────
  // Task #155: 30s in-memory cache. The two queries underneath
  // (per-campaign GROUP BY + cluster-wide DISTINCT subscriber_id) scan
  // the entire deferred backlog, which can reach hundreds of thousands of
  // rows during pressure events. The dashboard polls every 15s, so
  // without caching we ran two heavy aggregations every 15s per open
  // session — directly competing with the drain worker for the main
  // pool's slots. With a 30s TTL the page still feels live but the DB
  // sees at most one execution per 30s regardless of how many operators
  // have the page open. Cache returns immediately under refresh storms
  // (the typical case during an active incident).
  app.get("/api/admin/pressure-queue", async (req: Request, res: Response) => {
    if (!(await requireAdmin(req, res))) return;
    const cached = cacheGet<any>("admin:queue");
    if (cached) return res.json(cached);
    try {
      const summary = await db.execute(sql`
        SELECT
          cs.campaign_id,
          c.name AS campaign_name,
          c.started_at,
          c.created_at,
          c.deferred_count AS lifetime_defers,
          COUNT(*) AS pending_deferred,
          COUNT(*) FILTER (WHERE cs.eligible_at <= NOW()) AS due_now,
          MIN(cs.eligible_at) AS next_eligible_at
        FROM campaign_sends cs
        JOIN campaigns c ON c.id = cs.campaign_id
        WHERE cs.status = 'pending' AND cs.eligible_at IS NOT NULL
        GROUP BY cs.campaign_id, c.name, c.started_at, c.created_at, c.deferred_count
        ORDER BY c.created_at ASC NULLS FIRST
        LIMIT 500
      `);

      const totals = await db.execute(sql`
        SELECT
          COUNT(*) AS pending_deferred,
          COUNT(DISTINCT subscriber_id) AS distinct_contacts_in_cooldown,
          COUNT(*) FILTER (WHERE eligible_at <= NOW()) AS due_now
        FROM campaign_sends WHERE status = 'pending' AND eligible_at IS NOT NULL
      `);

      const payload = {
        windowHours: PRESSURE_WINDOW_HOURS,
        totals: totals.rows[0],
        campaigns: summary.rows,
        generatedAt: new Date().toISOString(),
      };
      if (res.headersSent) return;
      res.json(cacheSet("admin:queue", payload, 30_000));
    } catch (err: any) {
      logger.error(`[PRESSURE_QUEUE] /admin/pressure-queue failed: ${err?.message || err}`);
      if (res.headersSent) return;
      res.status(500).json({ error: err?.message || "Internal error" });
    }
  });

  // ── Purge throughput (mails/min currently being sent) ───────────────
  // Task #155: minute-by-minute series of all completed sends over the
  // last 30 minutes. We do NOT filter on eligible_at because the drain
  // path resets eligible_at to NULL on success — so a filter would drop
  // drain output too. Reporting total sent rate (drain + bulk sender)
  // is what operators actually want during an incident: "is the system
  // sending or stuck?". Filtering by sent_at hits the existing
  // campaign_sends_sent_at_idx and stays cheap even on a 20M-row table.
  // 20s cache shields the DB from dashboard refresh storms.
  app.get("/api/admin/pressure-queue/throughput", async (req: Request, res: Response) => {
    if (!(await requireAdmin(req, res))) return;
    const cached = cacheGet<any>("admin:throughput");
    if (cached) return res.json(cached);
    try {
      const series = await db.execute(sql`
        SELECT date_trunc('minute', sent_at) AS minute, COUNT(*)::int AS sent
        FROM campaign_sends
        WHERE status = 'sent'
          AND sent_at >= NOW() - interval '30 minutes'
          AND sent_at IS NOT NULL
        GROUP BY 1
        ORDER BY 1 ASC
      `);
      // last-1min count is the headline KPI surfaced as the big stat.
      // Rolling 60-second window so the card reflects "what's happening
      // right now" — matches the rightmost bar of the chart instead of a
      // smoothed 5-min average that hides recent spikes/drops.
      const last1 = await db.execute(sql`
        SELECT COUNT(*)::int AS sent_1min
        FROM campaign_sends
        WHERE status = 'sent'
          AND sent_at >= NOW() - interval '1 minute'
          AND sent_at IS NOT NULL
      `);
      const sent1 = Number((last1.rows[0] as any)?.sent_1min ?? 0);
      const last5 = await db.execute(sql`
        SELECT COUNT(*)::int AS sent_5min
        FROM campaign_sends
        WHERE status = 'sent'
          AND sent_at >= NOW() - interval '5 minutes'
          AND sent_at IS NOT NULL
      `);
      const sent5 = Number((last5.rows[0] as any)?.sent_5min ?? 0);
      const payload = {
        currentMailsPerMin: sent1,
        sentLast1Min: sent1,
        sentLast5Min: sent5,
        series: series.rows.map((r: any) => ({
          minute: r.minute,
          sent: Number(r.sent ?? 0),
        })),
        generatedAt: new Date().toISOString(),
      };
      if (res.headersSent) return;
      res.json(cacheSet("admin:throughput", payload, 20_000));
    } catch (err: any) {
      logger.error(`[PRESSURE_QUEUE] /admin/pressure-queue/throughput failed: ${err?.message || err}`);
      if (res.headersSent) return;
      res.status(500).json({ error: err?.message || "Internal error" });
    }
  });

  // ── Cross-campaign 7-day deferred / flush curve ─────────────────────
  // Returns daily series of: (a) defer events approximated by sent_at on
  // currently-deferred or recently-sent rows whose eligible_at IS NOT NULL,
  // and (b) flush events from pressure_flush_audit. Useful for the
  // admin "deferred over time" sparkline.
  app.get("/api/admin/pressure-queue/curve", async (req: Request, res: Response) => {
    if (!(await requireAdmin(req, res))) return;
    try {
      // R7: 5-min cache. The dashboard polls /curve every 60s — without
      // caching that's a 7-day group-by hitting the DB 60x/hr per session.
      const cached = cacheGet<any>("admin:curve");
      if (cached) return res.json(cached);
      const defers = await db.execute(sql`
        SELECT date_trunc('day', sent_at) AS day, COUNT(*) AS n
        FROM campaign_sends
        WHERE eligible_at IS NOT NULL
          AND sent_at >= NOW() - interval '7 days'
        GROUP BY 1 ORDER BY 1 ASC
      `);
      const flushes = await db.execute(sql`
        SELECT date_trunc('day', created_at) AS day, COALESCE(SUM(count),0) AS n
        FROM pressure_flush_audit
        WHERE created_at >= NOW() - interval '7 days'
        GROUP BY 1 ORDER BY 1 ASC
      `);
      const payload = {
        windowHours: PRESSURE_WINDOW_HOURS,
        defers: defers.rows,
        flushes: flushes.rows,
      };
      if (res.headersSent) return;
      res.json(cacheSet("admin:curve", payload, 5 * 60_000));
    } catch (err: any) {
      logger.error(`[PRESSURE_QUEUE] /admin/pressure-queue/curve failed: ${err?.message || err}`);
      if (res.headersSent) return;
      res.status(500).json({ error: err?.message || "Internal error" });
    }
  });

  // ── Top-20 most-deferred contacts (cross-campaign, currently pending) ─
  app.get("/api/admin/pressure-queue/top-contacts", async (req: Request, res: Response) => {
    if (!(await requireAdmin(req, res))) return;
    try {
      // R8: 30-second cache. Top-contacts is polled every 30s and runs a
      // GROUP BY across all currently-deferred rows.
      const cached = cacheGet<any>("admin:top-contacts");
      if (cached) return res.json(cached);
      const rows = await db.execute(sql`
        SELECT cs.subscriber_id, s.email, s.last_sent_at,
               COUNT(*) AS deferred_rows,
               MIN(cs.eligible_at) AS next_eligible_at
        FROM campaign_sends cs
        JOIN subscribers s ON s.id = cs.subscriber_id
        WHERE cs.status = 'pending' AND cs.eligible_at IS NOT NULL
        GROUP BY cs.subscriber_id, s.email, s.last_sent_at
        ORDER BY deferred_rows DESC, next_eligible_at ASC
        LIMIT 20
      `);
      if (res.headersSent) return;
      res.json(cacheSet("admin:top-contacts", { rows: rows.rows }, 30_000));
    } catch (err: any) {
      logger.error(`[PRESSURE_QUEUE] /top-contacts failed: ${err?.message || err}`);
      if (res.headersSent) return;
      res.status(500).json({ error: err?.message || "Internal error" });
    }
  });

  // ── Flush audit history ─────────────────────────────────────────────
  app.get("/api/admin/pressure-queue/history", async (req: Request, res: Response) => {
    if (!(await requireAdmin(req, res))) return;
    const limit = Math.min(200, Math.max(1, parseInt((req.query.limit as string) ?? "50", 10) || 50));
    // Short TTL cache (15s) — history is polled by the dashboard every
    // 30-60s; the join across audit/users/campaigns is cheap individually
    // but adds up under refresh storms.
    const cacheKey = `history:${limit}`;
    const hit = cacheGet<{ rows: unknown[] }>(cacheKey);
    if (hit) return res.json(hit);
    try {
      const rows = await db.execute(sql`
        SELECT a.id, a.created_at, a.scope, a.count, a.reason,
               a.user_id, u.username AS user_name,
               a.campaign_id, c.name AS campaign_name
        FROM pressure_flush_audit a
        LEFT JOIN users u ON u.id = a.user_id
        LEFT JOIN campaigns c ON c.id = a.campaign_id
        ORDER BY a.created_at DESC
        LIMIT ${limit}
      `);
      const payload = { rows: rows.rows };
      cacheSet(cacheKey, payload, 15_000);
      res.json(payload);
    } catch (err: any) {
      logger.error(`[PRESSURE_QUEUE] /history failed: ${err?.message || err}`);
      res.status(500).json({ error: err?.message || "Internal error" });
    }
  });

  app.post("/api/admin/pressure-queue/flush", async (req: Request, res: Response) => {
    if (!(await requireAdmin(req, res))) return;
    const parsed = adminFlushBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        error: "Invalid flush body",
        details: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      });
    }
    const reason = parsed.data.reason;
    try {
      const count = await flushDeferredSends({
        scope: "global-all",
        reason,
        userId: req.session.userId ?? null,
      });
      logger.info(`[PRESSURE_QUEUE] Admin global flush by user=${req.session.userId} reprogrammed ${count} send(s)`);
      res.json({ ok: true, reprogrammed: count, flushed: count });
    } catch (err: any) {
      logger.error(`[PRESSURE_QUEUE] global flush failed: ${err?.message || err}`);
      res.status(500).json({ error: err?.message || "Internal error" });
    }
  });

  // ── Subscriber "next eligible" ──────────────────────────────────────
  app.get("/api/subscribers/:id/pressure", async (req: Request, res: Response) => {
    if (!requireAuth(req, res)) return;
    const subscriberId = req.params.id;
    try {
      const r = await db.execute(sql`
        SELECT id, email, last_sent_at,
          CASE WHEN last_sent_at IS NULL THEN NOW()
               ELSE last_sent_at + (${PRESSURE_WINDOW_HOURS}::numeric || ' hours')::interval END AS next_eligible_at
        FROM subscribers WHERE id = ${subscriberId}
      `);
      if (r.rows.length === 0) return res.status(404).json({ error: "Subscriber not found" });
      const row = r.rows[0] as any;
      const nextEligibleAt = new Date(row.next_eligible_at);
      const hoursUntilEligible = Math.max(0, (nextEligibleAt.getTime() - Date.now()) / 3_600_000);

      const upcoming = await db.execute(sql`
        SELECT cs.campaign_id, c.name AS campaign_name, cs.eligible_at, cs.status
        FROM campaign_sends cs
        JOIN campaigns c ON c.id = cs.campaign_id
        WHERE cs.subscriber_id = ${subscriberId}
          AND cs.status = 'pending' AND cs.eligible_at IS NOT NULL
        ORDER BY cs.eligible_at ASC
        LIMIT 50
      `);

      res.json({
        id: row.id,
        email: row.email,
        lastSentAt: row.last_sent_at,
        nextEligibleAt: nextEligibleAt.toISOString(),
        hoursUntilEligible: Number(hoursUntilEligible.toFixed(2)),
        windowHours: PRESSURE_WINDOW_HOURS,
        upcomingDeferred: upcoming.rows,
      });
    } catch (err: any) {
      logger.error(`[PRESSURE_QUEUE] /subscribers/${subscriberId}/pressure failed: ${err?.message || err}`);
      res.status(500).json({ error: err?.message || "Internal error" });
    }
  });
}
