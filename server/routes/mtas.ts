import { type Express, type Request, type Response } from "express";
import { storage } from "../storage";
import { logger } from "../logger";
import { insertMtaSchema, insertEmailHeaderSchema } from "@shared/schema";
import { z } from "zod";
import { closeTransporter, resolveSmtpSecurity, invalidateDefaultHeadersCache } from "../email-service";
import nodemailer from "nodemailer";
import rateLimit from "express-rate-limit";
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

function classifySmtpError(error: any): { stage: string; suggestions: string[] } {
  const msg = (error.message || "").toLowerCase();
  const code = (error.code || "").toUpperCase();
  const responseCode = error.responseCode;

  if (code === "ENOTFOUND" || msg.includes("getaddrinfo") || msg.includes("dns")) {
    return {
      stage: "DNS Resolution",
      suggestions: [
        "Verify the hostname is spelled correctly",
        "Confirm the hostname resolves in DNS (try: ping " + (error.hostname || "hostname") + ")",
        "Try using the server's IP address instead of the hostname",
      ],
    };
  }
  if (code === "ECONNREFUSED") {
    return {
      stage: "TCP Connection",
      suggestions: [
        "The server actively refused the connection — check the port number",
        "Common ports: 25 (unauthenticated), 465 (SSL), 587 (STARTTLS)",
        "Verify no firewall or security group is blocking outbound SMTP",
      ],
    };
  }
  if (code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT" || msg.includes("timeout")) {
    return {
      stage: "Connection Timeout",
      suggestions: [
        "The server did not respond within the timeout window",
        "A firewall may be silently dropping the connection (no RST packet)",
        "Try a different port — some ISPs block port 25",
        "Check whether the server is online and accepting connections",
      ],
    };
  }
  if (
    code === "ESOCKET" ||
    code === "CERT_HAS_EXPIRED" ||
    code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
    msg.includes("tls") ||
    msg.includes("ssl") ||
    msg.includes("certificate") ||
    msg.includes("handshake")
  ) {
    return {
      stage: "TLS/SSL Handshake",
      suggestions: [
        "The server's TLS certificate may be self-signed or expired",
        "Port 465 requires SSL from the start; port 587 uses STARTTLS after greeting",
        "Temporarily set SMTP_SKIP_TLS_VERIFY=true to bypass cert validation (dev only)",
        "If your provider uses STARTTLS, ensure you are NOT using secure:true (port 465 mode)",
      ],
    };
  }
  if (
    code === "EAUTH" ||
    (responseCode && responseCode === 535) ||
    msg.includes("authentication") ||
    msg.includes("credentials") ||
    msg.includes("535") ||
    msg.includes("username") ||
    msg.includes("invalid login")
  ) {
    return {
      stage: "Authentication",
      suggestions: [
        "Double-check the SMTP username and password",
        "Some providers require an app-specific password when 2FA is enabled",
        "Ensure SMTP authentication is enabled for this account",
        "Gmail / Outlook may require OAuth2 instead of password auth",
      ],
    };
  }
  if (msg.includes("greeting") || msg.includes("banner") || msg.includes("ehlo") || msg.includes("helo")) {
    return {
      stage: "SMTP Greeting",
      suggestions: [
        "The server responded but rejected the EHLO/HELO greeting",
        "Your server IP may be on a blocklist or rate-limited",
        "Contact the SMTP provider for more detail on the rejection reason",
      ],
    };
  }
  if (code === "ECONNRESET" || msg.includes("connection reset") || msg.includes("socket hang up")) {
    return {
      stage: "Connection Reset",
      suggestions: [
        "The server closed the connection unexpectedly",
        "Your IP may be blocked or rate-limited by the server",
        "Try again in a few minutes",
      ],
    };
  }
  return {
    stage: "SMTP Protocol",
    suggestions: [
      "An unexpected error occurred during the SMTP handshake",
      "Check the raw error message below for more detail",
      "Review your SMTP server's logs for the matching request",
    ],
  };
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

interface PlainTestResult {
  success: boolean;
  connectionTimeMs: number;
  messageId?: string;
  accepted?: string[];
  rejected?: string[];
  from?: string;
  to?: string;
  stage?: string;
  errorCode?: string;
  errorMessage?: string;
  smtpCode?: number;
  suggestions?: string[];
}

const PLAIN_TEST_SUBJECT = "Hello moon";
const PLAIN_TEST_BODY = "I'm the sun";

/**
 * Sends a deliberately *raw* test email through the MTA, bypassing the entire
 * `prepareTrackedHtml` pipeline. NONE of our machinery is applied: no custom
 * email headers, no List-Unsubscribe / unsubscribe footer, no open-tracking
 * pixel, no click/link rewriting, no image rewriting, no preheader. Just the
 * MTA's own From, the recipient, subject "Hello moon" and a plain-text body
 * "I'm the sun". Useful for isolating raw deliverability of an MTA from any
 * tracking/header that content scanners might react to.
 *
 * A one-off, non-pooled transport is used on purpose so this manual test never
 * touches the production sending pool (`createTransporter`).
 */
async function sendPlainTestEmail(mta: Mta, to: string): Promise<PlainTestResult> {
  const start = Date.now();

  if ((mta as any).mode === "nullsink") {
    return {
      success: false,
      connectionTimeMs: 0,
      stage: "Not supported",
      errorMessage: "Plain Test sends a real email and is not available for a nullsink (test mode) MTA.",
      suggestions: ["Use a real SMTP MTA to send a plain test email."],
    };
  }

  const fromEmail = (mta.fromEmail || "").trim();
  if (!fromEmail) {
    return {
      success: false,
      connectionTimeMs: 0,
      stage: "Configuration",
      errorMessage: "This MTA has no From email configured, so a plain test cannot set a sender.",
      suggestions: ["Edit the MTA and set a From email (and optionally a From name)."],
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
    socketTimeout: 20000,
    tls: {
      rejectUnauthorized: process.env.SMTP_SKIP_TLS_VERIFY !== "true",
    },
  });

  const fromName = (mta.fromName || "").trim();
  const from = fromName ? { name: fromName, address: fromEmail } : fromEmail;

  try {
    // Raw on purpose: only From / To / Subject / plain-text body. No headers,
    // no unsubscribe, no tracking, no footer — bypasses prepareTrackedHtml.
    const info = await transporter.sendMail({
      from,
      to,
      subject: PLAIN_TEST_SUBJECT,
      text: PLAIN_TEST_BODY,
    });
    const connectionTimeMs = Date.now() - start;
    const normalizeAddrs = (arr: any[] | undefined): string[] =>
      (arr || []).map((a) => (typeof a === "string" ? a : a?.address)).filter(Boolean);
    return {
      success: true,
      connectionTimeMs,
      messageId: info.messageId,
      accepted: normalizeAddrs(info.accepted as any[]),
      rejected: normalizeAddrs(info.rejected as any[]),
      from: typeof from === "string" ? from : `${from.name} <${from.address}>`,
      to,
    };
  } catch (error: any) {
    const connectionTimeMs = Date.now() - start;
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
  } finally {
    transporter.close();
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
      const parsed = z.object({ to: z.string().trim().email() }).safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "A valid recipient email is required" });
      }
      const mta = await storage.getMta(req.params.id);
      if (!mta) {
        return res.status(404).json({ error: "MTA not found" });
      }
      // Log only the recipient domain to avoid writing a full address (PII) to logs.
      const toDomain = parsed.data.to.split("@")[1] || "unknown";
      logger.info(`[MTA PLAIN TEST] Sending plain test via MTA ${mta.name} → @${toDomain}`);
      const result = await sendPlainTestEmail(mta, parsed.data.to);
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
