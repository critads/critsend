import { type Express, type Request, type Response } from "express";
import { storage } from "../storage";
import { logger } from "../logger";
import { insertMtaSchema, insertEmailHeaderSchema } from "@shared/schema";
import { z } from "zod";
import { closeTransporter, resolveSmtpSecurity } from "../email-service";
import nodemailer from "nodemailer";
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

export function registerMtaRoutes(app: Express, helpers: {
  parsePagination: (query: any) => { page: number; limit: number };
  validateId: (id: string) => boolean;
}) {
  const { validateId } = helpers;

  app.get("/api/mtas", async (req: Request, res: Response) => {
    try {
      const mtasList = await storage.getMtas();
      res.json(mtasList);
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
      res.status(204).send();
    } catch (error) {
      logger.error("Error deleting header:", error);
      res.status(500).json({ error: "Failed to delete header" });
    }
  });
}
