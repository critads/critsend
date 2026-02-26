import { type Express, type Request, type Response } from "express";
import { storage } from "../storage";
import { logger } from "../logger";
import { z } from "zod";
import crypto from "crypto";

export function registerWebhookRoutes(app: Express) {
  function verifyWebhookSecret(req: Request, res: Response): boolean {
    const webhookSecret = process.env.WEBHOOK_SECRET;
    if (!webhookSecret) return true;
    const providedSecret = req.headers['x-webhook-secret'] as string;
    if (!providedSecret || Buffer.byteLength(providedSecret) !== Buffer.byteLength(webhookSecret)) {
      res.status(401).json({ error: "Invalid webhook secret" });
      return false;
    }
    if (!crypto.timingSafeEqual(Buffer.from(providedSecret), Buffer.from(webhookSecret))) {
      res.status(401).json({ error: "Invalid webhook secret" });
      return false;
    }
    return true;
  }

  app.post("/api/webhooks/bounce", async (req: Request, res: Response) => {
    if (!verifyWebhookSecret(req, res)) return;
    try {
      const bounceSchema = z.object({
        email: z.string().email(),
        type: z.enum(["hard_bounce", "soft_bounce", "complaint", "unsubscribe"]),
        reason: z.string().max(1000).optional(),
        campaignId: z.string().max(100).optional(),
        timestamp: z.string().optional(),
      });
      
      const data = bounceSchema.parse(req.body);
      
      const subscriber = await storage.getSubscriberByEmail(data.email);
      if (!subscriber) {
        return res.status(200).json({ status: "ok", message: "Subscriber not found, ignored" });
      }
      
      const currentTags = subscriber.tags || [];
      
      if (data.type === "hard_bounce" || data.type === "complaint") {
        if (currentTags.includes("BCK")) {
          logger.info(`[BOUNCE] Duplicate bounce skipped for ${data.email} (type: ${data.type}) - already blocklisted`);
          return res.json({ status: "ok", message: "Already processed" });
        }
        await storage.updateSubscriber(subscriber.id, {
          tags: [...currentTags, "BCK", `bounce:${data.type}`],
        });
        logger.info(`[BOUNCE] Blocklisted ${data.email} due to ${data.type}`);
      } else if (data.type === "soft_bounce") {
        const bounceTag = `bounce:soft`;
        if (currentTags.includes(bounceTag)) {
          logger.info(`[BOUNCE] Duplicate bounce skipped for ${data.email} (type: ${data.type}) - already tagged`);
          return res.json({ status: "ok", message: "Already processed" });
        }
        await storage.updateSubscriber(subscriber.id, {
          tags: [...currentTags, bounceTag],
        });
      } else if (data.type === "unsubscribe") {
        if (currentTags.includes("BCK")) {
          logger.info(`[BOUNCE] Duplicate unsubscribe skipped for ${data.email} - already blocklisted`);
          return res.json({ status: "ok", message: "Already processed" });
        }
      }
      
      await storage.logError({
        type: "send_failed",
        severity: "warning",
        message: `${data.type}: ${data.reason || 'No reason provided'}`,
        email: data.email,
        subscriberId: subscriber.id,
        campaignId: data.campaignId || null,
        details: JSON.stringify(data),
      });
      
      res.json({ status: "ok", action: data.type === "hard_bounce" || data.type === "complaint" ? "blocklisted" : "tagged" });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.errors });
      }
      logger.error("Error processing bounce webhook:", error);
      res.status(500).json({ error: "Failed to process bounce" });
    }
  });

  app.post("/api/webhooks/bounces/batch", async (req: Request, res: Response) => {
    if (!verifyWebhookSecret(req, res)) return;
    try {
      const batchSchema = z.object({
        idempotencyKey: z.string().max(255).optional(),
        bounces: z.array(z.object({
          email: z.string().email(),
          type: z.enum(["hard_bounce", "soft_bounce", "complaint", "unsubscribe"]),
          reason: z.string().max(1000).optional(),
        })).max(1000, "Maximum 1000 bounces per batch"),
      });
      
      const { bounces, idempotencyKey } = batchSchema.parse(req.body);
      if (idempotencyKey) {
        logger.info(`[BOUNCE] Batch received with idempotencyKey: ${idempotencyKey}`);
      }
      let processed = 0;
      let blocklisted = 0;
      let notFound = 0;
      let skipped = 0;

      const emails = [...new Set(bounces.map(b => b.email.toLowerCase()))];
      const subscriberMap = await storage.getSubscribersByEmails(emails);

      const hardBounceIds: string[] = [];
      const complaintIds: string[] = [];
      const softBounceIds: string[] = [];

      for (const bounce of bounces) {
        const subscriber = subscriberMap.get(bounce.email.toLowerCase());
        if (!subscriber) {
          notFound++;
          continue;
        }

        const currentTags = subscriber.tags || [];

        if (bounce.type === "hard_bounce" || bounce.type === "complaint") {
          if (currentTags.includes("BCK")) {
            skipped++;
            processed++;
            continue;
          }
          if (bounce.type === "hard_bounce") hardBounceIds.push(subscriber.id);
          else complaintIds.push(subscriber.id);
          blocklisted++;
        } else if (bounce.type === "soft_bounce") {
          if (currentTags.includes("bounce:soft")) {
            skipped++;
            processed++;
            continue;
          }
          softBounceIds.push(subscriber.id);
        }
        processed++;
      }

      if (hardBounceIds.length > 0) {
        await storage.bulkAddTags(hardBounceIds, ["BCK", "bounce:hard_bounce"]);
      }
      if (complaintIds.length > 0) {
        await storage.bulkAddTags(complaintIds, ["BCK", "bounce:complaint"]);
      }
      if (softBounceIds.length > 0) {
        await storage.bulkAddTags(softBounceIds, ["bounce:soft"]);
      }
      
      logger.info(`[BOUNCE] Batch processed: ${processed} bounces, ${blocklisted} blocklisted, ${skipped} skipped (already processed), ${notFound} not found`);
      res.json({ status: "ok", processed, blocklisted, skipped, notFound, total: bounces.length });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.errors });
      }
      logger.error("Error processing batch bounces:", error);
      res.status(500).json({ error: "Failed to process bounces" });
    }
  });
}
