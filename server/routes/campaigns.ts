import { type Express, type Request, type Response } from "express";
import { storage } from "../storage";
import { db } from "../db";
import { sql } from "drizzle-orm";
import { insertCampaignSchema, insertCampaignDraftSchema, updateCampaignDraftSchema, campaigns, campaignJobs } from "@shared/schema";
import { z } from "zod";
import { isMemoryPressure } from "../workers";
import { logger } from "../logger";
import { messageQueue } from "../message-queue";
import { IMAGES_DIR, downloadImage, getExtensionFromUrl, sanitizeCampaignHtml } from "../utils";
import * as cheerio from "cheerio";
import * as fs from "fs";
import * as path from "path";
import type { RateLimitRequestHandler } from "express-rate-limit";

export function registerCampaignRoutes(app: Express, helpers: {
  parsePagination: (query: any) => { page: number; limit: number };
  validateId: (id: string) => boolean;
  sanitizeCampaignHtml: (html: string) => string;
}, campaignLimiter: RateLimitRequestHandler) {
  const { validateId } = helpers;

  app.post("/api/campaigns/test", async (req: Request, res: Response) => {
    try {
      const { 
        email, 
        mtaId,
        fromName, 
        fromEmail, 
        subject, 
        preheader, 
        htmlContent,
        companyAddress,
        unsubscribeText,
        trackOpens,
        trackClicks,
      } = req.body;
      
      if (!email || !fromEmail || !subject || !htmlContent) {
        return res.status(400).json({ error: "Missing required fields (email, fromEmail, subject, htmlContent)" });
      }
      
      let mta = null;
      if (mtaId) {
        mta = await storage.getMta(mtaId);
      }
      
      const headers: Record<string, string> = {
        "X-Test-Email": "true",
      };
      
      const defaultHeaders = await storage.getDefaultHeaders();
      const trackingDomain = mta?.trackingDomain || undefined;
      const rawTrackingDomain = trackingDomain || "";
      const normalizedDomain = rawTrackingDomain
        ? (/^https?:\/\//i.test(rawTrackingDomain) ? rawTrackingDomain : `https://${rawTrackingDomain}`).replace(/\/$/, "")
        : "";
      const testUnsubscribeUrl = normalizedDomain
        ? `${normalizedDomain}/api/unsubscribe/test-campaign/test-subscriber`
        : "#unsubscribe-placeholder";
      
      for (const header of defaultHeaders) {
        const resolvedValue = header.value.replace(/\{UNSUBSCRIBE\}/gi, testUnsubscribeUrl);
        headers[header.name] = resolvedValue;
      }
      
      if (mta) {
        logger.info(`[TEST EMAIL] Sending via MTA SMTP (${mta.name}) to: ${email}`);
        const { sendTestEmailViaSMTP } = await import("../email-service");
        
        const result = await sendTestEmailViaSMTP(mta, {
          to: email,
          fromName: fromName || "Test",
          fromEmail,
          subject,
          htmlContent,
          preheader,
          companyAddress,
          unsubscribeText,
          trackingDomain,
          headers,
        });
        
        if (result.success) {
          res.json({ success: true, messageId: result.messageId });
        } else {
          res.status(500).json({ error: result.error || "Failed to send test email via SMTP" });
        }
        return;
      }
      
      logger.info(`[TEST EMAIL] No MTA selected, using Resend API to: ${email}`);
      const { sendTestEmailViaResend } = await import("../resend-client");
      
      const result = await sendTestEmailViaResend({
        to: email,
        fromName: fromName || "Test",
        fromEmail,
        subject,
        htmlContent,
        preheader,
        companyAddress,
        unsubscribeText,
        trackingDomain,
        headers,
      });
      
      if (result.success) {
        res.json({ success: true, messageId: result.messageId });
      } else {
        res.status(500).json({ error: result.error || "Failed to send test email" });
      }
    } catch (error: any) {
      logger.error("Error sending test email:", error);
      res.status(500).json({ error: "Failed to send test email" });
    }
  });
  
  app.get("/api/campaigns", async (req: Request, res: Response) => {
    try {
      const campaignsList = await storage.getCampaigns();
      res.json(campaignsList);
    } catch (error) {
      logger.error("Error fetching campaigns:", error);
      res.status(500).json({ error: "Failed to fetch campaigns" });
    }
  });

  app.get("/api/campaigns/:id", async (req: Request, res: Response) => {
    try {
      if (!validateId(req.params.id)) {
        return res.status(400).json({ error: "Invalid ID format" });
      }
      const campaign = await storage.getCampaign(req.params.id);
      if (!campaign) {
        return res.status(404).json({ error: "Campaign not found" });
      }
      res.json(campaign);
    } catch (error) {
      logger.error("Error fetching campaign:", error);
      res.status(500).json({ error: "Failed to fetch campaign" });
    }
  });

  app.post("/api/campaign-assets/session", async (_req: Request, res: Response) => {
    const sessionId = `temp_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    res.json({ sessionId });
  });

  app.post("/api/campaigns/:id/process-html", async (req: Request, res: Response) => {
    try {
      if (!validateId(req.params.id)) {
        return res.status(400).json({ error: "Invalid ID format" });
      }
      const campaignId = req.params.id;
      const { html, mtaId: bodyMtaId } = req.body;
      
      if (!html || typeof html !== "string") {
        return res.status(400).json({ error: "HTML content is required" });
      }
      
      const validIdPattern = /^[a-zA-Z0-9_-]+$/;
      if (!validIdPattern.test(campaignId) || campaignId.length > 100) {
        return res.status(400).json({ error: "Invalid campaign ID format" });
      }
      
      const campaignImagesDir = path.join(IMAGES_DIR, campaignId);
      if (!fs.existsSync(IMAGES_DIR)) {
        fs.mkdirSync(IMAGES_DIR, { recursive: true });
      }
      if (fs.existsSync(campaignImagesDir)) {
        const files = fs.readdirSync(campaignImagesDir);
        for (const file of files) {
          fs.unlinkSync(path.join(campaignImagesDir, file));
        }
      } else {
        fs.mkdirSync(campaignImagesDir, { recursive: true });
      }

      // Resolve image hosting domain: prefer mtaId from request body (current form selection),
      // fall back to the saved campaign's MTA for backward compatibility
      let imageHostingDomain: string | null = null;
      const effectiveMtaId = bodyMtaId || (await storage.getCampaign(campaignId))?.mtaId;
      if (effectiveMtaId) {
        const mta = await storage.getMta(effectiveMtaId);
        if (mta?.imageHostingDomain) {
          const raw = mta.imageHostingDomain.replace(/\/$/, "");
          imageHostingDomain = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
        }
      }
      
      const $ = cheerio.load(html);
      const imgElements = $("img");
      const downloadedImages: { original: string; local: string }[] = [];
      const failedImages: string[] = [];
      let imageIndex = 0;
      
      const imageTasks: Array<{ el: any; src: string; currentIndex: number }> = [];
      
      imgElements.each((_, el) => {
        const src = $(el).attr("src");
        if (src && (src.startsWith("http://") || src.startsWith("https://"))) {
          imageTasks.push({ el, src, currentIndex: imageIndex++ });
        }
      });

      const { mapWithConcurrency } = await import("../utils");
      await mapWithConcurrency(imageTasks, 5, async (task) => {
        const ext = getExtensionFromUrl(task.src);
        const filename = `img_${task.currentIndex}.${ext}`;
        const destPath = path.join(campaignImagesDir, filename);
        const relativePath = `/images/${campaignId}/${filename}`;
        const localUrl = imageHostingDomain
          ? `${imageHostingDomain}${relativePath}`
          : relativePath;
        const success = await downloadImage(task.src, destPath);
        if (success) {
          $(task.el).attr("src", localUrl);
          downloadedImages.push({ original: task.src, local: localUrl });
        } else {
          failedImages.push(task.src);
        }
      });

      // Normalize any protocol-less image hosting domain URLs left in the HTML
      // (e.g. from campaigns processed before the https:// fix was applied).
      // These are already on disk — no re-download needed, just prepend https://.
      if (imageHostingDomain) {
        const rawDomain = imageHostingDomain.replace(/^https?:\/\//i, "").replace(/\/$/, "");
        $("img").each((_, el) => {
          const src = $(el).attr("src");
          if (src && src.startsWith(rawDomain + "/")) {
            $(el).attr("src", `https://${src}`);
          }
        });
      }

      const processedHtml = $.html();
      
      res.json({
        html: processedHtml,
        downloaded: downloadedImages.length,
        failed: failedImages.length,
        failedUrls: failedImages
      });
    } catch (error) {
      logger.error("Error processing HTML:", error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: `Failed to process HTML content: ${errorMessage}` });
    }
  });

  app.post("/api/campaigns", campaignLimiter, async (req: Request, res: Response) => {
    try {
      logger.info("POST /api/campaigns - Body:", JSON.stringify(req.body));

      const isDraft = req.body.status === "draft" || !req.body.status;

      const normalizedBody = {
        ...req.body,
        mtaId: req.body.mtaId || null,
        segmentId: req.body.segmentId || null,
        replyEmail: req.body.replyEmail || null,
      };

      let data: any;
      if (isDraft) {
        data = insertCampaignDraftSchema.parse(normalizedBody);
        if (!data.subject) data.subject = "(Draft)";
        if (!data.htmlContent) data.htmlContent = "";
        if (!data.fromName) data.fromName = "";
        if (!data.fromEmail) data.fromEmail = "";
      } else {
        data = insertCampaignSchema.parse(normalizedBody);
      }

      if (data.htmlContent && data.htmlContent !== "") {
        data.htmlContent = sanitizeCampaignHtml(data.htmlContent);
      }
      const campaign = await db.transaction(async (tx) => {
        const [created] = await tx.insert(campaigns).values(data).returning();
        if (created.status === "sending") {
          await tx.insert(campaignJobs).values({
            campaignId: created.id,
            status: "pending",
          });
        }
        return created;
      });

      logger.info("Campaign created successfully:", campaign.id);
      res.status(201).json(campaign);
    } catch (error) {
      if (error instanceof z.ZodError) {
        logger.error("Campaign validation error:", error.errors);
        return res.status(400).json({ error: error.errors });
      }
      logger.error("Error creating campaign:", error);
      res.status(500).json({ error: "Failed to create campaign" });
    }
  });

  app.patch("/api/campaigns/:id", async (req: Request, res: Response) => {
    try {
      if (!validateId(req.params.id)) {
        return res.status(400).json({ error: "Invalid ID format" });
      }
      logger.info(`PATCH /api/campaigns/${req.params.id} - Body:`, JSON.stringify(req.body));

      const existingCampaign = await storage.getCampaign(req.params.id);
      if (!existingCampaign) {
        return res.status(404).json({ error: "Campaign not found" });
      }

      logger.info(`Campaign ${req.params.id} current status: ${existingCampaign.status}, new status: ${req.body.status || 'unchanged'}`);

      const isDraft = existingCampaign.status === "draft";

      let normalizedBody: Record<string, any>;
      if (isDraft) {
        const parsed = updateCampaignDraftSchema.parse(req.body);
        normalizedBody = { ...parsed };
      } else {
        normalizedBody = { ...req.body };
        if ('mtaId' in normalizedBody && !normalizedBody.mtaId) {
          normalizedBody.mtaId = null;
        }
        if ('segmentId' in normalizedBody && !normalizedBody.segmentId) {
          normalizedBody.segmentId = null;
        }
        if ('replyEmail' in normalizedBody && !normalizedBody.replyEmail) {
          normalizedBody.replyEmail = null;
        }
      }

      if (normalizedBody.htmlContent && normalizedBody.htmlContent !== "") {
        normalizedBody.htmlContent = sanitizeCampaignHtml(normalizedBody.htmlContent);
      }

      const campaign = await db.transaction(async (tx) => {
        const [updated] = await tx.update(campaigns).set(normalizedBody).where(sql`${campaigns.id} = ${req.params.id}`).returning();
        if (!updated) return null;
        if (existingCampaign.status !== "sending" && updated.status === "sending") {
          logger.info(`Starting campaign ${updated.id} via PATCH - queueing for processing`);
          await tx.insert(campaignJobs).values({
            campaignId: updated.id,
            status: "pending",
          });
        }
        return updated;
      });
      if (!campaign) {
        return res.status(404).json({ error: "Campaign not found" });
      }

      if (existingCampaign.status !== "sending" && campaign.status === "sending") {
        await messageQueue.notify("campaign_jobs", { campaignId: req.params.id });
        logger.info(`[CAMPAIGN_SEND] NOTIFY sent for campaign ${req.params.id}`);
      }

      res.json(campaign);
    } catch (error) {
      if (error instanceof z.ZodError) {
        logger.error("Campaign PATCH validation error:", error.errors);
        return res.status(400).json({ error: error.errors });
      }
      logger.error("Error updating campaign:", error);
      res.status(500).json({ error: "Failed to update campaign" });
    }
  });

  app.delete("/api/campaigns/bulk", async (req: Request, res: Response) => {
    try {
      const schema = z.object({ ids: z.array(z.string()).min(1).max(200) });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "ids must be a non-empty array (max 200)" });
      }
      const { ids } = parsed.data;
      if (ids.some((id) => !validateId(id))) {
        return res.status(400).json({ error: "One or more invalid ID formats" });
      }
      await Promise.all(ids.map((id) => storage.deleteCampaign(id)));
      res.status(204).send();
    } catch (error) {
      logger.error("Error bulk-deleting campaigns:", error);
      res.status(500).json({ error: "Failed to delete campaigns" });
    }
  });

  app.delete("/api/campaigns/:id", async (req: Request, res: Response) => {
    try {
      if (!validateId(req.params.id)) {
        return res.status(400).json({ error: "Invalid ID format" });
      }
      await storage.deleteCampaign(req.params.id);
      res.status(204).send();
    } catch (error) {
      logger.error("Error deleting campaign:", error);
      res.status(500).json({ error: "Failed to delete campaign" });
    }
  });

  app.post("/api/campaigns/:id/copy", async (req: Request, res: Response) => {
    try {
      if (!validateId(req.params.id)) {
        return res.status(400).json({ error: "Invalid ID format" });
      }
      const campaign = await storage.copyCampaign(req.params.id);
      if (!campaign) {
        return res.status(404).json({ error: "Campaign not found" });
      }
      res.status(201).json(campaign);
    } catch (error) {
      logger.error("Error copying campaign:", error);
      res.status(500).json({ error: "Failed to copy campaign" });
    }
  });

  app.post("/api/campaigns/:id/pause", async (req: Request, res: Response) => {
    try {
      if (!validateId(req.params.id)) {
        return res.status(400).json({ error: "Invalid ID format" });
      }
      const campaign = await storage.updateCampaign(req.params.id, { status: "paused" });
      if (!campaign) {
        return res.status(404).json({ error: "Campaign not found" });
      }
      res.json(campaign);
    } catch (error) {
      logger.error("Error pausing campaign:", error);
      res.status(500).json({ error: "Failed to pause campaign" });
    }
  });

  app.post("/api/campaigns/:id/resume", async (req: Request, res: Response) => {
    try {
      if (!validateId(req.params.id)) {
        return res.status(400).json({ error: "Invalid ID format" });
      }
      await storage.clearStuckJobsForCampaign(req.params.id);
      
      const resetCount = await storage.resetOrphanedFailedSends(req.params.id);
      if (resetCount > 0) {
        logger.info(`[CAMPAIGN_RESUME] Reset ${resetCount} orphaned failed sends for campaign ${req.params.id}`);
      }
      
      const campaign = await db.transaction(async (tx) => {
        const [updated] = await tx.update(campaigns).set({ status: "sending", pauseReason: null }).where(sql`${campaigns.id} = ${req.params.id}`).returning();
        if (!updated) return null;
        await tx.insert(campaignJobs).values({
          campaignId: updated.id,
          status: "pending",
        });
        return updated;
      });
      if (!campaign) {
        return res.status(404).json({ error: "Campaign not found" });
      }
      
      await messageQueue.notify("campaign_jobs", { campaignId: req.params.id });
      logger.info(`[CAMPAIGN_SEND] NOTIFY sent for campaign ${req.params.id}`);
      
      res.json(campaign);
    } catch (error) {
      logger.error("Error resuming campaign:", error);
      res.status(500).json({ error: "Failed to resume campaign" });
    }
  });

  app.get("/api/campaigns/:id/errors", async (req: Request, res: Response) => {
    try {
      if (!validateId(req.params.id)) {
        return res.status(400).json({ error: "Invalid ID format" });
      }
      const campaign = await storage.getCampaign(req.params.id);
      if (!campaign) {
        return res.status(404).json({ error: "Campaign not found" });
      }
      const { logs } = await storage.getErrorLogs({
        campaignId: req.params.id,
        limit: 50,
        page: 1,
      });
      res.json({ pauseReason: campaign.pauseReason, errors: logs });
    } catch (error) {
      logger.error("Error fetching campaign errors:", error);
      res.status(500).json({ error: "Failed to fetch campaign errors" });
    }
  });

  app.post("/api/campaigns/:id/requeue", async (req: Request, res: Response) => {
    try {
      if (!validateId(req.params.id)) {
        return res.status(400).json({ error: "Invalid ID format" });
      }
      const existingCampaign = await storage.getCampaign(req.params.id);
      if (!existingCampaign) {
        return res.status(404).json({ error: "Campaign not found" });
      }
      if (existingCampaign.status !== "failed") {
        return res.status(400).json({ error: "Only failed campaigns can be requeued" });
      }

      await storage.clearStuckJobsForCampaign(req.params.id);

      const campaign = await db.transaction(async (tx) => {
        const [updated] = await tx.update(campaigns).set({
          status: "sending",
          pauseReason: null,
          sentCount: 0,
          failedCount: 0,
        }).where(sql`${campaigns.id} = ${req.params.id}`).returning();
        if (!updated) return null;
        await tx.insert(campaignJobs).values({
          campaignId: updated.id,
          status: "pending",
        });
        return updated;
      });
      if (!campaign) {
        return res.status(404).json({ error: "Campaign not found" });
      }

      await messageQueue.notify("campaign_jobs", { campaignId: req.params.id });
      logger.info(`[CAMPAIGN_REQUEUE] NOTIFY sent for campaign ${req.params.id}`);

      res.json(campaign);
    } catch (error) {
      logger.error("Error requeuing campaign:", error);
      res.status(500).json({ error: "Failed to requeue campaign" });
    }
  });

  app.post("/api/campaigns/:id/send", async (req: Request, res: Response) => {
    if (isMemoryPressure) {
      res.setHeader('Retry-After', '60');
      return res.status(503).json({ error: "Server under memory pressure. Please retry later." });
    }
    const campaignId = req.params.id;
    const timestamp = new Date().toISOString();
    const isScheduled = !!req.body.scheduledAt;
    
    if (!validateId(campaignId)) {
      return res.status(400).json({ error: "Invalid ID format" });
    }
    
    logger.info(`[CAMPAIGN_SEND] ${timestamp} - Starting ${isScheduled ? 'schedule' : 'send'} process for campaign ${campaignId}`);
    logger.info(`[CAMPAIGN_SEND] ${timestamp} - Request body:`, JSON.stringify(req.body, null, 2));
    
    try {
      const existingCampaign = await storage.getCampaign(campaignId);
      if (!existingCampaign) {
        logger.error(`[CAMPAIGN_SEND] ${timestamp} - Campaign ${campaignId} not found`);
        return res.status(404).json({ error: "Campaign not found" });
      }
      
      logger.info(`[CAMPAIGN_SEND] ${timestamp} - Campaign found, current status: ${existingCampaign.status}`);
      
      if (existingCampaign.status === "sending") {
        logger.info(`[CAMPAIGN_SEND] ${timestamp} - Campaign already sending`);
        return res.status(400).json({ error: "Campaign is already sending" });
      }
      if (existingCampaign.status === "completed") {
        logger.info(`[CAMPAIGN_SEND] ${timestamp} - Campaign already completed`);
        return res.status(400).json({ error: "Campaign has already completed" });
      }
      
      const updateData = { ...req.body };
      delete updateData.status;
      
      if (Object.keys(updateData).length > 0) {
        logger.info(`[CAMPAIGN_SEND] ${timestamp} - Saving final campaign data`);
        await storage.updateCampaign(campaignId, updateData);
      }
      
      const refreshedCampaign = await storage.getCampaign(campaignId);
      if (!refreshedCampaign) {
        logger.error(`[CAMPAIGN_SEND] ${timestamp} - Campaign disappeared after update`);
        return res.status(500).json({ error: "Campaign update failed" });
      }
      
      const validationErrors: string[] = [];
      if (!refreshedCampaign.name) validationErrors.push("Campaign name is required");
      if (!refreshedCampaign.segmentId) validationErrors.push("Segment is required");
      if (!refreshedCampaign.mtaId) validationErrors.push("MTA server is required");
      if (!refreshedCampaign.fromName) validationErrors.push("Sender name is required");
      if (!refreshedCampaign.fromEmail) validationErrors.push("Sender email is required");
      if (!refreshedCampaign.subject) validationErrors.push("Subject line is required");
      if (!refreshedCampaign.htmlContent) validationErrors.push("Email content is required");
      
      if (validationErrors.length > 0) {
        logger.error(`[CAMPAIGN_SEND] ${timestamp} - Validation failed:`, validationErrors);
        return res.status(400).json({ 
          error: "Campaign validation failed", 
          details: validationErrors 
        });
      }
      
      const mta = await storage.getMta(refreshedCampaign.mtaId!);
      if (!mta) {
        logger.error(`[CAMPAIGN_SEND] ${timestamp} - MTA not found: ${refreshedCampaign.mtaId}`);
        return res.status(400).json({ error: "Selected MTA server not found" });
      }
      if (!mta.isActive) {
        logger.error(`[CAMPAIGN_SEND] ${timestamp} - MTA is not active: ${mta.name}`);
        return res.status(400).json({ error: "Selected MTA server is not active" });
      }
      
      const segment = await storage.getSegment(refreshedCampaign.segmentId!);
      if (!segment) {
        logger.error(`[CAMPAIGN_SEND] ${timestamp} - Segment not found: ${refreshedCampaign.segmentId}`);
        return res.status(400).json({ error: "Selected segment not found" });
      }
      
      const subscriberCount = await storage.countSubscribersForSegment(refreshedCampaign.segmentId!);
      logger.info(`[CAMPAIGN_SEND] ${timestamp} - Segment '${segment.name}' has ${subscriberCount} subscribers`);
      
      if (subscriberCount === 0) {
        logger.error(`[CAMPAIGN_SEND] ${timestamp} - Segment has no subscribers`);
        return res.status(400).json({ error: "Selected segment has no subscribers" });
      }
      
      if (isScheduled) {
        logger.info(`[CAMPAIGN_SEND] ${timestamp} - Setting campaign status to 'scheduled' for ${req.body.scheduledAt}`);
        const updatedCampaign = await storage.updateCampaign(campaignId, { 
          status: "scheduled",
          scheduledAt: new Date(req.body.scheduledAt)
        });
        
        if (!updatedCampaign || updatedCampaign.status !== "scheduled") {
          logger.error(`[CAMPAIGN_SEND] ${timestamp} - Failed to schedule campaign`);
          return res.status(500).json({ error: "Failed to schedule campaign" });
        }
        
        logger.info(`[CAMPAIGN_SEND] ${timestamp} - Campaign ${campaignId} scheduled successfully`);
        return res.json({ 
          success: true, 
          campaign: updatedCampaign,
          message: `Campaign scheduled for ${subscriberCount} subscribers` 
        });
      }
      
      logger.info(`[CAMPAIGN_SEND] ${timestamp} - Setting campaign status to 'sending' and enqueuing job`);
      const updatedCampaign = await db.transaction(async (tx) => {
        const [updated] = await tx.update(campaigns).set({ status: "sending" }).where(sql`${campaigns.id} = ${campaignId}`).returning();
        if (!updated || updated.status !== "sending") return null;
        await tx.insert(campaignJobs).values({
          campaignId: updated.id,
          status: "pending",
        });
        return updated;
      });
      
      if (!updatedCampaign) {
        logger.error(`[CAMPAIGN_SEND] ${timestamp} - Failed to update campaign status`);
        return res.status(500).json({ error: "Failed to start campaign - status update failed" });
      }
      logger.info(`[CAMPAIGN_SEND] ${timestamp} - Campaign successfully queued`);
      
      await messageQueue.notify("campaign_jobs", { campaignId });
      logger.info(`[CAMPAIGN_SEND] NOTIFY sent for campaign ${campaignId}`);
      
      logger.info(`[CAMPAIGN_SEND] ${timestamp} - Campaign ${campaignId} started successfully`);
      res.json({ 
        success: true, 
        campaign: updatedCampaign,
        message: `Campaign started with ${subscriberCount} subscribers` 
      });
      
    } catch (error: any) {
      logger.error(`[CAMPAIGN_SEND] ${timestamp} - Unexpected error:`, error);
      res.status(500).json({ error: error.message || "Failed to start campaign" });
    }
  });
}
