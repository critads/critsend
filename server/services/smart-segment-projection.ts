// Task #304 — steps 3/4 (pure part): block library, cohort-rate aggregation,
// fallback discounts, projections and the complaint cap. No database access
// here so every rule can be unit-tested on synthetic dossiers.
import type { SegmentCondition, SegmentGroup, SegmentRulesV2 } from "@shared/schema";
import {
  DOMAIN_FAMILIES,
  type CalibrationLevel,
  type CohortAxis,
  type CohortRate,
  type DomainFamilyId,
  type SmartSegmentBlock,
  type SmartSegmentBrandResolution,
  type RecencyBand,
  type RefRelation,
  NON_ACTIVE_RECENCY_BANDS,
  RECENCY_BAND_LABELS,
  SMART_SEGMENT_MAX_RECENT_SEND_EXCLUSIONS,
  refRecencyCohort,
} from "@shared/smart-segment";
import { BOT_OPENER_REF } from "../config/suppression";

export const CLICKER_TIERS = ["0", "1", "2-3", "4-5", "6+"] as const;
export type ClickerTier = (typeof CLICKER_TIERS)[number];

export function clickerTierFor(distinctCampaigns: number): ClickerTier {
  if (distinctCampaigns <= 0) return "0";
  if (distinctCampaigns === 1) return "1";
  if (distinctCampaigns <= 3) return "2-3";
  if (distinctCampaigns <= 5) return "4-5";
  return "6+";
}

/**
 * Documented decotes applied when a block is calibrated by fallback rather
 * than by the brand's own history: CTR is discounted, complaints marked up.
 */
export const CALIBRATION_ADJUSTMENTS: Record<CalibrationLevel, { discount: number; complaintMarkup: number; label: string }> = {
  brand: { discount: 1, complaintMarkup: 1, label: "historique de la marque" },
  vertical: { discount: 0.8, complaintMarkup: 1.25, label: "repli sur la verticale (CTR ×0,8, plaintes ×1,25)" },
  global: { discount: 0.65, complaintMarkup: 1.5, label: "repli toutes marques (CTR ×0,65, plaintes ×1,5)" },
};

/** Projection range around the point estimate (documented, symmetric-ish). */
export const PROJECTION_RANGE = { low: 0.7, high: 1.15 };

/** Cohorts thinner than this fall back to the axis-wide rate. */
export const MIN_RELIABLE_COHORT_DELIVERED = 1_000;

export type RawCohortRow = {
  axis: CohortAxis;
  cohort: string;
  delivered: number;
  humanClickers: number;
  botClickers: number;
  complaints: number;
  /** Un-scaled recipients behind a sampled row (recency axes). */
  observed?: number;
};

export function aggregateCohortRates(rows: RawCohortRow[]): CohortRate[] {
  const merged = new Map<string, RawCohortRow>();
  for (const row of rows) {
    const key = `${row.axis}\u0000${row.cohort}`;
    const current = merged.get(key) ?? { axis: row.axis, cohort: row.cohort, delivered: 0, humanClickers: 0, botClickers: 0, complaints: 0 };
    current.delivered += row.delivered;
    current.humanClickers += row.humanClickers;
    current.botClickers += row.botClickers;
    current.complaints += row.complaints;
    if (row.observed !== undefined) current.observed = (current.observed ?? 0) + row.observed;
    merged.set(key, current);
  }
  return [...merged.values()]
    .sort((a, b) => a.axis.localeCompare(b.axis) || a.cohort.localeCompare(b.cohort))
    .map((row) => ({
      ...row,
      humanCtr: row.delivered > 0 ? row.humanClickers / row.delivered : 0,
      complaintRate: row.delivered > 0 ? row.complaints / row.delivered : 0,
    }));
}

function axisTotals(rates: CohortRate[], axis: CohortAxis): { humanCtr: number; complaintRate: number; delivered: number } {
  let delivered = 0, clickers = 0, complaints = 0;
  for (const rate of rates) {
    if (rate.axis !== axis) continue;
    delivered += rate.delivered;
    clickers += rate.humanClickers;
    complaints += rate.complaints;
  }
  return {
    delivered,
    humanCtr: delivered > 0 ? clickers / delivered : 0,
    complaintRate: delivered > 0 ? complaints / delivered : 0,
  };
}

/**
 * Measured rate for a cohort; thin cohorts inherit the axis-wide rate so a
 * handful of recipients never drives a projection.
 */
export function rateFor(
  rates: CohortRate[],
  axis: CohortAxis,
  cohort: string,
): { humanCtr: number; complaintRate: number; delivered: number; reliable: boolean } {
  const exact = rates.find((rate) => rate.axis === axis && rate.cohort === cohort);
  if (exact && exact.delivered >= MIN_RELIABLE_COHORT_DELIVERED) {
    return { humanCtr: exact.humanCtr, complaintRate: exact.complaintRate, delivered: exact.delivered, reliable: true };
  }
  const totals = axisTotals(rates, axis);
  return { ...totals, reliable: false };
}

/**
 * Complaint bound of the selected domain family: every final audience is
 * restricted to that family, so no cell may be projected below the family's
 * own measured complaint rate (falls back to the axis total when the
 * in-family cohort is too small to be reliable).
 */
export const FAMILY_BOUND_COHORT = "family/in_family";
export function familyComplaintBound(rates: CohortRate[]): number {
  return rateFor(rates, "family", "in_family").complaintRate;
}

/**
 * Rate of a non-active recency band: the recency × ref-relation cross cohort
 * when it is reliable, else the band's marginal when reliable, else NOTHING.
 * There is deliberately no axis-wide fallback here: the recency axis is
 * dominated by 60-day actives, so blending would project dormant contacts at
 * the actives' rates — the one thing these blocks must never do.
 */
export function recencyRateFor(
  rates: CohortRate[],
  band: RecencyBand,
  refRelation?: RefRelation,
): { humanCtr: number; complaintRate: number; delivered: number; cohort: string } | null {
  if (refRelation) {
    const cohort = refRecencyCohort(refRelation, band);
    const cross = rates.find((rate) => rate.axis === "ref_recency" && rate.cohort === cohort);
    if (cross && reliableSupport(cross)) {
      return { humanCtr: cross.humanCtr, complaintRate: cross.complaintRate, delivered: cross.delivered, cohort: `ref_recency/${cohort}` };
    }
  }
  const marginal = rates.find((rate) => rate.axis === "recency" && rate.cohort === band);
  if (marginal && reliableSupport(marginal)) {
    return { humanCtr: marginal.humanCtr, complaintRate: marginal.complaintRate, delivered: marginal.delivered, cohort: `recency/${band}` };
  }
  return null;
}

/**
 * Reliability is judged on recipients actually observed: a sampled row is
 * re-scaled by its divisor for the effectives, but 20 observed dormant
 * recipients × 50 are not 1,000 measured ones.
 */
function reliableSupport(rate: Pick<CohortRate, "delivered" | "observed">): boolean {
  return (rate.observed ?? rate.delivered) >= MIN_RELIABLE_COHORT_DELIVERED;
}

/** Non-active bands that have a reliable rate somewhere in the dossier. */
export function calibratedRecencyBands(rates: CohortRate[]): RecencyBand[] {
  return NON_ACTIVE_RECENCY_BANDS.filter((band) => recencyRateFor(rates, band) !== null);
}

// ====== DSL helpers ======

export function condition(
  field: SegmentCondition["field"],
  operator: SegmentCondition["operator"],
  value: SegmentCondition["value"] = null,
): SegmentCondition {
  return { type: "condition", field, operator, value, value2: null } as SegmentCondition;
}

export function group(combinator: "AND" | "OR", children: SegmentGroup["children"]): SegmentGroup {
  return { type: "group", combinator, children };
}

export function familyFilterGroup(family: DomainFamilyId): SegmentGroup {
  return group("OR", DOMAIN_FAMILIES[family].domains.map((domain) => condition("email", "ends_with", `@${domain}`)));
}

/** Newest brand sends whose recipients are excluded (ids arrive newest first). */
export const MAX_RECENT_SEND_EXCLUSIONS = SMART_SEGMENT_MAX_RECENT_SEND_EXCLUSIONS;

/**
 * Mandatory exclusions every proposal must carry (Done-looks-like §4). Each
 * entry is a top-level AND condition/group plus a French label used when the
 * server has to inject it.
 */
export function mandatoryExclusions(
  brand: SmartSegmentBrandResolution,
  family: DomainFamilyId,
  recentBrandCampaignIds: string[],
): Array<{ id: string; label: string; node: SegmentCondition | SegmentGroup }> {
  const out: Array<{ id: string; label: string; node: SegmentCondition | SegmentGroup }> = [
    { id: "bot_ip", label: "Exclusion des boîtes détectées par l'IP de plainte", node: condition("engagement", "not_opened_from_bot_ip") },
    { id: "del_ref", label: `Exclusion de la ref ${BOT_OPENER_REF}`, node: condition("refs", "not_has_ref", BOT_OPENER_REF) },
    { id: "family", label: `Filtre de famille de domaines (${DOMAIN_FAMILIES[family].shortLabel})`, node: familyFilterGroup(family) },
  ];
  for (const tag of brand.unsubscribeTags) {
    out.push({ id: `unsub:${tag}`, label: `Exclusion du tag de désabonnement ${tag}`, node: condition("tags", "not_has_tag", tag) });
  }
  const recent = [...new Set(recentBrandCampaignIds)].slice(0, MAX_RECENT_SEND_EXCLUSIONS);
  if (recent.length) {
    // One condition carrying every recent send: a single anti-join instead of
    // one NOT EXISTS per campaign, and no send can fall outside the cap.
    out.push({
      id: "not_received_recent",
      label: recent.length === 1
        ? "Exclusion des destinataires du dernier envoi de la marque"
        : `Exclusion des destinataires des ${recent.length} envois récents de la marque`,
      node: condition("engagement", "not_received_campaign", recent.length === 1 ? recent[0] : recent),
    });
  }
  return out;
}

function conditionValues(value: SegmentCondition["value"]): string[] {
  return (Array.isArray(value) ? value : value == null ? [] : [value]).map((entry) => String(entry).trim());
}

/**
 * A multi-campaign exclusion is satisfied when the top-level AND context
 * already excludes every required campaign, whatever the split into
 * conditions chosen by the model.
 */
function recentSendsCovered(root: SegmentGroup, required: SegmentCondition): boolean {
  const covered = new Set<string>();
  const visit = (current: SegmentGroup) => {
    if (current.combinator !== "AND") return;
    for (const child of current.children) {
      if (child.type === "condition") {
        const cond = child as SegmentCondition;
        if (cond.field === "engagement" && cond.operator === "not_received_campaign") {
          for (const id of conditionValues(cond.value)) covered.add(id);
        }
      } else if (child.type === "group") {
        visit(child as SegmentGroup);
      }
    }
  };
  visit(root);
  return conditionValues(required.value).every((id) => covered.has(id));
}

function sameCondition(a: SegmentCondition, b: SegmentCondition): boolean {
  const av = Array.isArray(a.value) ? a.value.join(",") : (a.value ?? "");
  const bv = Array.isArray(b.value) ? b.value.join(",") : (b.value ?? "");
  return a.field === b.field && a.operator === b.operator && av.trim().toLowerCase() === bv.trim().toLowerCase();
}

function nodeSatisfiedAtTopLevel(root: SegmentGroup, node: SegmentCondition | SegmentGroup): boolean {
  if (node.type === "condition" && node.operator === "not_received_campaign") return recentSendsCovered(root, node);
  // Only AND-context children count: an exclusion buried in an OR branch does
  // not constrain the audience.
  const visit = (current: SegmentGroup): boolean => {
    if (current.combinator !== "AND") return false;
    for (const child of current.children) {
      if (node.type === "condition" && child.type === "condition" && sameCondition(child as SegmentCondition, node)) return true;
      if (node.type === "group" && child.type === "group" && groupCoversFamily(child as SegmentGroup, node)) return true;
      if (child.type === "group" && visit(child as SegmentGroup)) return true;
    }
    return false;
  };
  return visit(root);
}

function groupCoversFamily(candidate: SegmentGroup, family: SegmentGroup): boolean {
  if (candidate.combinator !== "OR") return false;
  const candidateValues = new Set(
    candidate.children
      .filter((child): child is SegmentCondition => child.type === "condition")
      .filter((child) => child.field === "email" && child.operator === "ends_with")
      .map((child) => String(child.value ?? "").trim().toLowerCase()),
  );
  if (candidateValues.size !== candidate.children.length) return false;
  const required = family.children
    .filter((child): child is SegmentCondition => child.type === "condition")
    .map((child) => String(child.value ?? "").trim().toLowerCase());
  // Every candidate domain must belong to the family (a superset would widen
  // the family), and the candidate must not be empty.
  return candidateValues.size > 0 && [...candidateValues].every((value) => required.includes(value));
}

/**
 * Guarantees the mandatory exclusions on a model-produced rule tree. Missing
 * ones are appended under a top-level AND and reported so the UI can flag
 * "ajouté par le serveur".
 */
export function ensureMandatoryExclusions(
  rules: SegmentRulesV2,
  required: ReturnType<typeof mandatoryExclusions>,
): { rules: SegmentRulesV2; injected: string[] } {
  const injected: string[] = [];
  const missing = required.filter((entry) => !nodeSatisfiedAtTopLevel(rules.root, entry.node));
  if (!missing.length) return { rules, injected };
  for (const entry of missing) injected.push(entry.label);
  const root: SegmentGroup = rules.root.combinator === "AND"
    ? group("AND", [...rules.root.children, ...missing.map((entry) => entry.node)])
    : group("AND", [rules.root, ...missing.map((entry) => entry.node)]);
  return { rules: { version: 2, root }, injected };
}

// ====== Block library ======

export type BlockDefinition = {
  id: string;
  label: string;
  description: string;
  rules: SegmentGroup;
  calibration: { axis: CohortAxis; cohort: string; refRelation?: RefRelation };
  /** Nested clicker blocks are projected from the reservoir's tier mix. */
  tiers?: ClickerTier[];
};

/** Recency band of a block whose members have no activity in 60 days (undefined for the active blocks). */
export function blockRecencyBand(definition: { calibration: { axis: CohortAxis; cohort: string } }): RecencyBand | undefined {
  return definition.calibration.axis === "recency" ? (definition.calibration.cohort as RecencyBand) : undefined;
}

export function buildBlockLibrary(brand: SmartSegmentBrandResolution): BlockDefinition[] {
  const blocks: BlockDefinition[] = [
    {
      id: "clickers_6plus",
      label: "Cliqueurs très actifs (6+ campagnes en 60 j)",
      description: "Au moins 6 campagnes cliquées dans les 60 derniers jours, robots exclus.",
      rules: group("AND", [condition("engagement", "ultra_active_clicker")]),
      calibration: { axis: "clicker_tier", cohort: "6+" },
      tiers: ["6+"],
    },
    {
      id: "clickers_4plus",
      label: "Cliqueurs actifs (4+ campagnes en 60 j)",
      description: "Au moins 4 campagnes cliquées dans les 60 derniers jours, robots exclus.",
      rules: group("AND", [condition("engagement", "top_active_clicker")]),
      calibration: { axis: "clicker_tier", cohort: "4-5" },
      tiers: ["4-5", "6+"],
    },
    {
      id: "clickers_1plus",
      label: "Cliqueurs récents (au moins 1 clic en 60 j)",
      description: "Au moins un clic dans les 60 derniers jours, robots exclus.",
      rules: group("AND", [condition("engagement", "clicked_recently")]),
      calibration: { axis: "clicker_tier", cohort: "1" },
      tiers: ["1", "2-3", "4-5", "6+"],
    },
    {
      id: "warm_openers",
      label: "Ouvreurs/cliqueurs 60 j (warm)",
      description: "A ouvert ou cliqué dans les 60 derniers jours (les ouvertures du robot sont neutralisées par l'exclusion IP).",
      rules: group("AND", [condition("engagement", "engaged_recently")]),
      calibration: { axis: "clicker_tier", cohort: "0" },
    },
  ];
  if (brand.verticalRefs.length) {
    blocks.push({
      id: "openers_vertical",
      label: `Ouvreurs 60 j porteurs de refs ${brand.verticalLabel ?? "de la verticale"}`,
      description: "A ouvert ou cliqué dans les 60 derniers jours et porte au moins une ref d'une autre marque de la même verticale.",
      rules: group("AND", [
        condition("engagement", "engaged_recently"),
        group("OR", brand.verticalRefs.map((ref) => condition("refs", "has_ref", ref))),
      ]),
      calibration: { axis: "ref_relation", cohort: "vertical" },
    });
  }
  if (brand.coreRefs.length) {
    blocks.push({
      id: "brand_core_refs",
      label: "Porteurs des refs de la marque (cœur)",
      description: "Porte une ref de la marque elle-même ; les destinataires des envois récents sont exclus par les règles obligatoires.",
      rules: group("AND", [group("OR", brand.coreRefs.map((ref) => condition("refs", "has_ref", ref)))]),
      calibration: { axis: "ref_relation", cohort: "core" },
    });
  }
  if (brand.extensionRefs.length) {
    blocks.push({
      id: "brand_extension_refs",
      label: "Porteurs des refs d'extension (US/E)",
      description: "Porte une déclinaison US ou E de la ref de la marque.",
      rules: group("AND", [group("OR", brand.extensionRefs.map((ref) => condition("refs", "has_ref", ref)))]),
      calibration: { axis: "ref_relation", cohort: "extension" },
    });
  }
  const similarRefs = brand.similarRefs ?? [];
  if (similarRefs.length) {
    blocks.push({
      id: "similar_refs_active",
      label: "Actifs 60 j porteurs de refs de marques similaires",
      description: "A ouvert ou cliqué dans les 60 derniers jours et porte une ref d'une marque similaire retenue par l'opérateur (co-occurrence mesurée sur la base).",
      rules: group("AND", [
        condition("engagement", "engaged_recently"),
        group("OR", similarRefs.map((ref) => condition("refs", "has_ref", ref))),
      ]),
      calibration: { axis: "ref_relation", cohort: "similar" },
    });
  }
  // Non-active bands: the same ref pools without any activity in 60 days,
  // split by recency so the model can take the lapsed band alone. Each one is
  // calibrated on its recency (× ref relation) cohort, never on the actives.
  const refPools: Array<{ key: string; relation: RefRelation; refs: string[]; who: string }> = [
    { key: "brand_core_refs", relation: "core", refs: brand.coreRefs, who: "des refs de la marque (cœur)" },
    { key: "similar_refs", relation: "similar", refs: similarRefs, who: "de refs de marques similaires" },
    { key: "vertical_refs", relation: "vertical", refs: brand.verticalRefs, who: `de refs ${brand.verticalLabel ?? "de la verticale"}` },
  ];
  const bands: Array<{ band: RecencyBand; suffix: string; operator: SegmentCondition["operator"]; when: string }> = [
    { band: "opened_61_180d", suffix: "lapsed", operator: "engaged_lapsed", when: "dernière ouverture ou clic il y a 61 à 180 jours" },
    { band: "dormant_180d", suffix: "dormant", operator: "dormant", when: "aucune ouverture ni clic depuis plus de 180 jours" },
  ];
  for (const { band, suffix, operator, when } of bands) {
    for (const pool of refPools) {
      if (!pool.refs.length) continue;
      blocks.push({
        id: `${pool.key}_${suffix}`,
        label: `Porteurs ${pool.who} — ${RECENCY_BAND_LABELS[band]}`,
        description: `Porte au moins une ref ${pool.who.replace(/^(des|de) /, "")} et ${when} (aucune activité 60 j : bloc calibré sur sa cohorte de récence, pas sur les actifs).`,
        rules: group("AND", [
          condition("engagement", operator),
          group("OR", pool.refs.map((ref) => condition("refs", "has_ref", ref))),
        ]),
        calibration: { axis: "recency", cohort: band, refRelation: pool.relation },
      });
    }
  }
  return blocks;
}

/**
 * Splits a block library into the blocks that can be projected from the
 * dossier and the ones that must be omitted: a non-active block whose recency
 * band (× ref relation) has no reliable cohort is never offered, so it can
 * never be projected at the actives' rates.
 */
export function splitProjectableBlocks(
  definitions: BlockDefinition[],
  cohortRates: CohortRate[],
): { projectable: BlockDefinition[]; omitted: Array<{ id: string; label: string; reason: string }> } {
  const projectable: BlockDefinition[] = [];
  const omitted: Array<{ id: string; label: string; reason: string }> = [];
  for (const definition of definitions) {
    const band = blockRecencyBand(definition);
    if (band && !recencyRateFor(cohortRates, band, definition.calibration.refRelation)) {
      omitted.push({ id: definition.id, label: definition.label, reason: `aucune cohorte « ${RECENCY_BAND_LABELS[band]} » fiable (≥ ${MIN_RELIABLE_COHORT_DELIVERED.toLocaleString("fr-FR")} livrés) dans le calibrage` });
      continue;
    }
    projectable.push(definition);
  }
  return { projectable, omitted };
}

export type TierCounts = Partial<Record<ClickerTier, number>>;

export function projectBlock(
  definition: BlockDefinition,
  available: number,
  cohortRates: CohortRate[],
  level: CalibrationLevel,
  tierCounts: TierCounts,
  recencyLevel: CalibrationLevel = level,
): SmartSegmentBlock {
  const band = blockRecencyBand(definition);
  const adjustments = CALIBRATION_ADJUSTMENTS[band ? recencyLevel : level];
  let humanCtr: number;
  let complaintRate: number;
  if (band) {
    const rate = recencyRateFor(cohortRates, band, definition.calibration.refRelation);
    if (!rate) throw new Error(`bloc « ${definition.id} » sans cohorte de récence fiable : à omettre avant projection`);
    humanCtr = rate.humanCtr;
    // Worst of the recency cohort and the ref relation's own complaint history
    // (core / similar / vertical), exactly like the ref blocks it derives from.
    const relation = definition.calibration.refRelation;
    complaintRate = relation && relation !== "none"
      ? Math.max(rate.complaintRate, rateFor(cohortRates, "ref_relation", relation).complaintRate)
      : rate.complaintRate;
  } else if (definition.tiers && definition.tiers.some((tier) => (tierCounts[tier] ?? 0) > 0)) {
    let weight = 0, clicks = 0, complaints = 0;
    for (const tier of definition.tiers) {
      const count = tierCounts[tier] ?? 0;
      if (!count) continue;
      const rate = rateFor(cohortRates, "clicker_tier", tier);
      weight += count;
      clicks += count * rate.humanCtr;
      complaints += count * rate.complaintRate;
    }
    humanCtr = weight ? clicks / weight : 0;
    complaintRate = weight ? complaints / weight : 0;
  } else {
    const rate = rateFor(cohortRates, definition.calibration.axis, definition.calibration.cohort);
    humanCtr = rate.humanCtr;
    complaintRate = rate.complaintRate;
  }
  const expectedCtr = humanCtr * adjustments.discount;
  const expectedComplaintRate = Math.max(complaintRate, familyComplaintBound(cohortRates)) * adjustments.complaintMarkup;
  const point = available * expectedCtr;
  return {
    id: definition.id,
    label: definition.label,
    description: definition.description,
    rules: definition.rules,
    available,
    calibration: { ...definition.calibration, level: band ? recencyLevel : level, discount: adjustments.discount, complaintMarkup: adjustments.complaintMarkup },
    expectedCtr,
    expectedComplaintRate,
    projectedClicks: { low: Math.round(point * PROJECTION_RANGE.low), high: Math.round(point * PROJECTION_RANGE.high) },
    projectedComplaints: Math.round(available * expectedComplaintRate),
  };
}

/** Exact measure of a final composition: total and its clicker-tier partition. */
export type AudienceMeasure = {
  total: number;
  /** Disjoint counts per clicker tier (60 d), "0" = non-clickers; sums to total. */
  tierCounts: TierCounts;
  /** Recency partition of the same audience (last open/click), when measured. */
  recencyCounts?: Partial<Record<RecencyBand, number>>;
};

export type TierProjection = {
  tier: ClickerTier;
  /** Set on the non-active cells carved out of tier "0" (lapsed / dormant). */
  band?: RecencyBand;
  count: number;
  ctr: number;
  complaintRate: number;
  /** Cohort whose complaint rate was retained for this cell (worst implicated). */
  complaintCohort: string;
};

export type CompositionProjection = {
  projectedClicks: { low: number; high: number };
  projectedComplaintRate: number;
  projectedComplaints: number;
  weightedCtr: number;
  usedBlockIds: string[];
  /** Ref-relation cohorts implicated by the used blocks (their rates bound every cell). */
  refCohortsApplied: string[];
  /** Complaint rate of the selected family (before markup) that bounds every cell. */
  familyComplaintBound: number;
  tiers: TierProjection[];
  /** Subscribers the tier partition did not account for (count drift): projected at the worst cell. */
  unattributedCount: number;
};

/**
 * Projects a proposal from the EXACT recount of its final rules, partitioned
 * by clicker tier (disjoint cells, so nested blocks such as 6+ ⊂ 4+ ⊂ 1+ or
 * AND/OR topology cannot double count anything). Each cell takes the tier's
 * calibrated CTR; its complaint rate is the WORST measured among the tier
 * cohort, the selected domain family (every audience is restricted to it)
 * and the ref-relation cohorts of the ref blocks used in the composition (a
 * core-ref holder with 0 clicks must never look safer than the core-ref
 * cohort, nor a family safer than its own history). Calibration-level
 * discount/markup apply on top.
 */
export function projectComposition(
  measure: AudienceMeasure,
  blockIds: string[],
  blocks: SmartSegmentBlock[],
  cohortRates: CohortRate[],
  level: CalibrationLevel,
  recencyLevel: CalibrationLevel = level,
): CompositionProjection {
  const used = blocks.filter((block) => blockIds.includes(block.id));
  const adjustments = CALIBRATION_ADJUSTMENTS[level];
  const recencyAdjustments = CALIBRATION_ADJUSTMENTS[recencyLevel];
  // Ref relations implicated by the blocks used: the cohort of the ref-relation
  // blocks (core, extension, similar, vertical) and the relation of the
  // non-active blocks. Each one's complaint history bounds EVERY cell.
  const bandRelations = [...new Set(used.flatMap((block): RefRelation[] => {
    if (block.calibration.axis === "ref_relation") return [block.calibration.cohort as RefRelation];
    return block.calibration.refRelation && block.calibration.refRelation !== "none" ? [block.calibration.refRelation] : [];
  }))];
  const refCohorts: string[] = bandRelations;
  const bounds = [
    { cohort: FAMILY_BOUND_COHORT, rate: familyComplaintBound(cohortRates) },
    ...refCohorts.map((cohort) => ({ cohort: `ref_relation/${cohort}`, rate: rateFor(cohortRates, "ref_relation", cohort).complaintRate })),
  ];
  const worstBound = (candidates: Array<{ cohort: string; rate: number }>, initial: { cohort: string; rate: number }) => {
    let worst = initial;
    for (const bound of candidates) if (bound.rate > worst.rate) worst = bound;
    return worst;
  };

  // Non-active cells carved out of tier "0": each band is projected at its own
  // recency cohort — never at the tier-0 openers' rate. CTR = the LOWEST
  // reliable rate among the band's marginal and the recency × relation
  // crosses of the ref blocks used; complaints = the worst of them and of the
  // usual bounds. A band without any reliable rate is still carved out, at a
  // zero CTR and the worst complaint rate measured anywhere (fail closed).
  const nonActiveCells: TierProjection[] = [];
  const worstMeasuredAnywhere = cohortRates.reduce((max, row) => Math.max(max, row.complaintRate), 0);
  for (const band of NON_ACTIVE_RECENCY_BANDS) {
    const count = Math.max(0, Math.round(measure.recencyCounts?.[band] ?? 0));
    if (!count) continue;
    const rate = recencyRateFor(cohortRates, band);
    if (!rate) {
      const worst = worstBound(bounds, { cohort: `non calibré/${band}`, rate: worstMeasuredAnywhere });
      nonActiveCells.push({ tier: "0", band, count, ctr: 0, complaintRate: worst.rate * recencyAdjustments.complaintMarkup, complaintCohort: worst.cohort });
      continue;
    }
    const crosses = bandRelations
      .map((relation) => recencyRateFor(cohortRates, band, relation))
      .filter((cross): cross is NonNullable<typeof cross> => !!cross && cross.cohort.startsWith("ref_recency/"));
    const lowestCtr = crosses.reduce((min, cross) => Math.min(min, cross.humanCtr), rate.humanCtr);
    const worst = worstBound([...bounds, ...crosses.map((cross) => ({ cohort: cross.cohort, rate: cross.complaintRate }))], { cohort: rate.cohort, rate: rate.complaintRate });
    nonActiveCells.push({
      tier: "0",
      band,
      count,
      ctr: lowestCtr * recencyAdjustments.discount,
      complaintRate: worst.rate * recencyAdjustments.complaintMarkup,
      complaintCohort: worst.cohort,
    });
  }
  const carvedOut = nonActiveCells.reduce((sum, cell) => sum + cell.count, 0);

  const tiers: TierProjection[] = [];
  let attributed = 0;
  let clicks = 0;
  let complaints = 0;
  for (const tier of CLICKER_TIERS) {
    let count = Math.max(0, Math.round(measure.tierCounts[tier] ?? 0));
    if (tier === "0") count = Math.max(0, count - carvedOut);
    if (!count) continue;
    const rate = rateFor(cohortRates, "clicker_tier", tier);
    const worst = worstBound(bounds, { cohort: `clicker_tier/${tier}`, rate: rate.complaintRate });
    const ctr = rate.humanCtr * adjustments.discount;
    const complaintRate = worst.rate * adjustments.complaintMarkup;
    tiers.push({ tier, count, ctr, complaintRate, complaintCohort: worst.cohort });
    attributed += count;
    clicks += count * ctr;
    complaints += count * complaintRate;
  }
  for (const cell of nonActiveCells) {
    tiers.push(cell);
    attributed += cell.count;
    clicks += cell.count * cell.ctr;
    complaints += cell.count * cell.complaintRate;
  }
  // Drift between the total and its partition (counts taken at slightly
  // different instants) is charged to the worst cell — or, without any cell,
  // to the worst complaint rate measured anywhere with the 0-click CTR.
  const total = Math.max(0, Math.round(measure.total));
  const unattributedCount = Math.max(0, total - attributed);
  if (unattributedCount > 0) {
    const zero = rateFor(cohortRates, "clicker_tier", "0");
    const worstMeasured = cohortRates.reduce((max, row) => Math.max(max, row.complaintRate), zero.complaintRate);
    const worstCell = tiers.reduce<TierProjection | null>((acc, cell) => (!acc || cell.complaintRate > acc.complaintRate ? cell : acc), null);
    const ctr = worstCell ? Math.min(worstCell.ctr, zero.humanCtr * adjustments.discount) : zero.humanCtr * adjustments.discount;
    const complaintRate = Math.max(worstCell?.complaintRate ?? 0, worstMeasured * adjustments.complaintMarkup);
    clicks += unattributedCount * ctr;
    complaints += unattributedCount * complaintRate;
  }
  const denominator = Math.max(total, attributed);
  const weightedCtr = denominator ? clicks / denominator : 0;
  const projectedComplaintRate = denominator ? complaints / denominator : 0;
  return {
    projectedClicks: { low: Math.round(clicks * PROJECTION_RANGE.low), high: Math.round(clicks * PROJECTION_RANGE.high) },
    projectedComplaintRate,
    projectedComplaints: Math.round(complaints),
    weightedCtr,
    usedBlockIds: used.map((block) => block.id),
    refCohortsApplied: refCohorts,
    familyComplaintBound: bounds[0].rate,
    tiers,
    unattributedCount,
  };
}

export function exceedsComplaintCap(projectedComplaintRate: number, cap: number): boolean {
  return projectedComplaintRate > cap + 1e-12;
}

/** Deterministic 1/k sampling divisor for very large sends. */
export function sampleDivisorFor(rows: number, target: number): number {
  if (rows <= target) return 1;
  return Math.ceil(rows / target);
}
