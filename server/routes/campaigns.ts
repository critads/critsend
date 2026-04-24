import { type Express, type Request, type Response } from "express";
import { storage } from "../storage";
import { db, pool } from "../db";
import { sql } from "drizzle-orm";
import { insertCampaignSchema, insertCampaignDraftSchema, updateCampaignDraftSchema, campaigns, campaignJobs, errorLogs } from "@shared/schema";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { isMemoryPressure } from "../workers";
import { logger } from "../logger";
import { classifyDbError, userFacingMessageFor } from "../db-errors";
import { messageQueue } from "../message-queue";
import { IMAGES_DIR, downloadImage, getExtensionFromUrl, sanitizeCampaignHtml, sanitizeImageFilename, generateBase62 } from "../utils";
import * as cheerio from "cheerio";
import * as fs from "fs";
import * as path from "path";
import type { RateLimitRequestHandler } from "express-rate-limit";


// Bootstrap: add auto_retry_count column to campaigns if upgrading from older schema.
(async () => {
  try {
    await db.execute(sql`ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS auto_retry_count integer NOT NULL DEFAULT 0`);
    // Cached engagement counters for fast /campaigns list rendering.
    // Maintained by server/tracking-buffer.ts (live txn-bumped) and
    // server/workers/counter-reconciler.ts (15-min reconciliation).
    await db.execute(sql`ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS unique_opens_count  integer NOT NULL DEFAULT 0`);
    await db.execute(sql`ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS total_opens_count   integer NOT NULL DEFAULT 0`);
    await db.execute(sql`ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS unique_clicks_count integer NOT NULL DEFAULT 0`);
    await db.execute(sql`ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS total_clicks_count  integer NOT NULL DEFAULT 0`);
    await db.execute(sql`ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS unsubscribes_count  integer NOT NULL DEFAULT 0`);
    await db.execute(sql`ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS complaints_count    integer NOT NULL DEFAULT 0`);
    // Auto-resend to openers (Task #56). All five columns are nullable / have
    // safe defaults so existing campaigns become "no follow-up" rows without
    // any data backfill required. See shared/schema.ts campaigns block for the
    // full design notes.
    await db.execute(sql`ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS parent_campaign_id     varchar`);
    await db.execute(sql`ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS follow_up_enabled      boolean NOT NULL DEFAULT false`);
    await db.execute(sql`ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS follow_up_delay_hours  integer NOT NULL DEFAULT 36`);
    await db.execute(sql`ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS follow_up_subject      text`);
    await db.execute(sql`ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS follow_up_scheduled_at timestamp`);
    await db.execute(sql`ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS follow_up_campaign_id  varchar`);
    await db.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS campaigns_parent_campaign_unique_idx
      ON campaigns (parent_campaign_id)
      WHERE parent_campaign_id IS NOT NULL
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS campaigns_follow_up_schedule_idx
      ON campaigns (follow_up_scheduled_at)
      WHERE follow_up_enabled = true
        AND follow_up_campaign_id IS NULL
        AND follow_up_scheduled_at IS NOT NULL
    `);
    // Self-FK on parent_campaign_id with ON DELETE RESTRICT — declared in
    // shared/schema.ts via `.references((): any => campaigns.id, {
    // onDelete: "restrict" })`. We do NOT add it here at runtime: ALTER
    // TABLE ADD CONSTRAINT FOREIGN KEY on a self-reference takes an
    // AccessExclusive lock and would wedge boot if any other session
    // touches campaigns. The schema declaration is the canonical contract
    // applied via `npm run db:push`; the application-level
    // FollowUpPendingError check in deleteCampaignWithFollowUpCleanup
    // enforces RESTRICT semantics in the meantime.
    logger.info("[CAMPAIGNS] Bootstrap migration: auto_retry_count + cached engagement counters + auto-resend ready");
  } catch (err: any) {
    logger.error(`[CAMPAIGNS] Bootstrap migration FAILED: ${err?.message || err}`);
  }
})();

/**
 * Custom error thrown by the auto-resend (Task #56) delete guard when the
 * target campaign is a parent with a pending (scheduled / sending) follow-up
 * child. Per spec the user must cancel/delete the child first — blind
 * cascade would silently throw away a queued send.
 */
class FollowUpPendingError extends Error {
  constructor(public readonly childId: string, public readonly childStatus: string) {
    super(`Cannot delete campaign with a ${childStatus} follow-up (child ${childId})`);
    this.name = "FollowUpPendingError";
  }
}

/**
 * Auto-resend (Task #56) cleanup. Used by both the single-id and bulk DELETE
 * routes so they apply the SAME safety behavior:
 *   - If the target is a PARENT with a pending follow-up child (status =
 *     scheduled/sending/draft) we BLOCK the delete and surface a 409 to the
 *     UI. The user must cancel or delete the child first.
 *   - If the parent's child is already in a terminal state (completed/
 *     failed/cancelled) we cascade-delete it because there's nothing
 *     destructive to lose.
 *   - If the target is a CHILD, we clear the parent's follow_up_campaign_id
 *     pointer so the UI stops showing a broken link. parent.followUpEnabled
 *     is intentionally left alone — the spawner will re-spawn on the next
 *     poll if appropriate.
 */
const PENDING_CHILD_STATUSES = new Set(["draft", "scheduled", "sending", "paused"]);

async function deleteCampaignWithFollowUpCleanup(id: string): Promise<void> {
  const target = await storage.getCampaign(id);
  if (target?.followUpCampaignId) {
    const child = await storage.getCampaign(target.followUpCampaignId);
    if (child && PENDING_CHILD_STATUSES.has(child.status)) {
      throw new FollowUpPendingError(child.id, child.status);
    }
    if (child) {
      await storage.deleteCampaign(child.id).catch((err: any) =>
        logger.warn(`[CAMPAIGN_DELETE] Cascade child delete failed: ${err?.message || err}`),
      );
    }
  }
  if (target?.parentCampaignId) {
    await db.execute(sql`
      UPDATE campaigns SET follow_up_campaign_id = NULL
      WHERE id = ${target.parentCampaignId}
    `).catch((err: any) =>
      logger.warn(`[CAMPAIGN_DELETE] Parent unlink failed: ${err?.message || err}`),
    );
  }
  await storage.deleteCampaign(id);
}

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
  
  // Per-process throttle so a sustained DB outage doesn't spam the logs with
  // one stack trace per failed list request. We log the first failure with
  // full context and then a single summary line every 60s.
  let lastCampaignsListErrorLog = 0;
  let suppressedCampaignsListErrors = 0;
  const CAMPAIGNS_LIST_ERROR_LOG_INTERVAL_MS = 60_000;

  app.get("/api/campaigns", async (req: Request, res: Response) => {
    try {
      const campaignsList = await storage.getCampaigns();
      res.json(campaignsList);
    } catch (error) {
      const classified = classifyDbError(error);
      if (classified.transient) {
        const now = Date.now();
        if (now - lastCampaignsListErrorLog >= CAMPAIGNS_LIST_ERROR_LOG_INTERVAL_MS) {
          logger.error(
            `[campaigns] list query failed (transient ${classified.kind}, code=${classified.code ?? "n/a"}): ${classified.message}` +
            (suppressedCampaignsListErrors > 0
              ? ` (+${suppressedCampaignsListErrors} similar suppressed)`
              : "")
          );
          lastCampaignsListErrorLog = now;
          suppressedCampaignsListErrors = 0;
        } else {
          suppressedCampaignsListErrors++;
        }
        // Stable JSON shape — never leak raw Postgres text like
        // "Disk quota exceeded" or file paths to the browser. The campaigns
        // page renders this as the existing "Failed to load campaigns" state.
        res.status(503).json({
          error: "service_unavailable",
          kind: classified.kind,
          message: userFacingMessageFor(classified.kind),
          retryable: true,
        });
        return;
      }
      logger.error("Error fetching campaigns:", error);
      res.status(500).json({
        error: "internal_error",
        message: "Failed to fetch campaigns",
      });
    }
  });

  app.get("/api/campaigns/stats", async (_req: Request, res: Response) => {
    try {
      // Fast read of the cached counters maintained by the tracking-buffer
      // flush transaction (server/tracking-buffer.ts) and re-derived by the
      // counter-drift reconciler (server/workers/counter-reconciler.ts).
      // Replaces the previous COUNT(DISTINCT)…GROUP BY over the full
      // campaign_stats event table, which became unscalable past a few
      // million rows and caused the /campaigns list to timeout-and-render-zeros.
      const result = await pool.query(`
        SELECT id,
               unique_opens_count,
               unique_clicks_count,
               unsubscribes_count,
               complaints_count
          FROM campaigns
      `);
      const statsMap: Record<string, { opens: number; clicks: number; unsubscribes: number; complaints: number }> = {};
      for (const row of result.rows as Array<{
        id: string;
        unique_opens_count: number | string;
        unique_clicks_count: number | string;
        unsubscribes_count: number | string;
        complaints_count: number | string;
      }>) {
        statsMap[row.id] = {
          opens: Number(row.unique_opens_count) || 0,
          clicks: Number(row.unique_clicks_count) || 0,
          unsubscribes: Number(row.unsubscribes_count) || 0,
          complaints: Number(row.complaints_count) || 0,
        };
      }
      res.json(statsMap);
    } catch (error) {
      logger.error("Error fetching campaign stats:", error);
      res.status(500).json({ error: "Failed to fetch campaign stats" });
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
    const sessionId = `draft-${generateBase62(12)}`;
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
      // Ensure directories exist — never wipe existing images upfront.
      // Wiping here would destroy already-downloaded images when the campaign
      // is edited and saved a second time (they have relative /campaigns/... src
      // attributes that are not external URLs and would never be re-downloaded).
      fs.mkdirSync(campaignImagesDir, { recursive: true, mode: 0o755 });

      // Resolve image hosting domain: prefer mtaId from request body (current form selection),
      // fall back to the saved campaign's MTA, then fall back to the request's own origin
      // so images are always stored with absolute URLs even when no domain is configured on the MTA.
      let imageHostingDomain: string | null = null;
      const campaign = await storage.getCampaign(campaignId);
      const effectiveMtaId = bodyMtaId || campaign?.mtaId;
      if (effectiveMtaId) {
        const mta = await storage.getMta(effectiveMtaId);
        if (mta?.imageHostingDomain) {
          const raw = mta.imageHostingDomain.replace(/\/$/, "");
          imageHostingDomain = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
        }
      }
      // Fallback: derive absolute origin from the incoming request so images are never
      // stored as relative paths — relative paths break email clients and iframe previews.
      if (!imageHostingDomain) {
        const proto = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0].trim() || req.protocol || "https";
        const host = req.headers["x-forwarded-host"] as string | undefined || req.headers.host;
        if (host) {
          imageHostingDomain = `${proto}://${host}`;
        }
      }

      // Derive year/month from campaign's created_at for stable URL paths
      const campaignDate = campaign?.createdAt ? new Date(campaign.createdAt) : new Date();
      const year = campaignDate.getUTCFullYear().toString();
      const month = String(campaignDate.getUTCMonth() + 1).padStart(2, '0');
      
      const $ = cheerio.load(html);
      const imgElements = $("img");
      const downloadedImages: { original: string; local: string }[] = [];
      const failedImages: string[] = [];
      let imageIndex = 0;
      
      const imageTasks: Array<{ el: any; src: string; currentIndex: number }> = [];
      
      imgElements.each((_, el) => {
        const src = $(el).attr("src");
        // Only queue external URLs for download — images already stored locally
        // (/campaigns/... or relative paths) are preserved as-is on disk.
        if (src && (src.startsWith("http://") || src.startsWith("https://"))) {
          imageTasks.push({ el, src, currentIndex: imageIndex++ });
        }
      });

      // Track used filenames within this request to handle conflicts with a numeric suffix
      const usedFilenames = new Set<string>();

      const { mapWithConcurrency } = await import("../utils");
      await mapWithConcurrency(imageTasks, 5, async (task) => {
        const ext = getExtensionFromUrl(task.src);
        // Derive clean filename from the source URL
        let baseFilename = sanitizeImageFilename(task.src, task.currentIndex, ext);
        // Handle conflicts: append numeric suffix until unique
        if (usedFilenames.has(baseFilename)) {
          const base = baseFilename.replace(/\.[^.]+$/, '');
          let counter = 2;
          while (usedFilenames.has(`${base}-${counter}.${ext}`)) counter++;
          baseFilename = `${base}-${counter}.${ext}`;
        }
        usedFilenames.add(baseFilename);

        const destPath = path.join(campaignImagesDir, baseFilename);
        const relativePath = `/campaigns/${year}/${month}/${campaignId}/${baseFilename}`;
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
        // Auto-resend (Task #56): even on non-draft PATCH we must enforce
        // the same constraints we'd enforce on insert/draft. Without this
        // guard a client could PATCH followUpDelayHours=99999 or
        // followUpSubject=<10 KB blob> on a scheduled/sending campaign and
        // bypass the wizard validation. We only validate the follow-up
        // subset (everything else on a non-draft is intentionally trusted).
        const followUpPatchSchema = z.object({
          followUpEnabled: z.boolean().optional(),
          followUpDelayHours: z.coerce.number().int().min(1).max(168).optional(),
          followUpSubject: z.preprocess((v) => (v === "" ? null : v), z.string().max(998).nullable().optional()),
        });
        const fu = followUpPatchSchema.parse({
          followUpEnabled: normalizedBody.followUpEnabled,
          followUpDelayHours: normalizedBody.followUpDelayHours,
          followUpSubject: normalizedBody.followUpSubject,
        });
        if (fu.followUpEnabled !== undefined) normalizedBody.followUpEnabled = fu.followUpEnabled;
        if (fu.followUpDelayHours !== undefined) normalizedBody.followUpDelayHours = fu.followUpDelayHours;
        if (fu.followUpSubject !== undefined) normalizedBody.followUpSubject = fu.followUpSubject;
      }

      if (normalizedBody.scheduledAt && typeof normalizedBody.scheduledAt === 'string') {
        normalizedBody.scheduledAt = new Date(normalizedBody.scheduledAt);
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
      const results = await Promise.allSettled(
        ids.map((id) => deleteCampaignWithFollowUpCleanup(id)),
      );
      const blocked = results
        .map((r, i) => ({ r, id: ids[i] }))
        .filter(({ r }) => r.status === "rejected" && (r as any).reason instanceof FollowUpPendingError);
      if (blocked.length > 0) {
        return res.status(409).json({
          error: "follow_up_pending",
          message: `${blocked.length} campaign(s) have a pending follow-up. Cancel or delete the follow-up first.`,
          blockedIds: blocked.map((b) => b.id),
        });
      }
      const otherFailures = results.filter((r) => r.status === "rejected");
      if (otherFailures.length > 0) {
        logger.error("Error bulk-deleting campaigns:", (otherFailures[0] as any).reason);
        return res.status(500).json({ error: "Failed to delete campaigns" });
      }
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
      await deleteCampaignWithFollowUpCleanup(req.params.id);
      res.status(204).send();
    } catch (error: any) {
      if (error instanceof FollowUpPendingError) {
        return res.status(409).json({
          error: "follow_up_pending",
          message: `Cannot delete: this campaign has a ${error.childStatus} follow-up. Cancel or delete the follow-up first.`,
          childId: error.childId,
        });
      }
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
      const page = Math.max(1, parseInt(req.query.page as string) || 1);
      const limit = Math.min(200, Math.max(1, parseInt(req.query.limit as string) || 100));
      const { logs, total } = await storage.getErrorLogs({
        campaignId: req.params.id,
        type: "send_failed",
        limit,
        page,
      });
      // Grouped summary: top error messages with occurrence counts
      const summaryRows = await db
        .select({ message: errorLogs.message, count: sql<number>`count(*)::int` })
        .from(errorLogs)
        .where(and(eq(errorLogs.campaignId, req.params.id), eq(errorLogs.type, "send_failed")))
        .groupBy(errorLogs.message)
        .orderBy(sql`count(*) desc`)
        .limit(20);
      res.json({
        pauseReason: campaign.pauseReason,
        errors: logs,
        total,
        page,
        limit,
        summary: summaryRows.map(r => ({ message: r.message, count: Number(r.count) })),
      });
    } catch (error) {
      logger.error("Error fetching campaign errors:", error);
      res.status(500).json({ error: "Failed to fetch campaign errors" });
    }
  });

  // Retry only failed individual sends — already-sent recipients are never re-contacted.
  // Works regardless of current campaign status (completed, sending, paused, failed).
  //
  // Mechanism:
  //   Failed rows are reset to 'pending' with a fresh sent_at timestamp. The main
  //   send loop (bulkReserveSendSlots / INSERT ON CONFLICT DO NOTHING) will skip
  //   them, but campaign-sender.ts calls recoverOrphanedPendingSends(campaignId, 0)
  //   after flushBuffer() to collect these carry-over rows, adds their count to
  //   totalFailed, and the retry phase then re-sends them via getFailedSendsForRetry.
  //   Already-sent rows (status='sent') are never touched.
  app.post("/api/campaigns/:id/retry-failed", async (req: Request, res: Response) => {
    try {
      if (!validateId(req.params.id)) {
        return res.status(400).json({ error: "Invalid ID format" });
      }
      const existingCampaign = await storage.getCampaign(req.params.id);
      if (!existingCampaign) {
        return res.status(404).json({ error: "Campaign not found" });
      }

      // All three operations in one transaction for atomicity.
      const { campaign, resetCount } = await db.transaction(async (tx) => {
        // 1. Reset failed rows to pending.
        //    Eligibility is derived from actual DB rows (not just failedCount counter)
        //    to guard against counter drift.
        //    sent_at is refreshed so recoverOrphanedPendingSends (2-min threshold)
        //    at job start does NOT immediately revert them back to failed.
        //    retry_count/last_retry_at are incremented to preserve history.
        const resetResult = await tx.execute(sql`
          UPDATE campaign_sends
          SET status = 'pending',
              retry_count = retry_count + 1,
              last_retry_at = NOW(),
              sent_at = NOW()
          WHERE campaign_id = ${req.params.id} AND status = 'failed'
          RETURNING id
        `);
        const resetCount = resetResult.rows.length;
        if (resetCount === 0) return { campaign: null, resetCount: 0 };

        // 2. Reset campaign counters and status.
        //    retryUntil and autoRetryCount are cleared so campaign-sender sets a fresh
        //    12-hour window and the auto-retry counter resets to 0 (giving 3 more attempts).
        const [updated] = await tx
          .update(campaigns)
          .set({ status: "sending", failedCount: 0, pauseReason: null, retryUntil: null, autoRetryCount: 0 })
          .where(sql`${campaigns.id} = ${req.params.id}`)
          .returning();
        if (!updated) return { campaign: null, resetCount };

        // 3. Enqueue a new campaign job (deduplicated: skip if one is already
        //    pending/processing to avoid competing workers).
        await tx.execute(sql`
          INSERT INTO campaign_jobs (id, campaign_id, status)
          SELECT gen_random_uuid(), ${updated.id}, 'pending'
          WHERE NOT EXISTS (
            SELECT 1 FROM campaign_jobs
            WHERE campaign_id = ${updated.id} AND status IN ('pending', 'processing')
          )
        `);
        return { campaign: updated, resetCount };
      });

      if (!campaign) {
        if (resetCount === 0) {
          return res.status(400).json({ error: "No failed sends to retry" });
        }
        return res.status(404).json({ error: "Campaign not found" });
      }

      await messageQueue.notify("campaign_jobs", { campaignId: req.params.id });
      logger.info(`[CAMPAIGN_RETRY_FAILED] Reset ${resetCount} failed sends to pending, NOTIFY sent for campaign ${req.params.id}`);
      res.json({ campaign, resetCount });
    } catch (error) {
      logger.error("Error retrying failed campaign sends:", error);
      res.status(500).json({ error: "Failed to retry failed sends" });
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
      if (updateData.scheduledAt && typeof updateData.scheduledAt === 'string') {
        updateData.scheduledAt = new Date(updateData.scheduledAt);
      }
      
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
