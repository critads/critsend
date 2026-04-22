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
 * Enforcement: when a request already holds the cap and asks for ANOTHER
 * checkout, we throw `RequestLeaseExceededError` from the new attempt only.
 * Already-acquired clients (and any in-progress transaction on them) keep
 * running, so transactional state is not corrupted. The thrown error is
 * caught by `poolErrorHandler` and translated to 503 + Retry-After.
 *
 * In addition, we record on the per-request ALS context whenever a real
 * pg checkout-timeout error happens, so `pool-safety.ts` can upgrade any
 * downstream `res.status(500)` from a route's local catch block into the
 * standard 503 contract.
 */
import { AsyncLocalStorage } from "async_hooks";
import type { Request, Response, NextFunction } from "express";
import type { Pool, PoolClient } from "pg";
import { pool, isPoolCheckoutError } from "../db";
import { routeBucket } from "./route-bucket";

type ConnectCallback = (err: Error | undefined, client: PoolClient | undefined, release: (err?: Error | boolean) => void) => void;
type ReleaseFn = (err?: Error | boolean) => void;
type ConnectFn = Pool["connect"];
import { logger } from "../logger";
import {
  poolRequestHolding,
  poolRequestLeaseExceededTotal,
} from "../metrics";

const MAX_PER_REQUEST = Number(process.env.MAX_CONNECTIONS_PER_REQUEST || 2);

/**
 * Thrown when a request tries to check out more than MAX_CONNECTIONS_PER_REQUEST
 * pool clients concurrently. Caught by `poolErrorHandler` and translated
 * into 503 + Retry-After. Existing in-progress transactions on this request
 * keep their already-acquired client (we throw on the new attempt only),
 * so transactional state is not corrupted.
 */
export class RequestLeaseExceededError extends Error {
  readonly code = "REQUEST_LEASE_EXCEEDED";
  constructor(public route: string, public count: number, public cap: number) {
    super(`Route ${route} attempted ${count} concurrent DB connections (cap=${cap})`);
    this.name = "RequestLeaseExceededError";
  }
}

export function isRequestLeaseExceeded(err: unknown): err is RequestLeaseExceededError {
  return !!err && (err as any).code === "REQUEST_LEASE_EXCEEDED";
}

interface LeaseCtx {
  route: string;
  count: number;
  peak: number;
  warned: boolean;
  /** Set true when ANY pool checkout error happened during this request. */
  poolErrorOccurred: boolean;
}

/** Mark the active request as having seen a pool checkout error. No-op
 *  outside an ALS context (e.g. background workers). */
export function markPoolErrorOnRequest(): void {
  const ctx = leaseStore.getStore();
  if (ctx) ctx.poolErrorOccurred = true;
}

export function requestSawPoolError(): boolean {
  return leaseStore.getStore()?.poolErrorOccurred === true;
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
  const route = (req.route?.path as string) || routeBucket(req.path);
  leaseStore.run({ route, count: 0, peak: 0, warned: false, poolErrorOccurred: false }, () => next());
}

let patched = false;

function checkCap(ctx: LeaseCtx): void {
  // Throw BEFORE checkout if this request already holds the cap. The
  // already-acquired client is left untouched so any in-progress
  // transaction can complete + release cleanly.
  if (ctx.count >= MAX_PER_REQUEST) {
    poolRequestLeaseExceededTotal.inc({ route: ctx.route });
    if (!ctx.warned) {
      ctx.warned = true;
      logger.warn(
        `[POOL LEASE] Route ${ctx.route} attempted ${ctx.count + 1}-th concurrent checkout (cap=${MAX_PER_REQUEST}); rejecting with 503.`,
      );
    }
    // Mark on the request ALS context so any locally caught 500 from the
    // route handler is upgraded to the canonical 503 + Retry-After contract
    // by `poolErrorResponseUpgrade` in pool-safety.ts.
    ctx.poolErrorOccurred = true;
    throw new RequestLeaseExceededError(ctx.route, ctx.count + 1, MAX_PER_REQUEST);
  }
}

function attribute(ctx: LeaseCtx, client: PoolClient): void {
  ctx.count++;
  if (ctx.count > ctx.peak) ctx.peak = ctx.count;
  poolRequestHolding.inc({ route: ctx.route });
  // pg's PoolClient.release accepts (err?: Error | boolean | undefined).
  const originalRelease: ReleaseFn = client.release.bind(client) as ReleaseFn;
  let released = false;
  const wrapped: ReleaseFn = (err?: Error | boolean) => {
    if (released) return;
    released = true;
    ctx.count = Math.max(0, ctx.count - 1);
    poolRequestHolding.dec({ route: ctx.route });
    return originalRelease(err);
  };
  client.release = wrapped as PoolClient["release"];
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

  const originalConnect: ConnectFn = pool.connect.bind(pool);

  function patchedConnect(): Promise<PoolClient>;
  function patchedConnect(cb: ConnectCallback): void;
  function patchedConnect(cb?: ConnectCallback): Promise<PoolClient> | void {
    // ── Callback form (used by pool.query internally) ──────────────────
    if (typeof cb === "function") {
      const ctxCb = leaseStore.getStore();
      if (ctxCb) {
        try { checkCap(ctxCb); }
        catch (capErr) {
          // No client to release; provide a no-op release to satisfy signature.
          const noop: ReleaseFn = () => {};
          return cb(capErr as Error, undefined, noop);
        }
      }
      return originalConnect((err, client, release) => {
        if (err && isPoolCheckoutError(err)) markPoolErrorOnRequest();
        if (err || !client) return cb(err, client, release);
        const ctx = leaseStore.getStore();
        if (!ctx) return cb(err, client, release);
        // Wrap `client.release` (same as the promise path) so the lease
        // is decremented regardless of whether the consumer calls
        // `client.release()` (drizzle, sequential pool.query in modern pg)
        // or the third callback arg (legacy patterns). Both end up at the
        // same wrapper which uses an internal `released` flag for idempotency.
        attribute(ctx, client);
        return cb(err, client, client.release.bind(client) as ReleaseFn);
      });
    }

    // ── Promise form ──────────────────────────────────────────────────
    const ctx = leaseStore.getStore();
    if (ctx) checkCap(ctx);
    const p = originalConnect();
    if (!ctx) return p;
    return p.then(
      (client) => {
        attribute(ctx, client);
        return client;
      },
      (err) => {
        if (isPoolCheckoutError(err)) markPoolErrorOnRequest();
        throw err;
      },
    );
  }
  pool.connect = patchedConnect as ConnectFn;

  logger.info(`[POOL LEASE] Request-lease tracker installed (cap=${MAX_PER_REQUEST}/request)`);
}
