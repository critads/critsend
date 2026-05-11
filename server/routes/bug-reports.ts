import { type Express, type Request, type Response } from "express";
import { z } from "zod";
import { db } from "../db";
import { bugReports, insertBugReportSchema, type BugReport } from "@shared/schema";
import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import { ObjectStorageService, ObjectNotFoundError } from "../replit_integrations/object_storage/objectStorage";
import { logger } from "../logger";

const VALID_STATUSES = ["new", "in_progress", "completed"] as const;

const updateStatusSchema = z.object({
  status: z.enum(VALID_STATUSES),
});

export function registerBugReportRoutes(app: Express) {
  const objectStorage = new ObjectStorageService();

  // Get presigned upload URL for screenshot
  app.post("/api/bug-reports/upload-url", async (_req: Request, res: Response) => {
    try {
      const uploadURL = await objectStorage.getObjectEntityUploadURL();
      const objectPath = objectStorage.normalizeObjectEntityPath(uploadURL);
      res.json({ uploadURL, objectPath });
    } catch (error: any) {
      logger.error("bug-report upload-url error", { error: String(error) });
      res.status(500).json({ error: "Failed to generate upload URL" });
    }
  });

  // Create a bug report
  app.post("/api/bug-reports", async (req: Request, res: Response) => {
    try {
      const parsed = insertBugReportSchema.safeParse({
        ...req.body,
        userId: req.session.userId ?? null,
      });
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid input", details: parsed.error.flatten().fieldErrors });
      }

      let screenshotPath = parsed.data.screenshotPath ?? null;
      if (screenshotPath) {
        // Only accept paths produced by our presigned upload flow:
        // `/objects/uploads/<uuid>` — reject arbitrary object references
        // to prevent attaching unrelated files. Drop the screenshot if ACL
        // hardening fails so we never persist a path that isn't private.
        const validPath = /^\/objects\/uploads\/[A-Za-z0-9_-]{8,}$/.test(screenshotPath);
        if (!validPath) {
          screenshotPath = null;
        } else {
          try {
            await objectStorage.trySetObjectEntityAclPolicy(screenshotPath, {
              owner: req.session.userId ?? "system",
              visibility: "private",
            });
          } catch (e) {
            logger.warn("bug-report acl set failed; dropping screenshot", { error: String(e) });
            screenshotPath = null;
          }
        }
      }

      const [report] = await db.insert(bugReports).values({
        userId: parsed.data.userId ?? req.session.userId ?? null,
        userEmail: parsed.data.userEmail ?? null,
        description: parsed.data.description,
        screenshotPath,
        pageUrl: parsed.data.pageUrl ?? null,
        userAgent: parsed.data.userAgent ?? null,
        viewportWidth: parsed.data.viewportWidth ?? null,
        viewportHeight: parsed.data.viewportHeight ?? null,
      }).returning();

      res.status(201).json(report);
    } catch (error: any) {
      logger.error("bug-report create error", { error: error.message });
      res.status(500).json({ error: "Failed to create bug report" });
    }
  });

  // List bug reports (admin)
  app.get("/api/bug-reports", async (req: Request, res: Response) => {
    try {
      const status = typeof req.query.status === "string" ? req.query.status : undefined;
      const search = typeof req.query.q === "string" ? req.query.q.trim() : "";
      const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "100"), 10) || 100, 1), 500);
      const offset = Math.max(parseInt(String(req.query.offset ?? "0"), 10) || 0, 0);

      const conds: any[] = [];
      if (status && (VALID_STATUSES as readonly string[]).includes(status)) {
        conds.push(eq(bugReports.status, status));
      }
      if (search) {
        const like = `%${search}%`;
        conds.push(or(ilike(bugReports.description, like), ilike(bugReports.userEmail, like), ilike(bugReports.pageUrl, like)));
      }
      const where = conds.length ? and(...conds) : undefined;

      const rows = await db.select().from(bugReports)
        .where(where as any)
        .orderBy(desc(bugReports.createdAt))
        .limit(limit)
        .offset(offset);

      const totalRow = await db.execute(sql`SELECT COUNT(*)::int AS c FROM bug_reports ${where ? sql`WHERE ${where}` : sql``}`);
      const total = Number((totalRow.rows[0] as any)?.c ?? 0);

      res.json({ reports: rows, total });
    } catch (error: any) {
      logger.error("bug-report list error", { error: error.message });
      res.status(500).json({ error: "Failed to list bug reports" });
    }
  });

  // Get a single bug report
  app.get("/api/bug-reports/:id", async (req: Request, res: Response) => {
    try {
      const [report] = await db.select().from(bugReports).where(eq(bugReports.id, req.params.id)).limit(1);
      if (!report) return res.status(404).json({ error: "Bug report not found" });
      res.json(report);
    } catch (error: any) {
      res.status(500).json({ error: "Failed to fetch bug report" });
    }
  });

  // Update bug report status (admin)
  app.patch("/api/bug-reports/:id", async (req: Request, res: Response) => {
    try {
      const parsed = updateStatusSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid input", details: parsed.error.flatten().fieldErrors });
      }
      const [report] = await db.update(bugReports)
        .set({ status: parsed.data.status, updatedAt: new Date() })
        .where(eq(bugReports.id, req.params.id))
        .returning();
      if (!report) return res.status(404).json({ error: "Bug report not found" });
      res.json(report);
    } catch (error: any) {
      logger.error("bug-report update error", { error: error.message });
      res.status(500).json({ error: "Failed to update bug report" });
    }
  });

  // Stream screenshot via authenticated proxy
  app.get("/api/bug-reports/:id/screenshot", async (req: Request, res: Response) => {
    try {
      const [report] = await db.select().from(bugReports).where(eq(bugReports.id, req.params.id)).limit(1);
      if (!report || !report.screenshotPath) {
        return res.status(404).json({ error: "Screenshot not found" });
      }
      const file = await objectStorage.getObjectEntityFile(report.screenshotPath);
      await objectStorage.downloadObject(file, res, 60);
    } catch (error: any) {
      if (error instanceof ObjectNotFoundError) {
        return res.status(404).json({ error: "Screenshot not found" });
      }
      logger.error("bug-report screenshot error", { error: error.message });
      res.status(500).json({ error: "Failed to fetch screenshot" });
    }
  });
}
