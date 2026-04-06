import express, { type Express } from "express";
import { createServer, type Server } from "http";
import path from "path";
import rateLimit from "express-rate-limit";
import {
  IMAGES_DIR,
  cleanupOrphanedTempSessions,
  sanitizeCampaignHtml,
  parsePagination,
  validateId,
} from "./utils";
import { registerSubscriberRoutes } from "./routes/subscribers";
import { registerSegmentRoutes } from "./routes/segments";
import { registerMtaRoutes } from "./routes/mtas";
import { registerTrackingRoutes } from "./routes/tracking";
import { registerWebhookRoutes } from "./routes/webhooks";
import { registerAnalyticsRoutes } from "./routes/analytics";
import { registerAbTestingRoutes } from "./routes/ab-testing";
import { registerWarmupRoutes } from "./routes/warmup";
import { registerAutomationRoutes } from "./routes/automation";
import { registerAdvancedAnalyticsRoutes } from "./routes/advanced-analytics";
import { registerCampaignRoutes } from "./routes/campaigns";
import { registerImportExportRoutes } from "./routes/import-export";
import { registerHealthRoutes } from "./routes/health";
import { registerNullsinkRoutes } from "./routes/nullsink";
import { registerDatabaseHealthRoutes } from "./routes/database-health";

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  const generalLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests, please try again later" },
  });
  app.use("/api/", generalLimiter);

  const importLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many import requests, please try again later" },
  });
  app.use("/api/import", importLimiter);

  const campaignLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many campaign requests, please try again later" },
  });
  app.use("/api/campaigns", campaignLimiter);

  const trackingLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
  });
  app.use("/api/track/", trackingLimiter);
  app.use("/api/unsubscribe/", trackingLimiter);
  app.use("/c/", trackingLimiter);
  app.use("/u/", trackingLimiter);

  const webhookLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many webhook requests, please try again later" },
  });
  app.use("/api/webhooks/", webhookLimiter);

  // Legacy static serving — backward compat for old campaign image URLs
  app.use("/images", express.static(IMAGES_DIR));

  // Stable branded image URLs: /campaigns/{year}/{month}/{campaignId}/{filename}
  // Year/month are semantic only — files live at images/{campaignId}/{filename} on disk
  app.get("/campaigns/:year/:month/:campaignId/:filename", (req, res) => {
    const { year, month, campaignId, filename } = req.params;
    // Validate all path segments to prevent directory traversal
    const segmentPattern = /^[a-zA-Z0-9_-]+$/;
    const filePattern = /^[a-zA-Z0-9._-]+$/;
    if (
      !segmentPattern.test(year) || !segmentPattern.test(month) ||
      !segmentPattern.test(campaignId) || !filePattern.test(filename)
    ) {
      return res.status(400).end();
    }
    const filePath = path.resolve(IMAGES_DIR, campaignId, filename);
    res.sendFile(filePath, (err) => {
      if (err && !res.headersSent) res.status(404).end();
    });
  });
  
  cleanupOrphanedTempSessions();
  setInterval(cleanupOrphanedTempSessions, 60 * 60 * 1000);
  
  const helpers = { parsePagination, validateId, sanitizeCampaignHtml };
  registerHealthRoutes(app);
  registerNullsinkRoutes(app, helpers);
  registerSubscriberRoutes(app, helpers);
  registerSegmentRoutes(app, helpers);
  registerMtaRoutes(app, helpers);
  registerTrackingRoutes(app);
  registerWebhookRoutes(app);
  registerAnalyticsRoutes(app, helpers);
  registerAbTestingRoutes(app, helpers);
  registerWarmupRoutes(app, helpers);
  registerAutomationRoutes(app, helpers);
  registerAdvancedAnalyticsRoutes(app);
  registerCampaignRoutes(app, helpers, campaignLimiter);
  registerImportExportRoutes(app, helpers);
  registerDatabaseHealthRoutes(app);

  return httpServer;
}
