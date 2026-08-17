import { type Express, type Request, type Response, type NextFunction } from "express";
import rateLimit from "express-rate-limit";
import crypto from "crypto";
import { z } from "zod";
import { db } from "../db";
import { sql } from "drizzle-orm";
import { logger } from "../logger";
import { campaigns } from "@shared/schema";
import { generateBase62 } from "../utils";

/**
 * External API (Task: campaign creation API) + API key management.
 *
 * - Management routes (/api/api-keys/*) are session-protected like the rest
 *   of the app: create, list, delete keys from the UI.
 * - External route (/api/v1/campaigns) is exempted from session+CSRF in
 *   server/index.ts and authenticated with an API key sent as
 *   `X-Api-Key: <key>` or `Authorization: Bearer <key>`.
 *
 * Keys look like `csk_<40 base62 chars>`; only the SHA-256 hash is stored.
 */

// Idempotent bootstrap (prod deploys don't run drizzle push).
(async () => {
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS api_keys (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        name text NOT NULL,
        key_hash text NOT NULL UNIQUE,
        prefix text NOT NULL,
        created_at timestamp NOT NULL DEFAULT now(),
        last_used_at timestamp
      )
    `);
    logger.info("[API-KEYS] Bootstrap migration: api_keys table ready");
  } catch (err: any) {
    logger.error(`[API-KEYS] Bootstrap migration FAILED: ${err?.message || err}`);
  }
})();

function hashKey(key: string): string {
  return crypto.createHash("sha256").update(key).digest("hex");
}

function extractApiKey(req: Request): string | null {
  const headerKey = req.headers["x-api-key"];
  if (typeof headerKey === "string" && headerKey.trim()) return headerKey.trim();
  const auth = req.headers["authorization"];
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) {
    const token = auth.slice(7).trim();
    if (token) return token;
  }
  return null;
}

/** Authenticates the external API. Attaches nothing; 401 on failure. */
async function requireApiKey(req: Request, res: Response, next: NextFunction) {
  try {
    const key = extractApiKey(req);
    if (!key || !key.startsWith("csk_")) {
      return res.status(401).json({ error: "Missing or malformed API key (expected X-Api-Key or Authorization: Bearer)" });
    }
    const keyHash = hashKey(key);
    const found: any = await db.execute(sql`SELECT id FROM api_keys WHERE key_hash = ${keyHash} LIMIT 1`);
    if (!found.rows.length) {
      return res.status(401).json({ error: "Invalid API key" });
    }
    // Best-effort usage timestamp; never blocks the request.
    db.execute(sql`UPDATE api_keys SET last_used_at = NOW() WHERE id = ${found.rows[0].id}`).catch(() => {});
    next();
  } catch (err) {
    logger.error("API key auth error:", err);
    res.status(500).json({ error: "Authentication failed" });
  }
}

const externalCampaignSchema = z.object({
  name: z.string().min(1, "name required").max(200, "name too long"),
  subject: z.string().min(1, "subject required").max(998, "subject too long"),
  html: z.string().min(1, "html required").max(5000000, "html too large"),
});

export function registerApiKeyRoutes(app: Express) {
  // ---- Management (session-protected via global middleware) ----

  app.get("/api/api-keys", async (_req: Request, res: Response) => {
    try {
      const r: any = await db.execute(sql`SELECT id, name, prefix, created_at AS "createdAt", last_used_at AS "lastUsedAt" FROM api_keys ORDER BY created_at DESC`);
      res.json(r.rows);
    } catch (error) {
      logger.error("Error listing API keys:", error);
      res.status(500).json({ error: "Failed to list API keys" });
    }
  });

  app.post("/api/api-keys", async (req: Request, res: Response) => {
    try {
      const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
      if (!name || name.length > 100) {
        return res.status(400).json({ error: "A name (1-100 chars) is required" });
      }
      const key = "csk_" + generateBase62(40);
      const prefix = key.slice(0, 12);
      const r: any = await db.execute(sql`
        INSERT INTO api_keys (name, key_hash, prefix)
        VALUES (${name}, ${hashKey(key)}, ${prefix})
        RETURNING id, name, prefix, created_at AS "createdAt"
      `);
      // The plaintext key is returned ONCE and never stored.
      res.status(201).json({ ...r.rows[0], key });
    } catch (error) {
      logger.error("Error creating API key:", error);
      res.status(500).json({ error: "Failed to create API key" });
    }
  });

  app.delete("/api/api-keys/:id", async (req: Request, res: Response) => {
    try {
      const r: any = await db.execute(sql`DELETE FROM api_keys WHERE id = ${req.params.id} RETURNING id`);
      if (!r.rows.length) return res.status(404).json({ error: "API key not found" });
      res.status(204).send();
    } catch (error) {
      logger.error("Error deleting API key:", error);
      res.status(500).json({ error: "Failed to delete API key" });
    }
  });

  // ---- External API (API-key auth, session/CSRF exempt) ----

  const externalLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests" },
  });

  // Secure-by-default: EVERY /api/v1/* route requires a valid API key.
  // (server/index.ts exempts the /api/v1/ namespace from session+CSRF, so
  // this gate must stay registered before any /api/v1 route.)
  app.use("/api/v1/", externalLimiter, requireApiKey);

  app.post("/api/v1/campaigns", async (req: Request, res: Response) => {
    try {
      const parsed = externalCampaignSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.errors.map(e => `${e.path.join(".")}: ${e.message}`) });
      }
      const { name, subject, html } = parsed.data;
      const [created] = await db
        .insert(campaigns)
        .values({
          name,
          subject,
          htmlContent: html,
          fromName: "",
          fromEmail: "",
          status: "draft",
        })
        .returning({ id: campaigns.id, name: campaigns.name, subject: campaigns.subject, status: campaigns.status, createdAt: campaigns.createdAt });
      logger.info(`[API-V1] Campaign created via external API: ${created.id} (${name})`);
      res.status(201).json(created);
    } catch (error) {
      logger.error("Error creating campaign via external API:", error);
      res.status(500).json({ error: "Failed to create campaign" });
    }
  });
}
