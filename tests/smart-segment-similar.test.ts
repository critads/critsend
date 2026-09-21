import { describe, expect, it } from "vitest";
import {
  excludedSimilarRefs,
  listSimilarBrandCandidates,
  validateSimilarRefs,
  withSimilarRefs,
  type SimilarBrandDeps,
} from "../server/services/smart-segment-similar";
import type { SmartSegmentBrandResolution } from "../shared/smart-segment";
import { smartSegmentAnalysisIdentity } from "../shared/smart-segment";

const brand: SmartSegmentBrandResolution = {
  detected: true, source: "directory", brandName: "Air France", coreRefs: ["4AF"], extensionRefs: ["US4AF", "E4AF"],
  unsubscribeTags: ["U4AF"], vertical: "4", verticalLabel: "Voyage", verticalRefs: ["4TUI", "4CLUB", "4PIE"], matchedKeys: [], similarRefs: [],
};

function analysis(sourceRef: string, refs: Array<[string, number]>, status: "ready" | "insufficient_source" | "no_reliable_affinity" = "ready") {
  return {
    sourceRef,
    status,
    resolvedRefs: refs.map(([ref]) => ref),
    candidates: refs.map(([ref, lift]) => ({ ref, lift, commonCount: 1_000, additionalCount: 5_000, sourceFrequency: 0.1, referenceFrequency: 0.01, score: lift })),
  };
}

describe("similar brands for the smart segment composer", () => {
  it("merges the trusted similar refs of every core ref, best lift first, minus the brand's own refs, DEL and the bot ref", async () => {
    const calls: string[] = [];
    const deps: SimilarBrandDeps = {
      analyze: async (sourceRef) => {
        calls.push(sourceRef);
        if (sourceRef === "4AF") return analysis("4AF", [["4TUI", 3.2], ["US4AF", 9], ["DEL", 4]]);
        return analysis("4AFB", [["4TUI", 4.1], ["4PIE", 2.5]]);
      },
      brandNames: async (refs) => new Map(refs.map((ref) => [ref, `Marque ${ref}`])),
    };
    const result = await listSimilarBrandCandidates(["4afb", "4AF", "4af"], deps);
    expect(calls).toEqual(["4AF", "4AFB"]);
    expect(result.coreRefs).toEqual(["4AF", "4AFB"]);
    expect(result.candidates.map((candidate) => [candidate.ref, candidate.sourceRef, candidate.lift, candidate.brandName])).toEqual([
      ["4TUI", "4AFB", 4.1, "Marque 4TUI"],
      ["4PIE", "4AFB", 2.5, "Marque 4PIE"],
    ]);
    expect(result.notes).toEqual([]);
  });

  it("explains a source ref without usable affinity instead of failing", async () => {
    const deps: SimilarBrandDeps = {
      analyze: async (sourceRef) => sourceRef === "4AF" ? analysis("4AF", [], "insufficient_source") : Promise.reject(new Error("boom")),
      brandNames: async () => new Map(),
    };
    const result = await listSimilarBrandCandidates(["4AF", "4XX"], deps);
    expect(result.candidates).toEqual([]);
    expect(result.notes).toHaveLength(2);
  });

  it("validates the operator's selection: uppercase, deduplicated, brand refs refused explicitly", () => {
    expect(excludedSimilarRefs(["4AF"])).toEqual(new Set(["4AF", "US4AF", "E4AF", "DEL"]));
    const checked = validateSimilarRefs([" 4tui", "4TUI", "us4af", "del", "4club"], brand);
    expect(checked.similarRefs).toEqual(["4CLUB", "4TUI"]);
    expect(checked.rejected).toEqual(["DEL", "US4AF"]);
  });

  it("moves a kept similar ref out of the vertical pool so it is never counted twice", () => {
    const resolved = withSimilarRefs(brand, ["4TUI"]);
    expect(resolved.similarRefs).toEqual(["4TUI"]);
    expect(resolved.verticalRefs).toEqual(["4CLUB", "4PIE"]);
    expect(resolved.coreRefs).toEqual(["4AF"]);
  });

  it("makes the selection part of the analysis identity", () => {
    const base = { campaignName: "Air France", campaignId: null, family: "fai_fr" as const, targetClicks: 1_000, complaintCap: 0.004 };
    expect(smartSegmentAnalysisIdentity({ ...base, similarRefs: ["4tui", "4CLUB"] })).toBe(smartSegmentAnalysisIdentity({ ...base, similarRefs: ["4CLUB", "4TUI", "4TUI"] }));
    expect(smartSegmentAnalysisIdentity({ ...base, similarRefs: ["4TUI"] })).not.toBe(smartSegmentAnalysisIdentity({ ...base }));
  });
});
