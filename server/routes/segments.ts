import { type Express, type Request, type Response } from "express";
import { storage } from "../storage";
import { logger } from "../logger";
import { insertSegmentSchema, segmentRulesInputSchema, migrateRulesV1toV2 } from "@shared/schema";
import type { SegmentRulesV2 } from "@shared/schema";
import { z } from "zod";

export function registerSegmentRoutes(app: Express, helpers: {
  parsePagination: (query: any) => { page: number; limit: number };
  validateId: (id: string) => boolean;
}) {
  const { validateId, parsePagination } = helpers;

  function normalizeRules(rules: any): SegmentRulesV2 | null {
    if (!rules) return null;
    if (rules.version === 2) return rules;
    if (Array.isArray(rules) && rules.length > 0) return migrateRulesV1toV2(rules);
    return null;
  }

  app.get("/api/segments", async (req: Request, res: Response) => {
    try {
      const segmentsList = await storage.getSegments();
      // Server-side pagination. If the client passes paginate=true (or any
      // page/limit param), return an envelope { segments, total, page, limit }.
      // Otherwise return the raw array for backward compatibility with older
      // callers (campaign wizards etc. that need the full list).
      const wantsPaginated = req.query.paginate === "true" || req.query.page !== undefined || req.query.limit !== undefined;
      if (wantsPaginated) {
        // Strict validation: reject invalid page/limit instead of silently
        // clamping. Allows the client to detect bad requests early.
        const rawPage = req.query.page;
        const rawLimit = req.query.limit;
        const pageNum = rawPage === undefined ? 1 : Number(rawPage);
        const limitNum = rawLimit === undefined ? 20 : Number(rawLimit);
        if (
          !Number.isInteger(pageNum) || pageNum < 1 || pageNum > 10000 ||
          !Number.isInteger(limitNum) || limitNum < 1 || limitNum > 100
        ) {
          return res.status(400).json({
            error: "Invalid pagination: page must be an integer in [1,10000] and limit must be an integer in [1,100]",
          });
        }
        const total = segmentsList.length;
        const start = (pageNum - 1) * limitNum;
        const slice = segmentsList.slice(start, start + limitNum);
        return res.json({ segments: slice, total, page: pageNum, limit: limitNum });
      }
      res.json(segmentsList);
    } catch (error) {
      logger.error("Error fetching segments:", error);
      res.status(500).json({ error: "Failed to fetch segments" });
    }
  });

  app.get("/api/segments/counts", async (req: Request, res: Response) => {
    try {
      // Optional `ids` query param: comma-separated list of segment ids to
      // compute counts for. When omitted, falls back to all segments
      // (preserves backward compat). The list endpoint should always send
      // `ids` to limit work to the visible page.
      const idsParam = typeof req.query.ids === "string" ? req.query.ids : "";
      const refresh = req.query.refresh === "true";

      let targetIds: string[];
      if (idsParam) {
        targetIds = idsParam
          .split(",")
          .map((s) => s.trim())
          .filter((s) => validateId(s))
          .slice(0, 100); // hard cap to prevent abuse
      } else {
        const segmentsList = await storage.getSegments();
        targetIds = segmentsList.map((s) => s.id);
      }

      // When refresh=true, drop the cached entries for the requested ids so
      // the next call computes fresh counts. Used by the "Refresh counts"
      // button after a large import.
      if (refresh) {
        await Promise.all(targetIds.map((id) => storage.invalidateSegmentCountCache(id)));
      }

      const counts: Record<string, number> = {};
      const { mapWithConcurrency } = await import("../utils");
      await mapWithConcurrency(targetIds, 5, async (id) => {
        // Use the cached helper (5-minute TTL). The cache is invalidated
        // on subscriber imports / flush jobs, and can be force-refreshed
        // via ?refresh=true above.
        counts[id] = await storage.getSegmentSubscriberCountCached(id);
      });
      res.json(counts);
    } catch (error) {
      logger.error("Error fetching segment counts:", error);
      res.status(500).json({ error: "Failed to fetch segment counts" });
    }
  });

  app.post("/api/segments/preview-count", async (req: Request, res: Response) => {
    try {
      const { rules } = req.body;
      if (!rules) return res.json({ count: 0, sample: [] });
      
      const normalized = normalizeRules(rules);
      if (!normalized) return res.json({ count: 0, sample: [] });
      
      if (!normalized.root?.children?.length) {
        return res.json({ count: 0, sample: [] });
      }
      
      segmentRulesInputSchema.parse(rules);
      
      const sampleLimit = Math.min(parseInt(req.query.sampleLimit as string) || 10, 25);
      const result = await storage.previewSegmentRules(normalized, sampleLimit);
      res.json(result);
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
        segmentRulesInputSchema.parse(data.rules);
      }
      if (data.rules && data.rules.version === 2) {
        if (!data.rules.root?.children?.length) {
          return res.status(400).json({ error: "Segment must have at least one rule" });
        }
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
        segmentRulesInputSchema.parse(req.body.rules);
      }
      if (req.body.rules && req.body.rules.version === 2) {
        if (!req.body.rules.root?.children?.length) {
          return res.status(400).json({ error: "Segment must have at least one rule" });
        }
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

  app.post("/api/segments/:id/duplicate", async (req: Request, res: Response) => {
    try {
      if (!validateId(req.params.id)) {
        return res.status(400).json({ error: "Invalid ID format" });
      }
      const duplicated = await storage.duplicateSegment(req.params.id);
      if (!duplicated) {
        return res.status(404).json({ error: "Segment not found" });
      }
      res.status(201).json(duplicated);
    } catch (error) {
      logger.error("Error duplicating segment:", error);
      res.status(500).json({ error: "Failed to duplicate segment" });
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
