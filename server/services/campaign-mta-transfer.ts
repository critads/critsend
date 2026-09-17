import type { CampaignMtaTransferPreview, TransferIdentityChoice } from "@shared/campaign-mta-transfer";
import { z } from "zod";
import {
  getCampaignMtaTransferSnapshot,
  hasStartedCampaignTraces,
  type TransferCampaignSnapshot,
  type TransferMtaSnapshot,
} from "../repositories/campaign-mta-transfer-repository";
import { inspectCampaignMtaTransferImages, prepareCampaignMtaTransferImages, TransferImageError, type PreparedTransferImages } from "./campaign-mta-transfer-images";
import { normalizeImageHostingDomain } from "./html-image-processor";

export class CampaignMtaTransferError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly httpStatus = 409,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "CampaignMtaTransferError";
  }
}

function clean(value: string | null | undefined): string | null {
  return value?.trim() || null;
}

function validEmail(value: string | null | undefined): boolean {
  return !!value && z.string().email().max(254).safeParse(value).success;
}

function validFromName(value: string | null | undefined): boolean {
  return !!value && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value) && value.trim().length > 0;
}

function validCampaignIdentity(fromName: string | null | undefined, fromEmail: string | null | undefined): boolean {
  return validFromName(fromName) && validEmail(fromEmail);
}

function validCampaignName(value: string): boolean {
  return value.length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value);
}

function validDomain(value: string | null | undefined): boolean {
  if (!value) return false;
  try {
    const parsed = new URL(normalizeImageHostingDomain(value) ?? "");
    return !!parsed.hostname && !parsed.username && !parsed.password && (parsed.protocol === "http:" || parsed.protocol === "https:");
  } catch {
    return false;
  }
}

function smtpConfigured(mta: TransferMtaSnapshot | null): boolean {
  if (!mta) return false;
  return mta.mode === "nullsink"
    || (!!mta.hostname && Number.isInteger(mta.port) && mta.port >= 1 && mta.port <= 65535 && validEmail(mta.fromEmail));
}

function capabilities(mta: TransferMtaSnapshot | null, campaign: TransferCampaignSnapshot) {
  return {
    active: mta?.isActive === true,
    smtpValidated: smtpConfigured(mta),
    trackingDomain: mta?.trackingDomain ?? null,
    // Some MTAs intentionally use one tracking host for both click and open
    // events. Keep the effective value identical to the validation decision
    // shown to the user in preview.
    openTrackingDomain: mta?.openTrackingDomain || mta?.trackingDomain || null,
    imageHostingDomain: mta?.imageHostingDomain ?? null,
    sendingSpeed: campaign.sendingSpeed ?? null,
  };
}

export function validateTargetMta(mta: TransferMtaSnapshot | null, campaign: TransferCampaignSnapshot): void {
  if (!mta) throw new CampaignMtaTransferError("Target MTA was not found", "MTA_INACTIVE", 422);
  if (!mta.isActive) throw new CampaignMtaTransferError("Target MTA is inactive", "MTA_INACTIVE", 422);
  if (!smtpConfigured(mta)) {
    throw new CampaignMtaTransferError("Target MTA SMTP settings are not valid", "MTA_SMTP_INVALID", 422);
  }
  if (campaign.trackClicks && !validDomain(mta.trackingDomain)) {
    throw new CampaignMtaTransferError("Target MTA has no valid tracking domain", "MTA_DOMAIN_INVALID", 422);
  }
  const effectiveOpenTrackingDomain = mta.openTrackingDomain || mta.trackingDomain;
  if (campaign.trackOpens && !validDomain(effectiveOpenTrackingDomain)) {
    throw new CampaignMtaTransferError("Target MTA has no valid open-tracking domain", "MTA_DOMAIN_INVALID", 422);
  }
  const images = inspectCampaignMtaTransferImages(campaign.htmlContent, campaign.sourceMta?.imageHostingDomain);
  if ((images.externalCount > 0 || images.managedCount > 0) && !validDomain(mta.imageHostingDomain)) {
    throw new CampaignMtaTransferError("Target MTA has no valid image hosting domain", "MTA_DOMAIN_INVALID", 422);
  }
  if (images.unsupported.length) {
    throw new CampaignMtaTransferError("Campaign contains unsupported image markup", "IMAGES_UNSUPPORTED", 422, {
      unsupported: images.unsupported,
    });
  }
}

function aliases(mta: TransferMtaSnapshot | null): string[] {
  if (!mta) return [];
  return [mta.name, mta.hostname ?? "", (mta.hostname ?? "").split(".")[0]]
    .map((value) => value.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, ""))
    .filter((value) => value.length >= 4);
}

export function proposeCampaignName(name: string, source: TransferMtaSnapshot | null, target: TransferMtaSnapshot): {
  current: string;
  proposed: string;
  changed: boolean;
  managedSuffix: boolean;
  requiresConfirmation: boolean;
} {
  const trailing = /^(.*)(\s+(?:-|–|—|\|)\s+)([^–—|]+?)\s*$/.exec(name);
  const suffix = trailing?.[3]?.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "");
  const managed = !!suffix && aliases(source).some((alias) => alias === suffix);
  const proposedRaw = managed && trailing
    ? `${trailing[1]}${trailing[2]}${target.name.trim()}`
    : `${name.trimEnd()} - ${target.name.trim()}`;
  const proposed = proposedRaw.slice(0, 200).trimEnd();
  return {
    current: name,
    proposed,
    changed: proposed !== name,
    managedSuffix: managed,
    requiresConfirmation: !managed,
  };
}

function identityIsCustom(campaign: TransferCampaignSnapshot, source: TransferMtaSnapshot | null): { from: boolean; replyTo: boolean } {
  return {
    from: !source || campaign.fromName !== source.fromName || campaign.fromEmail !== source.fromEmail,
    replyTo: !source || campaign.replyEmail !== (source.fromEmail || null),
  };
}

function proposedIdentity(campaign: TransferCampaignSnapshot, target: TransferMtaSnapshot, choice?: TransferIdentityChoice) {
  const custom = identityIsCustom(campaign, campaign.sourceMta);
  const selectedFrom = choice?.from ?? (custom.from ? "custom" : "target");
  const selectedReply = choice?.replyTo ?? (custom.replyTo ? "custom" : "target");
  const replyTarget = clean(target.fromEmail);
  return {
    from: {
      current: `${campaign.fromName} <${campaign.fromEmail}>`,
      sourceMta: `${campaign.sourceMta?.fromName ?? ""} <${campaign.sourceMta?.fromEmail ?? ""}>`,
      targetMta: `${target.fromName} <${target.fromEmail}>`,
      target: `${target.fromName} <${target.fromEmail}>`,
      currentIsCustom: custom.from,
      selected: selectedFrom,
      proposed: selectedFrom === "target" ? `${target.fromName}` : campaign.fromName,
    },
    replyTo: {
      current: campaign.replyEmail,
      sourceMta: campaign.sourceMta?.fromEmail ?? null,
      targetMta: replyTarget,
      target: replyTarget,
      currentIsCustom: custom.replyTo,
      selected: selectedReply,
      proposed: selectedReply === "target" ? replyTarget : selectedReply === "empty" ? null : campaign.replyEmail,
    },
    selectedFrom,
    selectedReply,
  };
}

function assertSelectedIdentity(
  fromName: string | null | undefined,
  fromEmail: string | null | undefined,
  replyEmail: string | null | undefined,
): void {
  if (!validCampaignIdentity(fromName, fromEmail)) {
    throw new CampaignMtaTransferError(
      "Selected from identity is not valid for a campaign",
      "IDENTITY_INVALID",
      422,
    );
  }
  if (replyEmail !== null && replyEmail !== undefined && !validEmail(replyEmail)) {
    throw new CampaignMtaTransferError("Selected reply-to address is invalid", "IDENTITY_INVALID", 422);
  }
}

function assertTransferable(campaign: TransferCampaignSnapshot, traces: boolean): void {
  if (campaign.status !== "scheduled") {
    throw new CampaignMtaTransferError("Only campaigns that are still scheduled can be transferred", "STATUS_NOT_TRANSFERABLE", 409, { status: campaign.status });
  }
  if (!campaign.scheduledAt || !Number.isFinite(campaign.scheduledAt.getTime()) || campaign.scheduledAt.getTime() <= Date.now()) {
    throw new CampaignMtaTransferError("Campaign is due to start and cannot be transferred", "STATUS_NOT_TRANSFERABLE", 409);
  }
  if (campaign.startedAt || campaign.firstSendAt || campaign.sentCount > 0 || campaign.pendingCount > 0 || campaign.failedCount > 0 || traces) {
    throw new CampaignMtaTransferError("Campaign has already started or has send reservations", "STATUS_NOT_TRANSFERABLE", 409);
  }
}

export async function previewCampaignMtaTransfer(input: {
  campaignId: string;
  targetMtaId: string;
  identity?: TransferIdentityChoice;
}): Promise<CampaignMtaTransferPreview> {
  const campaign = await getCampaignMtaTransferSnapshot(input.campaignId, input.targetMtaId);
  if (!campaign) throw new CampaignMtaTransferError("Campaign not found", "NOT_FOUND", 404);
  if (campaign.mtaId === input.targetMtaId) throw new CampaignMtaTransferError("Campaign is already assigned to this MTA", "SAME_MTA", 409);
  assertTransferable(campaign, await hasStartedCampaignTraces(input.campaignId));
  validateTargetMta(campaign.targetMta, campaign);
  const identity = proposedIdentity(campaign, campaign.targetMta!, input.identity);
  const selectedFromName = identity.selectedFrom === "target" ? campaign.targetMta!.fromName : campaign.fromName;
  const selectedFromEmail = identity.selectedFrom === "target" ? campaign.targetMta!.fromEmail : campaign.fromEmail;
  const selectedReplyEmail = identity.selectedReply === "target"
    ? clean(campaign.targetMta!.fromEmail)
    : identity.selectedReply === "empty" ? null : campaign.replyEmail;
  assertSelectedIdentity(selectedFromName, selectedFromEmail, selectedReplyEmail);
  const images = inspectCampaignMtaTransferImages(campaign.htmlContent, campaign.sourceMta?.imageHostingDomain);
  return {
    campaignId: campaign.id,
    sourceMtaId: campaign.mtaId,
    targetMtaId: input.targetMtaId,
    revision: campaign.revision,
    status: "scheduled",
    scheduledAt: campaign.scheduledAt.toISOString(),
    name: proposeCampaignName(campaign.name, campaign.sourceMta, campaign.targetMta!),
    identity: { from: identity.from, replyTo: identity.replyTo },
    images: { ...images, required: images.externalCount > 0 || images.managedCount > 0 },
    preserved: [
      "scheduledAt", "audience", "exclusions", "subject", "preheader",
      "tracking", "followUps", "tags", "unsubscribeRules", "footer",
    ],
    targetCapabilities: {
      ...capabilities(campaign.targetMta!, campaign),
    },
    sourceCapabilities: capabilities(campaign.sourceMta, campaign),
  };
}

export async function prepareTransfer(input: {
  campaignId: string;
  targetMtaId: string;
  expectedRevision: string;
  identity?: TransferIdentityChoice;
  acceptName?: boolean;
  name?: string;
}): Promise<{
  campaign: TransferCampaignSnapshot;
  name: string;
  fromName: string;
  fromEmail: string;
  replyEmail: string | null;
  images: PreparedTransferImages | null;
}> {
  const campaign = await getCampaignMtaTransferSnapshot(input.campaignId, input.targetMtaId);
  if (!campaign) throw new CampaignMtaTransferError("Campaign not found", "NOT_FOUND", 404);
  if (campaign.revision !== input.expectedRevision) throw new CampaignMtaTransferError("Campaign changed while preparing the transfer", "CONFLICT", 409);
  if (campaign.mtaId === input.targetMtaId) throw new CampaignMtaTransferError("Campaign is already assigned to this MTA", "SAME_MTA", 409);
  assertTransferable(campaign, await hasStartedCampaignTraces(input.campaignId));
  validateTargetMta(campaign.targetMta, campaign);
  const name = proposeCampaignName(campaign.name, campaign.sourceMta, campaign.targetMta!);
  if (name.requiresConfirmation && input.acceptName !== true) {
    throw new CampaignMtaTransferError("Manual campaign name needs explicit confirmation", "NAME_CONFIRMATION_REQUIRED", 422, { proposedName: name.proposed });
  }
  const requestedName = input.name?.trim();
  if (requestedName && !validCampaignName(requestedName)) {
    throw new CampaignMtaTransferError("Campaign name must be 1-200 characters without control characters", "INVALID_REQUEST", 400);
  }
  const identity = proposedIdentity(campaign, campaign.targetMta!, input.identity);
  const fromName = identity.selectedFrom === "target" ? campaign.targetMta!.fromName : campaign.fromName;
  const fromEmail = identity.selectedFrom === "target" ? campaign.targetMta!.fromEmail : campaign.fromEmail;
  const replyEmail = identity.selectedReply === "target"
    ? clean(campaign.targetMta!.fromEmail)
    : identity.selectedReply === "empty" ? null : campaign.replyEmail;
  assertSelectedIdentity(fromName, fromEmail, replyEmail);
  const selectedName = requestedName && input.acceptName === true ? requestedName : name.proposed;
  if (!validCampaignName(selectedName)) {
    throw new CampaignMtaTransferError("Campaign name must be 1-200 characters without control characters", "INVALID_REQUEST", 400);
  }
  let images: PreparedTransferImages | null = null;
  const inspection = inspectCampaignMtaTransferImages(campaign.htmlContent, campaign.sourceMta?.imageHostingDomain);
  if (inspection.externalCount || inspection.managedCount) {
    try {
      images = await prepareCampaignMtaTransferImages({
        html: campaign.htmlContent,
        campaignId: campaign.id,
        createdAt: campaign.createdAt,
        imageHostingDomain: campaign.targetMta!.imageHostingDomain!,
          sourceImageHostingDomain: campaign.sourceMta?.imageHostingDomain,
      });
    } catch (error) {
      if (error instanceof TransferImageError) {
        throw new CampaignMtaTransferError(
          error.message,
          error.code === "IMAGES_UNSUPPORTED" ? "IMAGES_UNSUPPORTED" : "IMAGE_PREPARATION_FAILED",
          422,
          { unsupported: error.unsupported },
        );
      }
      throw error;
    }
  }
  return {
    campaign,
    name: selectedName,
    fromName,
    fromEmail,
    replyEmail,
    images,
  };
}