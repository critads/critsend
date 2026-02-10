import { type Express, type Request, type Response } from "express";
import { storage } from "../storage";
import { logger } from "../logger";
import { insertSegmentSchema, segmentRulesArraySchema } from "@shared/schema";
import { z } from "zod";

export function registerSegmentRoutes(app: Express, helpers: {
  parsePagination: (query: any) => { page: number; limit: number };
  validateId: (id: string) => boolean;
}) {
  const { validateId, parsePagination } = helpers;

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

  app.get("/api/segments/:id/subscribers", async (req: Request, res: Response) => {
    try {
      if (!validateId(req.params.id)) {
        return res.status(400).json({ error: "Invalid ID format" });
      }

      const segment = await storage.getSegment(req.params.id);
      if (!segment) {
        return res.status(404).json({ error: "Segment not found" });
      }

      const { page, limit } = parsePagination(req.query);
      const offset = (page - 1) * limit;

      const [subscribers, total] = await Promise.all([
        storage.getSubscribersForSegment(req.params.id, limit, offset),
        storage.countSubscribersForSegment(req.params.id),
      ]);

      const totalPages = Math.ceil(total / limit);

      res.json({
        subscribers,
        total,
        page,
        limit,
        totalPages,
      });
    } catch (error) {
      logger.error("Error fetching segment subscribers:", error);
      res.status(500).json({ error: "Failed to fetch segment subscribers" });
    }
  });

  app.get("/api/segments/:id/export", async (req: Request, res: Response) => {
    try {
      if (!validateId(req.params.id)) {
        return res.status(400).json({ error: "Invalid ID format" });
      }

      const segment = await storage.getSegment(req.params.id);
      if (!segment) {
        return res.status(404).json({ error: "Segment not found" });
      }

      const fieldsParam = (req.query.fields as string) || "email,tags,ipAddress,importDate";
      const fields = fieldsParam.split(",").map(f => f.trim()).filter(f => f.length > 0);

      if (fields.length === 0) {
        return res.status(400).json({ error: "At least one field is required" });
      }

      const validFields = ["email", "tags", "ipAddress", "importDate", "id"];
      const invalidFields = fields.filter(f => !validFields.includes(f));
      if (invalidFields.length > 0) {
        return res.status(400).json({ error: `Invalid fields: ${invalidFields.join(", ")}` });
      }

      const sanitizeCsvValue = (value: any): string => {
        if (value === null || value === undefined) {
          return "";
        }

        let str = Array.isArray(value) ? value.join("; ") : String(value);

        if (str.match(/[\n\r",=+\-@\t]/)) {
          if (str.startsWith("=") || str.startsWith("+") || str.startsWith("-") || 
              str.startsWith("@") || str.startsWith("\t") || str.startsWith("\r")) {
            str = "'" + str;
          }
          str = '"' + str.replace(/"/g, '""') + '"';
        } else if (str.match(/[=+\-@\t\r]/)) {
          str = "'" + str;
        }

        return str;
      };

      const filename = `segment-${segment.name || segment.id}-${Date.now()}.csv`;
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

      const batchSize = 10000;
      let cursorId: string | undefined;
      let rowCount = 0;
      let hasMore = true;

      const headerRow = fields.join(",") + "\n";
      let writeOk = res.write(headerRow);

      while (hasMore) {
        try {
          const batch = await storage.getSubscribersForSegmentCursor(req.params.id, batchSize, cursorId);

          if (batch.length === 0) {
            hasMore = false;
            break;
          }

          for (const subscriber of batch) {
            const values = fields.map(field => {
              let value: any = null;
              if (field === "email") value = subscriber.email;
              else if (field === "tags") value = (subscriber.tags || []).join(";");
              else if (field === "ipAddress") value = subscriber.ipAddress || "";
              else if (field === "importDate") value = subscriber.importDate instanceof Date ? subscriber.importDate.toISOString() : String(subscriber.importDate || "");
              else if (field === "id") value = subscriber.id;
              return sanitizeCsvValue(value);
            });

            const row = values.join(",") + "\n";

            if (!writeOk) {
              await new Promise<void>((resolve) => {
                res.once("drain", () => resolve());
              });
            }

            writeOk = res.write(row);
            rowCount++;
          }

          if (batch.length < batchSize) {
            hasMore = false;
          } else {
            cursorId = batch[batch.length - 1]?.id;
          }
        } catch (batchError) {
          logger.error("Error processing batch during export:", batchError);
          hasMore = false;
          break;
        }
      }

      res.end();
    } catch (error) {
      logger.error("Error exporting segment subscribers:", error);
      if (!res.headersSent) {
        res.status(500).json({ error: "Failed to export segment subscribers" });
      } else {
        res.end();
      }
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
