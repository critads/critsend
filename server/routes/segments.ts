import { type Express, type Request, type Response } from "express";
import { storage } from "../storage";
import { logger } from "../logger";
import { insertSegmentSchema, segmentRulesInputSchema, migrateRulesV1toV2 } from "@shared/schema";
import type { SegmentRulesV2 } from "@shared/schema";
import { z } from "zod";
import { db } from "../db";
import { sql } from "drizzle-orm";
import multer from "multer";
import os from "os";
import path from "path";
import fs from "fs/promises";
import crypto from "crypto";
import {
  MAX_SEGMENT_EXCLUSION_CSV_BYTES,
  parseSegmentExclusionCsvFile,
} from "../services/segment-exclusion-csv";
import rateLimit from "express-rate-limit";

const exclusionOperationLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 12,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many exclusion CSV operations. Please try again in a minute." },
});

let activeExclusionOperations = 0;
const limitExclusionOperations = (req: Request, res: Response, next: (error?: any) => void) => {
  if (!req.is("multipart/form-data")) return next();
  exclusionOperationLimiter(req, res, () => {
    if (activeExclusionOperations >= 2) {
      return res.status(429).json({ error: "Two exclusion CSV operations are already running. Please try again shortly." });
    }
    activeExclusionOperations += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      activeExclusionOperations = Math.max(0, activeExclusionOperations - 1);
    };
    res.once("finish", release);
    res.once("close", release);
    next();
  });
};

const exclusionUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => callback(null, os.tmpdir()),
    filename: (_req, _file, callback) =>
      callback(null, `segment-exclusions-${crypto.randomUUID()}.csv`),
  }),
  limits: { fileSize: MAX_SEGMENT_EXCLUSION_CSV_BYTES, files: 1, fields: 20 },
  fileFilter: (_req, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase();
    if (extension === ".csv" || extension === ".txt") callback(null, true);
    else callback(new Error("Exclusion upload must be a CSV or text file"));
  },
});

const acceptExclusionUpload = (req: Request, res: Response, next: (error?: any) => void) => {
  exclusionUpload.fields([
    { name: "exclusionFile", maxCount: 1 },
    { name: "exclusionCsv", maxCount: 1 },
    { name: "file", maxCount: 1 },
  ])(req, res, (error: any) => {
    if (!error) return next();
    const status = error?.code === "LIMIT_FILE_SIZE" ? 413 : 400;
    return res.status(status).json({ error: error.message || "Invalid exclusion upload" });
  });
};

function uploadedExclusionFiles(req: Request): Express.Multer.File[] {
  const groups = (req.files || {}) as Record<string, Express.Multer.File[]>;
  return Object.values(groups).flat();
}

async function cleanupExclusionFiles(files: Express.Multer.File[]): Promise<void> {
  await Promise.all(files.map((file) => fs.unlink(file.path).catch(() => {})));
}

function parseJsonMultipartField(value: unknown, field: string): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`Multipart field "${field}" must contain valid JSON`);
  }
}

(async () => {
  try {
    await db.execute(sql`ALTER TABLE segments ADD COLUMN IF NOT EXISTS cached_count integer`);
    logger.info("[SEGMENT] Bootstrap migration: cached_count column ready");
  } catch (err: any) {
    logger.error(`[SEGMENT] Bootstrap migration FAILED (cached_count): ${err?.message || err}`);
  }
})();

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
      const wantsPaginated = req.query.paginate === "true" || req.query.page !== undefined || req.query.limit !== undefined;
      if (wantsPaginated) {
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
        const search = (typeof req.query.search === "string" ? req.query.search : "").trim() || undefined;
        const result = await storage.getSegmentsPaginated({ page: pageNum, limit: limitNum, search });
        return res.json({ segments: result.segments, total: result.total, page: pageNum, limit: limitNum });
      }
      const segmentsList = await storage.getSegments();
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

      // Both branches return at most 100 segment ids. The explicit-`ids`
      // branch trims a caller-supplied list; the fallback branch loads
      // the first page of segments. The 100-item ceiling protects the
      // pool from a workspace with thousands of segments turning a
      // single request into a stampede of cache-miss count queries.
      let targetIds: string[];
      if (idsParam) {
        targetIds = idsParam
          .split(",")
          .map((s) => s.trim())
          .filter((s) => validateId(s))
          .slice(0, 100); // hard cap to prevent abuse
      } else {
        // Fallback path: caller did not specify which segments. Cap the
        // fan-out at the same 100-item ceiling as the explicit-ids branch
        // so a workspace with thousands of segments cannot turn a single
        // request into an O(N) burst of cache-miss count queries. Use the
        // paginated reader so we only fetch the first page from the DB
        // instead of loading the entire segments table into memory.
        const { segments: firstPage } = await storage.getSegmentsPaginated({ page: 1, limit: 100 });
        targetIds = firstPage.map((s) => s.id);
      }

      // When refresh=true, drop the cached entries for the requested ids so
      // the next call computes fresh counts. Used by the "Refresh counts"
      // button after a large import.
      if (refresh) {
        await Promise.all(targetIds.map((id) => storage.invalidateSegmentCountCache(id)));
      }

      const counts: Record<string, number> = {};
      const { mapWithConcurrency } = await import("../utils");
      // Concurrency must not exceed MAX_CONNECTIONS_PER_REQUEST (default 2);
      // otherwise cache misses fan out past the per-request lease cap and
      // get rejected with 503 by the request-lease tracker. Most calls are
      // cache hits and don't touch the pool, so this only constrains the
      // miss tail — exactly when the pool is most likely to be hot.
      await mapWithConcurrency(targetIds, 2, async (id) => {
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

  app.post("/api/segments/preview-count", limitExclusionOperations, acceptExclusionUpload, async (req: Request, res: Response) => {
    const files = uploadedExclusionFiles(req);
    try {
      if (files.length > 1) return res.status(400).json({ error: "Only one exclusion CSV may be uploaded" });
      const rules = parseJsonMultipartField(req.body?.rules, "rules");
      if (!rules) return res.json({ count: 0, sample: [] });
      
      const normalized = normalizeRules(rules);
      if (!normalized) return res.json({ count: 0, sample: [] });
      
      if (!normalized.root?.children?.length) {
        return res.json({ count: 0, sample: [] });
      }
      
      segmentRulesInputSchema.parse(rules);
      
      const sampleLimit = Math.min(parseInt(req.query.sampleLimit as string) || 10, 25);
      const hashes = files[0] ? await parseSegmentExclusionCsvFile(files[0].path) : [];
      if (files[0] && hashes.length === 0) {
        return res.status(400).json({ error: "Exclusion CSV does not contain any SHA-256 hashes" });
      }
      const result = await storage.previewSegmentRules(normalized, sampleLimit, hashes);
      res.json({ ...result, exclusionHashCount: hashes.length });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.errors });
      }
      if (error instanceof Error && /Exclusion CSV|SHA-256|hexadecimal|unique hashes|valid JSON/.test(error.message)) {
        return res.status(400).json({ error: error.message });
      }
      logger.error("Error counting segment preview:", error);
      res.status(500).json({ error: "Failed to count subscribers" });
    } finally {
      await cleanupExclusionFiles(files);
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
      // Optional `exclude` query param (Task #138): when provided, returns
      // the NET count of subscribers in `:id` minus those in `:exclude`.
      // Bypasses the per-segment cache because the combined count is
      // derived from two segments and isn't something we can safely cache
      // under a single key. Self-exclusion returns 0 (also enforced at
      // create/PATCH).
      const excludeRaw = typeof req.query.exclude === "string" ? req.query.exclude.trim() : "";
      if (excludeRaw) {
        // Reject malformed exclude IDs explicitly (don't silently fall back
        // to the non-exclusion count — that would mislead the UI).
        if (!validateId(excludeRaw)) {
          return res.status(400).json({ error: "Invalid exclude segment ID format" });
        }
        if (excludeRaw === req.params.id) {
          return res.status(400).json({ error: "Exclusion segment cannot be the same as the audience segment" });
        }
        // Mirror create/PATCH: reject a non-existent exclusion segment
        // explicitly instead of silently ignoring it in the repo layer.
        const excludeSeg = await storage.getSegment(excludeRaw);
        if (!excludeSeg) {
          return res.status(400).json({ error: "Exclusion segment does not exist" });
        }
        const count = await storage.countSubscribersForSegment(req.params.id, excludeRaw);
        return res.json({ count });
      }
      const count = await storage.getSegmentSubscriberCountCached(req.params.id);
      res.json({ count });
    } catch (error) {
      logger.error("Error counting segment subscribers:", error);
      res.status(500).json({ error: "Failed to count subscribers" });
    }
  });

  // Task #251: union count for campaign wizards. Subscriber rows are queried
  // once with OR-composed rules, so overlap is naturally deduplicated.
  app.post("/api/segments/count", async (req: Request, res: Response) => {
    try {
      const segmentIds = req.body?.segmentIds;
      const excludeSegmentId = req.body?.excludeSegmentId || undefined;
      if (!Array.isArray(segmentIds) || !segmentIds.length || segmentIds.some((id) => !validateId(id)) ||
          new Set(segmentIds).size !== segmentIds.length) {
        return res.status(400).json({ error: "segmentIds must be a unique non-empty list of valid IDs" });
      }
      if (excludeSegmentId && (!validateId(excludeSegmentId) || segmentIds.includes(excludeSegmentId))) {
        return res.status(400).json({ error: "Exclusion segment cannot be the same as an audience segment" });
      }
      const found = await storage.getSegmentsByIds([...segmentIds, ...(excludeSegmentId ? [excludeSegmentId] : [])]);
      if (found.length !== segmentIds.length + (excludeSegmentId ? 1 : 0)) {
        return res.status(400).json({ error: "One or more segments do not exist" });
      }
      res.json({ count: await storage.countSubscribersForSegments(segmentIds, excludeSegmentId) });
    } catch (error) {
      logger.error("Error counting multi-segment subscribers:", error);
      res.status(500).json({ error: "Failed to count segment subscribers" });
    }
  });

  app.post(["/api/segments", "/api/segments/with-exclusions"], limitExclusionOperations, acceptExclusionUpload, async (req: Request, res: Response) => {
    const files = uploadedExclusionFiles(req);
    try {
      if (files.length > 1) return res.status(400).json({ error: "Only one exclusion CSV may be uploaded" });
      const multipartData = req.body?.data !== undefined
        ? parseJsonMultipartField(req.body.data, "data")
        : req.body;
      if (!multipartData || typeof multipartData !== "object" || Array.isArray(multipartData)) {
        return res.status(400).json({ error: "Segment data must be an object" });
      }
      const body = {
        ...multipartData,
        rules: parseJsonMultipartField((multipartData as any).rules, "rules"),
      };
      const data = insertSegmentSchema.parse(body);
      if (data.rules) {
        segmentRulesInputSchema.parse(data.rules);
      }
      const parsedRules = data.rules as any;
      if (parsedRules && parsedRules.version === 2) {
        if (!parsedRules.root?.children?.length) {
          return res.status(400).json({ error: "Segment must have at least one rule" });
        }
      }
      if (!files[0]) {
        const segment = await storage.createSegment(data);
        return res.status(201).json(segment);
      }
      const hashes = await parseSegmentExclusionCsvFile(files[0].path);
      if (files[0] && hashes.length === 0) {
        return res.status(400).json({ error: "Exclusion CSV does not contain any SHA-256 hashes" });
      }
      const result = await storage.createSegmentWithExclusions(data, hashes);
      res.status(201).json({
        ...result.segment,
        exclusionHashCount: result.exclusionHashCount,
        finalHashCount: result.exclusionHashCount,
        matchedExclusionCount: result.matchedExclusionCount,
        finalSegmentCount: result.finalSegmentCount,
        exclusionSummary: {
          hashCount: result.exclusionHashCount,
          matchedCount: result.matchedExclusionCount,
          finalCount: result.finalSegmentCount,
        },
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.errors });
      }
      if (error instanceof Error && (
        /Exclusion CSV|SHA-256|hexadecimal|unique hashes|valid JSON/.test(error.message)
      )) {
        return res.status(400).json({ error: error.message });
      }
      logger.error("Error creating segment:", error);
      res.status(500).json({ error: "Failed to create segment" });
    } finally {
      await cleanupExclusionFiles(files);
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
