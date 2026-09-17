import type { Express, Request, Response } from "express";
import { sql } from "drizzle-orm";
import { db } from "../db";
import {
  campaignMtaTransferCommitSchema,
  campaignMtaTransferRequestSchema,
  transferOpaqueIdSchema,
} from "@shared/campaign-mta-transfer";
import { CampaignMtaTransferError, prepareTransfer, previewCampaignMtaTransfer } from "../services/campaign-mta-transfer";
import { commitCampaignMtaTransfer } from "../repositories/campaign-mta-transfer-repository";
import { publishCampaignsListInvalidation } from "../repositories/campaigns-list-cache";
import { logger } from "../logger";

async function isAdmin(uid: string): Promise<boolean> {
  try {
    const result = await db.execute(sql`SELECT is_admin FROM users WHERE id = ${uid}`);
    if (result.rows[0]?.is_admin === true) return true;
  } catch {
    // Older installations may not have users.is_admin yet.  The allowlist is
    // intentionally limited to bootstrap/non-production use.
  }
  const allowlist = (process.env.ADMIN_USER_IDS ?? "").split(",").map((v) => v.trim()).filter(Boolean);
  return allowlist.includes(uid);
}

async function authorize(req: Request, res: Response, campaignId: string): Promise<boolean> {
  const uid = req.session?.userId as string | undefined;
  if (!uid) {
    res.status(401).json({ error: "Authentication required", code: "UNAUTHORIZED" });
    return false;
  }
  if (await isAdmin(uid)) return true;
  try {
    const row = await db.execute(sql`SELECT user_id FROM campaigns WHERE id = ${campaignId}`);
    if (!row.rows.length) {
      res.status(404).json({ error: "Campaign not found", code: "NOT_FOUND" });
      return false;
    }
    // Existing campaign creation permits a NULL owner for shared/single-tenant
    // campaigns. Preserve that schedule policy: any authenticated user may
    // operate a NULL-owned campaign, while an explicitly owned campaign is
    // restricted to its owner (or the admin branch above).
    if (row.rows[0].user_id && row.rows[0].user_id !== uid) {
      res.status(403).json({ error: "Forbidden", code: "FORBIDDEN" });
      return false;
    }
    return true;
  } catch (error) {
    logger.error("[MTA_TRANSFER] ownership check failed", error);
    res.status(503).json({ error: "Authorization temporarily unavailable", code: "AUTH_UNAVAILABLE" });
    return false;
  }
}

function sendError(res: Response, error: unknown): void {
  if (error instanceof CampaignMtaTransferError) {
    res.status(error.httpStatus).json({
      error: error.message,
      code: error.code,
      ...(error.details ?? {}),
    });
    return;
  }
  if ((error as any)?.name === "ZodError") {
    res.status(400).json({ error: "Invalid transfer request", code: "INVALID_REQUEST", details: (error as any).errors });
    return;
  }
  logger.error("[MTA_TRANSFER] request failed", error);
  res.status(500).json({ error: "Failed to transfer campaign", code: "TRANSFER_FAILED" });
}

function bodyForPreview(req: Request) {
  const parsed = campaignMtaTransferRequestSchema.pick({ targetMtaId: true, identity: true }).parse(req.body ?? {});
  return parsed;
}

export function registerCampaignMtaTransferRoutes(app: Express): void {
  app.post("/api/campaigns/:campaignId/mta-transfer/preview", async (req, res) => {
    const parsedId = transferOpaqueIdSchema.safeParse(req.params.campaignId);
    if (!parsedId.success) {
      res.status(400).json({ error: "Invalid campaign identifier", code: "INVALID_REQUEST" });
      return;
    }
    const campaignId = parsedId.data;
    if (!await authorize(req, res, campaignId)) return;
    try {
      const body = bodyForPreview(req);
      const result = await previewCampaignMtaTransfer({
        campaignId,
        targetMtaId: body.targetMtaId,
        identity: body.identity,
      });
      res.json(result);
    } catch (error) {
      sendError(res, error);
    }
  });

  const commit = async (req: Request, res: Response) => {
    const parsedId = transferOpaqueIdSchema.safeParse(req.params.campaignId);
    if (!parsedId.success) {
      res.status(400).json({ error: "Invalid campaign identifier", code: "INVALID_REQUEST" });
      return;
    }
    const campaignId = parsedId.data;
    if (!await authorize(req, res, campaignId)) return;
    let prepared: Awaited<ReturnType<typeof prepareTransfer>> | null = null;
    let commitAttempted = false;
    try {
      const body = campaignMtaTransferCommitSchema.parse(req.body ?? {});
      prepared = await prepareTransfer({
        campaignId,
        targetMtaId: body.targetMtaId,
        expectedRevision: body.expectedRevision,
        identity: body.identity,
        acceptName: body.acceptName,
        name: body.name,
      });
      commitAttempted = true;
      const committed = await commitCampaignMtaTransfer({
        campaignId,
        targetMtaId: body.targetMtaId,
        expectedRevision: body.expectedRevision,
        name: prepared.name,
        fromName: prepared.fromName,
        fromEmail: prepared.fromEmail,
        replyEmail: prepared.replyEmail,
        htmlContent: prepared.images?.html ?? prepared.campaign.htmlContent,
      });
      if (!committed.ok) {
        await prepared.images?.cleanup();
        const code = committed.reason === "not_found" ? "NOT_FOUND"
          : committed.reason === "unsafe_status" ? "STATUS_NOT_TRANSFERABLE"
            : committed.reason === "same_mta" ? "SAME_MTA" : "CONFLICT";
        return res.status(code === "NOT_FOUND" ? 404 : 409).json({
          error: "Campaign changed while validating the transfer",
          code,
        });
      }
      publishCampaignsListInvalidation();
      const campaign = committed.campaign;
      return res.json({
        campaignId: campaign.id,
        sourceMtaId: campaign.sourceMta?.id ?? null,
        targetMtaId: campaign.mtaId!,
        revision: campaign.revision,
        status: "scheduled",
        name: campaign.name,
        fromName: campaign.fromName,
        fromEmail: campaign.fromEmail,
        replyEmail: campaign.replyEmail,
        htmlContent: campaign.htmlContent,
        scheduledAt: campaign.scheduledAt.toISOString(),
      });
    } catch (error) {
      // Once COMMIT has been attempted, the connection outcome may be
      // ambiguous (the database can have committed immediately before a
      // network error). Never delete prepared files in that branch: the
      // committed HTML may already reference them. An operator can run the
      // normal orphan cleanup after reloading the campaign.
      if (commitAttempted) {
        logger.error("[MTA_TRANSFER] commit outcome unknown; preserving prepared assets", {
          campaignId,
          preparedAssetCount: prepared?.images?.preparedFiles.length ?? 0,
        });
        res.status(503).json({
          error: "Transfer outcome is uncertain. Reload the campaign before retrying.",
          code: "TRANSFER_COMMIT_UNKNOWN",
        });
        return;
      }
      await prepared?.images?.cleanup();
      sendError(res, error);
    }
  };

  // POST is the canonical commit verb. PATCH is retained for clients that
  // model this operation as a guarded resource mutation.
  app.post("/api/campaigns/:campaignId/mta-transfer", commit);
  app.patch("/api/campaigns/:campaignId/mta-transfer", commit);
  app.post("/api/campaigns/:campaignId/mta-transfer/commit", commit);
  app.patch("/api/campaigns/:campaignId/mta-transfer/commit", commit);
}