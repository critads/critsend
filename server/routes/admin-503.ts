/**
 * Admin endpoint that exposes a snapshot of every 503 ("service_busy")
 * response emitted by the safety net since process start, plus a ring
 * buffer of the 50 most-recent emissions with full per-event context
 * (rid, route, source, kind, pool snapshot, lease holding).
 *
 * Created by Task #148 to make every "Failed to load campaigns" 503 in
 * the UI immediately attributable to one of:
 *
 *   - load_shed         (pool waiting > persistence threshold OR > 90% sat)
 *   - lease_exceeded    (request tried > MAX_CONNECTIONS_PER_REQUEST checkouts)
 *   - checkout_timeout  (pg pool checkout timed out)
 *   - handler_transient (DB statement_timeout / connection / disk_full inside route)
 *   - memory_pressure   (heap-utilisation gauge tripped → POST /campaigns/:id/send)
 *
 * Mirrors the admin gate logic of `server/routes/pressure.ts` so
 * `users.is_admin = true` is the source of truth (with `ADMIN_USER_IDS`
 * env-var bootstrap fallback).
 */
import type { Express, Request, Response } from "express";
import { db } from "../db";
import { sql } from "drizzle-orm";
import { logger } from "../logger";
import { getAttributionSnapshot } from "../middleware/service-busy";

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
    const me = await db.execute(
      sql<{ is_admin: boolean | null }>`SELECT is_admin FROM users WHERE id = ${uid}`,
    );
    const row = me.rows[0] as { is_admin: boolean | null } | undefined;
    if (row && row.is_admin === true) return true;
    const any = await db.execute(sql`SELECT 1 FROM users WHERE is_admin = true LIMIT 1`);
    dbAdminExists = any.rows.length > 0;
  } catch (err: any) {
    const code = err?.code ?? err?.cause?.code;
    if (code === "42703") dbErrorIsMissingColumn = true;
    else dbHadRuntimeError = true;
    if (dbHadRuntimeError && process.env.NODE_ENV === "production") {
      logger.warn(
        `[ADMIN_503] DB error during admin check (${err?.message || err}) — failing closed`,
      );
      return false;
    }
  }
  if (!dbAdminExists || dbErrorIsMissingColumn) {
    const allowlist = (process.env.ADMIN_USER_IDS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (allowlist.includes(uid)) return true;
    if (allowlist.length === 0 && process.env.NODE_ENV !== "production") return true;
  }
  return false;
}

export function register503AttributionRoutes(app: Express): void {
  app.get("/api/admin/503-attribution", async (req: Request, res: Response) => {
    if (!requireAuth(req, res)) return;
    const uid = req.session.userId as string;
    if (!(await isAdminUser(uid))) {
      return res.status(403).json({ error: "Forbidden" });
    }
    try {
      const snap = await getAttributionSnapshot();
      res.json({
        generatedAt: new Date().toISOString(),
        ...snap,
      });
    } catch (err: any) {
      logger.error(`[ADMIN_503] snapshot failed: ${err?.message || err}`);
      res.status(500).json({ error: "Failed to compute 503 attribution" });
    }
  });
}
