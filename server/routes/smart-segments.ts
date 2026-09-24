// Task #304 — Smart segment routes (all under /api, so session-authenticated
// by the global guard in server/index.ts).
import { type Express, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { logger } from "../logger";
import {
  smartSegmentAnalysisRequestSchema,
  smartSegmentMaterializeRequestSchema,
  smartSegmentOutcomesRequestSchema,
  smartSegmentResolveRequestSchema,
  smartSegmentSimilarBrandsRequestSchema,
  type SmartSegmentSimilarBrandsResponse,
  type SmartSegmentFeatureStatus,
  type SmartSegmentOutcomesResponse,
  type SmartSegmentResolveResponse,
} from "@shared/smart-segment";
import { smartSegmentFeatureStatus } from "../config/smart-segment";
import { SmartSegmentError } from "../services/smart-segment-evidence";
import { resolveSmartSegmentContext } from "../services/smart-segment-brand";
import { listSmartSegmentOutcomes } from "../services/smart-segment-outcomes";
import { lookupSimilarBrands } from "../services/smart-segment-similar";
import {
  getSmartSegmentAnalysis,
  materializeSmartSegmentProposal,
  startSmartSegmentAnalysis,
} from "../services/smart-segment-jobs";

const analysisLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Trop de demandes d'analyse Smart segment. Réessayez dans une minute.", code: "RATE_LIMITED" },
});

const resolveLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Trop de résolutions de marque. Réessayez dans une minute.", code: "RATE_LIMITED" },
});

const similarLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 12,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Trop de recherches de marques similaires. Réessayez dans une minute.", code: "RATE_LIMITED" },
});

const idSchema = z.string().uuid();

function sendError(res: Response, error: unknown, context: string): void {
  if (error instanceof SmartSegmentError) {
    res.status(error.status).json({ error: error.message, code: error.code });
    return;
  }
  if (error instanceof z.ZodError) {
    res.status(400).json({ error: "Paramètres invalides", code: "VALIDATION", details: error.issues.slice(0, 8) });
    return;
  }
  logger.error(`[SMART_SEGMENT] ${context} failed`, { error: (error as Error)?.message ?? String(error) });
  res.status(500).json({ error: `Erreur interne (${context}).`, code: "INTERNAL" });
}

function sessionUserId(req: Request): string | null {
  const userId = (req as Request & { session?: { userId?: unknown } }).session?.userId;
  return typeof userId === "string" ? userId : userId != null ? String(userId) : null;
}

export function registerSmartSegmentRoutes(app: Express): void {
  app.get("/api/smart-segments/status", (_req: Request, res: Response) => {
    const status: SmartSegmentFeatureStatus = smartSegmentFeatureStatus();
    res.json(status);
  });

  app.post("/api/smart-segments/resolve", resolveLimiter, async (req: Request, res: Response) => {
    try {
      const body = smartSegmentResolveRequestSchema.parse(req.body ?? {});
      const result: SmartSegmentResolveResponse = await resolveSmartSegmentContext({
        campaignName: body.campaignName,
        mtaId: body.mtaId ?? null,
        brandOverride: body.brandOverride ?? null,
      });
      res.json(result);
    } catch (error) {
      sendError(res, error, "resolve");
    }
  });

  // Similar brands for the wizard: one synchronous model call (web search)
  // choosing inside the brand directory, persisted per brand. Slow (tens of
  // seconds) and billed, hence its own tighter limiter.
  app.post("/api/smart-segments/similar-brands", similarLimiter, async (req: Request, res: Response) => {
    try {
      const body = smartSegmentSimilarBrandsRequestSchema.parse(req.body ?? {});
      const result: SmartSegmentSimilarBrandsResponse = await lookupSimilarBrands({
        brandName: body.brandName,
        coreRefs: body.coreRefs ?? [],
        refresh: body.refresh === true,
      });
      res.json(result);
    } catch (error) {
      sendError(res, error, "similar-brands");
    }
  });

  // « Projeté vs réel » panel: projections of the brand's recent analyses next
  // to the cached counters of the campaigns that used their segments.
  app.get("/api/smart-segments/outcomes", resolveLimiter, async (req: Request, res: Response) => {
    try {
      const rawOverride = typeof req.query.brandOverride === "string" && req.query.brandOverride.trim()
        ? JSON.parse(req.query.brandOverride)
        : null;
      const body = smartSegmentOutcomesRequestSchema.parse({ campaignName: req.query.campaignName, brandOverride: rawOverride });
      const result: SmartSegmentOutcomesResponse = await listSmartSegmentOutcomes({
        campaignName: body.campaignName,
        brandOverride: body.brandOverride ?? null,
      });
      res.json(result);
    } catch (error) {
      if (error instanceof SyntaxError) {
        res.status(400).json({ error: "Paramètres invalides", code: "VALIDATION" });
        return;
      }
      sendError(res, error, "outcomes");
    }
  });

  app.post("/api/smart-segments/analyses", analysisLimiter, async (req: Request, res: Response) => {
    try {
      const params = smartSegmentAnalysisRequestSchema.parse(req.body ?? {});
      const { view, created } = await startSmartSegmentAnalysis(params, sessionUserId(req));
      res.status(created ? 201 : 200).json(view);
    } catch (error) {
      sendError(res, error, "start analysis");
    }
  });

  app.get("/api/smart-segments/analyses/:id", async (req: Request, res: Response) => {
    try {
      const id = idSchema.parse(req.params.id);
      const view = await getSmartSegmentAnalysis(id);
      if (!view) return res.status(404).json({ error: "Analyse introuvable.", code: "NOT_FOUND" });
      res.json(view);
    } catch (error) {
      sendError(res, error, "get analysis");
    }
  });

  app.post("/api/smart-segments/analyses/:id/materialize", async (req: Request, res: Response) => {
    try {
      const id = idSchema.parse(req.params.id);
      const body = smartSegmentMaterializeRequestSchema.parse(req.body ?? {});
      const result = await materializeSmartSegmentProposal(id, {
        campaignId: body.campaignId ?? null,
        proposalIndexes: body.proposalIndexes,
        attach: body.attach,
      });
      res.status(201).json(result);
    } catch (error) {
      sendError(res, error, "materialize");
    }
  });
}
