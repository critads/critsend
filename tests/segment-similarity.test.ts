import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  segmentRulesV2Schema,
  type SegmentRulesV2,
  type SegmentSimilarity,
} from "../shared/schema";
import {
  compileSegmentRules,
  SimilaritySnapshotMismatchError,
} from "../server/services/segment-compiler";
import {
  rankSimilarityCandidates,
  parseCampaignSimilaritySnapshot,
  SIMILARITY_CALIBRATION,
  similaritySnapshotsForSegments,
} from "../server/services/segment-similarity";

const affinity: SegmentSimilarity = {
  type: "similarity",
  ruleId: "08345316-2af7-44a9-8b00-58dfc8f38eb0",
  sourceRef: "SourceExact",
  analysisId: "8ee55e4b-26f9-43b4-986e-a8e8ab6d9b8c",
  resolvedRefs: ["Click-A", "Click-B"],
  analyzedAt: "2026-09-10T10:00:00.000Z",
  candidates: [
    { ref: "Click-A", commonCount: 80, additionalCount: 160, sourceFrequency: 0.4, referenceFrequency: 0.08, lift: 5, score: 0.6438 },
    { ref: "Click-B", commonCount: 50, additionalCount: 100, sourceFrequency: 0.25, referenceFrequency: 0.05, lift: 5, score: 0.4024 },
  ],
  calibration: "production-v1",
};

function rules(rule = affinity): SegmentRulesV2 {
  return {
    version: 2,
    root: { type: "group", combinator: "AND", children: [rule] },
  };
}

describe("similar audience segment rules", () => {
  it("validates trusted explainable metadata and rejects source overlap", () => {
    expect(segmentRulesV2Schema.safeParse(rules()).success).toBe(true);
    expect(segmentRulesV2Schema.safeParse(rules({
      ...affinity,
      resolvedRefs: ["SourceExact"],
      candidates: [{ ...affinity.candidates[0], ref: "SourceExact" }],
    })).success).toBe(false);
    expect(segmentRulesV2Schema.safeParse(rules({
      ...affinity,
      resolvedRefs: [],
      candidates: [],
    })).success).toBe(false);
  });

  it("compiles exact-case any-ref membership with mandatory source exclusion", () => {
    const query = new PgDialect().sqlToQuery(compileSegmentRules(rules()));
    expect(query.sql).toContain("&&");
    expect(query.sql).toContain("ANY");
    expect(query.params).toContainEqual(["Click-A", "Click-B"]);
    expect(query.params).toContain("SourceExact");
    expect(query.params).not.toContain("sourceexact");
  });

  it("uses a frozen campaign resolution instead of refreshed segment tags", () => {
    const frozen = [{ ...affinity, resolvedRefs: ["Old-Ref"], candidates: [
      { ref: "Old-Ref", commonCount: 50, additionalCount: 100, sourceFrequency: 0.25, referenceFrequency: 0.05, lift: 5, score: 0.4024 },
    ] }];
    const query = new PgDialect().sqlToQuery(compileSegmentRules(rules(), frozen));
    expect(query.params).toContainEqual(["Old-Ref"]);
    expect(query.params).not.toContainEqual(["Click-A", "Click-B"]);
  });

  it("filters weak and rare coincidences and sorts deterministically", () => {
    const selected = rankSimilarityCandidates({
      sourceRef: "SRC",
      sourceCount: 1_000,
      referenceCount: 10_000,
      commonCounts: new Map([
        ["rare", 4],
        ["weak", 100],
        ["z-strong", 300],
        ["a-strong", 300],
        ["DEL", 900],
      ]),
      referenceCounts: new Map([
        ["rare", 4],
        ["weak", 900],
        ["z-strong", 500],
        ["a-strong", 500],
        ["DEL", 900],
      ]),
    });
    expect(selected.map((item) => item.ref)).toEqual(["a-strong", "z-strong"]);
    expect(SIMILARITY_CALIBRATION.calibratedOnProduction).toBe(true);
    expect(SIMILARITY_CALIBRATION.maxCandidatesExamined).toBe(20);
  });

  it("snapshots only similarity blocks, preserving immutable exact refs", () => {
    expect(similaritySnapshotsForSegments([
      { id: "segment-a", rules: rules() },
      { id: "segment-b", rules: { version: 2, root: { type: "group", combinator: "AND", children: [] } } },
    ])).toEqual({ "segment-a": [affinity] });
  });

  it("treats explicit empty and missing-rule frozen snapshots as authoritative", () => {
    expect(() => compileSegmentRules(rules(), [])).toThrow(SimilaritySnapshotMismatchError);
    const replacement = { ...affinity, ruleId: "05da7fa8-bbae-47c2-af04-6477456e8083" };
    expect(() => compileSegmentRules(rules(), [replacement])).toThrow(SimilaritySnapshotMismatchError);
    const removedRule: SegmentRulesV2 = {
      version: 2,
      root: { type: "group", combinator: "AND", children: [] },
    };
    expect(() => compileSegmentRules(removedRule, [affinity])).toThrow(SimilaritySnapshotMismatchError);
  });

  it("never proposes DEL and rejects DEL in persisted rules", () => {
    const selected = rankSimilarityCandidates({
      sourceRef: "SRC",
      sourceCount: 1_000,
      referenceCount: 10_000,
      commonCounts: new Map([["DEL", 900], ["Useful", 300]]),
      referenceCounts: new Map([["DEL", 1_000], ["Useful", 500]]),
    });
    expect(selected.map((candidate) => candidate.ref)).toEqual(["Useful"]);
    expect(segmentRulesV2Schema.safeParse(rules({
      ...affinity,
      resolvedRefs: ["DEL"],
      candidates: [{ ...affinity.candidates[0], ref: "DEL" }],
    })).success).toBe(false);
  });

  it("balances affinity with useful common support", () => {
    const selected = rankSimilarityCandidates({
      sourceRef: "SRC",
      sourceCount: 1_000,
      referenceCount: 100_000,
      commonCounts: new Map([["tiny-perfect", 20], ["broad-strong", 500]]),
      referenceCounts: new Map([["tiny-perfect", 20], ["broad-strong", 1_000]]),
    });
    expect(selected.map((candidate) => candidate.ref)).toEqual(["broad-strong", "tiny-perfect"]);
    expect(selected[0].additionalCount).toBe(1_000);
    expect(selected[0].score).toBeGreaterThan(selected[1].score);
  });

  it("rejects malformed or legacy-tag campaign snapshot JSON", () => {
    expect(() => parseCampaignSimilaritySnapshot({ "segment-a": [{ ...affinity, resolvedRefs: ["DEL"] }] })).toThrow();
    const { sourceRef: _sourceRef, resolvedRefs: _resolvedRefs, ...rest } = affinity;
    expect(() => parseCampaignSimilaritySnapshot({
      "segment-a": [{ ...rest, sourceTag: "SourceExact", resolvedTags: ["Click-A"] }],
    })).toThrow();
  });
});