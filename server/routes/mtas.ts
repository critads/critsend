import { type Express, type Request, type Response } from "express";
import { storage } from "../storage";
import { db } from "../db";
import { sql } from "drizzle-orm";
import { logger } from "../logger";
import { insertMtaSchema, insertEmailHeaderSchema } from "@shared/schema";
import { z } from "zod";
import { closeTransporter, resolveSmtpSecurity, invalidateDefaultHeadersCache } from "../email-service";
import { classifySmtpError, sendPlainTestEmail } from "../services/plain-test-sender";
import { getOrangeTestService, OrangeTestError } from "../services/orange-test-jobs";
import { toPublicOrangeTestConfig } from "../config/orange-test";
import nodemailer from "nodemailer";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import type { Mta } from "@shared/schema";

interface SmtpTestResult {
  success: boolean;
  connectionTimeMs: number;
  stage?: string;
  errorCode?: string;
  errorMessage?: string;
  smtpCode?: number;
  suggestions?: string[];
  serverBanner?: string;
}

async function testSmtpConnection(mta: Mta): Promise<SmtpTestResult> {
  const start = Date.now();

  if ((mta as any).mode === "nullsink") {
    return {
      success: true,
      connectionTimeMs: 0,
      serverBanner: "Nullsink (internal test SMTP server)",
    };
  }

  const port = mta.port || 587;
  const protocol = (mta as any).protocol || "STARTTLS";
  const { secure, ignoreTLS } = resolveSmtpSecurity(protocol);

  const transporter = nodemailer.createTransport({
    host: mta.hostname || "localhost",
    port,
    secure,
    ignoreTLS,
    auth: mta.username && mta.password
      ? { user: mta.username, pass: mta.password }
      : undefined,
    pool: false,
    connectionTimeout: 15000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
    tls: {
      rejectUnauthorized: process.env.SMTP_SKIP_TLS_VERIFY !== "true",
    },
  });

  try {
    await transporter.verify();
    const connectionTimeMs = Date.now() - start;
    transporter.close();
    return { success: true, connectionTimeMs };
  } catch (error: any) {
    const connectionTimeMs = Date.now() - start;
    transporter.close();
    const { stage, suggestions } = classifySmtpError(error);
    return {
      success: false,
      connectionTimeMs,
      stage,
      errorCode: error.code || undefined,
      errorMessage: error.message || "Unknown error",
      smtpCode: error.responseCode || undefined,
      suggestions,
    };
  }
}

// Plain Test sends a REAL outbound email to an arbitrary recipient, so it gets a
// strict per-user/IP limiter (well below the general /api 200/min) to bound abuse
// if an operator account is compromised. Auth middleware runs first, so the
// keyGenerator can rely on req.session.userId being present.
const plainTestLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => (req.session?.userId as string) || req.ip || "anonymous",
  message: { error: "Plain test rate limit exceeded — 5 per minute" },
});

// Orange Test also sends a real email (to the fixed Orange mailbox) and each
// start is idempotent per MTA, so the limiter mainly bounds accidental
// hammering of many MTAs at once.
const orangeTestLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => (req.session?.userId as string) || (req.ip ? ipKeyGenerator(req.ip) : "anonymous"),
  message: { error: "Orange test rate limit exceeded — 10 per minute" },
});

export function registerMtaRoutes(app: Express, helpers: {
  parsePagination: (query: any) => { page: number; limit: number };
  validateId: (id: string) => boolean;
}) {
  const { validateId } = helpers;

  app.get("/api/mtas", async (req: Request, res: Response) => {
    try {
      const paginate = req.query.paginate === "true";
      if (paginate) {
        const page = Math.max(1, parseInt(req.query.page as string) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
        const search = (req.query.search as string)?.trim() || undefined;
        const result = await storage.getMtasPaginated({ page, limit, search });
        res.json({
          mtas: result.mtas,
          total: result.total,
          page,
          totalPages: Math.max(1, Math.ceil(result.total / limit)),
        });
      } else {
        const mtasList = await storage.getMtas();
        res.json(mtasList);
      }
    } catch (error) {
      logger.error("Error fetching MTAs:", error);
      res.status(500).json({ error: "Failed to fetch MTAs" });
    }
  });

  // Per-MTA scheduling insights for the campaign wizard (Basic Info step):
  // - scheduled: campaigns currently in status 'scheduled' on each MTA
  //   (shown under the selected server so the operator sees what's queued);
  // - lowOpen: campaigns from the last 24h on each MTA whose unique open
  //   rate is below 10% (surfaced as a warning icon + tooltip).
  // NOTE: must be registered BEFORE /api/mtas/:id or ":id" would swallow it.
  app.get("/api/mtas/schedule-insights", async (_req: Request, res: Response) => {
    try {
      const result = await db.execute(sql`
        SELECT mta_id, id, name, scheduled_at, status, sent_count, unique_opens_count
        FROM campaigns
        WHERE mta_id IS NOT NULL
          AND (
            status = 'scheduled'
            OR (
              status IN ('sending', 'paused', 'completed')
              AND sent_count > 0
              AND COALESCE(scheduled_at, created_at) >= now() - interval '24 hours'
            )
          )
        ORDER BY scheduled_at ASC NULLS LAST
        LIMIT 500
      `);
      const insights: Record<string, {
        scheduled: Array<{ id: string; name: string; scheduledAt: string | null }>;
        lowOpen: Array<{ id: string; name: string; scheduledAt: string | null; openRate: number }>;
      }> = {};
      for (const row of result.rows as Array<Record<string, unknown>>) {
        const mtaId = String(row.mta_id);
        if (!insights[mtaId]) insights[mtaId] = { scheduled: [], lowOpen: [] };
        const ref = {
          id: String(row.id),
          name: String(row.name ?? ""),
          scheduledAt: row.scheduled_at ? new Date(row.scheduled_at as string).toISOString() : null,
        };
        if (row.status === "scheduled") {
          insights[mtaId].scheduled.push(ref);
        } else {
          const sent = Number(row.sent_count) || 0;
          const opens = Number(row.unique_opens_count) || 0;
          const openRate = sent > 0 ? (opens / sent) * 100 : 0;
          if (sent > 0 && openRate < 10) {
            insights[mtaId].lowOpen.push({ ...ref, openRate });
          }
        }
      }
      res.json(insights);
    } catch (error) {
      logger.error("Error building MTA schedule insights:", error);
      res.status(500).json({ error: "Failed to fetch MTA schedule insights" });
    }
  });

  // --- Orange Test -------------------------------------------------------
  // Static paths first so they are never read as an MTA id.
  app.get("/api/mtas/orange-test/config", (_req: Request, res: Response) => {
    res.json(toPublicOrangeTestConfig());
  });

  // Control values for the MTA cards: ?ids=a,b,c → { values: { [mtaId]: { latest, latestVerdict } } }
  app.get("/api/mtas/orange-test/summary", async (req: Request, res: Response) => {
    try {
      const raw = typeof req.query.ids === "string" ? req.query.ids : "";
      const ids = raw.split(",").map((v) => v.trim()).filter((v) => v.length > 0);
      if (ids.some((id) => !validateId(id))) {
        return res.status(400).json({ error: "Invalid ID format" });
      }
      const values = await getOrangeTestService().getControlValues(ids.slice(0, 200));
      res.json({ values });
    } catch (error) {
      logger.error("Error loading Orange test summary:", error);
      res.status(500).json({ error: "Failed to load Orange test summary" });
    }
  });

  app.post("/api/mtas/:id/orange-test", orangeTestLimiter, async (req: Request, res: Response) => {
    try {
      if (!validateId(req.params.id)) {
        return res.status(400).json({ error: "Invalid ID format" });
      }
      const requestedBy = (req.session?.userId as string | undefined) || null;
      const { test, reused } = await getOrangeTestService().startOrangeTest(req.params.id, requestedBy);
      res.status(202).json({ test, reused });
    } catch (error) {
      if (error instanceof OrangeTestError) {
        return res.status(error.httpStatus).json({ error: error.message, code: error.code });
      }
      logger.error("Error starting Orange test:", error);
      res.status(500).json({ error: "Failed to start Orange test" });
    }
  });

  app.get("/api/mtas/:id/orange-tests", async (req: Request, res: Response) => {
    try {
      if (!validateId(req.params.id)) {
        return res.status(400).json({ error: "Invalid ID format" });
      }
      const parsedLimit = Number.parseInt(String(req.query.limit ?? "10"), 10);
      const limit = Number.isFinite(parsedLimit) ? parsedLimit : 10;
      const tests = await getOrangeTestService().listOrangeTests(req.params.id, limit);
      res.json({ tests });
    } catch (error) {
      logger.error("Error listing Orange tests:", error);
      res.status(500).json({ error: "Failed to list Orange tests" });
    }
  });

  app.get("/api/mtas/:id/orange-tests/:testId", async (req: Request, res: Response) => {
    try {
      if (!validateId(req.params.id) || !validateId(req.params.testId)) {
        return res.status(400).json({ error: "Invalid ID format" });
      }
      const test = await getOrangeTestService().getOrangeTest(req.params.testId);
      if (!test || test.mtaId !== req.params.id) {
        return res.status(404).json({ error: "Orange test not found" });
      }
      res.json(test);
    } catch (error) {
      logger.error("Error fetching Orange test:", error);
      res.status(500).json({ error: "Failed to fetch Orange test" });
    }
  });

  app.get("/api/mtas/:id", async (req: Request, res: Response) => {
    try {
      if (!validateId(req.params.id)) {
        return res.status(400).json({ error: "Invalid ID format" });
      }
      const mta = await storage.getMta(req.params.id);
      if (!mta) {
        return res.status(404).json({ error: "MTA not found" });
      }
      res.json(mta);
    } catch (error) {
      logger.error("Error fetching MTA:", error);
      res.status(500).json({ error: "Failed to fetch MTA" });
    }
  });

  app.post("/api/mtas/:id/test", async (req: Request, res: Response) => {
    try {
      if (!validateId(req.params.id)) {
        return res.status(400).json({ error: "Invalid ID format" });
      }
      const mta = await storage.getMta(req.params.id);
      if (!mta) {
        return res.status(404).json({ error: "MTA not found" });
      }
      logger.info(`[MTA TEST] Testing connection for MTA: ${mta.name} (${mta.hostname}:${mta.port})`);
      const result = await testSmtpConnection(mta);
      logger.info(`[MTA TEST] Result for ${mta.name}: ${result.success ? "OK" : "FAILED — " + result.stage}`);
      res.json(result);
    } catch (error) {
      logger.error("Error testing MTA:", error);
      res.status(500).json({ error: "Failed to run connection test" });
    }
  });

  app.post("/api/mtas/:id/plain-test", plainTestLimiter, async (req: Request, res: Response) => {
    try {
      if (!validateId(req.params.id)) {
        return res.status(400).json({ error: "Invalid ID format" });
      }
      const parsed = z
        .object({
          to: z.string().trim().email(),
          // Optional manual headers. Names are restricted to a header token so a
          // value can never smuggle a CRLF into the message (header injection).
          headers: z
            .array(
              z.object({
                key: z
                  .string()
                  .trim()
                  .min(1)
                  .max(200)
                  .regex(/^[A-Za-z0-9][A-Za-z0-9-]*$/, "Invalid header name"),
                value: z
                  .string()
                  .max(2000)
                  .refine((v) => !/[\r\n]/.test(v), "Header value cannot contain line breaks"),
              }),
            )
            .max(25)
            .optional(),
        })
        .safeParse(req.body);
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: parsed.error.issues[0]?.message || "A valid recipient email is required" });
      }
      const mta = await storage.getMta(req.params.id);
      if (!mta) {
        return res.status(404).json({ error: "MTA not found" });
      }
      // Log only the recipient domain to avoid writing a full address (PII) to logs.
      const toDomain = parsed.data.to.split("@")[1] || "unknown";
      const headerCount = parsed.data.headers?.length || 0;
      logger.info(
        `[MTA PLAIN TEST] Sending plain test via MTA ${mta.name} → @${toDomain}` +
          (headerCount ? ` (+${headerCount} custom header${headerCount === 1 ? "" : "s"})` : ""),
      );
      const result = await sendPlainTestEmail(mta, parsed.data.to, parsed.data.headers);
      logger.info(`[MTA PLAIN TEST] Result for ${mta.name}: ${result.success ? "SENT" : "FAILED — " + result.stage}`);
      res.json(result);
    } catch (error) {
      logger.error("Error sending plain test email:", error);
      res.status(500).json({ error: "Failed to send plain test email" });
    }
  });

  app.post("/api/mtas", async (req: Request, res: Response) => {
    try {
      const data = insertMtaSchema.parse(req.body);
      const mta = await storage.createMta(data);
      res.status(201).json(mta);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.errors });
      }
      logger.error("Error creating MTA:", error);
      res.status(500).json({ error: "Failed to create MTA" });
    }
  });

  app.patch("/api/mtas/:id", async (req: Request, res: Response) => {
    try {
      if (!validateId(req.params.id)) {
        return res.status(400).json({ error: "Invalid ID format" });
      }
      const mta = await storage.updateMta(req.params.id, req.body);
      if (!mta) {
        return res.status(404).json({ error: "MTA not found" });
      }
      closeTransporter(req.params.id);
      res.json(mta);
    } catch (error) {
      logger.error("Error updating MTA:", error);
      res.status(500).json({ error: "Failed to update MTA" });
    }
  });

  app.delete("/api/mtas/:id", async (req: Request, res: Response) => {
    try {
      if (!validateId(req.params.id)) {
        return res.status(400).json({ error: "Invalid ID format" });
      }
      await storage.deleteMta(req.params.id);
      closeTransporter(req.params.id);
      res.status(204).send();
    } catch (error: any) {
      const detail = error?.message || String(error);
      const pgCode = error?.code;
      logger.error("Error deleting MTA:", { id: req.params.id, pgCode, detail });
      if (pgCode === "23503") {
        return res.status(409).json({
          error: "This MTA is still referenced by other records. Please remove those references first.",
        });
      }
      res.status(500).json({ error: "Failed to delete MTA", detail });
    }
  });

  app.get("/api/headers", async (req: Request, res: Response) => {
    try {
      const headers = await storage.getHeaders();
      res.json(headers);
    } catch (error) {
      logger.error("Error fetching headers:", error);
      res.status(500).json({ error: "Failed to fetch headers" });
    }
  });

  app.post("/api/headers", async (req: Request, res: Response) => {
    try {
      const data = insertEmailHeaderSchema.parse(req.body);
      const header = await storage.createHeader(data);
      invalidateDefaultHeadersCache();
      res.status(201).json(header);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.errors });
      }
      logger.error("Error creating header:", error);
      res.status(500).json({ error: "Failed to create header" });
    }
  });

  app.patch("/api/headers/:id", async (req: Request, res: Response) => {
    try {
      if (!validateId(req.params.id)) {
        return res.status(400).json({ error: "Invalid ID format" });
      }
      const header = await storage.updateHeader(req.params.id, req.body);
      if (!header) {
        return res.status(404).json({ error: "Header not found" });
      }
      invalidateDefaultHeadersCache();
      res.json(header);
    } catch (error) {
      logger.error("Error updating header:", error);
      res.status(500).json({ error: "Failed to update header" });
    }
  });

  app.delete("/api/headers/:id", async (req: Request, res: Response) => {
    try {
      if (!validateId(req.params.id)) {
        return res.status(400).json({ error: "Invalid ID format" });
      }
      await storage.deleteHeader(req.params.id);
      invalidateDefaultHeadersCache();
      res.status(204).send();
    } catch (error) {
      logger.error("Error deleting header:", error);
      res.status(500).json({ error: "Failed to delete header" });
    }
  });
}
