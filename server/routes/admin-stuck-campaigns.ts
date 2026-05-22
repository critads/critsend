/**
 * Admin endpoint for stuck-campaign visibility (Task #181).
 *
 *   GET /api/admin/stuck-campaigns
 *
 * Returns the live snapshot of campaigns the guardian currently
 * classifies as stuck, with the diagnosed reason, the action the
 * guardian will take, and per-reason totals.
 *
 * This is the operator-facing companion of the per-reason Prometheus
 * gauge `critsend_campaigns_stuck_total{reason="..."}`. Read-only —
 * never mutates state — so it is safe to poll from the UI.
 *
 * Admin-gated via the same `requireAdmin` helper used by the pressure
 * queue routes (users.is_admin OR ADMIN_USER_IDS env fallback OR
 * non-production session). See server/routes/pressure.ts for the full
 * resolution order.
 */

import type { Express, Request, Response } from "express";
import { sql } from "drizzle-orm";
import { db } from "../db";
import { logger } from "../logger";
import {
  diagnoseStuckCampaigns,
  countByReason,
  STUCK_SCHEDULED_MIN,
  STUCK_SENDING_NO_JOB_MIN,
  STUCK_HEARTBEAT_STALE_MIN,
  STUCK_NO_PROGRESS_MIN,
  STUCK_MAX_JOB_RETRIES,
} from "../services/stuck-campaign-diagnosis";

function requireAuth(req: Request, res: Response): boolean {
  if (!req.session?.userId) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

async function isAdminUser(uid: string): Promise<boolean> {
  let dbAdminExists = false;
  let dbErrorIsMissingColumn = false;
  let dbHadRuntimeError = false;
  try {
    const me = await db.execute(sql<{ is_admin: boolean | null }>`SELECT is_admin FROM users WHERE id = ${uid}`);
    const row = me.rows[0] as { is_admin: boolean | null } | undefined;
    if (row && row.is_admin === true) return true;
    const any = await db.execute(sql`SELECT 1 FROM users WHERE is_admin = true LIMIT 1`);
    dbAdminExists = any.rows.length > 0;
  } catch (err: any) {
    const code = err?.code ?? err?.cause?.code;
    if (code === "42703") dbErrorIsMissingColumn = true;
    else dbHadRuntimeError = true;
    if (dbHadRuntimeError && process.env.NODE_ENV === "production") {
      logger.warn(`[STUCK_ADMIN] DB error during admin check (${err?.message || err}) — failing closed`);
      return false;
    }
  }
  if (!dbAdminExists || dbErrorIsMissingColumn) {
    const allowlist = (process.env.ADMIN_USER_IDS ?? "")
      .split(",").map((s) => s.trim()).filter(Boolean);
    if (allowlist.includes(uid)) return true;
    if (allowlist.length === 0 && process.env.NODE_ENV !== "production") return true;
  }
  return false;
}

async function requireAdmin(req: Request, res: Response): Promise<boolean> {
  if (!requireAuth(req, res)) return false;
  const uid = req.session.userId as string;
  if (await isAdminUser(uid)) return true;
  res.status(403).json({ error: "Forbidden — admin required" });
  return false;
}

export function registerAdminStuckCampaignsRoutes(app: Express): void {
  app.get("/api/admin/stuck-campaigns", async (req: Request, res: Response) => {
    if (!(await requireAdmin(req, res))) return;
    try {
      const stuck = await diagnoseStuckCampaigns();
      const counts = countByReason(stuck);
      res.json({
        generatedAt: new Date().toISOString(),
        thresholds: {
          scheduledMin: STUCK_SCHEDULED_MIN,
          sendingNoJobMin: STUCK_SENDING_NO_JOB_MIN,
          heartbeatStaleMin: STUCK_HEARTBEAT_STALE_MIN,
          noProgressMin: STUCK_NO_PROGRESS_MIN,
          maxJobRetries: STUCK_MAX_JOB_RETRIES,
        },
        totals: {
          stuck: stuck.length,
          byReason: counts,
        },
        campaigns: stuck,
      });
    } catch (err: any) {
      logger.error(`[STUCK_ADMIN] /api/admin/stuck-campaigns failed: ${err?.message || err}`);
      if (!res.headersSent) res.status(500).json({ error: err?.message || "Internal error" });
    }
  });
}
