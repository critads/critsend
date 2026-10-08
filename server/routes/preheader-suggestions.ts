// AI preheader suggestions route (under /api, so session-authenticated by the
// global guard in server/index.ts). Registered BEFORE the campaign routes so
// the literal path is never shadowed by /api/campaigns/:id handlers.
import { type Express, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { logger } from "../logger";
import { preheaderSuggestionsRequestSchema, type PreheaderSuggestionsResponse } from "@shared/preheader-suggestions";
import { PreheaderSuggestionError, suggestPreheaders } from "../services/preheader-suggestions";

// Each click is one billed model call of a few seconds.
const preheaderLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Trop de demandes de suggestions de preheader. Réessayez dans une minute.", code: "RATE_LIMITED" },
});

export function registerPreheaderSuggestionRoutes(app: Express): void {
  app.post("/api/campaigns/preheader-suggestions", preheaderLimiter, async (req: Request, res: Response) => {
    try {
      const body = preheaderSuggestionsRequestSchema.parse(req.body ?? {});
      const result: PreheaderSuggestionsResponse = await suggestPreheaders({
        subject: body.subject,
        htmlContent: body.htmlContent,
        campaignName: body.campaignName ?? null,
      });
      res.json(result);
    } catch (error) {
      if (error instanceof PreheaderSuggestionError) {
        res.status(error.status).json({ error: error.message, code: error.code });
        return;
      }
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: "Paramètres invalides", code: "VALIDATION", details: error.issues.slice(0, 8) });
        return;
      }
      logger.error("[PREHEADER_AI] route failed", { error: (error as Error)?.message ?? String(error) });
      res.status(500).json({ error: "Erreur interne (suggestions de preheader).", code: "INTERNAL" });
    }
  });
}
