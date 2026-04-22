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
import { loadShedMiddleware, poolErrorHandler } from "./middleware/pool-safety";

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

async function gracefulShutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  
  logger.info(`Received ${signal}, starting graceful shutdown...`, { signal });
  
  const SHUTDOWN_TIMEOUT = 15000;
  const CONNECTION_DRAIN_TIMEOUT = 5000;
  
  const forceExitTimer = setTimeout(() => {
    logger.error('Graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT);
  forceExitTimer.unref();
  
  try {
    httpServer.close((err) => {
      if (err) {
        logger.error('Error closing HTTP server', { error: String(err) });
      } else {
        logger.info('HTTP server closed - no new connections');
      }
    });
    
    setTimeout(() => {
      logger.info('Destroying remaining keep-alive connections');
      httpServer.closeAllConnections();
    }, CONNECTION_DRAIN_TIMEOUT);
    
    stopAllBackgroundWorkers();
    stopImportGuardian();
    stopCampaignGuardian();
    stopMetricsCollector();
    logger.info('Background workers stopped');

    await Promise.allSettled([
      messageQueue.shutdown(),
      closeBullMQWorkers(),
      closeQueues(),
      redisSubscriber?.quit(),
    ]);

    await closeRedisConnections();
    
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Drain buffered tracking events before closing the dedicated pool.
    try {
      const { stopTrackingBufferFlusher } = await import("./tracking-buffer");
      await stopTrackingBufferFlusher();
    } catch (err: any) {
      logger.warn(`[TRACKING BUFFER] stop failed: ${err?.message || err}`);
    }
    try {
      const { stopBounceBufferFlusher } = await import("./bounce-buffer");
      await stopBounceBufferFlusher();
    } catch (err: any) {
      logger.warn(`[BOUNCE BUFFER] stop failed: ${err?.message || err}`);
    }
    try {
      const { closeTrackingPool } = await import("./tracking-pool");
      await closeTrackingPool();
    } catch {}

    const { pool } = await import("./db");
    await pool.end();
    logger.info('Database pool closed');
    
    logger.info('Graceful shutdown complete');
  } catch (err) {
    logger.error('Error during shutdown', { error: String(err) });
  }
  
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

app.use((req: Request, res: Response, next: NextFunction) => {
  const requestId = (req.headers['x-request-id'] as string) || crypto.randomUUID();
  res.setHeader('x-request-id', requestId);
  (req as any).requestId = requestId;
  next();
});

const PostgresSessionStore = connectPg(session);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
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
const sessionSkipPaths = ['/api/track/', '/api/unsubscribe/', '/api/webhooks/', '/api/health', '/metrics', '/t/', '/w/', '/c/', '/u/'];

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
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms [${ip}]`;
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
  
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  next();
});

(async () => {
  // Bootstrap connect-pg-simple session table (idempotent). Done here so
  // we don't pay for a CREATE TABLE on the first cold-start request, and
  // so connect-pg-simple can run with createTableIfMissing:false.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "session" (
      "sid" varchar NOT NULL COLLATE "default",
      "sess" json NOT NULL,
      "expire" timestamp(6) NOT NULL,
      CONSTRAINT "session_pkey" PRIMARY KEY ("sid") NOT DEFERRABLE INITIALLY IMMEDIATE
    );
  `).catch((err) => {
    logger.warn(`[SESSION] CREATE TABLE failed (likely already exists): ${err?.message || err}`);
  });
  await pool.query(`CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");`)
    .catch(() => {});

  const { runImportBootstrapMigrations } = await import("./routes/import-export");
  await runImportBootstrapMigrations();

  // Fire-and-forget: CREATE INDEX CONCURRENTLY can take many minutes on big
  // tables (campaign_sends ≈ 14M rows, campaign_stats ≈ 5.5M rows). Don't
  // block startup; the IF NOT EXISTS guard makes it safe across restarts.
  const { runAnalyticsBootstrapMigrations } = await import("./repositories/analytics-ops");
  runAnalyticsBootstrapMigrations();

  await registerRoutes(httpServer, app);

  validateConnectionBudget();

  // Start the in-memory tracking buffer flusher (web process only — tracking
  // routes are registered here, not in worker-main.ts). Flushes every
  // TRACKING_FLUSH_INTERVAL_MS to the dedicated tracking pool.
  const { startTrackingBufferFlusher } = await import("./tracking-buffer");
  startTrackingBufferFlusher();

  // In-memory bounce buffer + batched flusher. Bounce webhooks (Mailgun/SES
  // retries) can spike to hundreds/sec; the buffer keeps that traffic off
  // the main pool by sharing the dedicated tracking pool.
  const { startBounceBufferFlusher } = await import("./bounce-buffer");
  startBounceBufferFlusher();

  initQueues();

  // Subscribe to worker-process progress events and forward them to SSE clients.
  // A dedicated subscriber connection is required because Redis subscriptions block
  // the connection for all other commands.
  if (isRedisConfigured) {
    redisSubscriber = createRedisConnection("sse-subscriber");
    if (redisSubscriber) {
      startRedisProgressBridge(redisSubscriber);
      logger.info("[SSE] Redis progress bridge started");
      // Cross-process analytics cache invalidation. The worker process
      // publishes when a campaign job finishes / rollup completes; this
      // subscription drops the cached values in the web process so the
      // next analytics read recomputes from the database. Re-uses the
      // SSE subscriber connection (subscriptions multiplex on one socket).
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

  // Monolith mode: when PROCESS_TYPE is not explicitly 'web' (i.e. the deployed
  // production environment running a single process), start all background workers
  // here so that campaign sends, imports, flushes, and tag operations continue to work.
  // In split-process mode (dev-launcher), PROCESS_TYPE=web and the dedicated
  // worker process (worker-main.ts) handles all of this instead.
  // DISABLE_WORKERS=true can be set to prevent this instance from running workers
  // (e.g. a Replit-published app sharing a DB with a self-hosted PM2 deployment,
  // where uploaded files only exist on the PM2 server's filesystem).
  if (process.env.PROCESS_TYPE !== 'web' && process.env.DISABLE_WORKERS !== 'true') {
    logger.info("[MONOLITH] PROCESS_TYPE is not 'web' — starting background workers in-process");
    await startAllWorkers();
    startBullMQWorkers();

    // In split-process production this scheduler lives in worker-main.ts; in
    // monolith mode the web process IS the worker, so schedule it here too
    // (gated by the same DISABLE_WORKERS check) — otherwise the rollup never
    // refreshes and analytics queries that depend on analytics_daily would
    // gradually go stale.
    const { runAnalyticsRollup, runEngagementBackfillOnce } = await import("./repositories/analytics-ops");
    runEngagementBackfillOnce().catch((err) =>
      logger.error("[ANALYTICS_BACKFILL] Engagement backfill failed", { error: String(err) })
    );
    runAnalyticsRollup(3650).catch((err) =>
      logger.error("[ANALYTICS_ROLLUP] Initial backfill failed", { error: String(err) })
    );
    setInterval(() => {
      runAnalyticsRollup(7).catch((err) =>
        logger.error("[ANALYTICS_ROLLUP] Scheduled run failed", { error: String(err) })
      );
    }, 15 * 60 * 1000).unref();
  } else if (process.env.DISABLE_WORKERS === 'true') {
    logger.info("[MONOLITH] DISABLE_WORKERS=true — background workers disabled on this instance");
  }

  // Always start the import guardian in the web process (PROCESS_TYPE=web or DISABLE_WORKERS=true).
  // It polls every 30 s for pending import jobs that have been waiting > 60 s without a worker
  // claiming them. SKIP LOCKED makes it safe even when the dedicated worker IS alive.
  if (process.env.PROCESS_TYPE === 'web' || process.env.DISABLE_WORKERS === 'true') {
    startImportGuardian();
    startCampaignGuardian();

    // When a Requeue NOTIFY arrives, run a guardian poll after 10 s.
    // This allows the real worker a short window to claim first; if it doesn't,
    // the guardian takes over — so requeue always triggers processing within ~10 s.
    messageQueue.onMessage('import_jobs', () => {
      logger.info('[IMPORT_GUARDIAN] import_jobs NOTIFY received — scheduling fallback poll in 10 s');
      setTimeout(() => {
        triggerGuardianPoll().catch((err: any) =>
          logger.error('[IMPORT_GUARDIAN] Fallback poll error:', err?.message)
        );
      }, 10000);
    });
  }

  // Translate `pg` pool checkout timeouts into 503 + Retry-After:1 instead
  // of letting them bubble into the generic 500 handler. Must run before
  // the generic handler below.
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
    logger.error('Unhandled route error', { status, error: err.message, stack: err.stack, path: req.path, method: req.method });
    if (status >= 500) {
      tryLogSystemError(`HTTP ${status} — ${req.method} ${req.path}`, {
        error: err.message,
        stack: err.stack,
        code: err.code,
      });
    }
    if (!res.headersSent) {
      res.status(status).json({ error: message });
    }
  });

  // Second pool error listener — db.ts has the first (logger only); this one persists to DB.
  pool.on('error', (err: Error) => {
    tryLogSystemError('DB pool error on idle client', { error: err.message });
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (process.env.NODE_ENV === "production") {
    serveStatic(app, true);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || "5000", 10);
  httpServer.listen(
    {
      port,
      host: "0.0.0.0",
      reusePort: true,
    },
    () => {
      log(`serving on port ${port}`);
    },
  );
})();
