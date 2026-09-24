// Task #304 — step 5: prompt, strict output validation, mandatory-exclusion
// injection, server recount and the complaint cap. The model composes; the
// server decides. Nothing the model writes reaches SQL without passing the
// whitelist below and the existing DSL schema.
import { z } from "zod";
import type { SegmentCondition, SegmentGroup, SegmentRulesV2 } from "@shared/schema";
import {
  DOMAIN_FAMILIES,
  RECENCY_BAND_LABELS,
  SMART_SEGMENT_ALLOWED_OPERATORS,
  SMART_SEGMENT_DISCLAIMER,
  describeRulesFr,
  smartSegmentModelOutputSchema,
  type SmartSegmentAnalysisRequest,
  type SmartSegmentEvidence,
  type SmartSegmentModelOutput,
  type SmartSegmentProposal,
  type SmartSegmentProposalKind,
  type SmartSegmentProposalSegment,
} from "@shared/smart-segment";
import { BOT_OPENER_REF } from "../config/suppression";
import { SMART_SEGMENT_PROMPT_VERSION, type SmartSegmentConfig } from "../config/smart-segment";
import { anthropicCreateMessage, AnthropicClientError, extractJsonObject, type AnthropicMessageResponse } from "./anthropic-client";
import { SmartSegmentError } from "./smart-segment-evidence";
import {
  ensureMandatoryExclusions,
  exceedsComplaintCap,
  mandatoryExclusions,
  projectComposition,
  type AudienceMeasure,
} from "./smart-segment-projection";
import { logger } from "../logger";

// Counted AFTER block expansion: three ref-pool blocks of a wide vertical can
// carry ~60 has_ref conditions each, so the ceiling leaves room for them.
const MAX_CONDITIONS = 400;
const MAX_DEPTH = 5;
const ALLOWED = new Set<string>(SMART_SEGMENT_ALLOWED_OPERATORS);

export type ModelCaller = (prompt: { system: string; user: string }) => Promise<AnthropicMessageResponse>;

export type ProposalDeps = {
  callModel: ModelCaller;
  /** Exact recount of the final rules with their clicker-tier partition. */
  measureAudience: (rules: SegmentRulesV2) => Promise<AudienceMeasure>;
};

export function defaultModelCaller(config: SmartSegmentConfig): ModelCaller {
  if (!config.apiKey) {
    throw new SmartSegmentError("SMART_SEGMENT_NOT_CONFIGURED", "ANTHROPIC_API_KEY n'est pas configurée.", 503);
  }
  const apiKey = config.apiKey;
  return (prompt) => anthropicCreateMessage(
    { apiKey, model: config.model, baseUrl: config.anthropicBaseUrl, timeoutMs: config.aiTimeoutMs },
    { system: prompt.system, user: prompt.user, maxTokens: config.aiMaxTokens, temperature: 0 },
  );
}

// ====== Prompt ======

function pct(value: number): string {
  return `${(value * 100).toFixed(3)} %`;
}

export function buildSmartSegmentPrompt(
  evidence: SmartSegmentEvidence,
  params: SmartSegmentAnalysisRequest,
  feedback: string | null,
): { system: string; user: string } {
  const system = [
    "Tu es l'assistant de ciblage d'une plateforme d'emailing B2C française. Tu travailles EN CADRÉ :",
    "- tu ne calcules aucun chiffre : effectifs, CTR et taux de plaintes viennent du serveur et seront recomptés après toi ;",
    "- tu composes 1 à 3 segments à partir des BLOCS fournis (réservoirs déjà mesurés après exclusions) ;",
    "- tu n'écris jamais de SQL, jamais de tag de clic ou d'ouverture, jamais de ref ou de campagne absente du dossier ;",
    "- tu réponds UNIQUEMENT par un objet JSON valide, sans texte autour.",
    "",
    "Format de sortie :",
    '{"segments":[{"name":"<nom court en français, sans préfixe>","rules":{"version":2,"root":<groupe>},"blocksUsed":["<id de bloc>"],"rationale":"<justification en français, deux à six phrases, sans aucun chiffre>","warnings":["<mise en garde>"]}]}',
    "Un groupe s'écrit {\"type\":\"group\",\"combinator\":\"AND\"|\"OR\",\"children\":[...]}.",
    "Pour inclure un bloc, insère {\"block\":\"<id>\"} comme enfant : le serveur le remplace par les règles exactes du bloc.",
    "Chaque segment inclut au moins un bloc. Tu peux ajouter des conditions {\"type\":\"condition\",\"field\":...,\"operator\":...,\"value\":...,\"value2\":null} UNIQUEMENT pour exclure (not_has_ref, not_has_tag, not_received_campaign, not_opened_from_bot_ip, not_equals, unsubscribed_from_fewer_campaigns), avec les refs, tags et identifiants de campagne du dossier, placées en AND à côté des blocs (dans un OR, chaque branche doit contenir un bloc) : toute inclusion écrite à la main (has_ref, clicked_campaign, ends_with…) est refusée car non calibrée.",
    `Opérateurs autorisés : ${SMART_SEGMENT_ALLOWED_OPERATORS.join(", ")}. Le champ « engagement » porte les opérateurs d'engagement, « refs » has_ref / not_has_ref, « tags » not_has_tag seulement, « email » equals / not_equals / starts_with / ends_with.`,
    "Les exclusions obligatoires (IP de plainte, ref DEL, tags de désabonnement de la marque, famille de domaines, destinataires des envois récents) seront ajoutées par le serveur si tu les omets ; ne les contredis pas.",
    "Stratégie : atteindre l'objectif de clics avec le taux de plaintes projeté le plus bas — d'abord les cliqueurs les plus actifs, puis les autres actifs 60 j, puis les porteurs des refs de la marque, puis les porteurs de refs de marques similaires (similar_refs_*), puis la verticale ; n'élargis à un bloc suivant que si l'objectif n'est pas atteint. Les blocs « _lapsed » (ouverts 61–180 j) et « _dormant » (dormants > 180 j) portent des contacts sans activité 60 j : ils sont calibrés sur leur propre cohorte de récence, ne les ajoute que si les blocs actifs ne suffisent pas, prends d'abord la bande « _lapsed », et signale-le dans les mises en garde. Le premier segment est la recommandation ; un second segment optionnel propose une variante (plus sûre ou plus volumique). Chaque segment doit rester sous le plafond de plaintes.",
    "Marques similaires : si le dossier contient des blocs similar_refs_* (marques similaires retenues par l'opérateur), tu DOIS ajouter, en DERNIER, un segment « avec marques similaires » : la recommandation élargie au bloc similar_refs_active (et à similar_refs_lapsed s'il existe et si le plafond le permet), afin que l'opérateur mesure l'apport de ces marques ; ce segment doit lui aussi rester sous le plafond de plaintes. Sans bloc similar_refs_* dans le dossier, n'ajoute pas ce segment.",
    "Les projections sont indicatives (créa, objet et heure d'envoi comptent) : dis-le dans les mises en garde quand c'est pertinent.",
    "IMPORTANT : name, rationale et warnings ne doivent contenir AUCUN chiffre (ni effectif, ni taux, ni pourcentage, ni date) : le serveur affiche lui-même les chiffres recomptés. Cite les blocs par leur identifiant et explique le raisonnement en mots ; toute phrase chiffrée sera supprimée.",
  ].join("\n");

  const dossier = {
    campagne: params.campaignName,
    marque: {
      nom: evidence.brand.brandName,
      refsCoeur: evidence.brand.coreRefs,
      refsExtension: evidence.brand.extensionRefs,
      tagsDesabonnement: evidence.brand.unsubscribeTags,
      verticale: evidence.brand.verticalLabel,
      refsVerticale: evidence.brand.verticalRefs,
    },
    marquesSimilaires: (evidence.similarBrands ?? (evidence.brand.similarRefs ?? []).map((ref) => ({ ref, brandName: null }))).map((entry) => ({
      ref: entry.ref,
      nom: entry.brandName,
    })),
    familleDomaines: { id: evidence.family, libelle: DOMAIN_FAMILIES[evidence.family].label },
    objectifClics: params.targetClicks,
    plafondPlaintes: pct(params.complaintCap),
    calibrage: {
      niveau: evidence.calibrationLevel,
      campagnes: evidence.calibrationCampaignIds,
      recence: evidence.recencyCalibration
        ? { niveau: evidence.recencyCalibration.level, campagnes: evidence.recencyCalibration.campaignIds }
        : "aucune cohorte fiable : blocs non actifs indisponibles",
      blocsOmis: (evidence.omittedBlocks ?? []).map((block) => ({ id: block.id, raison: block.reason })),
      notes: evidence.notes,
    },
    derniersEnvois: evidence.brandSends.map((send) => ({
      id: send.campaignId,
      nom: send.name,
      date: send.firstSendAt.slice(0, 10),
      livres: send.delivered,
      segments: send.segmentNames,
      cliqueursHumains: send.humanClickers,
      cliqueursRobots: send.botClickers,
      plaintes: send.complaints,
      desabonnements: send.unsubscribes,
      ctrHumain: pct(send.humanCtr),
      tauxPlaintes: pct(send.complaintRate),
      termine: send.finished,
    })),
    cohortes: evidence.cohortRates.map((rate) => ({
      axe: rate.axis,
      cohorte: rate.cohort,
      livres: rate.delivered,
      ctrHumain: pct(rate.humanCtr),
      tauxPlaintes: pct(rate.complaintRate),
    })),
    blocs: evidence.blocks.map((block) => ({
      id: block.id,
      libelle: block.label,
      description: block.description,
      disponibles: block.available,
      ctrAttendu: pct(block.expectedCtr),
      tauxPlaintesAttendu: pct(block.expectedComplaintRate),
      clicsProjetes: block.projectedClicks,
      plaintesProjetees: block.projectedComplaints,
      calibrage: block.calibration,
    })),
    exclusionsObligatoires: evidence.mandatoryExclusions,
    campagnesRecentesExclues: evidence.recentBrandCampaignIds,
  };

  const user = [
    "Dossier de preuves (JSON) :",
    JSON.stringify(dossier),
    "",
    feedback ? `Ta proposition précédente a été refusée par le serveur : ${feedback}\nCorrige-la.` : "Propose maintenant le ou les segments.",
  ].join("\n");
  return { system, user };
}

// ====== Validation ======

type BlockMacro = { block: string };

function isBlockMacro(node: unknown): node is BlockMacro {
  return !!node && typeof node === "object" && typeof (node as BlockMacro).block === "string" && !("type" in (node as object));
}

/** Replaces {"block": id} placeholders with the block's rule group. */
/**
 * Replaces {"block":"<id>"} macros by the exact rules of the measured block.
 * Macros are tracked PER SEGMENT: the blocks a segment is projected from are
 * the ones actually present in its own rule tree, never the ones the model
 * merely declares (or uses in a sibling segment).
 */
/** A condition the model wrote itself (outside any block macro). */
export type RawModelCondition = { field: string; operator: string; value: unknown };

/**
 * Operators the model may write outside a block macro. They can only REMOVE
 * subscribers from a calibrated block, never widen or re-target it: every
 * inclusion criterion must come from a measured block, otherwise the
 * projection would apply a cohort rate to a population it was not measured
 * on (e.g. raw `has_ref` on the brand's core refs re-labelled as a safe
 * clicker block).
 */
export const RAW_EXCLUSION_OPERATORS = new Set<string>([
  "not_has_tag",
  "not_has_ref",
  "not_received_campaign",
  "not_opened_from_bot_ip",
  "not_equals",
  "unsubscribed_from_fewer_campaigns",
]);

function isRawCondition(node: unknown): node is RawModelCondition & { type: "condition" } {
  return !!node && typeof node === "object" && (node as { type?: unknown }).type === "condition";
}

/**
 * Structural check: does every subscriber matched by this (un-expanded) tree
 * belong to at least one calibrated block? A macro does; a raw condition
 * does not; an AND does as soon as one child does; an OR only if ALL its
 * children do — otherwise an allowed "exclusion" placed under an OR would
 * widen the audience beyond the measured blocks.
 */
export function impliesBlockMembership(node: unknown, knownBlockIds: ReadonlySet<string>): boolean {
  if (isBlockMacro(node)) return knownBlockIds.has(node.block);
  if (!node || typeof node !== "object") return false;
  const group = node as { type?: unknown; combinator?: unknown; children?: unknown };
  if (group.type !== "group" || !Array.isArray(group.children) || !group.children.length) return false;
  return group.combinator === "AND"
    ? group.children.some((child) => impliesBlockMembership(child, knownBlockIds))
    : group.children.every((child) => impliesBlockMembership(child, knownBlockIds));
}

export function expandBlockMacros(raw: unknown, evidence: SmartSegmentEvidence): {
  output: unknown;
  blockIds: string[];
  blockIdsBySegment: string[][];
  /** Conditions written by the model itself, per segment (macros excluded). */
  rawConditionsBySegment: RawModelCondition[][];
  /** Per segment: the rule tree implies membership in a known block. */
  impliesBlockBySegment: boolean[];
  unknown: string[];
} {
  const blockIds: string[] = [];
  const blockIdsBySegment: string[][] = [];
  const rawConditionsBySegment: RawModelCondition[][] = [];
  const impliesBlockBySegment: boolean[] = [];
  const unknown: string[] = [];
  const byId = new Map(evidence.blocks.map((block) => [block.id, block]));
  let current: string[] | null = null;
  let currentRaw: RawModelCondition[] | null = null;
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (isBlockMacro(node)) {
      const block = byId.get(node.block);
      if (!block) {
        unknown.push(node.block);
        return node;
      }
      if (!blockIds.includes(block.id)) blockIds.push(block.id);
      if (current && !current.includes(block.id)) current.push(block.id);
      // Deep copy, NOT walked: a block's own conditions are never "raw".
      return JSON.parse(JSON.stringify(block.rules));
    }
    if (node && typeof node === "object") {
      if (currentRaw && isRawCondition(node)) {
        currentRaw.push({ field: String(node.field), operator: String(node.operator), value: node.value });
      }
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) out[key] = walk(value);
      return out;
    }
    return node;
  };
  const root = raw as { segments?: unknown } | null;
  if (root && typeof root === "object" && Array.isArray(root.segments)) {
    const knownIds = new Set(byId.keys());
    const segments = root.segments.map((segment) => {
      current = [];
      currentRaw = [];
      blockIdsBySegment.push(current);
      rawConditionsBySegment.push(currentRaw);
      const rules = segment && typeof segment === "object" ? (segment as { rules?: { root?: unknown } }).rules : undefined;
      impliesBlockBySegment.push(impliesBlockMembership(rules?.root, knownIds));
      const expanded = walk(segment);
      current = null;
      currentRaw = null;
      return expanded;
    });
    const rest: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(root as Record<string, unknown>)) if (key !== "segments") rest[key] = walk(value);
    return { output: { ...rest, segments }, blockIds, blockIdsBySegment, rawConditionsBySegment, impliesBlockBySegment, unknown };
  }
  return { output: walk(raw), blockIds, blockIdsBySegment, rawConditionsBySegment, impliesBlockBySegment, unknown };
}

/**
 * Fail-closed guard: reasons why a segment's hand-written conditions cannot
 * be projected (empty when every inclusion comes from a block macro).
 */
export function auditRawConditions(blocksUsed: string[], rawConditions: RawModelCondition[], impliesBlock: boolean): string[] {
  const reasons: string[] = [];
  if (!blocksUsed.length) {
    reasons.push("aucun bloc calibré dans les règles : chaque segment doit inclure au moins un {\"block\":\"<id>\"}");
  } else if (!impliesBlock) {
    reasons.push("les règles n'impliquent pas l'appartenance à un bloc calibré : dans un OR, chaque branche doit contenir un bloc (les exclusions se posent en AND à côté des blocs)");
  }
  for (const raw of rawConditions) {
    if (RAW_EXCLUSION_OPERATORS.has(raw.operator)) continue;
    const shown = Array.isArray(raw.value) ? `${raw.value.length} valeurs` : raw.value == null ? "" : String(raw.value);
    reasons.push(`critère d'inclusion hors bibliothèque « ${raw.field} ${raw.operator}${shown ? ` ${shown}` : ""} » : les inclusions passent par un bloc calibré, seules les exclusions (${[...RAW_EXCLUSION_OPERATORS].join(", ")}) peuvent être écrites à la main`);
  }
  return [...new Set(reasons)];
}

export class ModelOutputRejected extends Error {
  constructor(public readonly reasons: string[]) {
    super(reasons.join(" ; "));
    this.name = "ModelOutputRejected";
  }
}

function conditionValue(condition: SegmentCondition): string {
  return Array.isArray(condition.value) ? condition.value.join(",") : String(condition.value ?? "");
}

/**
 * Whitelist pass over a parsed rule tree. Rejects anything the model is not
 * allowed to introduce: unknown operators, tag-based inclusion (click/open
 * tag lists), refs or campaign ids absent from the dossier, oversized trees.
 */
export function auditModelRules(rules: SegmentRulesV2, evidence: SmartSegmentEvidence): string[] {
  const reasons: string[] = [];
  const knownRefs = new Set([
    ...evidence.brand.coreRefs,
    ...evidence.brand.extensionRefs,
    ...evidence.brand.verticalRefs,
    ...(evidence.brand.similarRefs ?? []),
    BOT_OPENER_REF,
  ]);
  const knownCampaigns = new Set([
    ...evidence.brandSends.map((send) => send.campaignId),
    ...evidence.recentBrandCampaignIds,
    ...evidence.calibrationCampaignIds,
  ]);
  const knownTags = new Set(evidence.brand.unsubscribeTags);
  const familyDomains = new Set(DOMAIN_FAMILIES[evidence.family].domains.map((domain) => `@${domain}`));
  let conditions = 0;
  const walk = (group: SegmentGroup, depth: number) => {
    if (depth > MAX_DEPTH) {
      reasons.push(`imbrication de groupes trop profonde (> ${MAX_DEPTH})`);
      return;
    }
    for (const child of group.children) {
      if (child.type === "group") {
        walk(child as SegmentGroup, depth + 1);
        continue;
      }
      if (child.type !== "condition") {
        reasons.push("les règles de similarité ne sont pas autorisées dans une proposition IA");
        continue;
      }
      conditions += 1;
      const condition = child as SegmentCondition;
      const value = conditionValue(condition);
      if (!ALLOWED.has(condition.operator)) {
        reasons.push(`opérateur non autorisé « ${condition.operator} »`);
        continue;
      }
      switch (condition.field) {
        case "tags":
          if (condition.operator !== "not_has_tag") {
            reasons.push(`inclusion par tag interdite (« ${condition.operator} ${value} ») : les listes de tags de clic/ouverture ne sont pas des critères fiables`);
          } else if (!knownTags.has(value)) {
            reasons.push(`tag inconnu « ${value} » : seuls les tags de désabonnement de la marque peuvent être exclus`);
          }
          break;
        case "refs":
          if (!["has_ref", "not_has_ref"].includes(condition.operator)) {
            reasons.push(`opérateur de ref non autorisé « ${condition.operator} »`);
          } else if (!knownRefs.has(value)) {
            reasons.push(`ref « ${value} » absente du dossier`);
          }
          break;
        case "email":
          if (!["equals", "not_equals", "starts_with", "ends_with"].includes(condition.operator)) {
            reasons.push(`opérateur email non autorisé « ${condition.operator} »`);
          } else if (condition.operator === "ends_with" && !familyDomains.has(value.toLowerCase())) {
            reasons.push(`domaine « ${value} » hors de la famille choisie`);
          }
          break;
        case "engagement":
          if (["opened_campaign", "clicked_campaign", "not_received_campaign"].includes(condition.operator)) {
            const ids = Array.isArray(condition.value) ? condition.value.map(String) : [value];
            if (condition.operator !== "not_received_campaign" && Array.isArray(condition.value)) {
              reasons.push(`l'opérateur « ${condition.operator} » n'accepte qu'une campagne`);
            }
            for (const id of ids) if (!knownCampaigns.has(id)) reasons.push(`campagne « ${id} » absente du dossier`);
          }
          break;
        default:
          reasons.push(`champ non autorisé « ${condition.field} »`);
      }
    }
  };
  walk(rules.root, 1);
  if (conditions === 0) reasons.push("la proposition ne contient aucune condition");
  if (conditions > MAX_CONDITIONS) reasons.push(`trop de conditions (${conditions} > ${MAX_CONDITIONS})`);
  return [...new Set(reasons)];
}

export type ValidatedSegment = SmartSegmentProposalSegment;

const DIGIT = /\d/;

/** Server-authored label for a composition (block labels are server strings). */
export function compositionLabel(blocksUsed: string[], evidence: SmartSegmentEvidence): string {
  const labels = blocksUsed.map((id) => evidence.blocks.find((block) => block.id === id)?.label ?? id);
  return (labels.length ? labels.join(" + ") : "Composition").slice(0, 120);
}

/**
 * Removes every figure the model wrote. Block ids/labels are server strings
 * and may be quoted; any other sentence carrying a digit is dropped. Returns
 * the cleaned name (server label when the model's name carried a figure),
 * rationale, warnings, and how many sentences were removed.
 */
export function sanitizeModelText(
  segment: { name: string; rationale: string; warnings: string[] },
  blocksUsed: string[],
  evidence: SmartSegmentEvidence,
): { name: string; rationale: string; warnings: string[]; strippedSentences: number } {
  const mask = (value: string) => {
    let masked = value;
    for (const block of evidence.blocks) {
      masked = masked.split(block.label).join(" ").split(block.id).join(" ");
    }
    return masked;
  };
  let strippedSentences = 0;
  const cleanSentences = (value: string): string => {
    const sentences = value.split(/(?<=[.!?;])\s+|\n+/);
    const kept = sentences.filter((sentence) => {
      const keep = !DIGIT.test(mask(sentence));
      if (!keep && sentence.trim()) strippedSentences += 1;
      return keep;
    });
    return kept.join(" ").replace(/\s+/g, " ").trim();
  };
  const name = DIGIT.test(mask(segment.name)) ? compositionLabel(blocksUsed, evidence) : segment.name;
  const rationale = cleanSentences(segment.rationale);
  const warnings = segment.warnings.map(cleanSentences).filter(Boolean);
  return { name, rationale, warnings, strippedSentences };
}

/** Numeric explanation written by the server from the projection itself. */
export function serverRationale(
  projection: ReturnType<typeof projectComposition>,
  blocksUsed: string[],
  evidence: SmartSegmentEvidence,
): string {
  const tiers = projection.tiers.map((cell) => `${cell.band ? `0 clic, ${RECENCY_BAND_LABELS[cell.band]}` : cell.tier === "0" ? "0 clic" : `${cell.tier} campagne(s) cliquée(s)`} : ${cell.count.toLocaleString("fr-FR")} abonnés, plaintes ≈ ${pct(cell.complaintRate)}`);
  const level = evidence.calibrationLevel === "brand" ? "la marque" : evidence.calibrationLevel === "vertical" ? "la verticale" : "l'historique global";
  const floor = evidence.complaintFloor
    ? ` Plancher de plaintes ${pct(evidence.complaintFloor.rate)} appliqué à chaque tranche (${evidence.complaintFloor.label}).`
    : "";
  const unsubscribes = projection.projectedUnsubscribeRate !== null && projection.projectedUnsubscribes !== null
    ? ` Désabonnements ≈ ${projection.projectedUnsubscribes.toLocaleString("fr-FR")} (${pct(projection.projectedUnsubscribeRate)})${evidence.baselines?.unsubscribeRate != null ? `, historique de la marque ${pct(evidence.baselines.unsubscribeRate)}` : ""}.`
    : "";
  const ow = projection.orangeWanadoo
    ? ` Orange/Wanadoo : ${projection.orangeWanadoo.count.toLocaleString("fr-FR")} abonnés (${pct(projection.orangeWanadoo.share)} de l'audience${evidence.baselines?.orangeWanadooShare != null ? `, ${pct(evidence.baselines.orangeWanadooShare)} dans l'historique` : ""}), plaintes projetées ≈ ${pct(projection.orangeWanadoo.projectedComplaintRate)}${projection.orangeWanadoo.cohortReliable ? "" : " (cohorte Orange/Wanadoo trop mince : taux de l'audience appliqué)"}.`
    : "";
  return [
    `Chiffres serveur — blocs : ${compositionLabel(blocksUsed, evidence)}. Calibrage sur ${level} (${evidence.calibrationCampaignIds.length} envoi(s)).${floor}`,
    tiers.length ? `Répartition de l'audience recomptée par tranche de cliqueurs (60 j) — ${tiers.join(" ; ")}.` : "",
    `Projection : ${projection.projectedClicks.low.toLocaleString("fr-FR")} – ${projection.projectedClicks.high.toLocaleString("fr-FR")} clics humains, taux de plaintes ≈ ${pct(projection.projectedComplaintRate)}.${unsubscribes}${ow}`,
  ].filter(Boolean).join(" ");
}

/** Unsubscribe rate at or above this multiple of the brand baseline is flagged. */
export const UNSUBSCRIBE_WARNING_RATIO = 1.5;
/** Orange/Wanadoo share this many points above the brand baseline is flagged. */
export const ORANGE_WANADOO_SHARE_WARNING_POINTS = 0.15;
/** Below this many Orange/Wanadoo recipients the cap is not enforced on them (too few to matter or to measure). */
export const ORANGE_WANADOO_MIN_ENFORCED = 1_000;

/**
 * Warnings comparing a proposal with the brand's usual audiences and the
 * dossier's blind spots. Every figure is server-computed; the model never
 * sees or writes these lines.
 */
export function comparisonWarnings(
  projection: ReturnType<typeof projectComposition>,
  evidence: SmartSegmentEvidence,
): string[] {
  const warnings: string[] = [];
  const baselines = evidence.baselines;
  if (projection.projectedUnsubscribeRate !== null && baselines?.unsubscribeRate != null && baselines.unsubscribeRate > 0
    && projection.projectedUnsubscribeRate >= baselines.unsubscribeRate * UNSUBSCRIBE_WARNING_RATIO) {
    warnings.push(`Désabonnements projetés ${pct(projection.projectedUnsubscribeRate)} : au moins ${UNSUBSCRIBE_WARNING_RATIO.toLocaleString("fr-FR")} × l'historique de la marque (${pct(baselines.unsubscribeRate)}) — audience plus éloignée de ses abonnés habituels.`);
  }
  const ow = projection.orangeWanadoo;
  if (ow && baselines?.orangeWanadooShare != null && ow.share >= baselines.orangeWanadooShare + ORANGE_WANADOO_SHARE_WARNING_POINTS) {
    warnings.push(`Part Orange/Wanadoo ${pct(ow.share)} contre ${pct(baselines.orangeWanadooShare)} dans l'historique de la marque : exposition accrue au FAI qui bloque.`);
  }
  if (ow && ow.status === "red") {
    warnings.push(`Plaintes projetées sur Orange/Wanadoo ${pct(ow.projectedComplaintRate)} (${ow.count.toLocaleString("fr-FR")} abonnés) : au-dessus du seuil rouge de 0,6 %.`);
  } else if (ow && ow.status === "orange") {
    warnings.push(`Plaintes projetées sur Orange/Wanadoo ${pct(ow.projectedComplaintRate)} (${ow.count.toLocaleString("fr-FR")} abonnés) : zone orange (0,4 – 0,6 %).`);
  }
  if (evidence.mta?.capture === "blind") {
    warnings.push(`Le MTA choisi (${evidence.mta.name ?? evidence.mta.id}) ne remonte pas les plaintes : le taux réel ne sera pas mesurable sur cet envoi, la projection s'appuie sur les MTA qui les remontent.`);
  }
  if (evidence.complaintFloor) {
    warnings.push(`Les envois de calibrage ne mesurent pas les plaintes : plancher ${pct(evidence.complaintFloor.rate)} appliqué (${evidence.complaintFloor.label}).`);
  }
  return warnings;
}

/** Blocks built from the operator's similar-brand selection (see smart-segment-projection). */
export function similarBlockIds(evidence: Pick<SmartSegmentEvidence, "blocks">): string[] {
  return evidence.blocks.filter((block) => block.id.startsWith("similar_refs_")).map((block) => block.id);
}

/**
 * Role of every validated segment, from the blocks actually expanded: any
 * segment using a similar_refs_* block is the « with similar brands » one;
 * among the others the first is the recommendation, the rest are variants.
 */
export function assignProposalKinds<T extends { blocksUsed: string[] }>(segments: T[]): Array<T & { kind: SmartSegmentProposalKind }> {
  let recommendationSeen = false;
  return segments.map((segment) => {
    if (segment.blocksUsed.some((id) => id.startsWith("similar_refs_"))) return { ...segment, kind: "similar_brands" as const };
    const kind: SmartSegmentProposalKind = recommendationSeen ? "variant" : "recommendation";
    recommendationSeen = true;
    return { ...segment, kind };
  });
}

export type ValidatedProposal = {
  segments: SmartSegmentProposalSegment[];
};

/** Compatibility wrapper: validated segments only (see validateProposal). */
export async function validateAndProject(
  rawText: string,
  evidence: SmartSegmentEvidence,
  params: SmartSegmentAnalysisRequest,
  measureAudience: ProposalDeps["measureAudience"],
): Promise<SmartSegmentProposalSegment[]> {
  return (await validateProposal(rawText, evidence, params, measureAudience)).segments;
}

/**
 * Parses, audits, recounts and projects the model output. When the dossier
 * offers similar_refs_* blocks (the operator selected similar brands), the
 * proposal MUST hold a recommendation without them and, last, a « with
 * similar brands » segment: anything else is a rejection the model gets as
 * feedback, and after the last attempt the analysis fails explicitly — an
 * analysis without the segment the operator asked for is never persisted
 * as a success.
 */
export async function validateProposal(
  rawText: string,
  evidence: SmartSegmentEvidence,
  params: SmartSegmentAnalysisRequest,
  measureAudience: ProposalDeps["measureAudience"],
): Promise<ValidatedProposal> {
  const parsedJson = extractJsonObject(rawText);
  const expanded = expandBlockMacros(parsedJson, evidence);
  if (expanded.unknown.length) {
    throw new ModelOutputRejected(expanded.unknown.map((id) => `bloc inconnu « ${id} »`));
  }
  let output: SmartSegmentModelOutput;
  try {
    output = smartSegmentModelOutputSchema.parse(expanded.output);
  } catch (error) {
    const issues = error instanceof z.ZodError
      ? error.issues.slice(0, 6).map((issue) => `${issue.path.join(".") || "racine"} : ${issue.message}`)
      : [String(error)];
    throw new ModelOutputRejected([`sortie non conforme au schéma — ${issues.join(" ; ")}`]);
  }
  const required = mandatoryExclusions(evidence.brand, evidence.family, evidence.recentBrandCampaignIds);
  const segments: SmartSegmentProposalSegment[] = [];
  const rejections: string[] = [];
  type Candidate = {
    index: number;
    segment: SmartSegmentModelOutput["segments"][number];
    blocksUsed: string[];
    declaredOnly: string[];
    rules: SegmentRulesV2;
    injected: string[];
  };
  const candidates: Candidate[] = [];
  for (const [index, segment] of output.segments.entries()) {
    const audit = auditModelRules(segment.rules, evidence);
    if (audit.length) {
      rejections.push(`segment ${index + 1} : ${audit.join(" ; ")}`);
      continue;
    }
    // Authoritative attribution: only macros expanded inside THIS segment's
    // tree drive the projection. Declared-but-unused blocks are ignored (and
    // flagged) so the model cannot borrow a safe block's rates for raw rules,
    // and hand-written inclusions are refused outright (fail closed): a raw
    // criterion has no measured cohort, so no defensible complaint rate.
    const blocksUsed = expanded.blockIdsBySegment[index] ?? [];
    const rawAudit = auditRawConditions(blocksUsed, expanded.rawConditionsBySegment[index] ?? [], expanded.impliesBlockBySegment[index] === true);
    if (rawAudit.length) {
      rejections.push(`segment ${index + 1} : ${rawAudit.join(" ; ")}`);
      continue;
    }
    const declaredOnly = segment.blocksUsed.filter((id) => !blocksUsed.includes(id));
    const { rules, injected } = ensureMandatoryExclusions(segment.rules, required);
    candidates.push({ index, segment, blocksUsed, declaredOnly, rules, injected });
  }
  // The exact recounts dominate the validation time and are independent
  // (each opens its own read-only transaction), so the audited proposals are
  // recounted together instead of one after the other.
  const measures = await Promise.all(candidates.map((candidate) => measureAudience(candidate.rules)));
  const complaintFloor = evidence.complaintFloor?.rate ?? 0;
  for (const [position, { index, segment, blocksUsed, declaredOnly, rules, injected }] of candidates.entries()) {
    const measure = measures[position];
    const audienceCount = measure.total;
    const projection = projectComposition(
      measure,
      blocksUsed,
      evidence.blocks,
      evidence.cohortRates,
      evidence.calibrationLevel,
      evidence.recencyCalibration?.level ?? evidence.calibrationLevel,
      { complaintFloor },
    );
    if (audienceCount === 0) {
      rejections.push(`segment ${index + 1} : effectif nul après exclusions obligatoires`);
      continue;
    }
    if (exceedsComplaintCap(projection.projectedComplaintRate, params.complaintCap)) {
      rejections.push(`segment ${index + 1} : taux de plaintes projeté ${pct(projection.projectedComplaintRate)} > plafond ${pct(params.complaintCap)} — retire les blocs les plus risqués`);
      continue;
    }
    // Orange/Wanadoo is the ISP that blocks: its own projected rate must hold
    // the cap too, once the exposure is large enough to matter.
    const ow = projection.orangeWanadoo;
    if (ow && ow.count >= ORANGE_WANADOO_MIN_ENFORCED && exceedsComplaintCap(ow.projectedComplaintRate, params.complaintCap)) {
      rejections.push(`segment ${index + 1} : taux de plaintes projeté sur Orange/Wanadoo ${pct(ow.projectedComplaintRate)} (${ow.count.toLocaleString("fr-FR")} abonnés) > plafond ${pct(params.complaintCap)} — retire les blocs les plus risqués (leurs abonnés Orange/Wanadoo sont projetés au pire taux mesuré)`);
      continue;
    }
    // Operator-facing text: nothing numeric may come from the model. Its
    // name/rationale/warnings are kept only once every figure-bearing
    // sentence is removed; the server writes the numeric explanation itself.
    const text = sanitizeModelText(segment, blocksUsed, evidence);
    const warnings = [...text.warnings];
    if (text.strippedSentences > 0) {
      warnings.push("Des phrases chiffrées écrites par le modèle ont été retirées : seuls les chiffres calculés par le serveur sont affichés.");
    }
    const boundingCohorts = new Set(projection.tiers.map((tier) => tier.complaintCohort).filter((cohort) => !cohort.startsWith("clicker_tier/")));
    if (boundingCohorts.has("family/in_family")) {
      warnings.push("Taux de plaintes projeté borné par l'historique de la famille de domaines choisie sur au moins une tranche de cliqueurs : projection prudente.");
    }
    if ([...boundingCohorts].some((cohort) => cohort.startsWith("ref_relation/"))) {
      warnings.push("Taux de plaintes projeté borné par la cohorte de refs la plus risquée impliquée sur au moins une tranche de cliqueurs : projection prudente.");
    }
    if (projection.unattributedCount > 0) {
      warnings.push(`${projection.unattributedCount.toLocaleString("fr-FR")} abonnés non attribués à une tranche de cliqueurs (dérive de comptage) : projetés au pire taux.`);
    }
    if (declaredOnly.length) {
      warnings.push(`Blocs déclarés mais absents des règles, ignorés pour la projection : ${declaredOnly.join(", ")}.`);
    }
    if (projection.projectedClicks.high < params.targetClicks) {
      warnings.push(`Objectif de ${params.targetClicks.toLocaleString("fr-FR")} clics probablement hors de portée sous ce plafond (fourchette ${projection.projectedClicks.low.toLocaleString("fr-FR")} – ${projection.projectedClicks.high.toLocaleString("fr-FR")}).`);
    }
    warnings.push(...comparisonWarnings(projection, evidence));
    segments.push({
      name: text.name,
      rules,
      readableRules: describeRulesFr(rules, { campaignNames: evidence.campaignNames }),
      blocksUsed,
      audienceCount,
      projectedClicks: projection.projectedClicks,
      projectedComplaintRate: projection.projectedComplaintRate,
      projectedComplaints: projection.projectedComplaints,
      projectedUnsubscribeRate: projection.projectedUnsubscribeRate,
      projectedUnsubscribes: projection.projectedUnsubscribes,
      orangeWanadoo: projection.orangeWanadoo,
      rationale: [text.rationale, serverRationale(projection, blocksUsed, evidence)].filter(Boolean).join("\n\n"),
      warnings,
      injectedExclusions: injected,
    });
  }
  if (!segments.length) {
    throw new ModelOutputRejected(rejections.length ? rejections : ["aucun segment exploitable"]);
  }
  // Kinds come from the blocks really expanded, never from the model's
  // labels; the « with similar brands » segment(s) are shown last whatever
  // the model's order, so index 0 is always the recommendation.
  const typed = assignProposalKinds(segments);
  const ordered = [...typed.filter((segment) => segment.kind !== "similar_brands"), ...typed.filter((segment) => segment.kind === "similar_brands")];
  const similarIds = similarBlockIds(evidence);
  if (similarIds.length) {
    const preferred = similarIds.includes("similar_refs_active") ? "similar_refs_active" : similarIds[0];
    const hasSimilar = ordered.some((segment) => segment.kind === "similar_brands");
    const hasRecommendation = ordered.some((segment) => segment.kind === "recommendation");
    if (!hasSimilar) {
      throw new ModelOutputRejected([
        ...rejections,
        `aucun segment « avec marques similaires » valide : ajoute en dernier un segment reprenant la recommandation élargie au bloc ${preferred} (blocs disponibles : ${similarIds.join(", ")}), sous le plafond de plaintes`,
      ]);
    }
    if (!hasRecommendation) {
      throw new ModelOutputRejected([
        ...rejections,
        `aucune recommandation sans marques similaires : propose d'abord un segment sans bloc similar_refs_* (la recommandation), puis en dernier le segment élargi au bloc ${preferred}`,
      ]);
    }
  }
  return { segments: ordered };
}

/**
 * Calls the model, validates, recounts and projects. One retry with the
 * server's rejection reasons, then an explicit failure — never a silent
 * fallback to "something".
 */
export async function generateSmartSegmentProposal(
  evidence: SmartSegmentEvidence,
  params: SmartSegmentAnalysisRequest,
  deps: ProposalDeps,
  options: { model: string; onValidation?: () => Promise<void> | void } ,
): Promise<SmartSegmentProposal> {
  let feedback: string | null = null;
  const usage = { inputTokens: 0, outputTokens: 0 };
  let usageSeen = false;
  let lastModel = options.model;
  const maxAttempts = 2;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const prompt = buildSmartSegmentPrompt(evidence, params, feedback);
    let response: AnthropicMessageResponse;
    try {
      response = await deps.callModel(prompt);
    } catch (error) {
      if (error instanceof AnthropicClientError) {
        if (error.retryable && attempt < maxAttempts) {
          logger.warn("[SMART_SEGMENT] model call failed, retrying once", { code: error.code, attempt });
          feedback = null;
          continue;
        }
        throw new SmartSegmentError(error.code, error.message, error.status === 401 || error.status === 403 ? 503 : 502);
      }
      throw error;
    }
    lastModel = response.model;
    if (response.usage) {
      usageSeen = true;
      usage.inputTokens += response.usage.inputTokens;
      usage.outputTokens += response.usage.outputTokens;
    }
    const tokenUsage: SmartSegmentProposal["tokenUsage"] = usageSeen ? { ...usage } : null;
    await options.onValidation?.();
    try {
      const validated = await validateProposal(response.text, evidence, params, deps.measureAudience);
      return {
        segments: validated.segments,
        model: lastModel,
        promptVersion: SMART_SEGMENT_PROMPT_VERSION,
        attempts: attempt,
        disclaimer: SMART_SEGMENT_DISCLAIMER,
        tokenUsage,
      };
    } catch (error) {
      if (error instanceof ModelOutputRejected || (error instanceof AnthropicClientError && error.code === "AI_BAD_RESPONSE")) {
        const reason = error.message;
        logger.warn("[SMART_SEGMENT] model output rejected", { attempt, reason: reason.slice(0, 500) });
        if (attempt < maxAttempts) {
          feedback = reason;
          continue;
        }
        // The operator's similar brands are part of the request: a proposal
        // that cannot honour them fails out loud, with the way out.
        const hint = similarBlockIds(evidence).length && /marques similaires/.test(reason)
          ? " Relancez l'analyse ou retirez des marques similaires."
          : "";
        throw new SmartSegmentError("AI_PROPOSAL_REJECTED", `Proposition IA refusée après ${maxAttempts} tentatives : ${reason}${hint}`, 422);
      }
      throw error;
    }
  }
  throw new SmartSegmentError("AI_PROPOSAL_REJECTED", "Proposition IA indisponible.", 422);
}
