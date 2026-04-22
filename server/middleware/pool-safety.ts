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
import { routeBucket } from "./route-bucket";

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

// `routeBucket` lives in its own module so this file and `request-lease.ts`
// can both import it without forming a circular dependency.

/** Canonical body for every 503 response coming out of the safety net. */
// Strict shape per task contract: only `{ error: "service_busy" }`. The
// retry interval is communicated solely via the `Retry-After: 1` header.
const SERVICE_BUSY_BODY = { error: "service_busy" } as const;

function sendServiceBusy(res: Response): Response {
  res.setHeader("Retry-After", "1");
  return res.status(503).json(SERVICE_BUSY_BODY);
}

/**
 * Upgrade any `res.status(500)` to a canonical 503 + Retry-After +
 * `{ error: "service_busy" }` body when a pool checkout error happened
 * earlier in this request — even if the route catches the error locally
 * and returns 500 itself. This makes the "no 500s from pool starvation"
 * guarantee architectural rather than per-handler, and guarantees the
 * 503 contract body is uniform.
 *
 * Mount AFTER `requestLeaseMiddleware` so the ALS context exists.
 */
type StatusFn = Response["status"];
type SendStatusFn = Response["sendStatus"];
type JsonFn = Response["json"];
type SendFn = Response["send"];
type EndFn = Response["end"];

export function poolErrorResponseUpgrade(_req: Request, res: Response, next: NextFunction): void {
  const originalStatus: StatusFn = res.status.bind(res);
  const originalSendStatus: SendStatusFn = res.sendStatus.bind(res);
  const originalJson: JsonFn = res.json.bind(res);
  const originalSend: SendFn = res.send.bind(res);
  let upgraded = false;

  const patchedStatus: StatusFn = (code: number) => {
    if (code === 500 && !res.headersSent && requestSawPoolError()) {
      poolCheckoutTimeoutTotal.inc();
      upgraded = true;
      res.setHeader("Retry-After", "1");
      return originalStatus(503);
    }
    return originalStatus(code);
  };
  res.status = patchedStatus;

  const patchedSendStatus: SendStatusFn = (code: number) => {
    if (code === 500 && !res.headersSent && requestSawPoolError()) {
      poolCheckoutTimeoutTotal.inc();
      upgraded = true;
      res.setHeader("Retry-After", "1");
      return originalSendStatus(503);
    }
    return originalSendStatus(code);
  };
  res.sendStatus = patchedSendStatus;

  // When the request was upgraded, replace whatever body the handler tried
  // to send with the canonical service-busy payload — preserves contract.
  const patchedJson: JsonFn = (body?: unknown) => {
    if (upgraded) return originalJson(SERVICE_BUSY_BODY);
    return originalJson(body);
  };
  res.json = patchedJson;

  const patchedSend: SendFn = (body?: unknown) => {
    if (upgraded) return originalJson(SERVICE_BUSY_BODY);
    return originalSend(body);
  };
  res.send = patchedSend;

  // Some handlers call `res.status(500).end()` directly (no body). Without
  // this patch they would emit a 503 with an empty body, breaking the
  // canonical contract. When upgraded, redirect through `originalJson` so
  // the body is the strict service-busy payload.
  const originalEnd = res.end.bind(res) as EndFn;
  const patchedEnd = ((...args: unknown[]) => {
    if (upgraded && !res.headersSent) {
      return originalJson(SERVICE_BUSY_BODY);
    }
    return (originalEnd as (...a: unknown[]) => Response).apply(res, args);
  }) as EndFn;
  res.end = patchedEnd;

  next();
}

// ── Load-shed persistence gate ─────────────────────────────────────────────
// Only shed on `waitingCount > 0` after it has been continuously > 0 for
// at least WAITING_PERSISTENCE_MS — avoids over-shedding transient spikes.
// Saturation > LOAD_SHED_THRESHOLD always sheds immediately (hot pool).
const WAITING_PERSISTENCE_MS = Number(process.env.POOL_WAITING_PERSISTENCE_MS || 500);
let waitingSinceMs = 0;

let lastShedLogAt = 0;
const SHED_LOG_INTERVAL_MS = 5_000;

/**
 * Reject non-critical requests with 503 when the main pool is already
 * saturated. Runs before the request handler so we never queue work that
 * we know will fail.
 */
export function loadShedMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (isCritical(req.path)) return next();
  const waiting = pool.waitingCount;
  const saturation = getPoolSaturation();
  const now = Date.now();

  // Track how long waitingCount has been > 0 (cheap arithmetic, no setTimeout).
  if (waiting > 0) {
    if (waitingSinceMs === 0) waitingSinceMs = now;
  } else {
    waitingSinceMs = 0;
  }
  const waitingPersistent =
    waitingSinceMs > 0 && now - waitingSinceMs >= WAITING_PERSISTENCE_MS;
  const saturationHot = saturation >= LOAD_SHED_THRESHOLD;

  if (!waitingPersistent && !saturationHot) return next();

  const reason = saturationHot ? "saturation" : "waiting";
  poolLoadShedTotal.inc({ reason, route: routeBucket(req.path) });
  if (now - lastShedLogAt > SHED_LOG_INTERVAL_MS) {
    lastShedLogAt = now;
    const persistedFor = waitingSinceMs > 0 ? now - waitingSinceMs : 0;
    logger.warn(
      `[POOL SAFETY] Load-shedding ${req.method} ${req.path}: pool active=${pool.totalCount - pool.idleCount}/${MAIN_POOL_MAX}, waiting=${waiting} (for ${persistedFor}ms), saturation=${saturation.toFixed(2)} (reason=${reason})`,
    );
  }
  sendServiceBusy(res);
}

/**
 * Express error handler: convert pg pool checkout timeouts into 503.
 * Mounted last so it catches anything the route handlers don't catch
 * themselves.
 */
export function poolErrorHandler(err: unknown, req: Request, res: Response, next: NextFunction): void {
  if (isRequestLeaseExceeded(err)) {
    // The lease tracker already counted this in
    // critsend_db_pool_request_lease_exceeded_total{route} — just translate
    // to the standard 503 contract here.
    if (res.headersSent) return next(err);
    sendServiceBusy(res);
    return;
  }
  if (!isPoolCheckoutError(err)) return next(err);
  poolCheckoutTimeoutTotal.inc();
  const msg = err instanceof Error ? err.message : String(err);
  logger.warn(`[POOL SAFETY] Checkout timeout on ${req.method} ${req.path}: ${msg}`);
  if (res.headersSent) return next(err);
  sendServiceBusy(res);
}
