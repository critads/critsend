import { type Express, type Request, type Response } from "express";
import { db } from "../db";
import { abTestVariants, campaigns, insertAbTestVariantSchema } from "@shared/schema";
import { eq, and } from "drizzle-orm";
import { logger } from "../logger";
import { z } from "zod";

function normalCDF(x: number): number {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x);
  const t = 1.0 / (1.0 + p * absX);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX / 2);
  return 0.5 * (1.0 + sign * y);
}

function calculateSignificance(
  variantA: { opens: number; sent: number },
  variantB: { opens: number; sent: number }
): { zScore: number; pValue: number; significant: boolean; confidence: string } {
  if (variantA.sent === 0 || variantB.sent === 0) {
    return { zScore: 0, pValue: 1, significant: false, confidence: "Not significant" };
  }

  const p1 = variantA.opens / variantA.sent;
  const p2 = variantB.opens / variantB.sent;
  const p = (variantA.opens + variantB.opens) / (variantA.sent + variantB.sent);
  const se = Math.sqrt(p * (1 - p) * (1 / variantA.sent + 1 / variantB.sent));
  const zScore = se === 0 ? 0 : (p1 - p2) / se;
  const absZ = Math.abs(zScore);

  let confidence = "Not significant";
  let significant = false;
  if (absZ >= 2.576) { confidence = "99%"; significant = true; }
  else if (absZ >= 1.96) { confidence = "95%"; significant = true; }
  else if (absZ >= 1.645) { confidence = "90%"; significant = true; }

  const pValue = 2 * (1 - normalCDF(absZ));

  return { zScore, pValue, significant, confidence };
}

export function registerAbTestingRoutes(app: Express, helpers: {
  parsePagination: (query: any) => { page: number; limit: number };
  validateId: (id: string) => boolean;
}) {
  const { validateId } = helpers;

  app.post("/api/campaigns/:id/ab-test", async (req: Request, res: Response) => {
    try {
      if (!validateId(req.params.id)) {
        return res.status(400).json({ error: "Invalid ID format" });
      }

      const campaign = await db.query.campaigns.findFirst({
        where: eq(campaigns.id, req.params.id),
      });
      if (!campaign) {
        return res.status(404).json({ error: "Campaign not found" });
      }
      if (campaign.status !== "draft") {
        return res.status(400).json({ error: "Campaign must be in draft status to create A/B test variants" });
      }

      const bodySchema = z.object({
        variants: z.array(insertAbTestVariantSchema.omit({ campaignId: true })).min(2, "At least 2 variants required"),
      });
      const { variants } = bodySchema.parse(req.body);

      const totalAllocation = variants.reduce((sum, v) => sum + v.allocationPercent, 0);
      if (totalAllocation !== 100) {
        return res.status(400).json({ error: "Total allocation percent must equal 100" });
      }

      const created = await db.insert(abTestVariants).values(
        variants.map((v) => ({
          ...v,
          campaignId: req.params.id,
        }))
      ).returning();

      res.status(201).json(created);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.errors });
      }
      logger.error("Error creating A/B test variants:", error);
      res.status(500).json({ error: "Failed to create A/B test variants" });
    }
  });

  app.get("/api/campaigns/:id/ab-test", async (req: Request, res: Response) => {
    try {
      if (!validateId(req.params.id)) {
        return res.status(400).json({ error: "Invalid ID format" });
      }

      const variants = await db.query.abTestVariants.findMany({
        where: eq(abTestVariants.campaignId, req.params.id),
      });

      res.json(variants);
    } catch (error) {
      logger.error("Error fetching A/B test variants:", error);
      res.status(500).json({ error: "Failed to fetch A/B test variants" });
    }
  });

  app.put("/api/campaigns/:id/ab-test/:variantId", async (req: Request, res: Response) => {
    try {
      if (!validateId(req.params.id) || !validateId(req.params.variantId)) {
        return res.status(400).json({ error: "Invalid ID format" });
      }

      const existing = await db.query.abTestVariants.findFirst({
        where: eq(abTestVariants.id, req.params.variantId),
      });
      if (!existing) {
        return res.status(404).json({ error: "Variant not found" });
      }
      if (existing.campaignId !== req.params.id) {
        return res.status(404).json({ error: "Variant not found for this campaign" });
      }

      const updateSchema = z.object({
        name: z.string().min(1).max(100).optional(),
        subject: z.string().nullable().optional(),
        htmlContent: z.string().nullable().optional(),
        fromName: z.string().nullable().optional(),
        preheader: z.string().nullable().optional(),
        allocationPercent: z.number().int().min(1).max(100).optional(),
      });
      const data = updateSchema.parse(req.body);

      const [updated] = await db.update(abTestVariants)
        .set(data)
        .where(and(
          eq(abTestVariants.id, req.params.variantId),
          eq(abTestVariants.campaignId, req.params.id),
        ))
        .returning();

      res.json(updated);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.errors });
      }
      logger.error("Error updating A/B test variant:", error);
      res.status(500).json({ error: "Failed to update A/B test variant" });
    }
  });

  app.delete("/api/campaigns/:id/ab-test/:variantId", async (req: Request, res: Response) => {
    try {
      if (!validateId(req.params.id) || !validateId(req.params.variantId)) {
        return res.status(400).json({ error: "Invalid ID format" });
      }

      const existing = await db.query.abTestVariants.findFirst({
        where: eq(abTestVariants.id, req.params.variantId),
      });
      if (!existing) {
        return res.status(404).json({ error: "Variant not found" });
      }
      if (existing.campaignId !== req.params.id) {
        return res.status(404).json({ error: "Variant not found for this campaign" });
      }

      await db.delete(abTestVariants).where(and(
        eq(abTestVariants.id, req.params.variantId),
        eq(abTestVariants.campaignId, req.params.id),
      ));

      res.status(204).send();
    } catch (error) {
      logger.error("Error deleting A/B test variant:", error);
      res.status(500).json({ error: "Failed to delete A/B test variant" });
    }
  });

  app.post("/api/campaigns/:id/ab-test/winner", async (req: Request, res: Response) => {
    try {
      if (!validateId(req.params.id)) {
        return res.status(400).json({ error: "Invalid ID format" });
      }

      const winnerSchema = z.object({
        variantId: z.string().min(1),
      });
      const { variantId } = winnerSchema.parse(req.body);

      if (!validateId(variantId)) {
        return res.status(400).json({ error: "Invalid variant ID format" });
      }

      const variant = await db.query.abTestVariants.findFirst({
        where: and(
          eq(abTestVariants.id, variantId),
          eq(abTestVariants.campaignId, req.params.id),
        ),
      });
      if (!variant) {
        return res.status(404).json({ error: "Variant not found" });
      }

      await db.update(abTestVariants)
        .set({ isWinner: false })
        .where(eq(abTestVariants.campaignId, req.params.id));

      await db.update(abTestVariants)
        .set({ isWinner: true })
        .where(and(
          eq(abTestVariants.id, variantId),
          eq(abTestVariants.campaignId, req.params.id),
        ));

      const updateData: Record<string, string> = {};
      if (variant.subject) updateData.subject = variant.subject;
      if (variant.htmlContent) updateData.htmlContent = variant.htmlContent;
      if (variant.fromName) updateData.fromName = variant.fromName;
      if (variant.preheader) updateData.preheader = variant.preheader;

      if (Object.keys(updateData).length > 0) {
        await db.update(campaigns)
          .set(updateData)
          .where(eq(campaigns.id, req.params.id));
      }

      res.json({ success: true, winnerId: variantId });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.errors });
      }
      logger.error("Error declaring A/B test winner:", error);
      res.status(500).json({ error: "Failed to declare A/B test winner" });
    }
  });

  app.get("/api/campaigns/:id/ab-test/results", async (req: Request, res: Response) => {
    try {
      if (!validateId(req.params.id)) {
        return res.status(400).json({ error: "Invalid ID format" });
      }

      const variants = await db.query.abTestVariants.findMany({
        where: eq(abTestVariants.campaignId, req.params.id),
      });

      if (variants.length === 0) {
        return res.status(404).json({ error: "No A/B test variants found for this campaign" });
      }

      const variantResults = variants.map((v) => ({
        id: v.id,
        name: v.name,
        allocationPercent: v.allocationPercent,
        sentCount: v.sentCount,
        openCount: v.openCount,
        clickCount: v.clickCount,
        unsubscribeCount: v.unsubscribeCount,
        bounceCount: v.bounceCount,
        isWinner: v.isWinner,
        openRate: v.sentCount > 0 ? (v.openCount / v.sentCount) * 100 : 0,
        clickRate: v.sentCount > 0 ? (v.clickCount / v.sentCount) * 100 : 0,
      }));

      const comparisons: Array<{
        variantA: string;
        variantB: string;
        metric: string;
        zScore: number;
        pValue: number;
        significant: boolean;
        confidence: string;
      }> = [];

      for (let i = 0; i < variants.length; i++) {
        for (let j = i + 1; j < variants.length; j++) {
          const openSig = calculateSignificance(
            { opens: variants[i].openCount, sent: variants[i].sentCount },
            { opens: variants[j].openCount, sent: variants[j].sentCount },
          );
          comparisons.push({
            variantA: variants[i].id,
            variantB: variants[j].id,
            metric: "open_rate",
            ...openSig,
          });

          const clickSig = calculateSignificance(
            { opens: variants[i].clickCount, sent: variants[i].sentCount },
            { opens: variants[j].clickCount, sent: variants[j].sentCount },
          );
          comparisons.push({
            variantA: variants[i].id,
            variantB: variants[j].id,
            metric: "click_rate",
            ...clickSig,
          });
        }
      }

      res.json({
        campaignId: req.params.id,
        variants: variantResults,
        comparisons,
      });
    } catch (error) {
      logger.error("Error fetching A/B test results:", error);
      res.status(500).json({ error: "Failed to fetch A/B test results" });
    }
  });
}
