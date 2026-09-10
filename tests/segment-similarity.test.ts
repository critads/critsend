import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  segmentRulesV2Schema,
  type SegmentRulesV2,
  type SegmentSimilarity,
} from "../shared/schema";
import { compileSegmentRules } from "../server/services/segment-compiler";
import {
  rankSimilarityCandidates,
  SIMILARITY_CALIBRATION,
  similaritySnapshotsForSegments,
} from "../server/services/segment-similarity";

const affinity: SegmentSimilarity = {
  type: "similarity",
  ruleId: "08345316-2af7-44a9-8b00-58dfc8f38eb0",
  sourceTag: "SourceExact",
  analysisId: "8ee55e4b-26f9-43b4-986e-a8e8ab6d9b8c",
  resolvedTags: ["Click-A", "Click-B"],
  analyzedAt: "2026-09-10T10:00:00.000Z",
  candidates: [
    { tag: "Click-A", commonCount: 80, sourceFrequency: 0.4, referenceFrequency: 0.08, lift: 5 },
    { tag: "Click-B", commonCount: 50, sourceFrequency: 0.25, referenceFrequency: 0.05, lift: 5 },
  ],
  calibration: "provisional-v1",
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
      resolvedTags: ["SourceExact"],
      candidates: [{ ...affinity.candidates[0], tag: "SourceExact" }],
    })).success).toBe(false);
  });

  it("compiles exact-case any-tag membership with mandatory source exclusion", () => {
    const query = new PgDialect().sqlToQuery(compileSegmentRules(rules()));
    expect(query.sql).toContain("&&");
    expect(query.sql).toContain("@>");
    expect(query.params).toContainEqual(["Click-A", "Click-B"]);
    expect(query.params).toContain("SourceExact");
    expect(query.params).not.toContain("sourceexact");
  });

  it("uses a frozen campaign resolution instead of refreshed segment tags", () => {
    const frozen = [{ ...affinity, resolvedTags: ["Old-Tag"], candidates: [
      { tag: "Old-Tag", commonCount: 50, sourceFrequency: 0.25, referenceFrequency: 0.05, lift: 5 },
    ] }];
    const query = new PgDialect().sqlToQuery(compileSegmentRules(rules(), frozen));
    expect(query.params).toContainEqual(["Old-Tag"]);
    expect(query.params).not.toContainEqual(["Click-A", "Click-B"]);
  });

  it("filters weak and rare coincidences and sorts deterministically", () => {
    const selected = rankSimilarityCandidates({
      sourceTag: "SRC",
      sourceCount: 1_000,
      referenceCount: 10_000,
      commonCounts: new Map([
        ["rare", 4],
        ["weak", 100],
        ["z-strong", 300],
        ["a-strong", 300],
        ["BCK", 900],
      ]),
      referenceCounts: new Map([
        ["rare", 4],
        ["weak", 900],
        ["z-strong", 500],
        ["a-strong", 500],
        ["BCK", 900],
      ]),
    });
    expect(selected.map((item) => item.tag)).toEqual(["a-strong", "z-strong"]);
    expect(SIMILARITY_CALIBRATION.calibratedOnProduction).toBe(false);
  });

  it("snapshots only similarity blocks, preserving immutable exact tags", () => {
    expect(similaritySnapshotsForSegments([
      { id: "segment-a", rules: rules() },
      { id: "segment-b", rules: { version: 2, root: { type: "group", combinator: "AND", children: [] } } },
    ])).toEqual({ "segment-a": [affinity] });
  });
});