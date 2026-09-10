import crypto from "crypto";
import { pool } from "../db";
import type {
  SegmentGroup,
  SegmentRulesV2,
  SegmentSimilarity,
} from "@shared/schema";

export const SIMILARITY_CALIBRATION = {
  name: "provisional-v1" as const,
  calibratedOnProduction: false,
  minimumSourceSize: 100,
  minimumCommonCount: 20,
  minimumSourceShare: 0.005,
  minimumLift: 1.25,
  confidenceLevel: 0.95,
  maxCandidatesExamined: 100,
  maxResolvedTags: 3,
  cacheTtlMs: 10 * 60_000,
  statementTimeoutMs: 15_000,
};

export type SimilarityCandidate = {
  tag: string;
  commonCount: number;
  sourceFrequency: number;
  referenceFrequency: number;
  lift: number;
};

export type SimilarityAnalysisResult = {
  analysisId: string;
  sourceTag: string;
  sourceCount: number;
  referenceCount: number;
  analyzedAt: string;
  resolvedTags: string[];
  candidates: SimilarityCandidate[];
  status: "ready" | "insufficient_source" | "no_reliable_affinity";
  calibration: typeof SIMILARITY_CALIBRATION.name;
  provisional: true;
  methodology: string;
};

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
  sourceTag: string;
  sourceCount: number;
  referenceCount: number;
  commonCounts: Map<string, number>;
  referenceCounts: Map<string, number>;
}): SimilarityCandidate[] {
  const minimumSupport = Math.max(
    SIMILARITY_CALIBRATION.minimumCommonCount,
    Math.ceil(input.sourceCount * SIMILARITY_CALIBRATION.minimumSourceShare),
  );
  return [...input.commonCounts.entries()]
    .filter(([tag, count]) => (
      tag !== input.sourceTag
      && tag !== "BCK"
      && count >= minimumSupport
    ))
    .map(([tag, commonCount]) => {
      const referenceTagCount = input.referenceCounts.get(tag) ?? 0;
      const sourceFrequency = commonCount / input.sourceCount;
      const referenceFrequency = referenceTagCount / input.referenceCount;
      const lift = referenceFrequency > 0 ? sourceFrequency / referenceFrequency : 0;
      const [sourceLower] = wilson(commonCount, input.sourceCount);
      const [, referenceUpper] = wilson(referenceTagCount, input.referenceCount);
      return { tag, commonCount, sourceFrequency, referenceFrequency, lift, sourceLower, referenceUpper };
    })
    .filter((candidate) => (
      candidate.lift >= SIMILARITY_CALIBRATION.minimumLift
      && candidate.sourceLower > candidate.referenceUpper
    ))
    .sort((a, b) => (
      (b.sourceLower / Math.max(b.referenceUpper, Number.EPSILON))
      - (a.sourceLower / Math.max(a.referenceUpper, Number.EPSILON))
      || b.commonCount - a.commonCount
      || a.tag.localeCompare(b.tag, "en")
    ))
    .slice(0, SIMILARITY_CALIBRATION.maxResolvedTags)
    .map(({ sourceLower: _sourceLower, referenceUpper: _referenceUpper, ...candidate }) => candidate);
}

async function computeSimilarity(sourceTag: string): Promise<SimilarityAnalysisResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    await client.query(`SET LOCAL statement_timeout = '${SIMILARITY_CALIBRATION.statementTimeoutMs}ms'`);
    // Probe the indexed source cohort first. Missing/rare source tags return
    // without paying for a full reference-population count.
    const sourcePopulation = await client.query<{ source_count: string }>(
      `SELECT COUNT(*)::text AS source_count
         FROM subscribers
        WHERE tags @> ARRAY[$1]::text[]
          AND NOT COALESCE('BCK' = ANY(tags), false)
          AND (suppressed_until IS NULL OR suppressed_until < NOW())`,
      [sourceTag],
    );
    const sourceCount = Number(sourcePopulation.rows[0]?.source_count ?? 0);
    let referenceCount = 0;
    let candidates: SimilarityCandidate[] = [];

    if (sourceCount >= SIMILARITY_CALIBRATION.minimumSourceSize) {
      const population = await client.query<{ reference_count: string }>(
        `SELECT COUNT(*)::text AS reference_count
           FROM subscribers
          WHERE NOT COALESCE('BCK' = ANY(tags), false)
            AND (suppressed_until IS NULL OR suppressed_until < NOW())`,
      );
      referenceCount = Number(population.rows[0]?.reference_count ?? 0);
    }

    if (sourceCount >= SIMILARITY_CALIBRATION.minimumSourceSize && referenceCount > 0) {
      const common = await client.query<{ tag: string; common_count: string }>(
        `SELECT candidate.tag, COUNT(*)::text AS common_count
           FROM subscribers s
           CROSS JOIN LATERAL (
             SELECT DISTINCT tag FROM unnest(s.tags) AS tag
           ) candidate
          WHERE s.tags @> ARRAY[$1]::text[]
            AND NOT COALESCE('BCK' = ANY(s.tags), false)
            AND (s.suppressed_until IS NULL OR s.suppressed_until < NOW())
            AND candidate.tag <> $1
            AND candidate.tag <> 'BCK'
          GROUP BY candidate.tag
          ORDER BY COUNT(*) DESC, candidate.tag ASC
          LIMIT ${SIMILARITY_CALIBRATION.maxCandidatesExamined}`,
        [sourceTag],
      );
      const candidateTags = common.rows.map((row) => row.tag);
      const referenceCounts = new Map<string, number>();
      if (candidateTags.length) {
        const global = await client.query<{ tag: string; reference_count: string }>(
          `SELECT candidate.tag, COUNT(*)::text AS reference_count
             FROM subscribers s
             CROSS JOIN LATERAL (
               SELECT DISTINCT tag
                 FROM unnest(s.tags) AS tag
                WHERE tag = ANY($1::text[])
             ) candidate
            WHERE s.tags && $1::text[]
              AND NOT COALESCE('BCK' = ANY(s.tags), false)
              AND (s.suppressed_until IS NULL OR s.suppressed_until < NOW())
            GROUP BY candidate.tag`,
          [candidateTags],
        );
        for (const row of global.rows) referenceCounts.set(row.tag, Number(row.reference_count));
      }
      candidates = rankSimilarityCandidates({
        sourceTag,
        sourceCount,
        referenceCount,
        commonCounts: new Map(common.rows.map((row) => [row.tag, Number(row.common_count)])),
        referenceCounts,
      });
    }

    const analyzedAt = new Date().toISOString();
    const analysisId = crypto.randomUUID();
    const result: SimilarityAnalysisResult = {
      analysisId,
      sourceTag,
      sourceCount,
      referenceCount,
      analyzedAt,
      resolvedTags: candidates.map((candidate) => candidate.tag),
      candidates,
      status: sourceCount < SIMILARITY_CALIBRATION.minimumSourceSize
        ? "insufficient_source"
        : candidates.length ? "ready" : "no_reliable_affinity",
      calibration: "provisional-v1",
      provisional: true,
      methodology: "Exact-case tags; active non-BCK reference population; minimum support max(20, 0.5% of source); lift >= 1.25; source 95% Wilson lower bound must exceed reference 95% Wilson upper bound.",
    };
    await client.query(
      `INSERT INTO segment_similarity_analyses (id, source_tag, result, created_at)
       VALUES ($1, $2, $3::jsonb, $4)`,
      [analysisId, sourceTag, JSON.stringify(result), analyzedAt],
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

export async function analyzeSimilarTags(sourceTag: string, refresh = false): Promise<SimilarityAnalysisResult & { cached: boolean }> {
  const now = Date.now();
  const existing = cache.get(sourceTag);
  if (!refresh && existing && existing.expiresAt > now) return { ...existing.result, cached: true };
  // Refresh bypasses a completed cache entry, not identical work already in
  // progress for this exact-case source.
  const key = sourceTag;
  let promise = inflight.get(key);
  if (!promise) {
    if (activeAnalyses >= MAX_CONCURRENT_ANALYSES) {
      const error = new Error("Two similarity analyses are already running");
      (error as Error & { code: string }).code = "SIMILARITY_BUSY";
      throw error;
    }
    activeAnalyses += 1;
    promise = computeSimilarity(sourceTag).then((result) => {
      cache.delete(sourceTag);
      cache.set(sourceTag, { result, expiresAt: Date.now() + SIMILARITY_CALIBRATION.cacheTtlMs });
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
  const records = await pool.query<{ id: string; source_tag: string; result: SimilarityAnalysisResult }>(
    `SELECT id, source_tag, result
       FROM segment_similarity_analyses
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
        if (!record || record.source_tag !== child.sourceTag) {
          throw new Error("Similarity analysis is missing or does not match the exact-case source tag");
        }
        const result = record.result;
        return {
          type: "similarity" as const,
          ruleId: child.ruleId,
          sourceTag: result.sourceTag,
          analysisId: result.analysisId,
          resolvedTags: result.resolvedTags,
          analyzedAt: result.analyzedAt,
          candidates: result.candidates,
          calibration: result.calibration,
        };
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
    const rules = segment.rules as SegmentRulesV2;
    if (!rules || rules.version !== 2) continue;
    const found: SegmentSimilarity[] = [];
    collectSimilarityRules(rules.root, found);
    if (found.length) snapshot[segment.id] = found;
  }
  return snapshot;
}