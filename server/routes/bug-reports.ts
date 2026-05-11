import { type Express, type Request, type Response } from "express";
import { z } from "zod";
import { db } from "../db";
import { bugReports, insertBugReportSchema } from "@shared/schema";
import { and, desc, eq, ilike, or, sql, type SQL } from "drizzle-orm";
import { ObjectStorageService, ObjectNotFoundError } from "../replit_integrations/object_storage/objectStorage";
import { logger } from "../logger";

const VALID_STATUSES = ["new", "in_progress", "completed"] as const;
type BugReportStatus = (typeof VALID_STATUSES)[number];

const updateStatusSchema = z.object({
  status: z.enum(VALID_STATUSES),
});

// Screenshots are stored under a dedicated `bug-reports/` namespace in the
// private bucket so they're easy to identify, audit, and bulk-purge.
const SCREENSHOT_PATH_RE = /^\/objects\/bug-reports\/[A-Za-z0-9_-]{8,}$/;

export function registerBugReportRoutes(app: Express) {
  const objectStorage = new ObjectStorageService();

  // Get presigned upload URL for a bug-report screenshot.
  app.post("/api/bug-reports/upload-url", async (_req: Request, res: Response) => {
    try {
      const uploadURL = await objectStorage.getNamespacedUploadURL("bug-reports");
      const objectPath = objectStorage.normalizeObjectEntityPath(uploadURL);
      res.json({ uploadURL, objectPath });
    } catch (error) {
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

      let screenshotPath: string | null = parsed.data.screenshotPath ?? null;
      if (screenshotPath) {
        // Only accept paths produced by our presigned upload flow under the
        // `bug-reports/` namespace. Reject arbitrary object references and
        // drop the screenshot if ACL hardening fails so we never persist a
        // path that isn't private.
        if (!SCREENSHOT_PATH_RE.test(screenshotPath)) {
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
    } catch (error) {
      logger.error("bug-report create error", { error: String(error) });
      res.status(500).json({ error: "Failed to create bug report" });
    }
  });

  // List bug reports (admin) — paginated, with optional status + free-text search.
  app.get("/api/bug-reports", async (req: Request, res: Response) => {
    try {
      const statusParam = typeof req.query.status === "string" ? req.query.status : undefined;
      const search = typeof req.query.q === "string" ? req.query.q.trim() : "";
      const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "50"), 10) || 50, 1), 200);
      const offset = Math.max(parseInt(String(req.query.offset ?? "0"), 10) || 0, 0);

      const conds: SQL[] = [];
      if (statusParam && (VALID_STATUSES as readonly string[]).includes(statusParam)) {
        conds.push(eq(bugReports.status, statusParam as BugReportStatus));
      }
      if (search) {
        const like = `%${search}%`;
        const orClause = or(
          ilike(bugReports.description, like),
          ilike(bugReports.userEmail, like),
          ilike(bugReports.pageUrl, like),
        );
        if (orClause) conds.push(orClause);
      }
      const where: SQL | undefined = conds.length ? and(...conds) : undefined;

      const rows = await db.select().from(bugReports)
        .where(where)
        .orderBy(desc(bugReports.createdAt))
        .limit(limit)
        .offset(offset);

      const [countRow] = await db
        .select({ total: sql<number>`count(*)::int` })
        .from(bugReports)
        .where(where);
      const total = countRow?.total ?? 0;

      res.json({ reports: rows, total, limit, offset });
    } catch (error) {
      logger.error("bug-report list error", { error: String(error) });
      res.status(500).json({ error: "Failed to list bug reports" });
    }
  });

  // Get a single bug report
  app.get("/api/bug-reports/:id", async (req: Request, res: Response) => {
    try {
      const [report] = await db.select().from(bugReports).where(eq(bugReports.id, req.params.id)).limit(1);
      if (!report) return res.status(404).json({ error: "Bug report not found" });
      res.json(report);
    } catch (error) {
      logger.error("bug-report fetch error", { error: String(error) });
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
    } catch (error) {
      logger.error("bug-report update error", { error: String(error) });
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
    } catch (error) {
      if (error instanceof ObjectNotFoundError) {
        return res.status(404).json({ error: "Screenshot not found" });
      }
      logger.error("bug-report screenshot error", { error: String(error) });
      res.status(500).json({ error: "Failed to fetch screenshot" });
    }
  });
}
