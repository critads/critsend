/**
 * Pool-safety middleware
 *
 * Two layered protections that turn DB pool starvation into a graceful
 * 503 + Retry-After response instead of a 500 / 10-second hang.
 *
 *   1. loadShed (runs early): for non-critical routes, if the main pool is
 *      already saturated (waitingCount > 0 OR active/max > LOAD_SHED_THRESHOLD),
 *      reject immediately with 503 — don't even let the request try to
 *      acquire a connection. Critical paths (health, metrics, tracking,
 *      webhooks, auth) bypass this check so observability and incoming
 *      mail-traffic webhooks always succeed.
 *
 *   2. poolErrorHandler (runs as Express error handler): catches `pg`
 *      checkout-timeout errors that bubble out of route handlers and
 *      converts them into 503 + Retry-After:1 instead of 500.
 *
 * Together these guarantee that a saturated pool degrades to "client
 * retries in ~1s" instead of "user sees Internal Server Error".
 */
import { type Request, type Response, type NextFunction } from "express";
import { pool, getPoolSaturation, isPoolCheckoutError } from "../db";
import { MAIN_POOL_MAX } from "../connection-budget";
import { logger } from "../logger";
import { poolLoadShedTotal, poolCheckoutTimeoutTotal } from "../metrics";
import { isRequestLeaseExceeded, requestSawPoolError } from "./request-lease";

const LOAD_SHED_THRESHOLD = Number(process.env.POOL_LOAD_SHED_THRESHOLD || 0.9);
// Routes that must always be served, even under saturation.
//   /api/health, /metrics       — observability must never lie
//   /api/track/, /c/, /u/       — already on the dedicated tracking pool
//   /api/unsubscribe/           — legal compliance (RFC 8058)
//   /api/webhooks/              — bounce/complaint webhooks now buffered
//                                 in-memory, so they never touch the main pool
//   /api/auth/, /api/csrf-token — login/logout must work to recover
//   /u, /c, /t, /w              — short tracking links (also support no
//                                 trailing slash for the /u root path)
const CRITICAL_PREFIXES = [
  "/api/health",
  "/metrics",
  "/api/track/",
  "/c/",
  "/u/",
  "/t/",
  "/w/",
  "/api/unsubscribe/",
  "/api/webhooks/",
  "/api/auth/",
  "/api/csrf-token",
];
// Bare paths (no trailing slash) treated as critical too — covers e.g. `/u`.
const CRITICAL_EXACT = new Set(["/u", "/c", "/t", "/w"]);

function isCritical(path: string): boolean {
  if (CRITICAL_EXACT.has(path)) return true;
  for (const p of CRITICAL_PREFIXES) {
    if (path.startsWith(p)) return true;
  }
  return false;
}

// Stable, low-cardinality route bucket for the load_shed metric.
function routeBucket(path: string): string {
  if (path.startsWith("/api/campaigns")) return "/api/campaigns";
  if (path.startsWith("/api/subscribers")) return "/api/subscribers";
  if (path.startsWith("/api/imports")) return "/api/imports";
  if (path.startsWith("/api/segments")) return "/api/segments";
  if (path.startsWith("/api/automations")) return "/api/automations";
  if (path.startsWith("/api/analytics")) return "/api/analytics";
  if (path.startsWith("/api/mtas")) return "/api/mtas";
  if (path.startsWith("/api/")) return "/api/other";
  return "non-api";
}

/**
 * Upgrade any `res.status(500)` to 503 + Retry-After when a pool checkout
 * error happened earlier in this request — even if the route catches the
 * error locally and returns 500 itself. This makes the "no 500s from pool
 * starvation" guarantee architectural rather than per-handler.
 *
 * Mount AFTER `requestLeaseMiddleware` so the ALS context exists.
 */
export function poolErrorResponseUpgrade(req: Request, res: Response, next: NextFunction): void {
  const originalStatus = res.status.bind(res);
  (res as any).status = function patchedStatus(code: number) {
    if (code === 500 && !res.headersSent && requestSawPoolError()) {
      poolCheckoutTimeoutTotal.inc();
      res.setHeader("Retry-After", "1");
      return originalStatus(503);
    }
    return originalStatus(code);
  };
  // Same for sendStatus.
  const originalSendStatus = res.sendStatus.bind(res);
  (res as any).sendStatus = function patchedSendStatus(code: number) {
    if (code === 500 && !res.headersSent && requestSawPoolError()) {
      poolCheckoutTimeoutTotal.inc();
      res.setHeader("Retry-After", "1");
      return originalSendStatus(503);
    }
    return originalSendStatus(code);
  };
  next();
}

let lastShedLogAt = 0;
const SHED_LOG_INTERVAL_MS = 5_000;

/**
 * Reject non-critical requests with 503 when the main pool is already
 * saturated. Runs before the request handler so we never queue work that
 * we know will fail.
 */
export function loadShedMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (isCritical(req.path)) return next();
  // Cheap, allocation-free checks first.
  const waiting = pool.waitingCount;
  const saturation = getPoolSaturation();
  if (waiting === 0 && saturation < LOAD_SHED_THRESHOLD) return next();

  const reason = waiting > 0 ? "waiting" : "saturation";
  poolLoadShedTotal.inc({ reason, route: routeBucket(req.path) });
  const now = Date.now();
  if (now - lastShedLogAt > SHED_LOG_INTERVAL_MS) {
    lastShedLogAt = now;
    logger.warn(
      `[POOL SAFETY] Load-shedding ${req.method} ${req.path}: pool active=${pool.totalCount - pool.idleCount}/${MAIN_POOL_MAX}, waiting=${waiting}, saturation=${saturation.toFixed(2)} (reason=${reason})`,
    );
  }
  res.setHeader("Retry-After", "1");
  res.status(503).json({ error: "service_busy", retryAfterSeconds: 1 });
}

/**
 * Express error handler: convert pg pool checkout timeouts into 503.
 * Mounted last so it catches anything the route handlers don't catch
 * themselves.
 */
export function poolErrorHandler(err: any, req: Request, res: Response, next: NextFunction): void {
  if (isRequestLeaseExceeded(err)) {
    // The lease tracker already counted this in
    // critsend_db_pool_request_lease_exceeded_total{route} — just translate
    // to the standard 503 contract here.
    if (res.headersSent) return next(err);
    res.setHeader("Retry-After", "1");
    res.status(503).json({ error: "service_busy", retryAfterSeconds: 1 });
    return;
  }
  if (!isPoolCheckoutError(err)) return next(err);
  poolCheckoutTimeoutTotal.inc();
  logger.warn(
    `[POOL SAFETY] Checkout timeout on ${req.method} ${req.path}: ${err?.message || err}`,
  );
  if (res.headersSent) return next(err);
  res.setHeader("Retry-After", "1");
  res.status(503).json({ error: "service_busy", retryAfterSeconds: 1 });
}
