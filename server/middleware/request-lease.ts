/**
 * Per-request DB connection lease accounting.
 *
 * Why: a single slow handler that opens 5+ pool clients (e.g. a transaction
 * + parallel sub-queries) can monopolize the pool and starve other users.
 * This middleware caps that to MAX_CONNECTIONS_PER_REQUEST (default 2) and
 * exposes `critsend_db_pool_request_holding{route}` so we can see which
 * routes are holding the most connections at any moment.
 *
 * How: AsyncLocalStorage carries a per-request counter. We monkey-patch
 * `pool.connect()` once at startup so every checkout (including pg-internal
 * `pool.query()`'s temporary checkouts) is observed transparently — no
 * route or storage code has to opt in.
 *
 * Enforcement: if a request exceeds the cap, we log a warning and increment
 * a metric, but we do NOT throw — aborting mid-transaction would corrupt
 * state. The hard backpressure comes from `loadShedMiddleware` rejecting
 * new requests once the pool is saturated.
 */
import { AsyncLocalStorage } from "async_hooks";
import type { Request, Response, NextFunction } from "express";
import type { PoolClient } from "pg";
import { pool } from "../db";
import { logger } from "../logger";
import {
  poolRequestHolding,
  poolRequestLeaseExceededTotal,
} from "../metrics";

const MAX_PER_REQUEST = Number(process.env.MAX_CONNECTIONS_PER_REQUEST || 2);

interface LeaseCtx {
  route: string;
  count: number;
  peak: number;
  warned: boolean;
}

export const leaseStore = new AsyncLocalStorage<LeaseCtx>();

/**
 * Express middleware: install a per-request ALS context so every
 * pool.connect() call inside this request is attributed to it.
 *
 * Use the route template if available (e.g. `/api/campaigns/:id`) so the
 * cardinality of the metric stays bounded; fall back to the raw path.
 */
export function requestLeaseMiddleware(req: Request, res: Response, next: NextFunction): void {
  // req.route is set after routing; before that, fall back to path. We
  // accept the slight cardinality cost because it's still bounded by the
  // number of unique routes the app exposes.
  const route = (req.route?.path as string) || req.baseUrl + req.path || req.path || "unknown";
  leaseStore.run({ route, count: 0, peak: 0, warned: false }, () => next());
}

let patched = false;

function attribute(ctx: LeaseCtx, client: PoolClient): void {
  ctx.count++;
  if (ctx.count > ctx.peak) ctx.peak = ctx.count;
  poolRequestHolding.inc({ route: ctx.route });
  if (ctx.count > MAX_PER_REQUEST && !ctx.warned) {
    ctx.warned = true;
    poolRequestLeaseExceededTotal.inc({ route: ctx.route });
    logger.warn(
      `[POOL LEASE] Route ${ctx.route} now holding ${ctx.count} DB connections (cap=${MAX_PER_REQUEST}). ` +
      `Investigate this handler — it may be opening parallel transactions or leaking clients.`,
    );
  }
  const originalRelease = client.release.bind(client);
  let released = false;
  (client as any).release = (err?: Error | boolean) => {
    if (released) return;
    released = true;
    ctx.count = Math.max(0, ctx.count - 1);
    poolRequestHolding.dec({ route: ctx.route });
    return originalRelease(err as any);
  };
}

/**
 * Install the pool.connect monkey-patch exactly once. Idempotent.
 *
 * pg's `pool.connect` supports BOTH a Promise form (no args) and a
 * callback form (`(err, client, release) => …`); `pool.query` uses the
 * callback form internally. We must preserve both so internal `pg`
 * machinery keeps working — only attribute when an ALS context exists.
 */
export function installRequestLeaseTracker(): void {
  if (patched) return;
  patched = true;

  const originalConnect = pool.connect.bind(pool) as any;
  (pool as any).connect = function patchedConnect(cb?: any): any {
    // ── Callback form (used by pool.query internally) ──────────────────
    if (typeof cb === "function") {
      return originalConnect((err: Error, client: PoolClient, release: any) => {
        if (err || !client) return cb(err, client, release);
        const ctx = leaseStore.getStore();
        if (!ctx) return cb(err, client, release);
        // Wrap the release callback so we decrement on release.
        ctx.count++;
        if (ctx.count > ctx.peak) ctx.peak = ctx.count;
        poolRequestHolding.inc({ route: ctx.route });
        if (ctx.count > MAX_PER_REQUEST && !ctx.warned) {
          ctx.warned = true;
          poolRequestLeaseExceededTotal.inc({ route: ctx.route });
          logger.warn(
            `[POOL LEASE] Route ${ctx.route} now holding ${ctx.count} DB connections (cap=${MAX_PER_REQUEST})`,
          );
        }
        let released = false;
        const wrappedRelease = (e?: any) => {
          if (released) return release(e);
          released = true;
          ctx.count = Math.max(0, ctx.count - 1);
          poolRequestHolding.dec({ route: ctx.route });
          return release(e);
        };
        return cb(err, client, wrappedRelease);
      });
    }

    // ── Promise form ──────────────────────────────────────────────────
    const ctx = leaseStore.getStore();
    const p = originalConnect() as Promise<PoolClient>;
    if (!ctx) return p;
    return p.then(
      (client) => {
        attribute(ctx, client);
        return client;
      },
      (err) => {
        throw err;
      },
    );
  };

  logger.info(`[POOL LEASE] Request-lease tracker installed (cap=${MAX_PER_REQUEST}/request)`);
}
