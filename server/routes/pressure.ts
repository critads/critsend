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
import { db } from "../db";
import { logger } from "../logger";
import {
  PRESSURE_WINDOW_HOURS,
  flushDeferredSends,
} from "../services/pressure-guard";
function requireAuth(req: Request, res: Response): boolean {
  if (!req.session?.userId) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

/**
 * Admin-scope guard. The `users` table in this codebase has no `role`
 * column, so admin status is granted via the `ADMIN_USER_IDS` env var
 * (comma-separated user IDs). When the env var is unset OR empty we
 * fail closed in production (NODE_ENV==='production') to prevent any
 * authenticated user from globally reprogramming queues; in non-prod
 * the first authenticated user is treated as admin to keep dev/test
 * ergonomics. Misconfiguration is logged loudly.
 */
function requireAdmin(req: Request, res: Response): boolean {
  if (!requireAuth(req, res)) return false;
  const allowlist = (process.env.ADMIN_USER_IDS ?? "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  const uid = req.session.userId as string;
  if (allowlist.length === 0) {
    if (process.env.NODE_ENV === "production") {
      logger.error("[PRESSURE_QUEUE] ADMIN_USER_IDS unset in production — blocking admin access");
      res.status(403).json({ error: "Admin access disabled (set ADMIN_USER_IDS)" });
      return false;
    }
    return true;
  }
  if (!allowlist.includes(uid)) {
    res.status(403).json({ error: "Forbidden: admin role required" });
    return false;
  }
  return true;
}

export function registerPressureRoutes(app: Express): void {
  // ── Per-campaign queue view ─────────────────────────────────────────
  app.get("/api/campaigns/:id/queue", async (req: Request, res: Response) => {
    if (!requireAuth(req, res)) return;
    const campaignId = req.params.id;
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
      if (status === "deferred") whereStatus = sql`status = 'pending' AND eligible_at IS NOT NULL`;
      else if (status === "pending") whereStatus = sql`status = 'pending' AND eligible_at IS NULL`;
      else if (status !== "all") whereStatus = sql`status = ${status}`;

      const rows = await db.execute(sql`
        SELECT cs.id, cs.subscriber_id, s.email, cs.status, cs.sent_at, cs.eligible_at, s.last_sent_at
        FROM campaign_sends cs
        LEFT JOIN subscribers s ON s.id = cs.subscriber_id
        WHERE cs.campaign_id = ${campaignId} AND ${whereStatus}
        ORDER BY cs.eligible_at ASC NULLS LAST, cs.sent_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `);

      res.json({
        campaign: campaignRow.rows[0],
        windowHours: PRESSURE_WINDOW_HOURS,
        counts: counts.rows[0],
        page,
        limit,
        rows: rows.rows,
      });
    } catch (err: any) {
      logger.error(`[PRESSURE_QUEUE] GET /campaigns/${campaignId}/queue failed: ${err?.message || err}`);
      res.status(500).json({ error: err?.message || "Internal error" });
    }
  });

  // ── Per-campaign flush ──────────────────────────────────────────────
  app.post("/api/campaigns/:id/queue/flush", async (req: Request, res: Response) => {
    if (!requireAuth(req, res)) return;
    const campaignId = req.params.id;
    const { scope, subscriberIds, reason } = req.body ?? {};
    if (scope !== "selected" && scope !== "all") {
      return res.status(400).json({ error: "scope must be 'selected' or 'all'" });
    }
    if (!reason || typeof reason !== "string" || reason.trim().length < 3) {
      return res.status(400).json({ error: "reason (>=3 chars) is required" });
    }
    try {
      // Spec contract: body = { campaignSendIds: string[] | "all", reason }.
      // We also accept the legacy `{ scope, subscriberIds }` shape for
      // backward compatibility with the in-app UI.
      const csIds = (req.body as any)?.campaignSendIds;
      let count = 0;
      if (csIds === "all" || scope === "all" || scope === "campaign-all") {
        count = await flushDeferredSends({
          campaignId,
          campaignSendIds: "all",
          scope: "campaign-all",
          reason,
          userId: req.session.userId ?? null,
        });
      } else if (Array.isArray(csIds) && csIds.length > 0) {
        count = await flushDeferredSends({
          campaignId,
          campaignSendIds: csIds,
          scope: "selected",
          reason,
          userId: req.session.userId ?? null,
        });
      } else if (scope === "selected") {
        if (!Array.isArray(subscriberIds) || subscriberIds.length === 0) {
          return res.status(400).json({ error: "campaignSendIds must be a non-empty array or \"all\"" });
        }
        count = await flushDeferredSends({
          campaignId,
          subscriberIds,
          scope: "selected",
          reason,
          userId: req.session.userId ?? null,
        });
      } else {
        return res.status(400).json({ error: "Provide campaignSendIds: string[] | \"all\"" });
      }
      // Counter increments are folded into flushDeferredSends().
      res.json({ ok: true, reprogrammed: count, flushed: count });
    } catch (err: any) {
      logger.error(`[PRESSURE_QUEUE] flush(${campaignId}) failed: ${err?.message || err}`);
      res.status(500).json({ error: err?.message || "Internal error" });
    }
  });

  // ── Cross-campaign admin view ───────────────────────────────────────
  app.get("/api/admin/pressure-queue", async (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;
    try {
      const summary = await db.execute(sql`
        SELECT
          cs.campaign_id,
          c.name AS campaign_name,
          c.started_at,
          c.deferred_count AS lifetime_defers,
          COUNT(*) AS pending_deferred,
          COUNT(*) FILTER (WHERE cs.eligible_at <= NOW()) AS due_now,
          MIN(cs.eligible_at) AS next_eligible_at
        FROM campaign_sends cs
        JOIN campaigns c ON c.id = cs.campaign_id
        WHERE cs.status = 'pending' AND cs.eligible_at IS NOT NULL
        GROUP BY cs.campaign_id, c.name, c.started_at, c.deferred_count
        ORDER BY c.started_at ASC NULLS FIRST
        LIMIT 500
      `);

      const totals = await db.execute(sql`
        SELECT
          COUNT(*) AS pending_deferred,
          COUNT(*) FILTER (WHERE eligible_at <= NOW()) AS due_now
        FROM campaign_sends WHERE status = 'pending' AND eligible_at IS NOT NULL
      `);

      res.json({
        windowHours: PRESSURE_WINDOW_HOURS,
        totals: totals.rows[0],
        campaigns: summary.rows,
      });
    } catch (err: any) {
      logger.error(`[PRESSURE_QUEUE] /admin/pressure-queue failed: ${err?.message || err}`);
      res.status(500).json({ error: err?.message || "Internal error" });
    }
  });

  app.post("/api/admin/pressure-queue/flush", async (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;
    const { reason } = req.body ?? {};
    if (!reason || typeof reason !== "string" || reason.trim().length < 3) {
      return res.status(400).json({ error: "reason (>=3 chars) is required" });
    }
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
