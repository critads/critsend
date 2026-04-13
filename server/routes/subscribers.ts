import { type Express, type Request, type Response } from "express";
import { storage } from "../storage";
import { logger } from "../logger";
import { insertSubscriberSchema } from "@shared/schema";
import { z } from "zod";

export function registerSubscriberRoutes(app: Express, helpers: {
  parsePagination: (query: any) => { page: number; limit: number };
  validateId: (id: string) => boolean;
}) {
  const { parsePagination, validateId } = helpers;

  app.get("/api/subscribers", async (req: Request, res: Response) => {
    try {
      const { page, limit } = parsePagination(req.query);
      const search = req.query.search as string | undefined;
      
      const result = await storage.getSubscribers(page, limit, search);
      res.json({
        ...result,
        page,
        limit,
        totalPages: Math.ceil(result.total / limit),
      });
    } catch (error) {
      logger.error("Error fetching subscribers:", error);
      res.status(500).json({ error: "Failed to fetch subscribers" });
    }
  });

  app.get("/api/subscribers/:id", async (req: Request, res: Response) => {
    try {
      if (!validateId(req.params.id)) {
        return res.status(400).json({ error: "Invalid ID format" });
      }
      const subscriber = await storage.getSubscriber(req.params.id);
      if (!subscriber) {
        return res.status(404).json({ error: "Subscriber not found" });
      }
      res.json(subscriber);
    } catch (error) {
      logger.error("Error fetching subscriber:", error);
      res.status(500).json({ error: "Failed to fetch subscriber" });
    }
  });

  app.post("/api/subscribers", async (req: Request, res: Response) => {
    try {
      const data = insertSubscriberSchema.parse(req.body);
      
      const existing = await storage.getSubscriberByEmail(data.email);
      if (existing) {
        const updated = await storage.updateSubscriber(existing.id, {
          tags: [...new Set([...(existing.tags || []), ...(data.tags || [])])],
        });
        return res.json(updated);
      }
      
      const subscriber = await storage.createSubscriber(data);
      storage.invalidateSegmentCountCache();
      res.status(201).json(subscriber);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.errors });
      }
      logger.error("Error creating subscriber:", error);
      res.status(500).json({ error: "Failed to create subscriber" });
    }
  });

  app.patch("/api/subscribers/:id", async (req: Request, res: Response) => {
    try {
      if (!validateId(req.params.id)) {
        return res.status(400).json({ error: "Invalid ID format" });
      }
      const updateSchema = z.object({
        email: z.string().email().max(254).transform(v => v.toLowerCase().trim()).optional(),
        tags: z.array(z.string().max(100)).max(1000).optional(),
        ipAddress: z.string().max(45).nullable().optional(),
      }).strict();
      const data = updateSchema.parse(req.body);
      const subscriber = await storage.updateSubscriber(req.params.id, data);
      if (!subscriber) {
        return res.status(404).json({ error: "Subscriber not found" });
      }
      res.json(subscriber);
    } catch (error) {
      logger.error("Error updating subscriber:", error);
      res.status(500).json({ error: "Failed to update subscriber" });
    }
  });

  app.post("/api/subscribers/bulk-delete", async (req: Request, res: Response) => {
    try {
      const schema = z.object({
        emails: z.array(z.string().email()).min(1).max(500000),
        confirmed: z.boolean().optional(),
      });
      const { emails, confirmed } = schema.parse(req.body);

      const unique = [...new Set(emails.map(e => e.toLowerCase().trim()))];

      if (!confirmed) {
        const matched = await storage.countByEmails(unique);
        return res.json({ matched, total: unique.length, notFound: unique.length - matched });
      }

      const result = await storage.bulkDeleteByEmails(unique);
      storage.invalidateSegmentCountCache();
      logger.info(`[BULK_DELETE] Deleted ${result.deleted} subscribers (${result.notFound} not found) from ${unique.length} emails`);
      res.json(result);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid input", details: error.errors });
      }
      logger.error("Error in bulk delete:", error);
      res.status(500).json({ error: "Failed to bulk delete subscribers" });
    }
  });

  app.delete("/api/subscribers/:id", async (req: Request, res: Response) => {
    try {
      if (!validateId(req.params.id)) {
        return res.status(400).json({ error: "Invalid ID format" });
      }
      await storage.deleteSubscriber(req.params.id);
      res.status(204).send();
    } catch (error) {
      logger.error("Error deleting subscriber:", error);
      res.status(500).json({ error: "Failed to delete subscriber" });
    }
  });

  app.delete("/api/subscribers", async (req: Request, res: Response) => {
    try {
      const totalRows = await storage.countAllSubscribers();
      if (totalRows === 0) {
        return res.json({ jobId: null, totalRows: 0, message: "No subscribers to delete" });
      }
      const job = await storage.createFlushJob(totalRows);
      res.status(202).json({ jobId: job.id, totalRows: job.totalRows, message: "Deletion started in background" });
    } catch (error) {
      logger.error("Error starting subscriber deletion:", error);
      res.status(500).json({ error: "Failed to start subscriber deletion" });
    }
  });

  app.post("/api/subscribers/flush", async (req: Request, res: Response) => {
    try {
      const totalRows = await storage.countAllSubscribers();
      if (totalRows === 0) {
        return res.json({ id: null, message: "No subscribers to delete" });
      }
      const job = await storage.createFlushJob(totalRows);
      res.status(201).json(job);
    } catch (error) {
      logger.error("Error creating flush job:", error);
      res.status(500).json({ error: "Failed to create flush job" });
    }
  });

  app.get("/api/subscribers/flush/:id", async (req: Request, res: Response) => {
    try {
      if (!validateId(req.params.id)) {
        return res.status(400).json({ error: "Invalid ID format" });
      }
      const job = await storage.getFlushJob(req.params.id);
      if (!job) {
        return res.status(404).json({ error: "Flush job not found" });
      }
      const percent = job.totalRows > 0 ? Math.round((job.processedRows / job.totalRows) * 100) : 0;
      res.json({ ...job, percent });
    } catch (error) {
      logger.error("Error fetching flush job:", error);
      res.status(500).json({ error: "Failed to fetch flush job" });
    }
  });

  app.post("/api/subscribers/flush/:id/cancel", async (req: Request, res: Response) => {
    try {
      if (!validateId(req.params.id)) {
        return res.status(400).json({ error: "Invalid ID format" });
      }
      const cancelled = await storage.cancelFlushJob(req.params.id);
      if (!cancelled) {
        return res.status(400).json({ error: "Cannot cancel job - it may already be completed or cancelled" });
      }
      res.json({ message: "Flush job cancelled" });
    } catch (error) {
      logger.error("Error cancelling flush job:", error);
      res.status(500).json({ error: "Failed to cancel flush job" });
    }
  });
}
