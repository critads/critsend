/**
 * Data Consolidation — manual refs ↔ tags reconciliation (see
 * server/services/data-consolidation.ts for the rules).
 *
 *   GET  /api/data-consolidation/status      current run (with progress), last run, cursor state, config, canManage
 *   GET  /api/data-consolidation/runs?limit  run history (newest first)
 *   POST /api/data-consolidation/run         { mode: "incremental" | "full" } → 202 + run, 409 if one is active
 *   POST /api/data-consolidation/cancel      flags the active run; it stops at its next batch boundary
 *
 * All routes sit behind the global session middleware (/api/*). The two
 * POST routes additionally require an admin: a run rewrites tags/refs across
 * the whole subscriber base and a cancel stops another operator's run, so
 * they follow the established admin policy (users.is_admin, with the
 * ADMIN_USER_IDS bootstrap fallback and a fail-closed production default —
 * same resolution order as server/routes/pressure.ts / pmta.ts). Reads stay
 * open to every signed-in user; `canManage` in the status payload lets the
 * page disable the buttons instead of surfacing a 403 after the click.
 */
import type { Express, Request, Response } from "express";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { logger } from "../logger";
import { storage } from "../storage";
import { getDataConsolidationService } from "../services/data-consolidation";

export async function isDataConsolidationAdmin(uid: string): Promise<boolean> {
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
      logger.warn(`[DATA_CONSOLIDATION] DB error during admin check (${err?.message || err}) — failing closed`);
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

/** 401 without a session, 403 for a signed-in non-admin; true when the caller may start/stop runs. */
async function requireAdmin(req: Request, res: Response): Promise<boolean> {
  const uid = req.session?.userId as string | undefined;
  if (!uid) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  if (await isDataConsolidationAdmin(uid)) return true;
  res.status(403).json({ error: "Forbidden — admin required to start or stop a consolidation run" });
  return false;
}

/** Operator label stored on the run row (username when resolvable, else the session user id). */
async function resolveOperator(req: Request): Promise<string | undefined> {
  const userId = req.session?.userId;
  if (!userId) return undefined;
  try {
    const user = await storage.getUserById(userId);
    return typeof user?.username === "string" && user.username ? user.username : String(userId);
  } catch {
    return String(userId);
  }
}

const runBodySchema = z.object({
  mode: z.enum(["incremental", "full"]).default("incremental"),
});

export function registerDataConsolidationRoutes(app: Express): void {
  app.get("/api/data-consolidation/status", async (req: Request, res: Response) => {
    try {
      const uid = req.session?.userId as string | undefined;
      const [status, canManage] = await Promise.all([
        getDataConsolidationService().getStatus(),
        uid ? isDataConsolidationAdmin(uid) : Promise.resolve(false),
      ]);
      res.json({ ...status, canManage });
    } catch (err: any) {
      logger.error(`[DATA_CONSOLIDATION] status failed: ${err?.message || err}`);
      res.status(500).json({ error: "Failed to load data consolidation status" });
    }
  });

  app.get("/api/data-consolidation/runs", async (req: Request, res: Response) => {
    try {
      const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? ""), 10) || 20, 1), 200);
      const service = getDataConsolidationService();
      await service.ensureSchema();
      res.json(await service.listRuns(limit));
    } catch (err: any) {
      logger.error(`[DATA_CONSOLIDATION] runs failed: ${err?.message || err}`);
      res.status(500).json({ error: "Failed to load data consolidation runs" });
    }
  });

  app.post("/api/data-consolidation/run", async (req: Request, res: Response) => {
    if (!(await requireAdmin(req, res))) return;
    const parsed = runBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid input", details: parsed.error.flatten().fieldErrors });
    }
    try {
      const result = await getDataConsolidationService().startRun({
        mode: parsed.data.mode,
        triggeredBy: await resolveOperator(req),
      });
      if (!result.started) {
        return res.status(409).json({
          error: result.reason,
          message:
            result.reason === "already_running"
              ? "A consolidation run is already in progress"
              : "Another process holds the consolidation lease; retry in a few minutes",
          run: result.run,
        });
      }
      res.status(202).json({ run: result.run });
    } catch (err: any) {
      logger.error(`[DATA_CONSOLIDATION] start failed: ${err?.message || err}`);
      res.status(500).json({ error: "Failed to start data consolidation run" });
    }
  });

  app.post("/api/data-consolidation/cancel", async (req: Request, res: Response) => {
    if (!(await requireAdmin(req, res))) return;
    try {
      const runId = typeof req.body?.runId === "string" && req.body.runId.length <= 64 ? req.body.runId : undefined;
      const run = await getDataConsolidationService().requestCancel(runId);
      if (!run) return res.status(404).json({ error: "No active run to cancel" });
      res.json({ run });
    } catch (err: any) {
      logger.error(`[DATA_CONSOLIDATION] cancel failed: ${err?.message || err}`);
      res.status(500).json({ error: "Failed to cancel data consolidation run" });
    }
  });
}
