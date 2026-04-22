import { type Express, type Request, type Response } from "express";
import { logger } from "../logger";
import { bouncesTotal } from "../metrics";
import { z } from "zod";
import crypto from "crypto";
import { enqueueBounce } from "../bounce-buffer";

/**
 * Bounce/complaint webhooks.
 *
 * Both endpoints validate, increment metrics, enqueue into the in-memory
 * bounce buffer, and return 202 immediately. The buffer flusher
 * (server/bounce-buffer.ts) batches DB writes against the dedicated
 * tracking pool, so a bounce flood from Mailgun/SES retries can never
 * drain the user-facing main pool.
 *
 * Idempotency contract: dedupe key (email|type) collapses repeats inside
 * a 60s window; the flusher then re-checks the subscriber's tags so
 * already-processed bounces are skipped exactly like the previous
 * synchronous path did.
 */
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

  app.post("/api/webhooks/bounce", (req: Request, res: Response) => {
    if (!verifyWebhookSecret(req, res)) return;
    try {
      const bounceSchema = z.object({
        email: z.string().email(),
        type: z.enum(["hard_bounce", "soft_bounce", "complaint", "unsubscribe"]),
        reason: z.string().max(1000).optional(),
        campaignId: z.string().max(100).optional(),
        // ESP-supplied unique message identifier — Mailgun's Message-Id,
        // SES's mail.messageId. When present, the bounce buffer dedupes on
        // (email|messageId) so retries from the ESP collapse cleanly.
        messageId: z.string().max(255).optional(),
        timestamp: z.string().optional(),
      });

      const data = bounceSchema.parse(req.body);
      bouncesTotal.inc({ type: data.type });
      const result = enqueueBounce({
        email: data.email,
        type: data.type,
        reason: data.reason,
        campaignId: data.campaignId,
        messageId: data.messageId,
      });
      res.status(202).json({ status: result });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.errors });
      }
      logger.error("Error queueing bounce webhook:", error);
      res.status(500).json({ error: "Failed to enqueue bounce" });
    }
  });

  app.post("/api/webhooks/bounces/batch", (req: Request, res: Response) => {
    if (!verifyWebhookSecret(req, res)) return;
    try {
      const batchSchema = z.object({
        idempotencyKey: z.string().max(255).optional(),
        bounces: z.array(z.object({
          email: z.string().email(),
          type: z.enum(["hard_bounce", "soft_bounce", "complaint", "unsubscribe"]),
          reason: z.string().max(1000).optional(),
          campaignId: z.string().max(100).optional(),
          messageId: z.string().max(255).optional(),
        })).max(1000, "Maximum 1000 bounces per batch"),
      });

      const { bounces, idempotencyKey } = batchSchema.parse(req.body);
      if (idempotencyKey) {
        logger.info(`[BOUNCE] Batch received with idempotencyKey: ${idempotencyKey}`);
      }

      let accepted = 0;
      let deduped = 0;
      let dropped = 0;
      for (const b of bounces) {
        bouncesTotal.inc({ type: b.type });
        const r = enqueueBounce({
          email: b.email,
          type: b.type,
          reason: b.reason,
          campaignId: b.campaignId,
          messageId: b.messageId,
        });
        if (r === "accepted") accepted++;
        else if (r === "deduped") deduped++;
        else dropped++;
      }
      res.status(202).json({ status: "accepted", accepted, deduped, dropped, total: bounces.length });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.errors });
      }
      logger.error("Error queueing batch bounces:", error);
      res.status(500).json({ error: "Failed to enqueue bounces" });
    }
  });
}
