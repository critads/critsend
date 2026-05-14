/**
 * Task #149 hotfix: one-shot admin endpoint to terminate stuck PgBouncer
 * backends still holding the legacy session-level advisory locks
 * (PRESSURE_DRAIN=900014, PRESSURE_MAINTENANCE=900015, PRESSURE_AUDIT_TTL=900016).
 *
 * Why this exists: prior to Task #149, the pressure-guard worker used
 * `pg_try_advisory_lock` which is session-level, but Neon's pooled
 * endpoint runs PgBouncer in transaction mode — so the acquire and
 * release queries land on different backends, leaking the lock on the
 * original backend forever (constated PIDs 15115 / 16609 in prod, idle,
 * `application_name=pgbouncer`, executing unrelated queries). After
 * deploying the lease-table replacement, this endpoint is invoked ONCE
 * to flush the stragglers; subsequent reboots no longer accumulate any.
 *
 * Admin-gated identically to /api/admin/pressure-queue.
 */
import type { Express, Request, Response } from "express";
import { db, pool } from "../db";
import { sql } from "drizzle-orm";
import { logger } from "../logger";

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
      logger.warn(`[ADMIN_PG_LOCKS] DB error during admin check (${err?.message || err}) — failing closed`);
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

// Same numeric keys as `LOCK_KEYS.PRESSURE_*` in server/bootstrap-lock.ts.
// Hard-coded here to keep this hotfix route self-contained.
const PRESSURE_LOCK_OBJIDS = [900014, 900015, 900016] as const;

export function registerAdminPressureGuardLocksRoutes(app: Express): void {
  app.post(
    "/api/admin/pressure-guard/release-stuck-locks",
    async (req: Request, res: Response) => {
      if (!requireAuth(req, res)) return;
      const uid = req.session.userId as string;
      if (!(await isAdminUser(uid))) {
        return res.status(403).json({ error: "Forbidden: admin role required" });
      }
      try {
        // Find every backend currently holding one of the 3 pressure-guard
        // session-level advisory locks. We only target idle (or
        // idle-in-transaction) backends — never `state='active'` — so we
        // never kill a worker mid-real-work.
        const locks = await pool.query<{
          pid: number;
          objid: number;
          state: string | null;
          application_name: string | null;
          query_start: Date | null;
        }>(
          `SELECT l.pid, l.objid, a.state, a.application_name, a.query_start
           FROM pg_locks l
           JOIN pg_stat_activity a ON a.pid = l.pid
           WHERE l.locktype = 'advisory'
             AND l.classid = 0
             AND l.objid = ANY($1::int[])
             AND l.granted = true
             AND a.state IN ('idle', 'idle in transaction', 'idle in transaction (aborted)')
             -- Tighten match to PgBouncer-only sessions per the
             -- documented behaviour. The pre-Task-#149 leak is exclusive
             -- to backends labelled application_name='pgbouncer'; never
             -- target our own app's connections.
             AND a.application_name = 'pgbouncer'`,
          [Array.from(PRESSURE_LOCK_OBJIDS)],
        );

        const targets = locks.rows;
        const terminated: Array<{ pid: number; objid: number; state: string | null; ok: boolean; error?: string }> = [];
        for (const row of targets) {
          try {
            const r = await pool.query<{ ok: boolean }>(`SELECT pg_terminate_backend($1) AS ok`, [row.pid]);
            terminated.push({ pid: row.pid, objid: row.objid, state: row.state, ok: r.rows[0]?.ok === true });
          } catch (err: any) {
            terminated.push({ pid: row.pid, objid: row.objid, state: row.state, ok: false, error: err?.message || String(err) });
          }
        }
        logger.warn(
          `[ADMIN_PG_LOCKS] release-stuck-locks by user=${uid}: targeted=${targets.length} terminated_ok=${terminated.filter((t) => t.ok).length}`,
        );
        res.json({
          ok: true,
          targeted: targets.length,
          terminated,
          note: "Only idle PgBouncer backends holding PRESSURE_DRAIN/MAINTENANCE/AUDIT_TTL session-level advisory locks were targeted. The lease-table replacement (Task #149) prevents future accumulation.",
        });
      } catch (err: any) {
        logger.error(`[ADMIN_PG_LOCKS] release-stuck-locks failed: ${err?.message || err}`);
        res.status(500).json({ error: err?.message || "Internal error" });
      }
    },
  );
}
