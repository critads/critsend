import express, { type Request, Response, NextFunction } from "express";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";
import session from "express-session";
import connectPg from "connect-pg-simple";
import crypto from "crypto";
import { registerRoutes } from "./routes";
import { startTagQueueWorker, stopAllBackgroundWorkers } from "./workers";
import { registerMetricsRoute, metricsMiddleware, startMetricsCollector, stopMetricsCollector } from "./metrics";
import { messageQueue } from "./message-queue";
import { serveStatic } from "./static";
import { createServer } from "http";
import { pool } from "./db";
import { logger } from "./logger";

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Promise Rejection', { reason: String(reason) });
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception (non-fatal)', { error: error.message, stack: error.stack });
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
    stopMetricsCollector();
    logger.info('Background workers stopped');
    
    await messageQueue.shutdown();
    
    await new Promise(resolve => setTimeout(resolve, 2000));
    
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

app.use((req: Request, res: Response, next: NextFunction) => {
  if (isShuttingDown) {
    res.status(503).json({ error: 'Server is shutting down' });
    return;
  }
  next();
});

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
    limit: "10mb", // Allow large HTML content for email campaigns
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false }));

// Request timeout middleware - prevents hung connections from consuming resources
app.use((req: Request, res: Response, next: NextFunction) => {
  // Long timeout for import/campaign/export endpoints that do heavy processing
  const longPaths = ['/api/import', '/api/campaigns', '/api/export', '/api/subscribers/flush', '/api/segments'];
  const isLongRequest = longPaths.some(p => req.path.startsWith(p));
  const timeout = isLongRequest ? 300000 : 30000; // 5min for heavy ops, 30s for normal
  
  req.setTimeout(timeout);
  res.setTimeout(timeout, () => {
    if (!res.headersSent) {
      logger.error('Request timed out', { method: req.method, path: req.path, timeout });
      res.status(408).json({ error: "Request timed out" });
    }
  });
  next();
});

app.use(
  session({
    store: new PostgresSessionStore({
      pool,
      createTableIfMissing: true,
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
      maxAge: 24 * 60 * 60 * 1000, // 24 hours (reduced from 30 days)
    },
  })
);

app.use((req: Request, res: Response, next: NextFunction) => {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomUUID();
  }
  next();
});

app.get('/api/csrf-token', (req: Request, res: Response) => {
  res.json({ csrfToken: req.session.csrfToken });
});

app.post('/api/auth/register', async (req: Request, res: Response) => {
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
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }
    
    const bcrypt = await import("bcrypt");
    const { storage } = await import("./storage");
    
    const user = await storage.getUserByUsername(username);
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
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
    logger.error('Login error', { error: error.message });
    res.status(500).json({ error: 'Login failed' });
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
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
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
  await registerRoutes(httpServer, app);
  
  startMetricsCollector();
  messageQueue.initialize().catch(err => logger.error('Message queue init failed', { error: String(err) }));
  
  // Start the tag queue worker for reliable tracking tag additions
  startTagQueueWorker();

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
    if (!res.headersSent) {
      res.status(status).json({ error: message });
    }
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
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
