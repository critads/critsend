import { z } from "zod";
import {
  campaignReferenceIdSchema,
  segmentRulesV2Schema,
  type SegmentCondition,
  type SegmentGroup,
  type SegmentRulesV2,
} from "./schema";

// ====== Smart segment (Task #304) — shared client/server contract ======
//
// Principle: "IA encadrée, jamais IA en roue libre". Every number shown to the
// operator is computed by the server (evidence engine + compiler recount);
// the model only picks, assembles and explains. These types describe the
// analysis job as the client sees it and the pieces the server persists.

export const SMART_SEGMENT_COMPLAINT_HARD_CAP = 0.006;
export const SMART_SEGMENT_COMPLAINT_TARGET = 0.0045;
export const SMART_SEGMENT_REUSE_WINDOW_MS = 6 * 60 * 60 * 1000;
/** Recipients of at most this many of the brand's newest sends (30 d) are excluded. */
export const SMART_SEGMENT_MAX_RECENT_SEND_EXCLUSIONS = 6;
export const SMART_SEGMENT_DISCLAIMER =
  "Projections issues de l'historique d'envois de la marque : le résultat réel dépend de la créa, de l'objet et de l'heure d'envoi.";

export const DOMAIN_FAMILY_IDS = ["fai_fr", "microsoft_yahoo"] as const;
export type DomainFamilyId = (typeof DOMAIN_FAMILY_IDS)[number];

export const DOMAIN_FAMILIES: Record<DomainFamilyId, { label: string; shortLabel: string; domains: readonly string[] }> = {
  fai_fr: {
    label: "FAI français (Orange, Free, SFR, La Poste, Bouygues…)",
    shortLabel: "FR",
    domains: [
      "orange.fr", "wanadoo.fr", "free.fr", "sfr.fr", "laposte.net", "neuf.fr", "bbox.fr",
      "numericable.fr", "aliceadsl.fr", "club-internet.fr", "cegetel.net", "noos.fr", "aol.fr",
    ],
  },
  microsoft_yahoo: {
    label: "Microsoft / Yahoo (Hotmail, Outlook, Live, MSN, Yahoo)",
    shortLabel: "US",
    domains: [
      "hotmail.fr", "hotmail.com", "outlook.fr", "outlook.com", "live.fr", "live.com", "msn.com",
      "yahoo.fr", "yahoo.com", "ymail.com", "rocketmail.com",
    ],
  },
};

export const smartSegmentBrandOverrideSchema = z.object({
  name: z.string().trim().min(1).max(120),
  ref: z.string().trim().min(1).max(32).regex(/^[A-Za-z0-9_-]+$/, "Ref invalide"),
});

export const smartSegmentAnalysisRequestSchema = z.object({
  campaignName: z.string().trim().min(1).max(500),
  campaignId: campaignReferenceIdSchema.nullable().optional(),
  mtaId: z.string().trim().min(1).max(255).nullable().optional(),
  family: z.enum(DOMAIN_FAMILY_IDS),
  targetClicks: z.number().int().min(50).max(5_000_000),
  complaintCap: z.number().min(0.0005).max(SMART_SEGMENT_COMPLAINT_HARD_CAP),
  brandOverride: smartSegmentBrandOverrideSchema.nullable().optional(),
  refresh: z.boolean().optional(),
});
export type SmartSegmentAnalysisRequest = z.infer<typeof smartSegmentAnalysisRequestSchema>;

/**
 * Canonical identity of an analysis request: every input that changes the
 * result, normalised the way the server de-duplicates (reuse window). The
 * MTA is deliberately absent — it only pre-selects the domain family, which
 * is an explicit input. Server: hashed into the row fingerprint. Client: a
 * displayed proposal may only be materialised while its params still carry
 * this exact identity.
 */
export function smartSegmentAnalysisIdentity(params: Omit<SmartSegmentAnalysisRequest, "refresh" | "mtaId"> & { mtaId?: unknown; refresh?: unknown }): string {
  return JSON.stringify({
    campaignName: params.campaignName.trim().toLowerCase(),
    campaignId: params.campaignId ?? null,
    family: params.family,
    targetClicks: params.targetClicks,
    complaintCap: Number(params.complaintCap.toFixed(6)),
    brandOverride: params.brandOverride
      ? { name: params.brandOverride.name.trim().toLowerCase(), ref: params.brandOverride.ref.trim().toUpperCase() }
      : null,
  });
}

export const smartSegmentResolveRequestSchema = z.object({
  campaignName: z.string().trim().min(1).max(500),
  mtaId: z.string().trim().min(1).max(255).nullable().optional(),
  brandOverride: smartSegmentBrandOverrideSchema.nullable().optional(),
});

export const smartSegmentMaterializeRequestSchema = z.object({
  campaignId: campaignReferenceIdSchema.nullable().optional(),
  proposalIndexes: z.array(z.number().int().min(0).max(1)).min(1).max(2).optional(),
});

export type SmartSegmentStatus = "queued" | "running" | "succeeded" | "failed";
export type SmartSegmentStage = "brand_history" | "cohorts" | "reservoirs" | "ai_proposal" | "validation" | "done";

export const SMART_SEGMENT_STAGE_LABELS: Record<SmartSegmentStage, string> = {
  brand_history: "Historique de la marque",
  cohorts: "Cohortes (CTR humain, plaintes)",
  reservoirs: "Réservoirs disponibles",
  ai_proposal: "Proposition IA",
  validation: "Validation et recomptage",
  done: "Terminé",
};

export type SmartSegmentBrandResolution = {
  detected: boolean;
  source: "directory" | "history" | "manual" | "none";
  brandName: string | null;
  /** Exact-case (uppercase) subscriber refs of the brand itself. */
  coreRefs: string[];
  /** US<ref> (Microsoft/Yahoo files) and E<ref> (openers extension) variants. */
  extensionRefs: string[];
  /** U<ref> tags = unsubscribed from this brand. */
  unsubscribeTags: string[];
  vertical: string | null;
  verticalLabel: string | null;
  /** Other brands' refs sharing the vertical prefix (capped). */
  verticalRefs: string[];
  /** Historical campaign name tokens matched (for transparency). */
  matchedKeys: string[];
};

export type SmartSegmentResolveResponse = {
  brand: SmartSegmentBrandResolution;
  suggestedFamily: DomainFamilyId | null;
  familyEvidence: { sampled: number; inFamilyShare: Record<DomainFamilyId, number> } | null;
};

export type SmartSegmentBrandSend = {
  campaignId: string;
  name: string;
  firstSendAt: string;
  delivered: number;
  segmentNames: string[];
  humanClickers: number;
  botClickers: number;
  complaints: number;
  unsubscribes: number;
  humanCtr: number;
  complaintRate: number;
  /** false when campaigns.sent_count has not reached its campaign_sends rows. */
  finished: boolean;
  usedForCalibration: boolean;
};

export type CohortAxis = "clicker_tier" | "ref_relation" | "family";

export type CohortRate = {
  axis: CohortAxis;
  cohort: string;
  delivered: number;
  humanClickers: number;
  botClickers: number;
  complaints: number;
  humanCtr: number;
  complaintRate: number;
};

export type CalibrationLevel = "brand" | "vertical" | "global";

export type SmartSegmentBlock = {
  id: string;
  label: string;
  description: string;
  rules: SegmentGroup;
  /** Available subscribers after mandatory exclusions (server count). */
  available: number;
  calibration: { axis: CohortAxis; cohort: string; level: CalibrationLevel; discount: number; complaintMarkup: number };
  expectedCtr: number;
  expectedComplaintRate: number;
  projectedClicks: { low: number; high: number };
  projectedComplaints: number;
};

export type SmartSegmentEvidence = {
  version: 1;
  generatedAt: string;
  brand: SmartSegmentBrandResolution;
  family: DomainFamilyId;
  brandSends: SmartSegmentBrandSend[];
  /** Campaign ids whose recipients are excluded (recent sends of the brand). */
  recentBrandCampaignIds: string[];
  /** Display names for every campaign id referenced in the dossier. */
  campaignNames: Record<string, string>;
  calibrationLevel: CalibrationLevel;
  calibrationCampaignIds: string[];
  cohortRates: CohortRate[];
  blocks: SmartSegmentBlock[];
  mandatoryExclusions: string[];
  budget: { elapsedMs: number; queries: number; sampledCampaigns: Array<{ campaignId: string; divisor: number }> };
  notes: string[];
};

export type SmartSegmentProposalSegment = {
  name: string;
  rules: SegmentRulesV2;
  readableRules: string[];
  blocksUsed: string[];
  audienceCount: number;
  projectedClicks: { low: number; high: number };
  projectedComplaintRate: number;
  projectedComplaints: number;
  rationale: string;
  warnings: string[];
  injectedExclusions: string[];
};

export type SmartSegmentProposal = {
  segments: SmartSegmentProposalSegment[];
  model: string;
  promptVersion: string;
  attempts: number;
  disclaimer: string;
  tokenUsage: { inputTokens: number; outputTokens: number } | null;
};

export type SmartSegmentCreatedSegment = { index: number; id: string; name: string };

export type SmartSegmentMaterializeResponse = {
  segments: SmartSegmentCreatedSegment[];
  attached: boolean;
  createdSegmentIds: string[];
};

export type SmartSegmentAnalysisView = {
  id: string;
  status: SmartSegmentStatus;
  stage: SmartSegmentStage;
  progress: number;
  error: string | null;
  errorCode: string | null;
  params: SmartSegmentAnalysisRequest;
  evidence: SmartSegmentEvidence | null;
  proposal: SmartSegmentProposal | null;
  /** Segments already materialised from this analysis, by proposal index. */
  createdSegments: SmartSegmentCreatedSegment[];
  /** Flat list of the ids above (kept for simple "anything created?" checks). */
  createdSegmentIds: string[];
  reused: boolean;
  createdAt: string;
  finishedAt: string | null;
};

export type SmartSegmentFeatureStatus = {
  configured: boolean;
  model: string | null;
  reason: string | null;
};

// ====== Model output contract ======
// The model returns rules in the existing DSL v2. Only these operators are
// accepted; everything else is rejected before any recount happens.
export const SMART_SEGMENT_ALLOWED_OPERATORS = [
  "equals", "not_equals", "ends_with", "starts_with",
  "has_tag", "not_has_tag", "has_ref", "not_has_ref",
  "engaged_recently", "not_engaged_recently", "clicked_recently", "top_active_clicker", "ultra_active_clicker",
  "not_opened_from_bot_ip", "unsubscribed_from_fewer_campaigns", "opened_campaign", "clicked_campaign",
  "not_received_campaign",
] as const;

export const smartSegmentModelSegmentSchema = z.object({
  name: z.string().trim().min(1).max(120),
  rules: segmentRulesV2Schema,
  blocksUsed: z.array(z.string().min(1).max(64)).max(12),
  rationale: z.string().trim().min(1).max(2500),
  warnings: z.array(z.string().trim().min(1).max(500)).max(8),
});

export const smartSegmentModelOutputSchema = z.object({
  segments: z.array(smartSegmentModelSegmentSchema).min(1).max(2),
});
export type SmartSegmentModelOutput = z.infer<typeof smartSegmentModelOutputSchema>;

// ====== Readable rules (French) ======

const FR_OPERATOR_LABELS: Record<string, (value: string, value2: string | null) => string> = {
  equals: (v) => `est égal à « ${v} »`,
  not_equals: (v) => `est différent de « ${v} »`,
  contains: (v) => `contient « ${v} »`,
  not_contains: (v) => `ne contient pas « ${v} »`,
  starts_with: (v) => `commence par « ${v} »`,
  ends_with: (v) => `se termine par « ${v} »`,
  is_empty: () => "est vide",
  is_not_empty: () => "n'est pas vide",
  has_tag: (v) => `a le tag « ${v} »`,
  not_has_tag: (v) => `n'a pas le tag « ${v} »`,
  has_any_tag: () => "a au moins un tag",
  has_no_tags: () => "n'a aucun tag",
  tag_contains: (v) => `a un tag contenant « ${v} »`,
  tag_not_contains: (v) => `n'a aucun tag contenant « ${v} »`,
  has_ref: (v) => `a la ref « ${v} »`,
  not_has_ref: (v) => `n'a pas la ref « ${v} »`,
  has_any_ref: () => "a au moins une ref",
  has_no_refs: () => "n'a aucune ref",
  ref_contains: (v) => `a une ref contenant « ${v} »`,
  before: (v) => `avant le ${v}`,
  after: (v) => `après le ${v}`,
  between: (v, v2) => `entre le ${v} et le ${v2 ?? "?"}`,
  in_last_days: (v) => `dans les ${v} derniers jours`,
  not_in_last_days: (v) => `hors des ${v} derniers jours`,
  engaged_recently: () => "a ouvert ou cliqué dans les 60 derniers jours",
  not_engaged_recently: () => "n'a ni ouvert ni cliqué dans les 60 derniers jours",
  clicked_recently: () => "a cliqué dans les 60 derniers jours (robots exclus)",
  top_active_clicker: () => "cliqueur actif : au moins 4 campagnes cliquées en 60 jours (robots exclus)",
  ultra_active_clicker: () => "cliqueur très actif : au moins 6 campagnes cliquées en 60 jours (robots exclus)",
  not_opened_from_bot_ip: () => "jamais détecté par l'IP de plainte (robot Orange/Wanadoo)",
  unsubscribed_from_fewer_campaigns: (v) => `s'est désabonné de moins de ${v} campagnes`,
  opened_campaign: (v) => `a ouvert la campagne « ${v} »`,
  clicked_campaign: (v) => `a cliqué la campagne « ${v} »`,
  not_received_campaign: (v) => `n'a pas reçu la campagne « ${v} »`,
};

const FR_FIELD_LABELS: Record<string, string> = {
  email: "L'email",
  tags: "Tags :",
  refs: "Refs :",
  date_added: "Date d'ajout",
  ip_address: "L'adresse IP",
  engagement: "Engagement :",
};

export function describeConditionFr(
  condition: SegmentCondition,
  options: { campaignNames?: Record<string, string> } = {},
): string {
  const isCampaignOperator = ["opened_campaign", "clicked_campaign", "not_received_campaign"].includes(condition.operator);
  const campaignName = (id: string) => options.campaignNames?.[id] ?? id;
  let text: string;
  if (condition.operator === "not_received_campaign" && Array.isArray(condition.value)) {
    // Multi-campaign exclusion (one anti-join over every recent send).
    const names = condition.value.map((id) => `« ${campaignName(id)} »`);
    text = names.length === 1
      ? `n'a pas reçu la campagne ${names[0]}`
      : `n'a reçu aucun des ${names.length} envois récents : ${names.join(", ")}`;
  } else {
    const rawValue = Array.isArray(condition.value) ? condition.value.join(", ") : condition.value ?? "";
    const value = isCampaignOperator ? campaignName(rawValue) : rawValue;
    const render = FR_OPERATOR_LABELS[condition.operator];
    text = render ? render(value, condition.value2 ?? null) : `${condition.operator} ${value}`;
  }
  if (condition.field === "engagement" || condition.field === "tags" || condition.field === "refs") {
    return text.charAt(0).toUpperCase() + text.slice(1);
  }
  return `${FR_FIELD_LABELS[condition.field] ?? condition.field} ${text}`;
}

/**
 * Renders DSL v2 rules as indented French lines. Nested groups are prefixed
 * with their combinator so an operator can audit the proposal without
 * opening the builder.
 */
export function describeRulesFr(
  rules: SegmentRulesV2,
  options: { campaignNames?: Record<string, string> } = {},
): string[] {
  const lines: string[] = [];
  const walk = (group: SegmentGroup, depth: number) => {
    const indent = "  ".repeat(depth);
    lines.push(`${indent}${group.combinator === "AND" ? "Tous les critères suivants :" : "Au moins un des critères suivants :"}`);
    for (const child of group.children) {
      if (child.type === "group") {
        walk(child as SegmentGroup, depth + 1);
      } else if (child.type === "condition") {
        lines.push(`${indent}  • ${describeConditionFr(child as SegmentCondition, options)}`);
      } else {
        lines.push(`${indent}  • Refs similaires à « ${(child as { sourceRef: string }).sourceRef} »`);
      }
    }
  };
  walk(rules.root, 0);
  return lines;
}

export function formatSmartSegmentName(brandName: string, family: DomainFamilyId, date: Date): string {
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `Smart · ${brandName} · ${day}/${month} · ${DOMAIN_FAMILIES[family].shortLabel}`;
}
