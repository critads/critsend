import { describe, expect, it } from "vitest";
import type { SegmentRulesV2 } from "../shared/schema";
import type { CohortRate, SmartSegmentBrandResolution } from "../shared/smart-segment";
import {
  CALIBRATION_ADJUSTMENTS,
  aggregateCohortRates,
  buildBlockLibrary,
  clickerTierFor,
  condition,
  ensureMandatoryExclusions,
  exceedsComplaintCap,
  group,
  mandatoryExclusions,
  MIN_RELIABLE_COHORT_DELIVERED,
  projectBlock,
  projectComposition,
  rateFor,
  sampleDivisorFor,
} from "../server/services/smart-segment-projection";
import { BOT_OPENER_REF } from "../server/config/suppression";

const brand: SmartSegmentBrandResolution = {
  detected: true,
  source: "directory",
  brandName: "Air France",
  coreRefs: ["4AF"],
  extensionRefs: ["US4AF", "E4AF"],
  unsubscribeTags: ["U4AF", "UUS4AF"],
  vertical: "4",
  verticalLabel: "Voyage",
  verticalRefs: ["4TUI", "4CLUB"],
  matchedKeys: ["air\u001ffrance"],
};

function rates(rows: Array<[CohortRate["axis"], string, number, number, number]>): CohortRate[] {
  return aggregateCohortRates(rows.map(([axis, cohort, delivered, humanClickers, complaints]) => ({
    axis, cohort, delivered, humanClickers, botClickers: 0, complaints,
  })));
}

describe("smart segment projection — cohorts", () => {
  it("maps distinct clicked campaigns to the documented tiers", () => {
    expect(clickerTierFor(0)).toBe("0");
    expect(clickerTierFor(1)).toBe("1");
    expect(clickerTierFor(3)).toBe("2-3");
    expect(clickerTierFor(5)).toBe("4-5");
    expect(clickerTierFor(9)).toBe("6+");
  });

  it("merges rows of the same cohort across calibration sends", () => {
    const merged = aggregateCohortRates([
      { axis: "clicker_tier", cohort: "6+", delivered: 1000, humanClickers: 100, botClickers: 5, complaints: 1 },
      { axis: "clicker_tier", cohort: "6+", delivered: 3000, humanClickers: 200, botClickers: 0, complaints: 3 },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].delivered).toBe(4000);
    expect(merged[0].humanCtr).toBeCloseTo(300 / 4000);
    expect(merged[0].complaintRate).toBeCloseTo(4 / 4000);
  });

  it("falls back to the axis-wide rate for thin cohorts", () => {
    const table = rates([
      ["clicker_tier", "6+", MIN_RELIABLE_COHORT_DELIVERED - 1, 500, 0],
      ["clicker_tier", "0", 99_000, 990, 99],
    ]);
    const thin = rateFor(table, "clicker_tier", "6+");
    expect(thin.reliable).toBe(false);
    expect(thin.humanCtr).toBeCloseTo(1490 / (MIN_RELIABLE_COHORT_DELIVERED - 1 + 99_000));
    const reliable = rateFor(table, "clicker_tier", "0");
    expect(reliable.reliable).toBe(true);
    expect(reliable.humanCtr).toBeCloseTo(0.01);
  });

  it("samples very large sends with a deterministic divisor", () => {
    expect(sampleDivisorFor(100_000, 250_000)).toBe(1);
    expect(sampleDivisorFor(1_000_000, 250_000)).toBe(4);
    expect(sampleDivisorFor(1_000_001, 250_000)).toBe(5);
  });
});

describe("smart segment projection — mandatory exclusions", () => {
  it("lists bot IP, DEL, family, unsubscribe tags and the NEWEST recent sends in one bounded condition", () => {
    // Ids arrive newest first from the evidence: nine sends in the window,
    // only the six most recent are excluded (spec: « ≤ 6 envois récents »).
    const window = Array.from({ length: 9 }, (_, i) => `camp-${i}`);
    const recent = window.slice(0, 6);
    const required = mandatoryExclusions(brand, "fai_fr", [...window, "camp-0"]);
    const ids = required.map((entry) => entry.id);
    expect(ids).toContain("bot_ip");
    expect(ids).toContain("del_ref");
    expect(ids).toContain("family");
    expect(ids).toContain("unsub:U4AF");
    expect(ids).toContain("unsub:UUS4AF");
    const notReceived = required.filter((entry) => entry.id === "not_received_recent");
    expect(notReceived).toHaveLength(1);
    expect(notReceived[0].node).toMatchObject({ field: "engagement", operator: "not_received_campaign", value: recent });
    expect(notReceived[0].label).toContain("6 envois récents");
    // A single recent send stays a scalar value (builder-friendly).
    const single = mandatoryExclusions(brand, "fai_fr", ["camp-x"]).find((entry) => entry.id === "not_received_recent")!;
    expect(single.node).toMatchObject({ value: "camp-x" });
    // Bounded whatever the window holds.
    const many = mandatoryExclusions(brand, "fai_fr", Array.from({ length: 80 }, (_, i) => `c-${i}`)).find((entry) => entry.id === "not_received_recent")!;
    expect((many.node as { value: string[] }).value).toEqual(["c-0", "c-1", "c-2", "c-3", "c-4", "c-5"]);
    const del = required.find((entry) => entry.id === "del_ref")!.node;
    expect(del).toMatchObject({ field: "refs", operator: "not_has_ref", value: BOT_OPENER_REF });
  });

  it("treats recent-send exclusions as satisfied only when every campaign is excluded at AND level", () => {
    const required = mandatoryExclusions(brand, "fai_fr", ["camp-1", "camp-2", "camp-3"]);
    const base = required.filter((entry) => entry.id !== "not_received_recent").map((entry) => entry.node);
    const split: SegmentRulesV2 = {
      version: 2,
      root: group("AND", [
        condition("engagement", "clicked_recently"),
        ...base,
        condition("engagement", "not_received_campaign", "camp-1"),
        condition("engagement", "not_received_campaign", ["camp-2", "camp-3"]),
      ]),
    };
    expect(ensureMandatoryExclusions(split, required).injected).toEqual([]);
    const partial: SegmentRulesV2 = {
      version: 2,
      root: group("AND", [condition("engagement", "clicked_recently"), ...base, condition("engagement", "not_received_campaign", ["camp-1", "camp-2"])]),
    };
    const { injected, rules } = ensureMandatoryExclusions(partial, required);
    expect(injected).toEqual(["Exclusion des destinataires des 3 envois récents de la marque"]);
    expect(rules.root.children.at(-1)).toMatchObject({ operator: "not_received_campaign", value: ["camp-1", "camp-2", "camp-3"] });
  });

  it("injects every missing exclusion under a top-level AND and reports it", () => {
    const required = mandatoryExclusions(brand, "microsoft_yahoo", ["camp-1"]);
    const rules: SegmentRulesV2 = { version: 2, root: group("OR", [condition("engagement", "ultra_active_clicker")]) };
    const { rules: fixed, injected } = ensureMandatoryExclusions(rules, required);
    expect(fixed.root.combinator).toBe("AND");
    expect(injected).toHaveLength(required.length);
    expect(injected).toContain("Exclusion des boîtes détectées par l'IP de plainte");
    // Original OR group preserved as the first child.
    expect(fixed.root.children[0]).toEqual(rules.root);
  });

  it("does not re-inject exclusions already present at AND level, but ignores those buried in an OR", () => {
    const required = mandatoryExclusions(brand, "fai_fr", []);
    const familyNode = required.find((entry) => entry.id === "family")!.node;
    const present: SegmentRulesV2 = {
      version: 2,
      root: group("AND", [
        condition("engagement", "clicked_recently"),
        condition("engagement", "not_opened_from_bot_ip"),
        condition("refs", "not_has_ref", BOT_OPENER_REF),
        condition("tags", "not_has_tag", "U4AF"),
        condition("tags", "not_has_tag", "UUS4AF"),
        familyNode,
      ]),
    };
    expect(ensureMandatoryExclusions(present, required).injected).toEqual([]);

    const buried: SegmentRulesV2 = {
      version: 2,
      root: group("AND", [
        group("OR", [condition("engagement", "not_opened_from_bot_ip"), condition("engagement", "clicked_recently")]),
      ]),
    };
    const { injected } = ensureMandatoryExclusions(buried, required);
    expect(injected).toContain("Exclusion des boîtes détectées par l'IP de plainte");
  });

  it("accepts a narrower family sub-group (subset of the family's domains) as satisfying the family filter", () => {
    const required = mandatoryExclusions(brand, "fai_fr", []);
    const narrow: SegmentRulesV2 = {
      version: 2,
      root: group("AND", [
        condition("engagement", "clicked_recently"),
        group("OR", [condition("email", "ends_with", "@orange.fr"), condition("email", "ends_with", "@wanadoo.fr")]),
      ]),
    };
    const { injected } = ensureMandatoryExclusions(narrow, required);
    expect(injected.some((label) => label.startsWith("Filtre de famille"))).toBe(false);
  });
});

describe("smart segment projection — blocks and compositions", () => {
  const table = rates([
    ["clicker_tier", "0", 100_000, 500, 60],
    ["clicker_tier", "1", 20_000, 600, 8],
    ["clicker_tier", "2-3", 10_000, 500, 3],
    ["clicker_tier", "4-5", 5_000, 400, 1],
    ["clicker_tier", "6+", 4_000, 480, 1],
    ["ref_relation", "core", 30_000, 900, 30],
    ["ref_relation", "extension", 10_000, 200, 12],
    ["ref_relation", "none", 99_000, 900, 40],
    // Family history well below every clicker tier here: the family bound is
    // exercised on its own in the dedicated test below.
    ["family", "in_family", 120_000, 1_500, 12],
  ]);

  it("builds ref-based blocks only when the brand has refs", () => {
    const ids = buildBlockLibrary(brand).map((block) => block.id);
    expect(ids).toEqual(["clickers_6plus", "clickers_4plus", "clickers_1plus", "warm_openers", "openers_vertical", "brand_core_refs", "brand_extension_refs"]);
    const anonymous = buildBlockLibrary({ ...brand, detected: false, coreRefs: [], extensionRefs: [], verticalRefs: [], vertical: null });
    expect(anonymous.map((block) => block.id)).toEqual(["clickers_6plus", "clickers_4plus", "clickers_1plus", "warm_openers"]);
  });

  it("projects tiered clicker blocks from the available tier mix and applies fallback discounts", () => {
    const [ultra, top] = buildBlockLibrary(brand);
    const brandCalibrated = projectBlock(ultra, 3_000, table, "brand", { "6+": 3_000 });
    expect(brandCalibrated.expectedCtr).toBeCloseTo(0.12);
    expect(brandCalibrated.projectedClicks.low).toBe(Math.round(3_000 * 0.12 * 0.7));
    expect(brandCalibrated.projectedClicks.high).toBe(Math.round(3_000 * 0.12 * 1.15));

    // 4+ block = weighted mix of the 4-5 and 6+ tiers actually available.
    const mixed = projectBlock(top, 5_000, table, "brand", { "4-5": 4_000, "6+": 1_000 });
    expect(mixed.expectedCtr).toBeCloseTo((4_000 * 0.08 + 1_000 * 0.12) / 5_000);

    const vertical = projectBlock(ultra, 3_000, table, "vertical", { "6+": 3_000 });
    expect(vertical.expectedCtr).toBeCloseTo(0.12 * CALIBRATION_ADJUSTMENTS.vertical.discount);
    expect(vertical.expectedComplaintRate).toBeCloseTo((1 / 4_000) * CALIBRATION_ADJUSTMENTS.vertical.complaintMarkup);
    expect(vertical.calibration.level).toBe("vertical");
  });

  it("projects a composition from the exact tier partition of its recounted audience (no block double counting)", () => {
    const definitions = buildBlockLibrary(brand);
    const blocks = [
      projectBlock(definitions[0], 2_000, table, "brand", { "6+": 2_000 }),
      projectBlock(definitions[1], 5_000, table, "brand", { "4-5": 3_000, "6+": 2_000 }),
    ];
    // OR(6+, 4+) recounts to 5 000 subscribers: 6+ ⊂ 4+, so the partition
    // is 2 000 in tier 6+ and 3 000 in tier 4-5 — never 7 000.
    const projection = projectComposition(
      { total: 5_000, tierCounts: { "6+": 2_000, "4-5": 3_000 } },
      ["clickers_6plus", "clickers_4plus"],
      blocks,
      table,
      "brand",
    );
    const clicks = 2_000 * 0.12 + 3_000 * 0.08;
    expect(projection.weightedCtr).toBeCloseTo(clicks / 5_000);
    expect(projection.projectedClicks.high).toBe(Math.round(clicks * 1.15));
    expect(projection.projectedComplaintRate).toBeCloseTo((2_000 * (1 / 4_000) + 3_000 * (1 / 5_000)) / 5_000);
    expect(projection.usedBlockIds).toEqual(["clickers_6plus", "clickers_4plus"]);
    expect(projection.refCohortsApplied).toEqual([]);
    expect(projection.unattributedCount).toBe(0);
    expect(projection.tiers.map((cell) => [cell.tier, cell.count, cell.complaintCohort])).toEqual([
      ["4-5", 3_000, "clicker_tier/4-5"],
      ["6+", 2_000, "clicker_tier/6+"],
    ]);
    expect(exceedsComplaintCap(projection.projectedComplaintRate, 0.006)).toBe(false);
    expect(exceedsComplaintCap(0.0061, 0.006)).toBe(true);
    expect(exceedsComplaintCap(0.006, 0.006)).toBe(false);
  });

  it("bounds every tier cell by the worst implicated ref-relation cohort when ref blocks are used", () => {
    const definitions = buildBlockLibrary(brand);
    const blocks = [
      projectBlock(definitions[0], 2_000, table, "brand", { "6+": 2_000 }),
      projectBlock(definitions[5], 40_000, table, "brand", {}),
    ];
    // OR(6+ clickers, core refs): 41 000 subscribers, mostly non-clickers.
    const projection = projectComposition(
      { total: 41_000, tierCounts: { "6+": 2_000, "1": 1_000, "0": 38_000 } },
      ["clickers_6plus", "brand_core_refs"],
      blocks,
      table,
      "brand",
    );
    const core = 30 / 30_000; // 0.1 % — worse than every clicker tier here
    expect(projection.refCohortsApplied).toEqual(["core"]);
    for (const cell of projection.tiers) expect(cell.complaintCohort).toBe("ref_relation/core");
    expect(projection.projectedComplaintRate).toBeCloseTo(core);
    // CTR stays per tier: non-clickers are never projected at the 6+ rate.
    expect(projection.weightedCtr).toBeCloseTo((2_000 * 0.12 + 1_000 * 0.03 + 38_000 * 0.005) / 41_000);
    // AND(6+ clickers, core refs) recounts to 6+ only: same bound, 6+ CTR.
    const narrowed = projectComposition({ total: 800, tierCounts: { "6+": 800 } }, ["clickers_6plus", "brand_core_refs"], blocks, table, "brand");
    expect(narrowed.weightedCtr).toBeCloseTo(0.12);
    expect(narrowed.projectedComplaintRate).toBeCloseTo(core);
  });

  it("bounds every cell (and every block) by the selected family's own complaint history", () => {
    // Same tiers, but this family complained at 0.75 % on the brand's sends:
    // above the hard cap, while every clicker tier looks harmless. The final
    // audience IS restricted to the family, so no cell may be projected below it.
    const riskyFamily = rates([
      ["clicker_tier", "0", 100_000, 500, 60],
      ["clicker_tier", "4-5", 5_000, 400, 1],
      ["clicker_tier", "6+", 4_000, 480, 1],
      ["ref_relation", "core", 30_000, 900, 30],
      ["family", "in_family", 120_000, 1_500, 900],
      ["family", "other", 80_000, 900, 8],
    ]);
    const familyRate = 900 / 120_000;
    const definitions = buildBlockLibrary(brand);
    const block = projectBlock(definitions[0], 2_000, riskyFamily, "brand", { "6+": 2_000 });
    expect(block.expectedComplaintRate).toBeCloseTo(familyRate);
    expect(block.expectedCtr).toBeCloseTo(0.12);
    const projection = projectComposition(
      { total: 5_000, tierCounts: { "6+": 2_000, "4-5": 3_000 } },
      ["clickers_6plus", "clickers_4plus"],
      [block, projectBlock(definitions[1], 5_000, riskyFamily, "brand", { "4-5": 3_000, "6+": 2_000 })],
      riskyFamily,
      "brand",
    );
    expect(projection.familyComplaintBound).toBeCloseTo(familyRate);
    for (const cell of projection.tiers) expect(cell.complaintCohort).toBe("family/in_family");
    expect(projection.projectedComplaintRate).toBeCloseTo(familyRate);
    expect(exceedsComplaintCap(projection.projectedComplaintRate, 0.006)).toBe(true);
    // Vertical fallback: the family bound carries the same markup as any cohort.
    const vertical = projectComposition({ total: 2_000, tierCounts: { "6+": 2_000 } }, ["clickers_6plus"], [block], riskyFamily, "vertical");
    expect(vertical.projectedComplaintRate).toBeCloseTo(familyRate * CALIBRATION_ADJUSTMENTS.vertical.complaintMarkup);
    // A worse ref cohort still wins over the family bound.
    const riskyCore = rates([
      ["clicker_tier", "6+", 4_000, 480, 1],
      ["ref_relation", "core", 30_000, 900, 300],
      ["family", "in_family", 120_000, 1_500, 900],
    ]);
    const core = projectComposition({ total: 800, tierCounts: { "6+": 800 } }, ["clickers_6plus", "brand_core_refs"], [block, projectBlock(definitions[5], 40_000, riskyCore, "brand", {})], riskyCore, "brand");
    expect(core.tiers[0].complaintCohort).toBe("ref_relation/core");
    expect(core.projectedComplaintRate).toBeCloseTo(300 / 30_000);
  });

  it("charges count drift to the worst cell and fails closed without any tier cell", () => {
    const definitions = buildBlockLibrary(brand);
    const blocks = [projectBlock(definitions[0], 2_000, table, "brand", { "6+": 2_000 })];
    const drifted = projectComposition({ total: 2_010, tierCounts: { "6+": 2_000 } }, ["clickers_6plus"], blocks, table, "brand");
    expect(drifted.unattributedCount).toBe(10);
    // Drift: worst cell complaint rate, at most the 0-click CTR.
    expect(drifted.projectedComplaintRate).toBeCloseTo((2_000 * (1 / 4_000) + 10 * Math.max(1 / 4_000, 0.0012)) / 2_010);
    expect(drifted.weightedCtr).toBeCloseTo((2_000 * 0.12 + 10 * 0.005) / 2_010);
    // No partition at all (e.g. tier query returned nothing): worst measured
    // complaint rate everywhere, 0-click CTR — never optimistic.
    const blind = projectComposition({ total: 10_000, tierCounts: {} }, ["clickers_6plus"], blocks, table, "global");
    expect(blind.tiers).toEqual([]);
    expect(blind.unattributedCount).toBe(10_000);
    expect(blind.weightedCtr).toBeCloseTo(0.005 * CALIBRATION_ADJUSTMENTS.global.discount);
    expect(blind.projectedComplaintRate).toBeCloseTo(0.0012 * CALIBRATION_ADJUSTMENTS.global.complaintMarkup);
  });
});
