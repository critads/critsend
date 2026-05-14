import express, { type Request, Response, NextFunction } from "express";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";
import session from "express-session";
import connectPg from "connect-pg-simple";
import crypto from "crypto";
import { registerRoutes } from "./routes";
import { startAllWorkers, stopAllBackgroundWorkers, startImportGuardian, stopImportGuardian, triggerGuardianPoll, startCampaignGuardian, stopCampaignGuardian } from "./workers";
import { registerMetricsRoute, metricsMiddleware, startMetricsCollector, stopMetricsCollector } from "./metrics";
import { messageQueue } from "./message-queue";
import { serveStatic } from "./static";
import { createServer } from "http";
import path from "path";
import fs from "fs";
import { pool } from "./db";
import { logger } from "./logger";
import { validateConnectionBudget } from "./connection-budget";
import { initQueues, closeQueues } from "./queues";
import { startBullMQWorkers, closeBullMQWorkers } from "./queue-workers";
import { closeRedisConnections, createRedisConnection, isRedisConfigured } from "./redis";
import { startRedisProgressBridge } from "./job-events";
import { loadShedMiddleware, poolErrorHandler, poolErrorResponseUpgrade } from "./middleware/pool-safety";
import { requestLeaseMiddleware, installRequestLeaseTracker } from "./middleware/request-lease";

/**
 * Silently attempt to persist a system-level error to the error_logs DB table.
 * Failures are swallowed so this never crashes the process — DB may itself be down.
 */
async function tryLogSystemError(message: string, details?: Record<string, unknown>): Promise<void> {
  try {
    const { logError } = await import('./repositories/job-repository');
    await logError({
      type: 'system_error',
      severity: 'error',
      message: message.slice(0, 500),
      details: details ? JSON.stringify(details).slice(0, 5000) : undefined,
    });
  } catch {
    // Cannot reach DB — error stays in PM2 logs only
  }
}

process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  const stack = reason instanceof Error ? reason.stack : undefined;
  logger.error('Unhandled Promise Rejection', { reason: msg });
  tryLogSystemError('Unhandled Promise Rejection', { reason: msg, stack });
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception (non-fatal)', { error: error.message, stack: error.stack });
  tryLogSystemError('Uncaught Exception', { error: error.message, stack: error.stack });
});

import('v8').then((v8) => {
  const heapStats = v8.getHeapStatistics();
  const heapLimitMB = Math.round(heapStats.heap_size_limit / 1024 / 1024);
  const nodeOptions = process.env.NODE_OPTIONS || '(not set)';
  logger.info('Process startup diagnostics', {
    nodeOptions,
    heapLimitMB,
    pid: process.pid,
    nodeVersion: process.version,
    gcExposed: typeof global.gc === 'function',
  });
}).catch(() => {});

let isShuttingDown = false;
let redisSubscriber: ReturnType<typeof createRedisConnection> = null;

const SHUTDOWN_TIMEOUT_MS = Number(process.env.SHUTDOWN_TIMEOUT_MS || 25_000);
const HTTP_DRAIN_TIMEOUT_MS = Number(process.env.HTTP_DRAIN_TIMEOUT_MS || 5_000);
const BUFFER_FLUSH_TIMEOUT_MS = Number(process.env.BUFFER_FLUSH_TIMEOUT_MS || 8_000);

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T | 'timeout'> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<'timeout'>(resolve => {
    timer = setTimeout(() => resolve('timeout'), ms);
  });
  try {
    const result = await Promise.race([promise, timeout]);
    clearTimeout(timer!);
    if (result === 'timeout') {
      logger.warn(`[SHUTDOWN] ${label} timed out after ${ms}ms`);
    }
    return result;
  } catch (err) {
    clearTimeout(timer!);
    throw err;
  }
}

async function gracefulShutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info(`[SHUTDOWN] Received ${signal}, starting graceful shutdown...`, { signal });

  const forceWarnTimer = setTimeout(() => {
    logger.warn(`[SHUTDOWN] Approaching force-exit deadline — ${Math.round(SHUTDOWN_TIMEOUT_MS * 0.1 / 1000)}s remaining`);
  }, Math.round(SHUTDOWN_TIMEOUT_MS * 0.9));
  forceWarnTimer.unref();

  const forceExitTimer = setTimeout(() => {
    logger.error(`[SHUTDOWN] Force-exit after ${SHUTDOWN_TIMEOUT_MS}ms — cleanup did not finish in time`);
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExitTimer.unref();

  // ── Phase 1: Stop accepting new HTTP connections ────────────────────
  logger.info('[SHUTDOWN] Phase 1: Stop accepting new connections');
  await new Promise<void>((resolve) => {
    let drainTimer: NodeJS.Timeout | null = null;

    httpServer.close((err) => {
      if (drainTimer) { clearTimeout(drainTimer); drainTimer = null; }
      if (err) {
        logger.warn(`[SHUTDOWN] httpServer.close callback error: ${String(err)}`);
      } else {
        logger.info('[SHUTDOWN] HTTP server closed — no new connections');
      }
      resolve();
    });

    drainTimer = setTimeout(() => {
      logger.info('[SHUTDOWN] HTTP drain timeout reached, destroying remaining keep-alive connections');
      httpServer.closeAllConnections();
    }, HTTP_DRAIN_TIMEOUT_MS);
  });

  // ── Phase 2: Stop background workers and guardians ──────────────────
  logger.info('[SHUTDOWN] Phase 2: Stop background workers and guardians');
  try { stopAllBackgroundWorkers(); } catch (err: any) {
    logger.warn(`[SHUTDOWN] stopAllBackgroundWorkers failed: ${err?.message || err}`);
  }
  try { stopImportGuardian(); } catch (err: any) {
    logger.warn(`[SHUTDOWN] stopImportGuardian failed: ${err?.message || err}`);
  }
  try { stopCampaignGuardian(); } catch (err: any) {
    logger.warn(`[SHUTDOWN] stopCampaignGuardian failed: ${err?.message || err}`);
  }
  try { stopMetricsCollector(); } catch (err: any) {
    logger.warn(`[SHUTDOWN] stopMetricsCollector failed: ${err?.message || err}`);
  }
  logger.info('[SHUTDOWN] Background workers stopped');

  // ── Phase 3: Flush in-memory buffers (BEFORE closing pools) ─────────
  logger.info('[SHUTDOWN] Phase 3: Flush in-memory tracking and bounce buffers');
  try {
    const { stopTrackingBufferFlusher } = await import("./tracking-buffer");
    const result = await withTimeout(stopTrackingBufferFlusher(), BUFFER_FLUSH_TIMEOUT_MS, 'tracking buffer flush');
    if (result === 'timeout') {
      logger.warn('[SHUTDOWN] Tracking buffer flush timed out — some events may be lost');
    } else {
      logger.info('[SHUTDOWN] Tracking buffer flushed successfully');
    }
  } catch (err: any) {
    logger.warn(`[SHUTDOWN] Tracking buffer flush failed: ${err?.message || err}`);
  }
  try {
    const { stopBounceBufferFlusher } = await import("./bounce-buffer");
    const result = await withTimeout(stopBounceBufferFlusher(), BUFFER_FLUSH_TIMEOUT_MS, 'bounce buffer flush');
    if (result === 'timeout') {
      logger.warn('[SHUTDOWN] Bounce buffer flush timed out — some events may be lost');
    } else {
      logger.info('[SHUTDOWN] Bounce buffer flushed successfully');
    }
  } catch (err: any) {
    logger.warn(`[SHUTDOWN] Bounce buffer flush failed: ${err?.message || err}`);
  }

  // ── Phase 4: Close queues and Redis ─────────────────────────────────
  logger.info('[SHUTDOWN] Phase 4: Close message queues and Redis');
  const queueResults = await Promise.allSettled([
    messageQueue.shutdown(),
    closeBullMQWorkers(),
    closeQueues(),
    redisSubscriber?.quit(),
  ]);
  for (let i = 0; i < queueResults.length; i++) {
    const r = queueResults[i];
    if (r.status === 'rejected') {
      const labels = ['messageQueue.shutdown', 'closeBullMQWorkers', 'closeQueues', 'redisSubscriber.quit'];
      logger.warn(`[SHUTDOWN] ${labels[i]} failed: ${r.reason?.message || r.reason}`);
    }
  }

  try {
    await closeRedisConnections();
    logger.info('[SHUTDOWN] Redis connections closed');
  } catch (err: any) {
    logger.warn(`[SHUTDOWN] closeRedisConnections failed: ${err?.message || err}`);
  }

  // ── Phase 5: Close database pools ───────────────────────────────────
  logger.info('[SHUTDOWN] Phase 5: Close database pools');
  try {
    const { closeTrackingPool } = await import("./tracking-pool");
    await closeTrackingPool();
    logger.info('[SHUTDOWN] Tracking pool closed');
  } catch (err: any) {
    logger.warn(`[SHUTDOWN] closeTrackingPool failed: ${err?.message || err}`);
  }
  try {
    const { closeImportPool } = await import("./import-pool");
    await closeImportPool();
    logger.info('[SHUTDOWN] Import pool closed');
  } catch (err: any) {
    logger.warn(`[SHUTDOWN] closeImportPool failed: ${err?.message || err}`);
  }

  try {
    const { pool } = await import("./db");
    await pool.end();
    logger.info('[SHUTDOWN] Main database pool closed');
  } catch (err: any) {
    logger.warn(`[SHUTDOWN] Main pool close failed: ${err?.message || err}`);
  }

  logger.info('[SHUTDOWN] Graceful shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

const app = express();
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "blob:", "https:"],
      connectSrc: ["'self'", "wss:", "ws:"],
    },
  },
}));
const corsOrigins = process.env.CORS_ORIGINS?.split(',').map(o => o.trim()).filter(Boolean);
app.use(cors({
  origin: corsOrigins && corsOrigins.length > 0 ? corsOrigins : false,
  credentials: true,
}));
app.set('trust proxy', 1);

const httpServer = createServer(app);

registerMetricsRoute(app);

if (process.env.NODE_ENV === "production") {
  const distPath = path.resolve(__dirname, "public");
  if (fs.existsSync(distPath)) {
    app.use(express.static(distPath, { maxAge: '1y', immutable: true }));
  }
}

app.use((req: Request, res: Response, next: NextFunction) => {
  const requestId = (req.headers['x-request-id'] as string) || crypto.randomUUID();
  res.setHeader('x-request-id', requestId);
  req.requestId = requestId;
  next();
});

app.use((req: Request, res: Response, next: NextFunction) => {
  if (isShuttingDown) {
    res.status(503).json({ error: 'Server is shutting down' });
    return;
  }
  next();
});

// Load-shedding: reject non-critical requests with 503 + Retry-After when
// the main pool is already saturated. Critical paths (health, metrics,
// tracking, webhooks, auth) bypass this check.
app.use(loadShedMiddleware);

// Per-request DB connection lease accounting (cap = MAX_CONNECTIONS_PER_REQUEST,
// default 2). Must run before any handler that opens DB clients so the
// AsyncLocalStorage context is set. Pairs with installRequestLeaseTracker()
// below which monkey-patches pool.connect to attribute checkouts to routes.
installRequestLeaseTracker();
app.use(requestLeaseMiddleware);
// Upgrade any 500 to 503+Retry-After when a pool checkout error happened
// during this request — guarantees no per-handler 500-from-saturation gaps.
app.use(poolErrorResponseUpgrade);

const PostgresSessionStore = connectPg(session);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

declare module "express-serve-static-core" {
  interface Request {
    requestId?: string;
  }
}

declare module "express-session" {
  interface SessionData {
    csrfToken?: string;
    userId?: string;
  }
}

app.use(
  express.json({
    limit: "10mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false }));

app.use((req: Request, res: Response, next: NextFunction) => {
  const longPaths = ['/api/import', '/api/campaigns', '/api/export', '/api/subscribers/flush', '/api/segments'];
  const isLongRequest = longPaths.some(p => req.path.startsWith(p));
  const timeout = isLongRequest ? 300000 : 30000;
  
  req.setTimeout(timeout);
  res.setTimeout(timeout, () => {
    if (!res.headersSent) {
      logger.error('Request timed out', { method: req.method, path: req.path, timeout });
      res.status(408).json({ error: "Request timed out" });
    }
  });
  next();
});

// Bootstrap the session table once at startup (instead of letting
// connect-pg-simple lazily CREATE TABLE on every cold-start request — that
// path acquires a pool connection and runs DDL inside the request lifecycle,
// which has caused stalls when the main pool is saturated). The bootstrap
// itself runs fire-and-forget inside the startup IIFE further down; here we
// just make sure connect-pg-simple does NOT try to lazily create the table.
const sessionMiddleware = session({
  store: new PostgresSessionStore({
    pool,
    createTableIfMissing: false,
    pruneSessionInterval: 900,
  }),
  secret: (() => {
    const secret = process.env.SESSION_SECRET;
    if (!secret && process.env.NODE_ENV === "production") {
      throw new Error("SESSION_SECRET environment variable is required in production");
    }
    return secret || "development_secret";
  })(),
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === "production",
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000,
  },
});

// Tracking endpoints must skip session middleware so they never acquire a
// connection from the main pool (connect-pg-simple writes to the session
// table per request). `/c/` and `/u/` are the branded short tracking URLs
// added in the link-registry migration; previous oversight had them going
// through session, which silently negated the tracking-pool isolation.
const sessionSkipPaths = ['/api/track/', '/api/unsubscribe/', '/api/webhooks/', '/api/health', '/metrics', '/t/', '/w/', '/c/', '/u/', '/api/jobs/stream', '/favicon.ico'];

app.use((req: Request, res: Response, next: NextFunction) => {
  if (sessionSkipPaths.some(p => req.path.startsWith(p))) {
    return next();
  }
  sessionMiddleware(req, res, next);
});

app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.session && !req.session.csrfToken) {
    req.session.csrfToken = crypto.randomUUID();
  }
  next();
});

app.get('/api/csrf-token', (req: Request, res: Response) => {
  res.json({ csrfToken: req.session.csrfToken });
});

app.post('/api/auth/register', async (req: Request, res: Response) => {
  const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || req.socket?.remoteAddress || 'unknown';
  logger.warn('Registration attempt blocked (registration disabled)', { ip, username: req.body?.username });
  return res.status(403).json({ error: 'Registration is disabled. Contact the administrator.' });
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }
    if (typeof username !== 'string' || username.length < 3 || username.length > 50) {
      return res.status(400).json({ error: 'Username must be 3-50 characters' });
    }
    if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
      return res.status(400).json({ error: 'Password must be 8-128 characters' });
    }
    
    const { storage } = await import("./storage");
    
    const existingUser = await storage.getUserByUsername(username);
    if (existingUser) {
      return res.status(409).json({ error: 'Username already taken' });
    }
    
    const user = await storage.createUser({ username, password });
    req.session.userId = user.id;
    req.session.csrfToken = crypto.randomUUID();
    req.session.save((err) => {
      if (err) {
        logger.error('Session save error on register', { error: String(err) });
        return res.status(500).json({ error: 'Registration failed' });
      }
      res.status(201).json({ user: { id: user.id, username: user.username }, csrfToken: req.session.csrfToken });
    });
  } catch (error: any) {
    logger.error('Registration error', { error: error.message });
    res.status(500).json({ error: 'Registration failed' });
  }
});

const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: "Too many login attempts, please try again later" },
});

app.post('/api/auth/login', authRateLimiter, async (req: Request, res: Response) => {
  const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || req.socket?.remoteAddress || 'unknown';
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }
    
    const bcrypt = await import("bcrypt");
    const { storage } = await import("./storage");
    
    const user = await storage.getUserByUsername(username);
    if (!user) {
      logger.warn('Login failed: unknown username', { ip, username });
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      logger.warn('Login failed: wrong password', { ip, username });
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    logger.info('Login successful', { ip, username, userId: user.id });
    req.session.userId = user.id;
    req.session.csrfToken = crypto.randomUUID();
    req.session.save((err) => {
      if (err) {
        logger.error('Session save error on login', { error: String(err) });
        return res.status(500).json({ error: 'Login failed' });
      }
      res.json({ user: { id: user.id, username: user.username }, csrfToken: req.session.csrfToken });
    });
  } catch (error: any) {
    logger.error('Login error', { ip, error: error.message });
    res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/api/auth/reset-password', async (req: Request, res: Response) => {
  const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || req.socket?.remoteAddress || 'unknown';
  try {
    const { token, newPassword } = req.body;
    if (!token || !newPassword) {
      return res.status(400).json({ error: 'Token and new password required' });
    }
    if (typeof newPassword !== 'string' || newPassword.length < 8 || newPassword.length > 128) {
      return res.status(400).json({ error: 'Password must be 8-128 characters' });
    }

    const secret = process.env.SESSION_SECRET;
    if (!secret) {
      logger.error('SESSION_SECRET not configured for password reset');
      return res.status(500).json({ error: 'Server configuration error' });
    }

    const parts = String(token).split('.');
    if (parts.length !== 2) {
      return res.status(400).json({ error: 'Invalid reset token format' });
    }
    const [encodedPayload, providedHmac] = parts;

    let payload: string;
    try {
      payload = Buffer.from(encodedPayload, 'base64url').toString('utf8');
    } catch {
      return res.status(400).json({ error: 'Invalid reset token' });
    }

    const expectedHmac = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    const hmacBuf = Buffer.from(providedHmac.padEnd(expectedHmac.length, '0'), 'hex');
    const expectedBuf = Buffer.from(expectedHmac, 'hex');
    const valid = hmacBuf.length === expectedBuf.length && crypto.timingSafeEqual(hmacBuf, expectedBuf);
    if (!valid) {
      logger.warn('Password reset attempt with invalid token signature', { ip });
      return res.status(400).json({ error: 'Invalid or expired reset token' });
    }

    const [userId, expiresAtStr] = payload.split('|');
    const expiresAt = parseInt(expiresAtStr, 10);
    if (!userId || isNaN(expiresAt) || Date.now() > expiresAt) {
      logger.warn('Password reset attempt with expired token', { ip, userId });
      return res.status(400).json({ error: 'Reset token has expired' });
    }

    const bcrypt = await import('bcrypt');
    const { storage } = await import('./storage');

    const user = await storage.getUserById(userId);
    if (!user) {
      return res.status(400).json({ error: 'Invalid reset token' });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 12);
    await storage.updateUserPassword(userId, hashedPassword);

    logger.info('Password reset successful', { ip, username: user.username, userId });
    res.json({ success: true });
  } catch (error: any) {
    logger.error('Password reset error', { ip, error: error.message });
    res.status(500).json({ error: 'Password reset failed' });
  }
});

app.post('/api/auth/logout', (req: Request, res: Response) => {
  req.session.destroy((err) => {
    if (err) {
      logger.error('Logout error', { error: String(err) });
      return res.status(500).json({ error: 'Logout failed' });
    }
    res.clearCookie('connect.sid');
    res.json({ success: true });
  });
});

app.get('/api/auth/me', async (req: Request, res: Response) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  try {
    const { storage } = await import("./storage");
    const user = await storage.getUserById(req.session.userId);
    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }
    res.json({ user });
  } catch (error: any) {
    logger.error('Auth check error', { error: error.message });
    res.status(500).json({ error: 'Auth check failed' });
  }
});

app.use((req: Request, res: Response, next: NextFunction) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return next();
  }
  if (req.path.startsWith('/api/auth/')) {
    return next();
  }
  if (req.path.startsWith('/api/track/') || req.path.startsWith('/api/unsubscribe/')) {
    return next();
  }
  // Branded short URLs (POST /u/:token is the RFC 8058 one-click unsubscribe).
  if (req.path.startsWith('/c/') || req.path.startsWith('/u/')) {
    return next();
  }
  if (req.path.startsWith('/api/webhooks/')) {
    return next();
  }
  if (req.path === '/metrics') {
    return next();
  }
  const csrfToken = req.headers['x-csrf-token'] as string;
  const sessionToken = req.session.csrfToken;
  if (!csrfToken || !sessionToken || csrfToken.length !== sessionToken.length || !crypto.timingSafeEqual(Buffer.from(csrfToken), Buffer.from(sessionToken))) {
    return res.status(403).json({ error: 'Invalid CSRF token' });
  }
  next();
});

export function log(message: string, source = "express") {
  logger.debug(message, { source });
}

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || req.socket?.remoteAddress || 'unknown';
      const reqId = req.requestId || '-';
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms [${ip}] rid=${reqId}`;
      const sensitivePatterns = ['subscribers', 'mtas', 'auth'];
      const isSensitive = sensitivePatterns.some(p => path.includes(p));
      if (capturedJsonResponse && !isSensitive) {
        const bodyStr = JSON.stringify(capturedJsonResponse);
        logLine += ` :: ${bodyStr.length > 200 ? bodyStr.substring(0, 200) + '...' : bodyStr}`;
      }

      log(logLine);
    }
  });

  next();
});

app.use(metricsMiddleware);

app.use((req: Request, res: Response, next: NextFunction) => {
  if (!req.path.startsWith('/api/')) return next();
  
  const publicPaths = [
    '/api/auth/',
    '/api/csrf-token',
    '/api/track/',
    '/api/unsubscribe/',
    '/api/webhooks/',
    '/api/health',
    '/metrics',
  ];
  if (publicPaths.some(p => req.path.startsWith(p))) return next();
  
  if (!req.session?.userId) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  next();
});

let startupComplete = false;

app.get("/api/health/startup", (_req: Request, res: Response) => {
  res.json({
    status: startupComplete ? "ready" : "starting",
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

(async () => {
  const port = parseInt(process.env.PORT || "5000", 10);
  await new Promise<void>((resolve) => {
    httpServer.listen({ port, host: "0.0.0.0", reusePort: true }, () => {
      log(`serving on port ${port} (startup phase — loading routes and migrations)`);
      resolve();
    });
  });

  pool.query(`
    CREATE TABLE IF NOT EXISTS "session" (
      "sid" varchar NOT NULL COLLATE "default",
      "sess" json NOT NULL,
      "expire" timestamp(6) NOT NULL,
      CONSTRAINT "session_pkey" PRIMARY KEY ("sid") NOT DEFERRABLE INITIALLY IMMEDIATE
    );
  `).catch((err) => {
    logger.warn(`[SESSION] CREATE TABLE failed (likely already exists): ${err?.message || err}`);
  });
  pool.query(`CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");`)
    .catch(() => {});

  await registerRoutes(httpServer, app);

  app.use(poolErrorHandler);

  app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    let message = "Internal Server Error";
    if (status < 500) {
      message = err.message || "Internal Server Error";
    } else if (req.path.includes('/import')) {
      message = "Import operation failed. The server may be under heavy load — please try again in a few moments.";
    } else if (err.code === 'ENOMEM' || (err.message && err.message.includes('memory'))) {
      message = "Server is temporarily overloaded. Please try again shortly.";
    }
    const reqId = req.requestId || '-';
    logger.error('Unhandled route error', { status, error: err.message, stack: err.stack, path: req.path, method: req.method, requestId: reqId });
    if (status >= 500) {
      tryLogSystemError(`HTTP ${status} — ${req.method} ${req.path} rid=${reqId}`, {
        error: err.message,
        stack: err.stack,
        code: err.code,
        requestId: reqId,
      });
    }
    if (!res.headersSent) {
      res.status(status).json({ error: message });
    }
  });

  pool.on('error', (err: Error) => {
    tryLogSystemError('DB pool error on idle client', { error: err.message });
  });

  if (process.env.NODE_ENV === "production") {
    serveStatic(app, true);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  startupComplete = true;
  log(`serving on port ${port} — routes and static files ready`);

  // ── Persistent import-upload directory safety check ─────────────────
  // In production the import upload dir MUST live outside process.cwd()
  // (the app directory) — otherwise `git pull` / atomic deploys / PM2
  // reloads can wipe queued CSVs and silently break in-flight imports.
  try {
    const { UPLOADS_DIR_BASE, CHUNKS_DIR_BASE, getUploadDirStatus, formatUploadDirError } = await import("./upload");
    const cwd = path.resolve(process.cwd());
    const insideCwd = (p: string) => {
      const rel = path.relative(cwd, p);
      return !rel.startsWith("..") && !path.isAbsolute(rel);
    };
    const uploadInsideCwd = insideCwd(UPLOADS_DIR_BASE);
    const chunksInsideCwd = insideCwd(CHUNKS_DIR_BASE);
    logger.info(`[IMPORT] Upload dir: ${UPLOADS_DIR_BASE} (chunks: ${CHUNKS_DIR_BASE})`);

    // Surface boot-time mkdir/writability failures via the in-app system
    // error store so operators see the actionable recovery command in both
    // web-err.log AND the admin UI. The upload route returns 503 when this
    // is the case, so the rest of the app keeps serving normally.
    const dirStatus = getUploadDirStatus();
    if (!dirStatus.uploads.ready) {
      logger.error(formatUploadDirError(dirStatus.uploads));
      tryLogSystemError("Import upload dir not writable — CSV imports disabled", {
        path: dirStatus.uploads.path,
        errorCode: dirStatus.uploads.errorCode,
        error: dirStatus.uploads.error,
      });
    }
    if (!dirStatus.chunks.ready) {
      logger.error(formatUploadDirError(dirStatus.chunks));
      tryLogSystemError("Import chunks dir not writable — chunked CSV uploads disabled", {
        path: dirStatus.chunks.path,
        errorCode: dirStatus.chunks.errorCode,
        error: dirStatus.chunks.error,
      });
    }

    if (process.env.NODE_ENV === "production" && (uploadInsideCwd || chunksInsideCwd)) {
      logger.error(
        `[IMPORT] CRITICAL: import upload dir is inside the app directory (${cwd}). ` +
        `Set IMPORT_UPLOAD_DIR (and optionally IMPORT_CHUNKS_DIR) to a path on a ` +
        `persistent volume — e.g. /var/lib/critsend/uploads/imports — or queued ` +
        `CSV imports will be wiped by every deploy / PM2 restart.`
      );
      tryLogSystemError("Import upload dir inside app directory in production", {
        uploadDir: UPLOADS_DIR_BASE,
        chunksDir: CHUNKS_DIR_BASE,
        cwd,
      });
    }
  } catch (err: any) {
    logger.warn(`[IMPORT] Upload dir safety check failed: ${err?.message || err}`);
  }

  // ── Background initialization (non-blocking) ─────────────────────────
  // Everything below runs AFTER the server is fully serving requests.

  validateConnectionBudget();

  const { probeTrackingPool } = await import("./tracking-pool");
  const { probeImportPool } = await import("./import-pool");
  probeTrackingPool().catch(() => {});
  probeImportPool();

  const { warmTokenCache, warmLinkCache } = await import("./tracking-queries");
  Promise.all([warmTokenCache(), warmLinkCache()]).catch((err) => {
    logger.warn(`[CACHE WARM] Failed (non-fatal): ${err?.message || err}`);
  });

  const { runImportBootstrapMigrations } = await import("./routes/import-export");
  runImportBootstrapMigrations().catch((err) => {
    logger.error(`[BOOTSTRAP] Import bootstrap failed (non-fatal): ${err?.message || err}`);
  });

  const { runAutomationBootstrapMigrations } = await import("./services/automation-engine");
  runAutomationBootstrapMigrations().catch((err) => {
    logger.error(`[BOOTSTRAP] Automation bootstrap failed (non-fatal): ${err?.message || err}`);
  });

  // Marketing Pressure Guard (Task #144) — adds last_sent_at, deferred_count,
  // eligible_at columns + partial index + audit table. Idempotent + advisory-
  // locked so the worker process can also call it safely.
  const { runPressureGuardBootstrap } = await import("./services/pressure-guard");
  runPressureGuardBootstrap().catch((err) => {
    logger.error(`[BOOTSTRAP] Pressure-guard bootstrap failed (non-fatal): ${err?.message || err}`);
  });

  const { runAnalyticsBootstrapMigrations } = await import("./repositories/analytics-ops");
  runAnalyticsBootstrapMigrations();

  const { ensureSegmentNameTrigramIndex, ensureSegmentNameLowerIndex } = await import("./repositories/subscriber-repository");
  ensureSegmentNameTrigramIndex()
    .catch((err: any) => logger.error('[BOOTSTRAP] Failed to create segment name trigram index (non-fatal):', err?.message || err));
  ensureSegmentNameLowerIndex()
    .catch((err: any) => logger.error('[BOOTSTRAP] Failed to create segment name lower index (non-fatal):', err?.message || err));

  const { ensureCampaignNameTrigramIndex, ensureCampaignSubjectTrigramIndex, ensureCampaignOriginalsListIndex } = await import("./repositories/campaign-repository");
  ensureCampaignNameTrigramIndex()
    .catch((err: any) => logger.error('[BOOTSTRAP] Failed to create campaign name trigram index (non-fatal):', err?.message || err));
  ensureCampaignSubjectTrigramIndex()
    .catch((err: any) => logger.error('[BOOTSTRAP] Failed to create campaign subject trigram index (non-fatal):', err?.message || err));
  ensureCampaignOriginalsListIndex()
    .catch((err: any) => logger.error('[BOOTSTRAP] Failed to create campaign originals list index (non-fatal):', err?.message || err));

  const { ensureMtaNameTrigramIndex, ensureMtaHostnameTrigramIndex } = await import("./repositories/mta-repository");
  ensureMtaNameTrigramIndex()
    .catch((err: any) => logger.error('[BOOTSTRAP] Failed to create MTA name trigram index (non-fatal):', err?.message || err));
  ensureMtaHostnameTrigramIndex()
    .catch((err: any) => logger.error('[BOOTSTRAP] Failed to create MTA hostname trigram index (non-fatal):', err?.message || err));

  const { startTrackingBufferFlusher } = await import("./tracking-buffer");
  startTrackingBufferFlusher();

  const { startBounceBufferFlusher } = await import("./bounce-buffer");
  startBounceBufferFlusher();

  // Counter reconciler is started AFTER analytics rollup completes (see below)
  // to avoid concurrent heavy queries on the main pool during cold start.

  initQueues();

  if (isRedisConfigured) {
    redisSubscriber = createRedisConnection("sse-subscriber");
    if (redisSubscriber) {
      startRedisProgressBridge(redisSubscriber);
      logger.info("[SSE] Redis progress bridge started");
      try {
        const { startAnalyticsInvalidationSubscriber } = await import("./repositories/analytics-ops");
        startAnalyticsInvalidationSubscriber(redisSubscriber);
        logger.info("[ANALYTICS] Cache invalidation subscriber started");
      } catch (err) {
        logger.warn(`[ANALYTICS] Failed to start invalidation subscriber: ${(err as Error).message}`);
      }
    }
  } else {
    logger.info("[SSE] Redis not configured — progress events via in-process EventEmitter (monolith mode)");
  }

  startMetricsCollector();
  messageQueue.initialize().catch(err => logger.error('Message queue init failed', { error: String(err) }));

  if (process.env.PROCESS_TYPE !== 'web' && process.env.DISABLE_WORKERS !== 'true') {
    logger.info("[MONOLITH] PROCESS_TYPE is not 'web' — starting background workers in-process");
    await startAllWorkers();
    startBullMQWorkers();

    const STARTUP_DELAY_MS = Number(process.env.WORKER_STARTUP_DELAY_MS || 300_000);
    logger.info(`[MONOLITH] Deferring analytics + counter reconciler by ${STARTUP_DELAY_MS}ms to avoid startup storm`);
    setTimeout(async () => {
      try {
        const { runEngagementBackfillOnce, runAnalyticsRollupSmart, runAnalyticsRollup } = await import("./repositories/analytics-ops");

        await runEngagementBackfillOnce().catch((err) =>
          logger.error("[ANALYTICS_BACKFILL] Engagement backfill failed", { error: String(err) })
        );

        await runAnalyticsRollupSmart().catch((err) =>
          logger.error("[ANALYTICS_ROLLUP] Initial smart rollup failed", { error: String(err) })
        );

        const { startCounterReconciler } = await import("./workers/counter-reconciler");
        startCounterReconciler();
        logger.info("[MONOLITH] Counter reconciler started after analytics rollup completed");

        setInterval(() => {
          runAnalyticsRollup(7).catch((err) =>
            logger.error("[ANALYTICS_ROLLUP] Scheduled run failed", { error: String(err) })
          );
        }, 15 * 60 * 1000).unref();
      } catch (err) {
        logger.error("[MONOLITH] Deferred analytics startup failed", { error: String(err) });
      }
    }, STARTUP_DELAY_MS);
  } else if (process.env.DISABLE_WORKERS === 'true') {
    logger.info("[MONOLITH] DISABLE_WORKERS=true — background workers disabled on this instance");
    const STARTUP_DELAY_MS = Number(process.env.WORKER_STARTUP_DELAY_MS || 300_000);
    setTimeout(async () => {
      const { startCounterReconciler } = await import("./workers/counter-reconciler");
      startCounterReconciler();
      logger.info("[WEB] Counter reconciler started (deferred, no analytics rollup in web-only mode)");
    }, STARTUP_DELAY_MS);
  }

  if (process.env.PROCESS_TYPE === 'web' || process.env.DISABLE_WORKERS === 'true') {
    startImportGuardian();
    startCampaignGuardian();

    // Pressure-guard deferred-drain worker (Task #144).
    // In split-process or DISABLE_WORKERS=true deployments, the dedicated
    // worker process never runs `startAllWorkers()` (which is the only other
    // caller of `startPressureGuardWorker`). Without this, deferred rows
    // (status='pending' AND eligible_at IS NOT NULL) are produced by the
    // sender but NEVER consumed — `campaigns.deferred_count` grows
    // monotonically, the queue page shows ever-increasing "pending deferred",
    // and campaigns can never flip to 'completed', causing the campaign
    // guardian to re-enqueue them in a loop. Leader election via
    // `pg_try_advisory_lock(LOCK_KEYS.PRESSURE_DRAIN)` inside the worker
    // keeps this safe if a real worker process is later re-enabled — only
    // one node ever drains a tick.
    const { startPressureGuardWorker } = await import('./workers/pressure-guard-worker');
    startPressureGuardWorker();

    messageQueue.onMessage('import_jobs', () => {
      logger.info('[IMPORT_GUARDIAN] import_jobs NOTIFY received — scheduling fallback poll in 10 s');
      setTimeout(() => {
        triggerGuardianPoll().catch((err: any) =>
          logger.error('[IMPORT_GUARDIAN] Fallback poll error:', err?.message)
        );
      }, 10000);
    });
  }
})();
