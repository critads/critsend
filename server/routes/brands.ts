import { type Express, type Request, type Response, type NextFunction } from "express";
import multer from "multer";
import rateLimit from "express-rate-limit";
import os from "os";
import crypto from "crypto";
import fs from "fs/promises";
import { insertBrandSchema } from "@shared/schema";
import { storage } from "../storage";
import { logger } from "../logger";
import {
  BrandCsvError,
  MAX_BRAND_CSV_BYTES,
  parseBrandCsv,
} from "../services/brand-csv";

const brandCsvUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => callback(null, os.tmpdir()),
    filename: (_req, _file, callback) => {
      callback(null, `brands-${crypto.randomUUID()}.csv`);
    },
  }),
  limits: {
    fileSize: MAX_BRAND_CSV_BYTES,
    files: 1,
    fields: 0,
  },
});

// Keep the request limiter ahead of multer so rejected import attempts never
// cause a multipart body to be written to disk or parsed into memory.
const brandImportLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many brand imports. Please try again in a minute." },
});

function receiveBrandCsv(req: Request, res: Response, next: NextFunction): void {
  brandCsvUpload.single("file")(req, res, (error: unknown) => {
    if (!error) {
      next();
      return;
    }
    // Multer can leave a partially written disk file when a size or field
    // limit is hit.  Remove it before returning the client-facing error.
    void removeUpload(req.file?.path);
    if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
      res.status(413).json({ error: `CSV file must be ${MAX_BRAND_CSV_BYTES} bytes or smaller` });
      return;
    }
    const message = error instanceof Error ? error.message : "Invalid CSV upload";
    res.status(400).json({ error: message });
  });
}

function isUniqueViolation(error: unknown): boolean {
  return !!error
    && typeof error === "object"
    && "code" in error
    && (error as { code?: unknown }).code === "23505";
}

function parsePageValue(
  value: unknown,
  field: "page" | "limit",
  defaultValue: number,
): number | null {
  if (value === undefined) return defaultValue;
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) return null;
  const parsed = Number(value);
  const max = field === "page" ? 10_000 : 100;
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) return null;
  return parsed;
}

function invalidSearch(search: unknown): boolean {
  return typeof search !== "string"
    || search.length > 255
    || /[\u0000-\u001f\u007f]/.test(search);
}

async function removeUpload(filePath: string | undefined): Promise<void> {
  if (filePath) await fs.unlink(filePath).catch(() => {});
}

export function registerBrandRoutes(app: Express): void {
  app.get("/api/brands", async (req: Request, res: Response) => {
    const page = parsePageValue(req.query.page, "page", 1);
    const limit = parsePageValue(req.query.limit, "limit", 25);
    if (page === null || limit === null) {
      return res.status(400).json({
        error: "Invalid pagination: page must be an integer in [1,10000] and limit must be an integer in [1,100]",
      });
    }

    const searchValue = req.query.search;
    if (searchValue !== undefined && invalidSearch(searchValue)) {
      return res.status(400).json({ error: "search must be a string of 255 characters or fewer" });
    }
    const search = typeof searchValue === "string" ? searchValue.trim() || undefined : undefined;

    try {
      const result = await storage.getBrandsPaginated({ page, limit, search });
      return res.json({
        brands: result.brands,
        total: result.total,
        page,
        totalPages: Math.ceil(result.total / limit),
      });
    } catch (error) {
      logger.error("Error fetching brands:", error);
      return res.status(500).json({ error: "Failed to fetch brands" });
    }
  });

  app.post("/api/brands", async (req: Request, res: Response) => {
    const parsed = insertBrandSchema.safeParse(req.body);
    if (!parsed.success) {
      const message = parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "brand"}: ${issue.message}`)
        .join("; ");
      return res.status(400).json({ error: message });
    }

    try {
      const brand = await storage.createBrand(parsed.data);
      return res.status(201).json(brand);
    } catch (error) {
      if (isUniqueViolation(error)) {
        return res.status(409).json({ error: "A brand with this exact name and ref already exists" });
      }
      logger.error("Error creating brand:", error);
      return res.status(500).json({ error: "Failed to create brand" });
    }
  });

  app.post("/api/brands/import", brandImportLimiter, receiveBrandCsv, async (req: Request, res: Response) => {
    const file = req.file;
    if (!file) {
      return res.status(400).json({ error: 'A CSV file is required in the "file" field' });
    }

    try {
      const rows = parseBrandCsv(await fs.readFile(file.path));
      const result = await storage.importBrands(rows);
      return res.json(result);
    } catch (error) {
      if (error instanceof BrandCsvError) {
        return res.status(400).json({ error: error.message });
      }
      logger.error("Error importing brands:", error);
      return res.status(500).json({ error: "Failed to import brands" });
    } finally {
      await removeUpload(file.path);
    }
  });
}