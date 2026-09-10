import crypto from "crypto";
import { pool } from "../db";
import type {
  SegmentGroup,
  SegmentRulesV2,
  SegmentSimilarity,
} from "@shared/schema";
import { segmentRulesV2Schema, segmentSimilaritySchema, similarityCandidateSchema } from "@shared/schema";
import { z } from "zod";

export const SIMILARITY_CALIBRATION = {
  name: "production-v1" as const,
  calibratedOnProduction: true,
  minimumSourceSize: 100,
  minimumCommonCount: 20,
  minimumSourceShare: 0.005,
  minimumAdditionalCount: 20,
  minimumAdditionalShare: 0.005,
  minimumLift: 1.25,
  confidenceLevel: 0.95,
  maxCandidatesExamined: 20,
  maxResolvedRefs: 3,
  cacheTtlMs: 10 * 60_000,
  statementTimeoutMs: 10_000,
};

export type SimilarityCandidate = {
  ref: string;
  commonCount: number;
  additionalCount: number;
  sourceFrequency: number;
  referenceFrequency: number;
  lift: number;
  score: number;
};

export type SimilarityAnalysisResult = {
  analysisId: string;
  sourceRef: string;
  sourceCount: number;
  referenceCount: number;
  analyzedAt: string;
  resolvedRefs: string[];
  candidates: SimilarityCandidate[];
  status: "ready" | "insufficient_source" | "no_reliable_affinity";
  calibration: typeof SIMILARITY_CALIBRATION.name;
  provisional: false;
  methodology: string;
};

const similarityAnalysisResultSchema = z.object({
  analysisId: z.string().uuid(),
  sourceRef: z.string().min(1).max(255).refine((ref) => ref !== "DEL"),
  sourceCount: z.number().int().nonnegative(),
  referenceCount: z.number().int().nonnegative(),
  analyzedAt: z.string().datetime(),
  resolvedRefs: z.array(z.string().min(1).max(255).refine((ref) => ref !== "DEL")).max(3),
  candidates: z.array(similarityCandidateSchema).max(3),
  status: z.enum(["ready", "insufficient_source", "no_reliable_affinity"]),
  calibration: z.literal("production-v1"),
  provisional: z.literal(false),
  methodology: z.string(),
}).superRefine((result, ctx) => {
  if (new Set(result.resolvedRefs).size !== result.resolvedRefs.length || result.resolvedRefs.includes(result.sourceRef)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["resolvedRefs"], message: "Resolved refs must be unique and exclude the source ref" });
  }
  if (
    result.resolvedRefs.length !== result.candidates.length
    || result.candidates.some((candidate, index) => candidate.ref !== result.resolvedRefs[index])
  ) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["candidates"], message: "Candidate refs do not match resolved refs" });
  }
  const ready = result.status === "ready";
  if (ready !== (result.resolvedRefs.length > 0)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["status"],
      message: "Ready analyses must have resolved refs and non-ready analyses must not",
    });
  }
});

const campaignSimilaritySnapshotSchema = z.record(z.array(segmentSimilaritySchema));

export function parseCampaignSimilaritySnapshot(value: unknown): Record<string, SegmentSimilarity[]> {
  const parsed = campaignSimilaritySnapshotSchema.safeParse(value);
  if (!parsed.success) throw new Error("Campaign similarity snapshot is invalid");
  return parsed.data;
}

export function canonicalizeSimilaritySelection(
  supplied: SegmentSimilarity,
  result: SimilarityAnalysisResult,
): SegmentSimilarity {
  if (result.status !== "ready" || result.resolvedRefs.length < 1) {
    throw new Error("Similarity analysis is not ready");
  }
  if (
    supplied.resolvedRefs.length < 1
    || supplied.resolvedRefs.some((ref) => !result.resolvedRefs.includes(ref))
  ) {
    throw new Error("Selected similarity refs do not belong to the saved analysis");
  }
  const candidatesByRef = new Map(result.candidates.map((candidate) => [candidate.ref, candidate]));
  const trustedCandidates = supplied.resolvedRefs.map((ref) => candidatesByRef.get(ref));
  if (trustedCandidates.some((candidate) => !candidate)) {
    throw new Error("Selected similarity ref metrics are missing from the saved analysis");
  }
  return {
    type: "similarity",
    ruleId: supplied.ruleId,
    sourceRef: result.sourceRef,
    analysisId: result.analysisId,
    resolvedRefs: supplied.resolvedRefs,
    analyzedAt: result.analyzedAt,
    candidates: trustedCandidates as SimilarityCandidate[],
    calibration: result.calibration,
  };
}

type Cached = { expiresAt: number; result: SimilarityAnalysisResult };
const cache = new Map<string, Cached>();
const inflight = new Map<string, Promise<SimilarityAnalysisResult>>();
const MAX_CACHE_ENTRIES = 100;
const MAX_CONCURRENT_ANALYSES = 2;
let activeAnalyses = 0;

function wilson(successes: number, total: number): [number, number] {
  if (total <= 0) return [0, 1];
  const z = 1.959963984540054;
  const p = successes / total;
  const denominator = 1 + (z * z) / total;
  const centre = p + (z * z) / (2 * total);
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * total)) / total);
  return [
    Math.max(0, (centre - margin) / denominator),
    Math.min(1, (centre + margin) / denominator),
  ];
}

export function rankSimilarityCandidates(input: {
  sourceRef: string;
  sourceCount: number;
  referenceCount: number;
  commonCounts: Map<string, number>;
  referenceCounts: Map<string, number>;
}): SimilarityCandidate[] {
  const minimumSupport = Math.max(
    SIMILARITY_CALIBRATION.minimumCommonCount,
    Math.ceil(input.sourceCount * SIMILARITY_CALIBRATION.minimumSourceShare),
  );
  const minimumAdditional = Math.max(
    SIMILARITY_CALIBRATION.minimumAdditionalCount,
    Math.ceil(input.sourceCount * SIMILARITY_CALIBRATION.minimumAdditionalShare),
  );
  return [...input.commonCounts.entries()]
    .filter(([ref, count]) => (
      ref !== input.sourceRef
      && ref !== "DEL"
      && count >= minimumSupport
    ))
    .map(([ref, commonCount]) => {
      const additionalCount = input.referenceCounts.get(ref) ?? 0;
      const sourceFrequency = commonCount / input.sourceCount;
      const referenceFrequency = input.referenceCount > 0 ? additionalCount / input.referenceCount : 0;
      const lift = referenceFrequency > 0 ? sourceFrequency / referenceFrequency : 0;
      const score = lift > 1 ? sourceFrequency * Math.log(lift) : 0;
      const [sourceLower] = wilson(commonCount, input.sourceCount);
      const [, referenceUpper] = wilson(additionalCount, input.referenceCount);
      return {
        ref,
        commonCount,
        additionalCount,
        sourceFrequency,
        referenceFrequency,
        lift,
        score,
        sourceLower,
        referenceUpper,
      };
    })
    .filter((candidate) => (
      candidate.additionalCount >= minimumAdditional
      &&
      candidate.lift >= SIMILARITY_CALIBRATION.minimumLift
      && candidate.sourceLower > candidate.referenceUpper
    ))
    .sort((a, b) => (
      b.score - a.score
      || b.commonCount - a.commonCount
      || a.ref.localeCompare(b.ref, "en")
    ))
    .slice(0, SIMILARITY_CALIBRATION.maxResolvedRefs)
    .map(({ sourceLower: _sourceLower, referenceUpper: _referenceUpper, ...candidate }) => candidate);
}

async function computeSimilarity(sourceRef: string): Promise<SimilarityAnalysisResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    await client.query(`SET LOCAL statement_timeout = '${SIMILARITY_CALIBRATION.statementTimeoutMs}ms'`);
    // Probe the indexed source cohort first. Missing/rare source refs return
    // without paying for a full reference-population count.
    const sourcePopulation = await client.query<{ source_count: string }>(
      `SELECT COUNT(*)::text AS source_count
         FROM subscribers
        WHERE refs @> ARRAY[$1]::text[]
          AND NOT COALESCE('BCK' = ANY(tags), false)
          AND (suppressed_until IS NULL OR suppressed_until < NOW())`,
      [sourceRef],
    );
    const sourceCount = Number(sourcePopulation.rows[0]?.source_count ?? 0);
    let referenceCount = 0;
    let candidates: SimilarityCandidate[] = [];

    if (sourceCount >= SIMILARITY_CALIBRATION.minimumSourceSize) {
      const population = await client.query<{ population_count: string }>(
        `SELECT COUNT(*)::text AS population_count
           FROM subscribers
          WHERE NOT COALESCE('BCK' = ANY(tags), false)
            AND (suppressed_until IS NULL OR suppressed_until < NOW())`,
      );
      referenceCount = Math.max(0, Number(population.rows[0]?.population_count ?? 0) - sourceCount);
    }

    if (sourceCount >= SIMILARITY_CALIBRATION.minimumSourceSize && referenceCount > 0) {
      const common = await client.query<{ ref: string; common_count: string }>(
        `SELECT candidate.ref, COUNT(*)::text AS common_count
           FROM subscribers s
           CROSS JOIN LATERAL (
             SELECT DISTINCT ref FROM unnest(s.refs) AS ref
           ) candidate
          WHERE s.refs @> ARRAY[$1]::text[]
            AND NOT COALESCE('BCK' = ANY(s.tags), false)
            AND (s.suppressed_until IS NULL OR s.suppressed_until < NOW())
            AND candidate.ref <> $1
            AND candidate.ref <> 'DEL'
          GROUP BY candidate.ref
          ORDER BY COUNT(*) DESC, candidate.ref ASC
          LIMIT ${SIMILARITY_CALIBRATION.maxCandidatesExamined}`,
        [sourceRef],
      );
      const candidateRefs = common.rows.map((row) => row.ref);
      const commonCounts = new Map(common.rows.map((row) => [row.ref, Number(row.common_count)]));
      const referenceCounts = new Map<string, number>();
      if (candidateRefs.length) {
        const global = await client.query<{ ref: string; reference_count: string }>(
          `SELECT candidate.ref, COUNT(*)::text AS reference_count
             FROM subscribers s
             CROSS JOIN LATERAL (
                SELECT DISTINCT ref
                  FROM unnest(s.refs) AS ref
                 WHERE ref = ANY($1::text[])
             ) candidate
            WHERE s.refs && $1::text[]
              AND NOT COALESCE('BCK' = ANY(s.tags), false)
              AND (s.suppressed_until IS NULL OR s.suppressed_until < NOW())
            GROUP BY candidate.ref`,
          [candidateRefs],
        );
        for (const row of global.rows) {
          referenceCounts.set(
            row.ref,
            Math.max(0, Number(row.reference_count) - (commonCounts.get(row.ref) ?? 0)),
          );
        }
      }
      candidates = rankSimilarityCandidates({
        sourceRef,
        sourceCount,
        referenceCount,
        commonCounts,
        referenceCounts,
      });
    }

    const analyzedAt = new Date().toISOString();
    const analysisId = crypto.randomUUID();
    const result: SimilarityAnalysisResult = {
      analysisId,
      sourceRef,
      sourceCount,
      referenceCount,
      analyzedAt,
      resolvedRefs: candidates.map((candidate) => candidate.ref),
      candidates,
      status: sourceCount < SIMILARITY_CALIBRATION.minimumSourceSize
        ? "insufficient_source"
        : candidates.length ? "ready" : "no_reliable_affinity",
      calibration: "production-v1",
      provisional: false,
      methodology: "Production-calibrated exact-case refs; DEL ignored; active non-BCK source compared with the disjoint non-source population; source and additional support each at least max(20, 0.5% of source); lift >= 1.25; non-overlapping 95% Wilson bounds; ranked by source share × ln(lift); 20 highest-support co-refs examined.",
    };
    await client.query(
      `INSERT INTO segment_ref_similarity_analyses (id, source_ref, result, created_at)
       VALUES ($1, $2, $3::jsonb, $4)`,
      [analysisId, sourceRef, JSON.stringify(result), analyzedAt],
    );
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function analyzeSimilarRefs(sourceRef: string, refresh = false): Promise<SimilarityAnalysisResult & { cached: boolean }> {
  if (sourceRef === "DEL") throw new Error("DEL cannot be analyzed as a similarity ref");
  const now = Date.now();
  const existing = cache.get(sourceRef);
  if (!refresh && existing && existing.expiresAt > now) return { ...existing.result, cached: true };
  // Refresh bypasses a completed cache entry, not identical work already in
  // progress for this exact-case source.
  const key = sourceRef;
  let promise = inflight.get(key);
  if (!promise) {
    if (activeAnalyses >= MAX_CONCURRENT_ANALYSES) {
      const error = new Error("Two similarity analyses are already running");
      (error as Error & { code: string }).code = "SIMILARITY_BUSY";
      throw error;
    }
    activeAnalyses += 1;
    promise = computeSimilarity(sourceRef).then((result) => {
      cache.delete(sourceRef);
      cache.set(sourceRef, { result, expiresAt: Date.now() + SIMILARITY_CALIBRATION.cacheTtlMs });
      while (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
      return result;
    }).finally(() => {
      inflight.delete(key);
      activeAnalyses = Math.max(0, activeAnalyses - 1);
    });
    inflight.set(key, promise);
  }
  return { ...(await promise), cached: false };
}

function collectSimilarityRules(group: SegmentGroup, output: SegmentSimilarity[]): void {
  for (const child of group.children) {
    if (child.type === "group") collectSimilarityRules(child, output);
    else if (child.type === "similarity") output.push(child);
  }
}

export async function canonicalizeTrustedSimilarityRules(rules: SegmentRulesV2): Promise<SegmentRulesV2> {
  const supplied: SegmentSimilarity[] = [];
  collectSimilarityRules(rules.root, supplied);
  if (!supplied.length) return rules;
  if (new Set(supplied.map((rule) => rule.ruleId)).size !== supplied.length) {
    throw new Error("Similarity analysis blocks must have unique rule IDs");
  }
  const ids = [...new Set(supplied.map((rule) => rule.analysisId))];
  const records = await pool.query<{ id: string; source_ref: string; result: unknown }>(
    `SELECT id, source_ref, result
       FROM segment_ref_similarity_analyses
      WHERE id = ANY($1::text[])`,
    [ids],
  );
  const byId = new Map(records.rows.map((row) => [row.id, row]));
  function walk(group: SegmentGroup): SegmentGroup {
    return {
      ...group,
      children: group.children.map((child) => {
        if (child.type === "group") return walk(child);
        if (child.type !== "similarity") return child;
        const record = byId.get(child.analysisId);
        if (!record || record.source_ref !== child.sourceRef) {
          throw new Error("Similarity analysis is missing or does not match the exact-case source ref");
        }
        const parsedResult = similarityAnalysisResultSchema.safeParse(record.result);
        if (!parsedResult.success) {
          throw new Error("Similarity analysis record is invalid");
        }
        const result = parsedResult.data;
        if (result.analysisId !== record.id || result.sourceRef !== record.source_ref) {
          throw new Error("Similarity analysis record identity is invalid");
        }
        return canonicalizeSimilaritySelection(child, result);
      }),
    };
  }
  return { version: 2, root: walk(rules.root) };
}

export function similaritySnapshotsForSegments(
  segments: Array<{ id: string; rules: unknown }>,
): Record<string, SegmentSimilarity[]> {
  const snapshot: Record<string, SegmentSimilarity[]> = {};
  for (const segment of segments) {
    if (Array.isArray(segment.rules)) continue;
    if (!segment.rules || typeof segment.rules !== "object" || (segment.rules as any).version !== 2) continue;
    const parsed = segmentRulesV2Schema.safeParse(segment.rules);
    if (!parsed.success) throw new Error(`Segment ${segment.id} has invalid stored rules`);
    const rules = parsed.data;
    const found: SegmentSimilarity[] = [];
    collectSimilarityRules(rules.root, found);
    if (found.length) snapshot[segment.id] = found;
  }
  return snapshot;
}