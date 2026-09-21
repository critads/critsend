// Task #311 — « marques similaires » for the smart segment composer.
//
// Candidates come from the existing co-occurrence engine (segment-similarity),
// unchanged: at most three trusted refs per source ref, DEL never a
// candidate, exact-case refs. This module only merges the per-core-ref
// results, joins the brand directory for display names and validates the
// operator's final selection (candidates + manual additions) against the
// brand's own refs. The selection is part of the analysis identity, so any
// change re-runs the evidence engine.
import { pool } from "../db";
import { logger } from "../logger";
import {
  SMART_SEGMENT_MAX_SIMILAR_REFS,
  normalizeSimilarRefs,
  type SmartSegmentBrandResolution,
  type SmartSegmentSimilarBrand,
  type SmartSegmentSimilarBrandsResponse,
} from "@shared/smart-segment";
import { BOT_OPENER_REF } from "../config/suppression";
import { analyzeSimilarRefs, type SimilarityAnalysisResult } from "./segment-similarity";
import { deriveExtensionRefs } from "./smart-segment-brand";

export type SimilarBrandDeps = {
  analyze: (sourceRef: string) => Promise<Pick<SimilarityAnalysisResult, "sourceRef" | "resolvedRefs" | "candidates" | "status">>;
  brandNames: (refs: string[]) => Promise<Map<string, string>>;
};

async function lookupBrandNames(refs: string[]): Promise<Map<string, string>> {
  if (!refs.length) return new Map();
  const result = await pool.query<{ ref: string; name: string }>(
    `SELECT DISTINCT ON (upper(ref)) upper(ref) AS ref, name FROM brands WHERE upper(ref) = ANY($1::text[]) ORDER BY upper(ref), name`,
    [refs],
  );
  return new Map(result.rows.map((row) => [row.ref, row.name]));
}

const defaultDeps: SimilarBrandDeps = {
  analyze: (sourceRef) => analyzeSimilarRefs(sourceRef),
  brandNames: lookupBrandNames,
};

/** Refs that can never be « similar brand » candidates for this brand. */
export function excludedSimilarRefs(coreRefs: string[]): Set<string> {
  return new Set([...coreRefs, ...deriveExtensionRefs(coreRefs), BOT_OPENER_REF, "DEL"]);
}

/**
 * Similar-brand candidates for a set of core refs: the union of the trusted
 * similar refs of every core ref, best lift first, minus the brand's own refs.
 * A source ref without enough history yields a note instead of candidates.
 */
export async function listSimilarBrandCandidates(coreRefsInput: string[], deps: SimilarBrandDeps = defaultDeps): Promise<SmartSegmentSimilarBrandsResponse> {
  const coreRefs = normalizeSimilarRefs(coreRefsInput).filter((ref) => ref !== "DEL");
  const excluded = excludedSimilarRefs(coreRefs);
  const notes: string[] = [];
  const byRef = new Map<string, SmartSegmentSimilarBrand>();
  for (const sourceRef of coreRefs) {
    let analysis: Awaited<ReturnType<SimilarBrandDeps["analyze"]>>;
    try {
      analysis = await deps.analyze(sourceRef);
    } catch (error) {
      logger.warn("[SMART_SEGMENT] similar-brand analysis failed", { sourceRef, error: (error as Error)?.message });
      notes.push(`Analyse de similarité indisponible pour ${sourceRef}.`);
      continue;
    }
    if (analysis.status === "insufficient_source") {
      notes.push(`Ref ${sourceRef} : trop peu de porteurs pour mesurer des marques similaires.`);
      continue;
    }
    if (analysis.status === "no_reliable_affinity" || !analysis.resolvedRefs.length) {
      notes.push(`Ref ${sourceRef} : aucune affinité fiable mesurée.`);
      continue;
    }
    const resolved = new Set(analysis.resolvedRefs);
    for (const candidate of analysis.candidates) {
      // Exact-case refs: the similarity engine's refs are used as-is.
      if (!resolved.has(candidate.ref) || excluded.has(candidate.ref)) continue;
      const current = byRef.get(candidate.ref);
      if (current && current.lift >= candidate.lift) continue;
      byRef.set(candidate.ref, {
        ref: candidate.ref,
        brandName: null,
        sourceRef: analysis.sourceRef,
        lift: candidate.lift,
        commonCount: candidate.commonCount,
        additionalCount: candidate.additionalCount,
      });
    }
  }
  const candidates = [...byRef.values()].sort((a, b) => b.lift - a.lift || a.ref.localeCompare(b.ref, "en")).slice(0, SMART_SEGMENT_MAX_SIMILAR_REFS);
  const names = await deps.brandNames(candidates.map((candidate) => candidate.ref));
  for (const candidate of candidates) candidate.brandName = names.get(candidate.ref) ?? null;
  return { coreRefs, candidates, notes };
}

/**
 * Validates the operator's selection for an analysis. Refs are normalised to
 * uppercase (exact-case convention of the base); the brand's own refs, its
 * extensions, the bot-opener ref and DEL are refused rather than silently
 * dropped, so the identity the client displays is the one the server used.
 */
export function validateSimilarRefs(
  refs: readonly string[] | null | undefined,
  brand: Pick<SmartSegmentBrandResolution, "coreRefs" | "extensionRefs">,
): { similarRefs: string[]; rejected: string[] } {
  const excluded = new Set([...brand.coreRefs, ...brand.extensionRefs, BOT_OPENER_REF, "DEL"]);
  const normalized = normalizeSimilarRefs(refs);
  const rejected = normalized.filter((ref) => excluded.has(ref));
  return { similarRefs: normalized.filter((ref) => !excluded.has(ref)), rejected };
}

/** Brand resolution carrying the operator's similar-ref selection. */
export function withSimilarRefs(brand: SmartSegmentBrandResolution, similarRefs: string[]): SmartSegmentBrandResolution {
  return {
    ...brand,
    similarRefs,
    // A similar ref is never counted twice: it leaves the vertical pool.
    verticalRefs: brand.verticalRefs.filter((ref) => !similarRefs.includes(ref)),
  };
}
