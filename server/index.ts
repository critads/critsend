import express, { type Request, Response, NextFunction } from "express";
import session from "express-session";
import connectPg from "connect-pg-simple";
import crypto from "crypto";
import { registerRoutes, startTagQueueWorker, stopAllBackgroundWorkers } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";
import { pool } from "./db";
import { logger } from "./logger";

process.on('unhandledRejection', (reason, promise) => {
  logger.fatal('Unhandled Promise Rejection', { reason: String(reason) });
});

process.on('uncaughtException', (error) => {
  logger.fatal('Uncaught Exception', { error: error.message, stack: error.stack });
  process.exit(1);
});

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
    logger.info('Background workers stopped');
    
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
const httpServer = createServer(app);

app.use((req: Request, res: Response, next: NextFunction) => {
  if (isShuttingDown) {
    res.status(503).json({ error: 'Server is shutting down' });
    return;
  }
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
  const longPaths = ['/api/import', '/api/campaigns', '/api/export', '/api/subscribers/flush'];
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
    secret: process.env.SESSION_SECRET || "development_secret",
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === "production",
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
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

app.use((req: Request, res: Response, next: NextFunction) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return next();
  }
  if (req.path.startsWith('/api/track/') || req.path.startsWith('/api/unsubscribe/')) {
    return next();
  }
  if (req.path.startsWith('/api/webhooks/')) {
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
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
  await registerRoutes(httpServer, app);
  
  // Start the tag queue worker for reliable tracking tag additions
  startTagQueueWorker();

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = status >= 500 ? "Internal Server Error" : (err.message || "Internal Server Error");
    logger.error('Unhandled route error', { status, error: err.message, stack: err.stack });
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
