import { z } from "zod";

/**
 * API contract for moving a scheduled campaign between MTAs.
 *
 * Campaign and MTA identifiers deliberately remain opaque.  In particular,
 * clients must not parse them as UUIDs: installations may use arbitrary
 * stable identifiers.
 */
export const transferOpaqueIdSchema = z.string().trim().min(1).max(512);
export const transferRevisionSchema = z.string().min(16).max(256);

export const transferIdentityChoiceSchema = z.object({
  /**
   * `target` uses the destination MTA's configured from identity.  `custom`
   * keeps the campaign's explicitly customised identity.
   */
  from: z.enum(["target", "custom"]).default("custom"),
  /**
   * `target` uses the destination MTA's reply identity (the destination
   * from-email when no separate reply identity is configured), `custom`
   * keeps the current campaign reply-to, and `empty` intentionally preserves
   * the empty/fallback semantics.
   */
  replyTo: z.enum(["target", "custom", "empty"]).default("custom"),
});

export type TransferIdentityChoice = z.infer<typeof transferIdentityChoiceSchema>;

export const campaignMtaTransferRequestSchema = z.object({
  targetMtaId: transferOpaqueIdSchema,
  expectedRevision: transferRevisionSchema,
  identity: transferIdentityChoiceSchema.optional(),
  /** Required only when the preview says the name is not MTA-managed. */
  acceptName: z.boolean().optional(),
  /** Optional explicitly confirmed name. The server validates length/control
   * characters and only accepts it when acceptName=true. */
  name: z.string().max(200).optional(),
});

export type CampaignMtaTransferRequest = z.infer<typeof campaignMtaTransferRequestSchema>;

export const transferNameProposalSchema = z.object({
  current: z.string().max(200),
  proposed: z.string().min(1).max(200),
  changed: z.boolean(),
  managedSuffix: z.boolean(),
  requiresConfirmation: z.boolean(),
});

export const transferIdentityValueSchema = z.object({
  current: z.string().nullable(),
  sourceMta: z.string().nullable(),
  targetMta: z.string().nullable(),
  /** Alias retained for the calendar UI's concise preview rendering. */
  target: z.string().nullable().optional(),
  currentIsCustom: z.boolean(),
  selected: z.enum(["target", "custom", "empty"]),
  proposed: z.string().nullable(),
});

export const campaignMtaTransferPreviewSchema = z.object({
  campaignId: transferOpaqueIdSchema,
  sourceMtaId: transferOpaqueIdSchema.nullable(),
  targetMtaId: transferOpaqueIdSchema,
  revision: transferRevisionSchema,
  status: z.literal("scheduled"),
  scheduledAt: z.string().datetime({ offset: true }),
  name: transferNameProposalSchema,
  identity: z.object({
    from: transferIdentityValueSchema,
    replyTo: transferIdentityValueSchema,
  }),
  images: z.object({
    required: z.boolean(),
    externalCount: z.number().int().nonnegative(),
    managedCount: z.number().int().nonnegative(),
    unsupported: z.array(z.string()),
  }),
  preserved: z.array(z.string()),
  targetCapabilities: z.object({
    active: z.boolean(),
    smtpValidated: z.boolean(),
    trackingDomain: z.string().nullable(),
    openTrackingDomain: z.string().nullable(),
    imageHostingDomain: z.string().nullable(),
    sendingSpeed: z.string().nullable(),
  }),
  sourceCapabilities: z.object({
    active: z.boolean(),
    smtpValidated: z.boolean(),
    trackingDomain: z.string().nullable(),
    openTrackingDomain: z.string().nullable(),
    imageHostingDomain: z.string().nullable(),
    sendingSpeed: z.string().nullable(),
  }),
});

export type CampaignMtaTransferPreview = z.infer<typeof campaignMtaTransferPreviewSchema>;

/** Commit intentionally repeats only the decision, never proposed HTML or
 * identity values.  The server recomputes the proposal from its locked
 * snapshot so a client cannot smuggle an unreviewed configuration into the
 * atomic update. */
export const campaignMtaTransferCommitSchema = campaignMtaTransferRequestSchema;

export type CampaignMtaTransferCommit = z.infer<typeof campaignMtaTransferCommitSchema>;

export const campaignMtaTransferResponseSchema = z.object({
  campaignId: transferOpaqueIdSchema,
  sourceMtaId: transferOpaqueIdSchema.nullable(),
  targetMtaId: transferOpaqueIdSchema,
  revision: transferRevisionSchema,
  status: z.literal("scheduled"),
  name: z.string(),
  fromName: z.string(),
  fromEmail: z.string(),
  replyEmail: z.string().nullable(),
  htmlContent: z.string(),
  scheduledAt: z.string().datetime({ offset: true }),
});

export type CampaignMtaTransferResponse = z.infer<typeof campaignMtaTransferResponseSchema>;

export type CampaignMtaTransferErrorCode =
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "SAME_MTA"
  | "STATUS_NOT_TRANSFERABLE"
  | "MTA_INACTIVE"
  | "MTA_SMTP_INVALID"
  | "MTA_DOMAIN_INVALID"
  | "IMAGES_UNSUPPORTED"
  | "IMAGE_PREPARATION_FAILED"
  | "CONFLICT"
  | "INVALID_REQUEST";