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
  classifyMtaComplaintCapture,
  COMPLAINT_FLOOR_COHORT,
  exceedsComplaintCap,
  group,
  mandatoryExclusions,
  MIN_RELIABLE_COHORT_DELIVERED,
  MTA_CAPTURE_MIN_DELIVERED,
  orangeWanadooStatus,
  projectBlock,
  projectComposition,
  rateFor,
  ruleOfThreeRate,
  sampleDivisorFor,
  recencyRateFor,
  splitProjectableBlocks,
} from "../server/services/smart-segment-projection";
import { ORANGE_WANADOO_COHORT } from "../shared/smart-segment";
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
    expect(ids).toEqual([
      "clickers_6plus", "clickers_4plus", "clickers_1plus", "warm_openers", "openers_vertical", "brand_core_refs", "brand_extension_refs",
      "brand_core_refs_lapsed", "vertical_refs_lapsed", "brand_core_refs_dormant", "vertical_refs_dormant",
    ]);
    const withSimilar = buildBlockLibrary({ ...brand, similarRefs: ["4TUI"] }).map((block) => block.id);
    expect(withSimilar).toContain("similar_refs_active");
    expect(withSimilar).toContain("similar_refs_lapsed");
    expect(withSimilar).toContain("similar_refs_dormant");
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

describe("smart segment projection — non-active recency blocks (Task #311)", () => {
  const brandTable = rates([
    ["clicker_tier", "0", 50_000, 400, 25],
    ["ref_relation", "core", 20_000, 300, 10],
    ["family", "in_family", 60_000, 500, 30],
    ["recency", "engaged_60d", 60_000, 700, 20],
  ]);
  const recencyTable = rates([
    ...brandTable.map((rate): [CohortRate["axis"], string, number, number, number] => [rate.axis, rate.cohort, rate.delivered, rate.humanClickers, rate.complaints]),
    ["recency", "opened_61_180d", 5_000, 20, 4],
    ["recency", "dormant_180d", 8_000, 8, 12],
    ["ref_recency", "core|opened_61_180d", 2_000, 12, 3],
    ["ref_recency", "core|dormant_180d", 500, 5, 0], // too thin: falls back to the band marginal
  ]);

  it("never blends a non-active band with the actives: no reliable band means no rate", () => {
    expect(recencyRateFor(brandTable, "opened_61_180d")).toBeNull();
    expect(recencyRateFor(brandTable, "dormant_180d", "core")).toBeNull();
    const cross = recencyRateFor(recencyTable, "opened_61_180d", "core")!;
    expect(cross.cohort).toBe("ref_recency/core|opened_61_180d");
    expect(cross.humanCtr).toBeCloseTo(12 / 2_000);
    const marginal = recencyRateFor(recencyTable, "dormant_180d", "core")!;
    expect(marginal.cohort).toBe("recency/dormant_180d");
    expect(marginal.humanCtr).toBeCloseTo(8 / 8_000);
  });

  it("omits the non-active blocks when their band is not calibrated and projects them on their own cohort otherwise", () => {
    const definitions = buildBlockLibrary({ ...brand, similarRefs: ["4TUI"] });
    const blind = splitProjectableBlocks(definitions, brandTable);
    expect(blind.omitted.map((block) => block.id).sort()).toEqual([
      "brand_core_refs_dormant", "brand_core_refs_lapsed", "similar_refs_dormant", "similar_refs_lapsed", "vertical_refs_dormant", "vertical_refs_lapsed",
    ]);
    expect(blind.projectable.map((block) => block.id)).toContain("similar_refs_active");
    expect(() => projectBlock(definitions.find((d) => d.id === "brand_core_refs_lapsed")!, 1_000, brandTable, "brand", {})).toThrow(/sans cohorte de récence fiable/);

    const sighted = splitProjectableBlocks(definitions, recencyTable);
    expect(sighted.omitted).toEqual([]);
    const lapsed = projectBlock(definitions.find((d) => d.id === "brand_core_refs_lapsed")!, 10_000, recencyTable, "brand", {}, "global");
    // Cross cohort core|lapsed, projected with the recency (global) markups, never the tier-0 rate.
    expect(lapsed.calibration.level).toBe("global");
    expect(lapsed.expectedCtr).toBeCloseTo((12 / 2_000) * CALIBRATION_ADJUSTMENTS.global.discount);
    expect(lapsed.expectedCtr).toBeLessThan(400 / 50_000);
    expect(lapsed.expectedComplaintRate).toBeCloseTo(Math.max(3 / 2_000, 30 / 60_000) * CALIBRATION_ADJUSTMENTS.global.complaintMarkup);
    const dormant = projectBlock(definitions.find((d) => d.id === "brand_core_refs_dormant")!, 10_000, recencyTable, "brand", {});
    expect(dormant.expectedCtr).toBeCloseTo(8 / 8_000);
    expect(dormant.expectedComplaintRate).toBeCloseTo(12 / 8_000);
  });

  it("carves the lapsed and dormant cells out of the 0-click tier of a composition and bounds them by the worst cross cohort", () => {
    const definitions = buildBlockLibrary(brand);
    const blocks = [
      projectBlock(definitions.find((d) => d.id === "brand_core_refs")!, 40_000, recencyTable, "brand", {}),
      projectBlock(definitions.find((d) => d.id === "brand_core_refs_lapsed")!, 10_000, recencyTable, "brand", {}),
    ];
    const measure = { total: 30_000, tierCounts: { "0": 30_000 }, recencyCounts: { engaged_60d: 12_000, opened_61_180d: 10_000, dormant_180d: 8_000 } };
    const projection = projectComposition(measure, ["brand_core_refs", "brand_core_refs_lapsed"], blocks, recencyTable, "brand", "global");
    const cells = Object.fromEntries(projection.tiers.map((cell) => [cell.band ?? cell.tier, cell]));
    expect(cells["0"].count).toBe(12_000);
    expect(cells["0"].ctr).toBeCloseTo(400 / 50_000);
    expect(cells.opened_61_180d.count).toBe(10_000);
    expect(cells.opened_61_180d.ctr).toBeCloseTo((20 / 5_000) * CALIBRATION_ADJUSTMENTS.global.discount);
    // Worst of: band marginal (4/5000), core cross (3/2000), family bound, ref_relation/core.
    expect(cells.opened_61_180d.complaintCohort).toBe("ref_recency/core|opened_61_180d");
    expect(cells.opened_61_180d.complaintRate).toBeCloseTo((3 / 2_000) * CALIBRATION_ADJUSTMENTS.global.complaintMarkup);
    expect(cells.dormant_180d.count).toBe(8_000);
    expect(cells.dormant_180d.complaintCohort).toBe("recency/dormant_180d");
    expect(projection.unattributedCount).toBe(0);

    // Without any reliable recency cohort the non-active contacts are still
    // carved out — at a zero CTR and the worst complaint rate measured anywhere.
    const blind = projectComposition(measure, ["brand_core_refs"], blocks, brandTable, "brand");
    const blindCells = Object.fromEntries(blind.tiers.map((cell) => [cell.band ?? cell.tier, cell]));
    expect(blindCells["0"].count).toBe(12_000);
    expect(blindCells.opened_61_180d.ctr).toBe(0);
    expect(blindCells.dormant_180d.ctr).toBe(0);
    const worstAnywhere = Math.max(...brandTable.map((rate) => rate.complaintRate));
    expect(blindCells.dormant_180d.complaintRate).toBeCloseTo(worstAnywhere * CALIBRATION_ADJUSTMENTS.brand.complaintMarkup);
    expect(blind.projectedClicks.high).toBeLessThan(projection.projectedClicks.high);
  });

  it("projects a carved cell at the lowest reliable CTR among the band marginal and the implicated crosses", () => {
    const table = rates([
      ["clicker_tier", "0", 50_000, 400, 25],
      ["ref_relation", "core", 20_000, 300, 10],
      ["family", "in_family", 60_000, 500, 30],
      ["recency", "opened_61_180d", 5_000, 50, 4],
      ["ref_recency", "core|opened_61_180d", 2_000, 4, 1], // lower CTR than the marginal
    ]);
    const definitions = buildBlockLibrary(brand);
    const blocks = [projectBlock(definitions.find((d) => d.id === "brand_core_refs")!, 40_000, table, "brand", {})];
    const measure = { total: 10_000, tierCounts: { "0": 10_000 }, recencyCounts: { engaged_60d: 5_000, opened_61_180d: 5_000, dormant_180d: 0 } };
    const projection = projectComposition(measure, ["brand_core_refs"], blocks, table, "brand");
    const lapsed = projection.tiers.find((cell) => cell.band === "opened_61_180d")!;
    expect(lapsed.ctr).toBeCloseTo(4 / 2_000);
    // Complaints: the cross has ONE complaint among 2,000 → rule of three
    // (3 / 2,000 = 0,15 %) beats the marginal's measured 4 / 5,000 = 0,08 %.
    expect(lapsed.complaintCohort).toBe("ref_recency/core|opened_61_180d");
    expect(lapsed.complaintRate).toBeCloseTo((3 / 2_000) * CALIBRATION_ADJUSTMENTS.brand.complaintMarkup);
  });
});

describe("smart segment projection — complaint calibration (rule of three, MTA capture, floor)", () => {
  it("bounds thin cohorts by the rule of three and never lowers a measured rate", () => {
    expect(ruleOfThreeRate(0, 10_000)).toBeCloseTo(3 / 10_000);
    expect(ruleOfThreeRate(2 / 10_000, 10_000)).toBeCloseTo(3 / 10_000);
    expect(ruleOfThreeRate(5 / 10_000, 10_000)).toBeCloseTo(5 / 10_000);
    expect(ruleOfThreeRate(0.001, 0)).toBe(0.001);
    // Bound is computed on the OBSERVED rows of a sampled cohort, not the rescaled ones.
    const table = aggregateCohortRates([
      { axis: "clicker_tier", cohort: "6+", delivered: 40_000, humanClickers: 4_000, botClickers: 0, complaints: 0, observed: 4_000 },
      { axis: "clicker_tier", cohort: "1", delivered: 40_000, humanClickers: 400, botClickers: 0, complaints: 80, observed: 4_000 },
    ]);
    expect(table.find((row) => row.cohort === "6+")!.complaintRateBound).toBeCloseTo(3 / 4_000);
    expect(table.find((row) => row.cohort === "1")!.complaintRateBound).toBeCloseTo(80 / 40_000);
  });

  it("classifies an MTA's complaint capture on its own 90-day history only once it delivered enough", () => {
    expect(classifyMtaComplaintCapture(MTA_CAPTURE_MIN_DELIVERED - 1, 0)).toBe("unknown");
    expect(classifyMtaComplaintCapture(5_000_000, 0)).toBe("blind");
    expect(classifyMtaComplaintCapture(5_000_000, 400)).toBe("blind"); // 0,008 % < 0,01 %
    expect(classifyMtaComplaintCapture(5_000_000, 600)).toBe("capturing");
  });

  it("applies the baseline floor to every cell (including the cohort bound of Orange/Wanadoo) when the calibration is blind", () => {
    const table = rates([
      ["clicker_tier", "6+", 20_000, 2_400, 0],
      ["clicker_tier", "0", 100_000, 500, 0],
      ["ref_relation", "core", 120_000, 2_900, 0],
      ["family", "in_family", 120_000, 2_900, 0],
      ["domain_group", ORANGE_WANADOO_COHORT, 30_000, 600, 0],
      ["domain_group", "other", 90_000, 2_300, 0],
    ]);
    const definitions = buildBlockLibrary(brand);
    const blocks = [projectBlock(definitions.find((d) => d.id === "clickers_6plus")!, 20_000, table, "brand", {})];
    const measure = { total: 10_000, tierCounts: { "6+": 10_000 }, recencyCounts: {}, orangeWanadooCount: 2_500 };
    const unfloored = projectComposition(measure, ["clickers_6plus"], blocks, table, "brand");
    // Blind history: 0 complaints everywhere → the rule of three alone (3 / 20,000 on the tier).
    expect(unfloored.tiers[0].complaintRate).toBeCloseTo((3 / 20_000) * CALIBRATION_ADJUSTMENTS.brand.complaintMarkup);
    const floored = projectComposition(measure, ["clickers_6plus"], blocks, table, "brand", "brand", { complaintFloor: 0.002 });
    expect(floored.tiers[0].complaintCohort).toBe(COMPLAINT_FLOOR_COHORT);
    expect(floored.tiers[0].complaintRate).toBeCloseTo(0.002 * CALIBRATION_ADJUSTMENTS.brand.complaintMarkup);
    expect(floored.projectedComplaintRate).toBeCloseTo(0.002 * CALIBRATION_ADJUSTMENTS.brand.complaintMarkup);
    expect(floored.projectedComplaints).toBe(Math.round(10_000 * 0.002 * CALIBRATION_ADJUSTMENTS.brand.complaintMarkup));
    expect(floored.orangeWanadoo).toMatchObject({ count: 2_500, share: 0.25, cohortReliable: true });
    expect(floored.orangeWanadoo!.projectedComplaintRate).toBeCloseTo(0.002 * CALIBRATION_ADJUSTMENTS.brand.complaintMarkup);
  });

  it("projects unsubscribes from the cells' cohorts and Orange/Wanadoo at the worst of the audience and its cohort", () => {
    const table = aggregateCohortRates([
      { axis: "clicker_tier", cohort: "6+", delivered: 20_000, humanClickers: 2_400, botClickers: 0, complaints: 10, unsubscribes: 100 },
      { axis: "clicker_tier", cohort: "1", delivered: 50_000, humanClickers: 1_000, botClickers: 0, complaints: 50, unsubscribes: 500 },
      { axis: "clicker_tier", cohort: "0", delivered: 100_000, humanClickers: 500, botClickers: 0, complaints: 60, unsubscribes: 800 },
      { axis: "ref_relation", cohort: "core", delivered: 170_000, humanClickers: 3_900, botClickers: 0, complaints: 120, unsubscribes: 1_400 },
      { axis: "family", cohort: "in_family", delivered: 170_000, humanClickers: 3_900, botClickers: 0, complaints: 120, unsubscribes: 1_400 },
      { axis: "domain_group", cohort: ORANGE_WANADOO_COHORT, delivered: 40_000, humanClickers: 800, botClickers: 0, complaints: 200, unsubscribes: 400 },
      { axis: "domain_group", cohort: "other", delivered: 130_000, humanClickers: 3_100, botClickers: 0, complaints: 20, unsubscribes: 1_000 },
    ]);
    const definitions = buildBlockLibrary(brand);
    const blocks = [projectBlock(definitions.find((d) => d.id === "clickers_1plus")!, 70_000, table, "brand", {})];
    const measure = { total: 10_000, tierCounts: { "6+": 4_000, "1": 6_000 }, recencyCounts: {}, orangeWanadooCount: 3_000 };
    const projection = projectComposition(measure, ["clickers_1plus"], blocks, table, "brand");
    // Unsubscribes: 4,000 × 0,5 % + 6,000 × 1 % = 80 → 0,8 %.
    expect(projection.projectedUnsubscribeRate).toBeCloseTo(0.008);
    expect(projection.projectedUnsubscribes).toBe(80);
    // Orange/Wanadoo: the cohort's 0,5 % (marked up) is worse than the audience's own projection.
    const markup = CALIBRATION_ADJUSTMENTS.brand.complaintMarkup;
    expect(projection.orangeWanadoo).toMatchObject({ count: 3_000, share: 0.3, cohortReliable: true });
    expect(projection.orangeWanadoo!.projectedComplaintRate).toBeCloseTo(0.005 * markup);
    expect(projection.orangeWanadoo!.projectedComplaints).toBe(Math.round(3_000 * 0.005 * markup));
    expect(projection.orangeWanadoo!.status).toBe(orangeWanadooStatus(0.005 * markup, 3_000));
    expect(projection.orangeWanadoo!.projectedComplaintRate).toBeGreaterThan(projection.projectedComplaintRate);
    // Thresholds of the campaign-list badge; no recipient → unknown.
    expect(orangeWanadooStatus(0.0039, 10)).toBe("green");
    expect(orangeWanadooStatus(0.006, 10)).toBe("orange");
    expect(orangeWanadooStatus(0.0061, 10)).toBe("red");
    expect(orangeWanadooStatus(0.01, 0)).toBe("unknown");
    // A thin Orange/Wanadoo cohort is not trusted: the audience's own rate applies.
    const thin = aggregateCohortRates(table.map((row) => (row.axis === "domain_group" ? { ...row, delivered: 500, observed: 500, complaints: 5 } : row)) as never);
    const thinProjection = projectComposition(measure, ["clickers_1plus"], blocks, thin, "brand");
    expect(thinProjection.orangeWanadoo).toMatchObject({ cohortReliable: false, projectedComplaintRate: thinProjection.projectedComplaintRate });
    // Dossiers without the Orange/Wanadoo axis or without the count carry no projection.
    expect(projectComposition({ total: 10_000, tierCounts: { "6+": 10_000 } }, ["clickers_1plus"], blocks, table, "brand").orangeWanadoo).toBeNull();
    expect(projection.tiers.every((cell) => cell.unsubscribeRate !== null)).toBe(true);
    const noUnsub = projectComposition(measure, ["clickers_1plus"], blocks, rates([["clicker_tier", "6+", 20_000, 2_400, 10], ["clicker_tier", "1", 50_000, 1_000, 50], ["family", "in_family", 70_000, 3_400, 60]]), "brand");
    expect(noUnsub.projectedUnsubscribeRate).toBeNull();
    expect(noUnsub.projectedUnsubscribes).toBeNull();
  });

  it("judges the reliability of a recency band on observed recipients, not on the re-scaled effectives", () => {
    const sampled = aggregateCohortRates([
      { axis: "recency", cohort: "dormant_180d", delivered: 20 * 50, humanClickers: 0, botClickers: 0, complaints: 0, observed: 20 },
      { axis: "recency", cohort: "opened_61_180d", delivered: 600 * 2, humanClickers: 10, botClickers: 0, complaints: 2, observed: 600 },
      { axis: "recency", cohort: "opened_61_180d", delivered: 500 * 2, humanClickers: 8, botClickers: 0, complaints: 1, observed: 500 },
    ]);
    expect(recencyRateFor(sampled, "dormant_180d")).toBeNull();
    const lapsed = recencyRateFor(sampled, "opened_61_180d")!;
    expect(lapsed.delivered).toBe(2_200);
    expect(sampled.find((rate) => rate.cohort === "opened_61_180d")?.observed).toBe(1_100);
    // Rows without an observed count (exact measurements) keep the delivered gate.
    expect(recencyRateFor(rates([["recency", "dormant_180d", 1_000, 1, 1]]), "dormant_180d")).not.toBeNull();
  });

  it("bounds a non-active ref block — alone in a composition — by its ref relation's complaint history, not only by the recency cohort", () => {
    const risky = rates([
      ["clicker_tier", "0", 50_000, 400, 25],
      ["ref_relation", "core", 20_000, 300, 160], // 0.8 % — above any cap
      ["family", "in_family", 60_000, 500, 30],
      ["recency", "opened_61_180d", 5_000, 20, 1], // 0.02 % — deceptively clean
    ]);
    const definitions = buildBlockLibrary(brand);
    const lapsedDefinition = definitions.find((d) => d.id === "brand_core_refs_lapsed")!;
    const block = projectBlock(lapsedDefinition, 10_000, risky, "brand", {});
    expect(block.expectedComplaintRate).toBeCloseTo(160 / 20_000);
    const measure = { total: 10_000, tierCounts: { "0": 10_000 }, recencyCounts: { opened_61_180d: 10_000 } };
    const projection = projectComposition(measure, ["brand_core_refs_lapsed"], [block], risky, "brand");
    expect(projection.refCohortsApplied).toEqual(["core"]);
    expect(projection.tiers).toHaveLength(1);
    expect(projection.tiers[0].complaintCohort).toBe("ref_relation/core");
    expect(projection.projectedComplaintRate).toBeCloseTo(160 / 20_000);
    expect(exceedsComplaintCap(projection.projectedComplaintRate, 0.006)).toBe(true);
  });
});
