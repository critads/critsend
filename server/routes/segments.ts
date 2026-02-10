import { type Express, type Request, type Response } from "express";
import { storage } from "../storage";
import { logger } from "../logger";
import { insertSegmentSchema, segmentRulesArraySchema } from "@shared/schema";
import { z } from "zod";

export function registerSegmentRoutes(app: Express, helpers: {
  parsePagination: (query: any) => { page: number; limit: number };
  validateId: (id: string) => boolean;
}) {
  const { validateId } = helpers;

  app.get("/api/segments", async (req: Request, res: Response) => {
    try {
      const segmentsList = await storage.getSegments();
      res.json(segmentsList);
    } catch (error) {
      logger.error("Error fetching segments:", error);
      res.status(500).json({ error: "Failed to fetch segments" });
    }
  });

  app.get("/api/segments/counts", async (req: Request, res: Response) => {
    try {
      const segmentsList = await storage.getSegments();
      const counts: Record<string, number> = {};
      await Promise.all(
        segmentsList.map(async (segment) => {
          counts[segment.id] = await storage.getSegmentSubscriberCountCached(segment.id);
        })
      );
      res.json(counts);
    } catch (error) {
      logger.error("Error fetching segment counts:", error);
      res.status(500).json({ error: "Failed to fetch segment counts" });
    }
  });

  app.post("/api/segments/preview-count", async (req: Request, res: Response) => {
    try {
      const { rules } = req.body;
      if (!rules || !Array.isArray(rules) || rules.length === 0) {
        return res.json({ count: 0 });
      }
      segmentRulesArraySchema.parse(rules);
      const count = await storage.countSubscribersForRules(rules);
      res.json({ count });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.errors });
      }
      logger.error("Error counting segment preview:", error);
      res.status(500).json({ error: "Failed to count subscribers" });
    }
  });

  app.get("/api/segments/:id", async (req: Request, res: Response) => {
    try {
      if (!validateId(req.params.id)) {
        return res.status(400).json({ error: "Invalid ID format" });
      }
      const segment = await storage.getSegment(req.params.id);
      if (!segment) {
        return res.status(404).json({ error: "Segment not found" });
      }
      res.json(segment);
    } catch (error) {
      logger.error("Error fetching segment:", error);
      res.status(500).json({ error: "Failed to fetch segment" });
    }
  });

  app.get("/api/segments/:id/count", async (req: Request, res: Response) => {
    try {
      if (!validateId(req.params.id)) {
        return res.status(400).json({ error: "Invalid ID format" });
      }
      const count = await storage.getSegmentSubscriberCountCached(req.params.id);
      res.json({ count });
    } catch (error) {
      logger.error("Error counting segment subscribers:", error);
      res.status(500).json({ error: "Failed to count subscribers" });
    }
  });

  app.post("/api/segments", async (req: Request, res: Response) => {
    try {
      const data = insertSegmentSchema.parse(req.body);
      if (data.rules) {
        segmentRulesArraySchema.parse(data.rules);
      }
      const segment = await storage.createSegment(data);
      res.status(201).json(segment);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.errors });
      }
      logger.error("Error creating segment:", error);
      res.status(500).json({ error: "Failed to create segment" });
    }
  });

  app.patch("/api/segments/:id", async (req: Request, res: Response) => {
    try {
      if (!validateId(req.params.id)) {
        return res.status(400).json({ error: "Invalid ID format" });
      }
      if (req.body.rules) {
        segmentRulesArraySchema.parse(req.body.rules);
      }
      const segment = await storage.updateSegment(req.params.id, req.body);
      if (!segment) {
        return res.status(404).json({ error: "Segment not found" });
      }
      res.json(segment);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.errors });
      }
      logger.error("Error updating segment:", error);
      res.status(500).json({ error: "Failed to update segment" });
    }
  });

  app.delete("/api/segments/:id", async (req: Request, res: Response) => {
    try {
      if (!validateId(req.params.id)) {
        return res.status(400).json({ error: "Invalid ID format" });
      }
      await storage.deleteSegment(req.params.id);
      res.status(204).send();
    } catch (error) {
      logger.error("Error deleting segment:", error);
      res.status(500).json({ error: "Failed to delete segment" });
    }
  });
}
