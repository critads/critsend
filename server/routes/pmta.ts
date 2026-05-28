/**
 * PMTA queue monitoring routes (Task #193).
 *
 * Contract: routes serve cached snapshot rows ONLY. The 5-minute collector
 * lives in server/services/pmta-collector.ts and is the only place that
 * opens an SSH connection. POST /refresh enqueues an out-of-cycle tick via
 * setImmediate; the HTTP request returns 202 immediately and the SSH work
 * runs off the event loop, gated by the same lease-table leader election
 * the scheduler uses.
 *
 * Security: every endpoint is gated by the same admin helper used by other
 * admin-tier pages (System Metrics, pressure queue). Refresh is additionally
 * rate-limited to 1 request per minute per authenticated user.
 */
import type { Express, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { sql } from "drizzle-orm";
import { db } from "../db";
import {
  getLatestPmtaSnapshots,
  getPmtaSnapshotHistory,
  getPmtaErrorQueues,
} from "../repositories/pmta-repository";
import {
  requestPmtaRefresh,
  isPmtaConfigured,
  getPmtaConfiguredDomains,
} from "../services/pmta-collector";
import { logger } from "../logger";

const DOMAIN_RE = /^[a-z0-9.-]+$/i;

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
      logger.warn(`[PMTA_ADMIN] DB error during admin check (${err?.message || err}) — failing closed`);
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

// Per-user 1/min rate limit on refresh. Keying by authenticated userId (NOT
// IP) is required by the task contract so multiple admins behind the same
// office IP don't starve each other. Auth middleware runs first, so the
// keyGenerator can rely on req.session.userId being present.
const refreshLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 1,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => (req.session?.userId as string) || req.ip || "anonymous",
  message: { error: "Refresh rate limit exceeded — 1 per minute per user" },
});

export function registerPmtaRoutes(app: Express) {
  app.get("/api/pmta/status", async (req: Request, res: Response) => {
    if (!(await requireAdmin(req, res))) return;
    res.json({
      configured: isPmtaConfigured(),
      domains: getPmtaConfiguredDomains(),
    });
  });

  app.get("/api/pmta/snapshots/latest", async (req: Request, res: Response) => {
    if (!(await requireAdmin(req, res))) return;
    try {
      const [rows, errorQueues] = await Promise.all([
        getLatestPmtaSnapshots(),
        getPmtaErrorQueues(),
      ]);
      res.json({
        configured: isPmtaConfigured(),
        configuredDomains: getPmtaConfiguredDomains(),
        snapshots: rows,
        errorQueues,
      });
    } catch (err) {
      logger.error("[PMTA] failed to fetch latest snapshots:", err);
      res.status(500).json({ error: "Failed to fetch PMTA snapshots" });
    }
  });

  app.get("/api/pmta/snapshots/:domain/history", async (req: Request, res: Response) => {
    if (!(await requireAdmin(req, res))) return;
    const domain = req.params.domain;
    if (!DOMAIN_RE.test(domain)) {
      return res.status(400).json({ error: "Invalid domain" });
    }
    const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 50, 1), 200);
    try {
      const rows = await getPmtaSnapshotHistory(domain, limit);
      res.json({ domain, snapshots: rows });
    } catch (err) {
      logger.error(`[PMTA] failed to fetch history for ${domain}:`, err);
      res.status(500).json({ error: "Failed to fetch PMTA history" });
    }
  });

  // Operator-facing refresh: fire-and-forget. NEVER opens SSH on the request
  // stack — the request returns 202 immediately and the tick runs off the
  // event loop, gated by the same leader-election upsert the 5-min scheduler
  // uses (so only the leader process actually contacts PMTA).
  app.post(
    "/api/pmta/refresh",
    async (req: Request, res: Response, next) => {
      if (!(await requireAdmin(req, res))) return;
      next();
    },
    refreshLimiter,
    (_req: Request, res: Response) => {
      if (!isPmtaConfigured()) {
        return res.status(503).json({ error: "PMTA collector not configured" });
      }
      const result = requestPmtaRefresh();
      if (!result.scheduled) {
        return res.status(202).json({ scheduled: false, reason: result.reason });
      }
      res.status(202).json({
        scheduled: true,
        note: "Refresh enqueued — will run on the PMTA collector leader process within seconds.",
      });
    },
  );
}
