import { describe, expect, it, vi } from "vitest";

vi.mock("../server/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
const poolConnect = vi.fn();
vi.mock("../server/db", () => ({ pool: { connect: (...args: unknown[]) => poolConnect(...args) }, db: {}, getPoolSaturation: () => 0 }));

const historyCandidates = vi.fn();
vi.mock("../server/repositories/campaign-repository", () => ({
  getSegmentPerformanceHistoryCandidates: (...args: unknown[]) => historyCandidates(...args),
}));

import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SmartSegmentBrandResolution, SmartSegmentStage } from "../shared/smart-segment";
import {
  buildSmartSegmentEvidence,
  isFinishedSend,
  measureAudienceWith,
  SmartSegmentError,
  createTransactionRunner,
  preferCapturingCandidates,
  RECENCY_TIMEOUT_SAMPLE_SCALE,
  type EvidenceQueryRunner,
} from "../server/services/smart-segment-evidence";
import type { SegmentRulesV2 } from "../shared/schema";
import { getSmartSegmentConfig } from "../server/config/smart-segment";

const dialect = new PgDialect();

const brand: SmartSegmentBrandResolution = {
  detected: true,
  source: "directory",
  brandName: "Air France",
  coreRefs: ["4AF"],
  extensionRefs: ["US4AF", "E4AF"],
  unsubscribeTags: ["U4AF", "UUS4AF"],
  vertical: "4",
  verticalLabel: "Voyage",
  verticalRefs: ["4TUI"],
  matchedKeys: ["air\u001ffrance"],
};

type Recorded = { label: string; text: string; params: unknown[] };

function statsRow(id: string, name: string, sentCount: number, deliveredRows: number, status = "completed", mta: { id: string; name: string } | null = null) {
  return {
    id, name, status, first_send_at: "2026-09-01T08:00:00.000Z",
    sent_count: String(sentCount), complaints_count: "90", unsubscribes_count: "40",
    delivered_rows: String(deliveredRows), clickers: "2700", bot_clickers: "300",
    mta_id: mta?.id ?? null, mta_name: mta?.name ?? null,
  };
}

function cohortRows(scale = 1) {
  return [
    { axis: "clicker_tier", cohort: "0", delivered: String(100_000 / scale), human_clickers: String(500 / scale), bot_clickers: "0", complaints: String(60 / scale) },
    { axis: "clicker_tier", cohort: "6+", delivered: String(4_000 / scale), human_clickers: String(480 / scale), bot_clickers: "0", complaints: String(2 / scale) },
    { axis: "ref_relation", cohort: "core", delivered: String(104_000 / scale), human_clickers: String(980 / scale), bot_clickers: "0", complaints: String(62 / scale) },
  ];
}

function fakeRunner(handlers: {
  stats?: (ids: string[], label: string) => unknown[];
  recent?: () => unknown[];
  fallback?: () => unknown[];
  verticalBrands?: () => unknown[];
  cohorts?: (campaignId: string, divisor: number) => unknown[];
  tiers?: () => unknown[];
  recency?: (campaignId: string, divisor: number, label: string) => unknown[];
  recencyPool?: () => unknown[];
  recencyMix?: () => unknown[];
  mtaCapture?: () => unknown[];
  floor?: (params: unknown[]) => unknown[];
  brandMtas?: (ids: string[]) => unknown[];
  count?: (sql: string, label: string) => number;
}) {
  const recorded: Recorded[] = [];
  const counts: string[] = [];
  const runner: EvidenceQueryRunner = {
    async query(label, text, params = []) {
      recorded.push({ label, text, params });
      // PostgreSQL rejects a statement that binds a parameter it never
      // references ("could not determine data type of parameter $n"), and a
      // reference beyond the bound list fails at bind time: check both here,
      // since the SQL text is otherwise only exercised against a real database.
      const referenced = new Set([...text.matchAll(/\$(\d+)/g)].map((match) => Number(match[1])));
      for (let index = 1; index <= params.length; index++) {
        if (!referenced.has(index)) throw new Error(`query « ${label} » binds ${index} but never references it`);
      }
      const beyond = [...referenced].filter((index) => index > params.length);
      if (beyond.length) throw new Error(`query « ${label} » references ${beyond[0]} beyond its ${params.length} params`);
      if (label === "envois récents toutes marques (récence)") return (handlers.recencyPool?.() ?? []) as never;
      if (label === "capture des plaintes par MTA") return (handlers.mtaCapture?.() ?? []) as never;
      if (label === "envois via MTA remontant les plaintes (plancher)") return (handlers.floor?.(params) ?? []) as never;
      if (label === "MTA des envois de la marque") return (handlers.brandMtas?.(params[0] as string[]) ?? []) as never;
      if (text.includes("AS delivered_rows")) return (handlers.stats?.(params[0] as string[], label) ?? []) as never;
      if (label === "envois récents de la marque") return (handlers.recent?.() ?? []) as never;
      if (label === "candidats de repli") return (handlers.fallback?.() ?? []) as never;
      if (label === "marques de la verticale") return (handlers.verticalBrands?.() ?? []) as never;
      if (label.startsWith("cohortes")) return (handlers.cohorts?.(params[0] as string, params[5] as number) ?? []) as never;
      if (label === "répartition des cliqueurs disponibles") return (handlers.tiers?.() ?? []) as never;
      if (label.startsWith("récence")) return (handlers.recency?.(params[0] as string, params[4] as number, label) ?? []) as never;
      if (label.startsWith("répartition par récence")) return (handlers.recencyMix?.() ?? []) as never;
      if (label === "noms des marques similaires") return [] as never;
      throw new Error(`unexpected query ${label}`);
    },
    async queryCount(label, statement: SQL) {
      const compiled = dialect.sqlToQuery(statement);
      counts.push(`${label}::${compiled.sql}`);
      return handlers.count?.(compiled.sql, label) ?? 1_000;
    },
    elapsedMs: () => 42,
    queries: () => recorded.length,
  };
  return { runner, recorded, counts };
}

const config = { ...getSmartSegmentConfig(), cohortSampleTarget: 250_000, recentBrandSendDays: 30 };

describe("isFinishedSend", () => {
  it("requires a completed status and a delivery counter that rejoined the send rows", () => {
    expect(isFinishedSend("completed", 100_000, 100_000)).toBe(true);
    expect(isFinishedSend("completed", 100_000, 99_850)).toBe(true); // within 0.2 %
    expect(isFinishedSend("completed", 100_000, 99_000)).toBe(false);
    expect(isFinishedSend("sending", 100_000, 100_000)).toBe(false);
    expect(isFinishedSend("completed", 3, 5)).toBe(true); // absolute tolerance for tiny sends
    expect(isFinishedSend("completed", 0, 0)).toBe(false);
  });
});

describe("buildSmartSegmentEvidence", () => {
  it("calibrates on the brand's finished sends, scales sampled cohorts and sizes every block after exclusions", async () => {
    historyCandidates.mockResolvedValueOnce([
      { campaignId: "camp-a", segmentName: "FR - Cliqueurs" },
      { campaignId: "camp-a", segmentName: "FR - Ouvreurs" },
      { campaignId: "camp-b", segmentName: "FR - Warm" },
    ]);
    const { runner, recorded, counts } = fakeRunner({
      stats: (ids) => ids.map((id) => id === "camp-a" ? statsRow(id, "Air France 01/09", 1_000_000, 1_000_000) : statsRow(id, "Air France 20/08", 120_000, 100_000)),
      recent: () => [
        { id: "camp-live", name: "Air France 19/09" },
        { id: "camp-other", name: "Air Caraïbes 19/09" },
        ...Array.from({ length: 8 }, (_, i) => ({ id: `camp-older-${i}`, name: `Air France ${18 - i}/09` })),
      ],
      cohorts: (campaignId, divisor) => (campaignId === "camp-a" ? cohortRows(divisor) : []),
      tiers: () => [{ tier: "6+", count: "3000" }, { tier: "1", count: "9000" }],
      count: (_sql, label) => (label.includes("très actifs") ? 3_000 : 20_000),
    });
    const stages: Array<[SmartSegmentStage, number]> = [];
    const evidence = await buildSmartSegmentEvidence(
      { campaignName: "Air France 21/09", excludeCampaignId: "camp-new", brand, family: "fai_fr" },
      (stage, progress) => { stages.push([stage, progress]); },
      { config, runner },
    );

    expect(historyCandidates).toHaveBeenCalledWith(expect.arrayContaining(["air\u001ffrance"]), "camp-new");
    // camp-b is not finished (120k counter vs 100k rows) → excluded from calibration but shown.
    expect(evidence.calibrationLevel).toBe("brand");
    expect(evidence.calibrationCampaignIds).toEqual(["camp-a"]);
    expect(evidence.brandSends.map((send) => [send.campaignId, send.finished, send.usedForCalibration])).toEqual([
      ["camp-a", true, true],
      ["camp-b", false, false],
    ]);
    expect(evidence.brandSends[0].humanClickers).toBe(2_400);
    // Only the brand's own recent sends are excluded (not the other advertiser
    // matched by ILIKE), and only the six NEWEST of them (rows arrive newest first).
    expect(evidence.recentBrandCampaignIds).toEqual(["camp-live", "camp-older-0", "camp-older-1", "camp-older-2", "camp-older-3", "camp-older-4"]);
    expect(evidence.campaignNames["camp-live"]).toBe("Air France 19/09");
    // 1,000,000 recipients → sampled 1/4 and rescaled.
    expect(evidence.budget.sampledCampaigns).toEqual([{ campaignId: "camp-a", divisor: 4 }]);
    const tier6 = evidence.cohortRates.find((rate) => rate.axis === "clicker_tier" && rate.cohort === "6+")!;
    expect(tier6.delivered).toBe(4_000);
    expect(tier6.humanCtr).toBeCloseTo(0.12);
    // Every block was counted with the mandatory exclusions compiled in.
    expect(evidence.blocks.map((block) => block.id)).toEqual(["clickers_6plus", "clickers_4plus", "clickers_1plus", "warm_openers", "openers_vertical", "brand_core_refs", "brand_extension_refs"]);
    expect(counts).toHaveLength(evidence.blocks.length);
    for (const entry of counts) {
      expect(entry).toContain("NOT IN (");
      expect(entry.toLowerCase()).toContain("campaign_sends");
    }
    expect(evidence.blocks[0].available).toBe(3_000);
    expect(evidence.blocks[0].projectedClicks.high).toBe(Math.round(3_000 * 0.12 * 1.15));
    expect(evidence.mandatoryExclusions).toContain("Exclusion du tag de désabonnement U4AF");
    // The tier-mix query embeds the compiled exclusion fragment with its bound params.
    const tierQuery = recorded.find((entry) => entry.label === "répartition des cliqueurs disponibles")!;
    expect(tierQuery.text).toContain("$1");
    expect(tierQuery.params.length).toBeGreaterThan(0);
    expect(tierQuery.text).toContain("suppressed_until");
    expect(stages[0]).toEqual(["brand_history", 5]);
    expect(stages.at(-1)![0]).toBe("reservoirs");
    expect(evidence.budget.queries).toBe(recorded.length);
  });

  it("calibrates the non-active bands on the finished sends of every brand when the brand's own sends reach too few of them", async () => {
    historyCandidates.mockResolvedValueOnce([{ campaignId: "camp-a", segmentName: "FR - Cliqueurs" }]);
    const recencyRow = (axis: string, cohort: string, delivered: number, clickers: number, complaints: number) =>
      ({ axis, cohort, delivered: String(delivered), human_clickers: String(clickers), bot_clickers: "0", complaints: String(complaints) });
    const { runner, recorded } = fakeRunner({
      stats: (ids) => ids.map((id) => statsRow(id, "Air France 01/09", 50_000, 50_000)),
      cohorts: (campaignId, divisor) => (campaignId === "camp-a" ? cohortRows(divisor) : []),
      // The brand's send is engagement-filtered: 30 lapsed / 10 dormant recipients only.
      recency: (campaignId) => campaignId === "camp-a"
        ? [recencyRow("recency", "engaged_60d", 49_000, 500, 20), recencyRow("recency", "opened_61_180d", 30, 0, 0), recencyRow("recency", "dormant_180d", 10, 0, 0)]
        : campaignId === "pool-ok"
          // Pool send of 600,000 recipients sampled 1/30 → 40 observed dormant rows are NOT 1,200 reliable ones.
          ? [recencyRow("recency", "engaged_60d", 15_000, 100, 5), recencyRow("recency", "opened_61_180d", 3_000, 6, 3), recencyRow("recency", "dormant_180d", 40, 0, 0),
             recencyRow("ref_recency", "none|opened_61_180d", 2_900, 6, 3)]
          : (() => { throw new Error(`unexpected recency query for ${campaignId}`); })(),
      recencyPool: () => [
        { id: "pool-live", name: "Autre 20/09", status: "completed", first_send_at: "2026-09-20T08:00:00.000Z", sent_count: "400000", delivered_rows: "350000" }, // counter not converged
        { id: "pool-ok", name: "Autre 15/09", status: "completed", first_send_at: "2026-09-15T08:00:00.000Z", sent_count: "600000", delivered_rows: "600000" },
      ],
      tiers: () => [{ tier: "1", count: "9000" }],
      recencyMix: () => [],
    });
    const evidence = await buildSmartSegmentEvidence(
      { campaignName: "Air France 21/09", excludeCampaignId: "camp-new", brand, family: "fai_fr" },
      async () => {},
      { config: { ...config, recencyPoolSampleTarget: 20_000, recencyPoolMaxCampaigns: 12 }, runner },
    );
    // Only the converged pool send was measured (with the pool sample target), never the live one.
    const recencyQueries = recorded.filter((entry) => entry.label.startsWith("récence"));
    expect(recencyQueries.map((entry) => entry.params[0])).toEqual(["camp-a", "pool-ok"]);
    expect(recencyQueries[1].params[4]).toBe(30);
    expect(evidence.recencyCalibration).toEqual({ level: "global", campaignIds: ["pool-ok"] });
    expect(evidence.campaignNames["pool-ok"]).toBe("Autre 15/09");
    // Lapsed band: 3,000 observed → reliable, rescaled ×30; dormant: 40 observed → not reliable although 1,200 once rescaled.
    const lapsed = evidence.cohortRates.find((rate) => rate.axis === "recency" && rate.cohort === "opened_61_180d")!;
    expect(lapsed.delivered).toBe(90_000);
    expect(lapsed.observed).toBe(3_000);
    const dormant = evidence.cohortRates.find((rate) => rate.axis === "recency" && rate.cohort === "dormant_180d")!;
    expect(dormant.delivered).toBe(1_200);
    expect(dormant.observed).toBe(40);
    // Lapsed blocks are offered with the global markups; dormant blocks are omitted, never projected at the actives' rates.
    const lapsedBlock = evidence.blocks.find((block) => block.id === "brand_core_refs_lapsed")!;
    expect(lapsedBlock.calibration.level).toBe("global");
    expect(lapsedBlock.expectedCtr).toBeCloseTo((6 / 3_000) * 0.65);
    expect(evidence.blocks.some((block) => block.id.endsWith("_dormant"))).toBe(false);
    expect(evidence.omittedBlocks?.map((block) => block.id)).toEqual(["brand_core_refs_dormant", "vertical_refs_dormant"]);
    expect(evidence.notes.some((note) => note.includes("repli global"))).toBe(true);
  });

  it("falls back to the vertical, then to all brands, and fails explicitly without any finished send", async () => {
    historyCandidates.mockResolvedValue([]);
    const vertical = fakeRunner({
      stats: (ids) => ids.map((id) => statsRow(id, id === "camp-v" ? "TUI 10/09" : "Autre 10/09", 50_000, 50_000)),
      fallback: () => [{ id: "camp-v", name: "TUI 10/09" }, { id: "camp-g", name: "Autre 10/09" }],
      verticalBrands: () => [{ name: "TUI" }],
      cohorts: () => cohortRows(),
      tiers: () => [],
    });
    const verticalEvidence = await buildSmartSegmentEvidence(
      { campaignName: "Nouvelle Marque 21/09", excludeCampaignId: null, brand, family: "fai_fr" },
      () => {},
      { config, runner: vertical.runner },
    );
    expect(verticalEvidence.calibrationLevel).toBe("vertical");
    expect(verticalEvidence.calibrationCampaignIds).toEqual(["camp-v"]);
    expect(verticalEvidence.blocks[0].calibration.discount).toBe(0.8);
    expect(verticalEvidence.notes.join(" ")).toContain("verticale");

    const global = fakeRunner({
      stats: (ids) => ids.map((id) => statsRow(id, "Autre 10/09", 50_000, 50_000)),
      fallback: () => [{ id: "camp-g", name: "Autre 10/09" }],
      verticalBrands: () => [],
      cohorts: () => cohortRows(),
      tiers: () => [],
    });
    const globalEvidence = await buildSmartSegmentEvidence(
      { campaignName: "Nouvelle Marque 21/09", excludeCampaignId: null, brand, family: "fai_fr" },
      () => {},
      { config, runner: global.runner },
    );
    expect(globalEvidence.calibrationLevel).toBe("global");
    expect(globalEvidence.blocks[0].calibration.complaintMarkup).toBe(1.5);

    const none = fakeRunner({ stats: (ids) => ids.map((id) => statsRow(id, "Autre", 50_000, 10_000)), fallback: () => [{ id: "camp-x", name: "Autre" }] });
    await expect(buildSmartSegmentEvidence(
      { campaignName: "Nouvelle Marque 21/09", excludeCampaignId: null, brand, family: "fai_fr" },
      () => {},
      { config, runner: none.runner },
    )).rejects.toMatchObject({ code: "NO_CALIBRATION", status: 422 });
  });

  it("measures a composition as total + clicker-tier partition from one runner, with non-clickers as the remainder", async () => {
    const seen: Array<{ label: string; sql: string; params?: unknown[] }> = [];
    const runner: EvidenceQueryRunner = {
      query: async (label, text, params) => {
        seen.push({ label, sql: text, params });
        return [{ tier: "6+", count: "300" }, { tier: "1", count: "700" }] as never;
      },
      queryCount: async (label, statement) => {
        seen.push({ label, sql: dialect.sqlToQuery(statement).sql });
        return 1_500;
      },
      elapsedMs: () => 0,
      queries: () => 0,
    };
    const rules: SegmentRulesV2 = {
      version: 2,
      root: { type: "group", combinator: "AND", children: [
        { type: "condition", field: "refs", operator: "has_ref", value: "4AF" },
        { type: "condition", field: "tags", operator: "not_has_tag", value: "U4AF" },
      ] },
    };
    const measure = await measureAudienceWith(runner, rules);
    expect(measure).toEqual({ total: 1_500, tierCounts: { "6+": 300, "1": 700, "0": 500 }, recencyCounts: {}, orangeWanadooCount: 0 });
    expect(seen).toHaveLength(3);
    // All statements apply the same base filters (BCK tag, suppression) and
    // the same compiled rules, so each partition is a partition of the total.
    for (const statement of seen) {
      expect(statement.sql).toContain("'BCK' = ANY(");
      expect(statement.sql).toContain("suppressed_until");
    }
    expect(seen[1].sql).toContain("COUNT(DISTINCT st.campaign_id)");
    expect(seen[1].params).toEqual(expect.arrayContaining(["4AF", "U4AF"]));
    // Recency bands follow the live last_engaged_at, like the engagement operators.
    expect(seen[2].sql).toContain("last_engaged_at >= NOW() - INTERVAL '60 days'");
    expect(seen[2].sql).toContain("INTERVAL '180 days'");
    expect(seen[2].params).toEqual(expect.arrayContaining(["4AF", "U4AF"]));
    // The recency partition also counts the Orange/Wanadoo recipients of each band.
    expect(seen[2].sql).toContain("AS orange_wanadoo");
    expect(seen[2].sql).toContain("'orange.fr'");
    // Empty audience: no tier query at all.
    const empty = await measureAudienceWith({ ...runner, queryCount: async () => 0 }, rules);
    expect(empty).toEqual({ total: 0, tierCounts: {}, orangeWanadooCount: 0 });
  });

  it("sums the Orange/Wanadoo recipients across the recency bands", async () => {
    const runner: EvidenceQueryRunner = {
      query: async (label) => (label.startsWith("répartition par récence")
        ? [{ band: "engaged_60d", count: "900", orange_wanadoo: "300" }, { band: "dormant_180d", count: "100", orange_wanadoo: "50" }]
        : [{ tier: "1", count: "400" }]) as never,
      queryCount: async () => 1_000,
      elapsedMs: () => 0,
      queries: () => 0,
    };
    const rules: SegmentRulesV2 = { version: 2, root: { type: "group", combinator: "AND", children: [{ type: "condition", field: "refs", operator: "has_ref", value: "4AF" }] } };
    await expect(measureAudienceWith(runner, rules)).resolves.toEqual({
      total: 1_000,
      tierCounts: { "1": 400, "0": 600 },
      recencyCounts: { engaged_60d: 900, dormant_180d: 100 },
      orangeWanadooCount: 350,
    });
  });

  it("keeps blind-MTA sends out of the complaint calibration when a capturing send exists, and floors everything when none does", async () => {
    const kammaspeed = { id: "mta-k", name: "Kammaspeed" };
    const powermta = { id: "mta-p", name: "PowerMTA" };
    // 90-day capture: Kammaspeed reported 2 complaints on 8 M (blind), PowerMTA 3,000 on 2 M (capturing).
    const mtaCapture = () => [
      { mta_id: "mta-k", mta_name: "Kammaspeed", delivered: "8000000", complaints: "2" },
      { mta_id: "mta-p", mta_name: "PowerMTA", delivered: "2000000", complaints: "3000" },
      { mta_id: "mta-new", mta_name: "Nouveau", delivered: "50000", complaints: "0" }, // too little history: unknown
    ];
    historyCandidates.mockResolvedValueOnce([
      { campaignId: "camp-k", segmentName: "FR - Cliqueurs" },
      { campaignId: "camp-p", segmentName: "FR - Cliqueurs" },
    ]);
    const mixed = fakeRunner({
      mtaCapture,
      stats: (ids) => ids.map((id) => (id === "camp-k" ? statsRow(id, "Air France 15/09", 200_000, 200_000, "completed", kammaspeed) : statsRow(id, "Air France 01/09", 50_000, 50_000, "completed", powermta))),
      cohorts: (campaignId, divisor) => (campaignId === "camp-p" ? cohortRows(divisor) : (() => { throw new Error(`blind send ${campaignId} must not be sampled`); })()),
      tiers: () => [],
    });
    const evidence = await buildSmartSegmentEvidence(
      { campaignName: "Air France 21/09", excludeCampaignId: "camp-new", brand, family: "fai_fr", mtaId: "mta-k" },
      () => {},
      { config, runner: mixed.runner },
    );
    // The bigger, more recent Kammaspeed send is shown but never calibrates complaints.
    expect(evidence.calibrationCampaignIds).toEqual(["camp-p"]);
    expect(evidence.brandSends.map((send) => [send.campaignId, send.mtaName, send.mtaComplaintCapture, send.usedForCalibration])).toEqual([
      ["camp-k", "Kammaspeed", "blind", false],
      ["camp-p", "PowerMTA", "capturing", true],
    ]);
    expect(evidence.complaintFloor ?? null).toBeNull();
    expect(evidence.mta).toMatchObject({ id: "mta-k", name: "Kammaspeed", capture: "blind", observedDelivered: 8_000_000, calibrationSendsOnMta: 0 });
    expect(evidence.notes.join(" ")).toContain("écarté(s) du calibrage");
    expect(evidence.notes.join(" ")).toContain("ne seront pas visibles dans les compteurs");
    expect(mixed.recorded.some((entry) => entry.label === "envois via MTA remontant les plaintes (plancher)")).toBe(false);
    expect(evidence.baselines).toMatchObject({ level: "brand" });

    // Only blind sends: they still calibrate the CTR, and the brand's sends on
    // capturing MTAs (180 d, cached counters) floor every complaint projection.
    historyCandidates.mockResolvedValueOnce([{ campaignId: "camp-k", segmentName: "FR - Cliqueurs" }]);
    const blindOnly = fakeRunner({
      mtaCapture,
      stats: (ids) => ids.map((id) => statsRow(id, "Air France 15/09", 200_000, 200_000, "completed", kammaspeed)),
      floor: (params) => {
        expect(params).toEqual([180, 5_000, "camp-new", ["mta-p"]]);
        return [
          { id: "camp-old-1", name: "Air France 10/06", mta_id: "mta-p", sent_count: "100000", complaints_count: "150" },
          { id: "camp-old-2", name: "Air France 20/05", mta_id: "mta-p", sent_count: "100000", complaints_count: "250" },
          { id: "camp-other", name: "Autre 01/06", mta_id: "mta-p", sent_count: "100000", complaints_count: "900" }, // another brand: ignored at brand level
        ];
      },
      cohorts: (campaignId, divisor) => (campaignId === "camp-k" ? cohortRows(divisor) : []),
      tiers: () => [{ tier: "6+", count: "3000" }],
    });
    const floored = await buildSmartSegmentEvidence(
      { campaignName: "Air France 21/09", excludeCampaignId: "camp-new", brand, family: "fai_fr", mtaId: "mta-k" },
      () => {},
      { config, runner: blindOnly.runner },
    );
    expect(floored.calibrationCampaignIds).toEqual(["camp-k"]);
    expect(floored.complaintFloor).toMatchObject({ level: "brand", campaignIds: ["camp-old-1", "camp-old-2"], delivered: 200_000, complaints: 400 });
    expect(floored.complaintFloor!.rate).toBeCloseTo(0.002);
    expect(floored.campaignNames["camp-old-1"]).toBe("Air France 10/06");
    expect(floored.notes.join(" ")).toContain("plancher de plaintes 0,200 %");
    // Every reservoir is projected at least at the floor (marked up), whatever its own 0-complaint history says.
    for (const block of floored.blocks) expect(block.expectedComplaintRate).toBeGreaterThanOrEqual(0.002);
    expect(floored.mta).toMatchObject({ capture: "blind", calibrationSendsOnMta: 1 });
  });

  it("ranks capturing sends ahead of blind ones BEFORE the history cap, within the 180-day complaint horizon", async () => {
    const captures = new Map([
      ["mta-k", { name: "Kammaspeed", capture: "blind" as const, delivered: 8_000_000, complaints: 2 }],
      ["mta-p", { name: "PowerMTA", capture: "capturing" as const, delivered: 2_000_000, complaints: 3_000 }],
    ]);
    const now = Date.parse("2026-09-24T00:00:00.000Z");
    const day = 24 * 60 * 60 * 1000;
    const rows = [
      ...Array.from({ length: 7 }, (_, i) => ({ id: `blind-${i}`, mtaId: "mta-k", firstSendAt: new Date(now - (i + 1) * day) })),
      { id: "capturing-recent", mtaId: "mta-p", firstSendAt: new Date(now - 100 * day) },
      { id: "unknown-mta", mtaId: null, firstSendAt: new Date(now - 120 * day) },
      { id: "capturing-old", mtaId: "mta-p", firstSendAt: new Date(now - 300 * day) },
    ];
    expect(preferCapturingCandidates(rows, captures, 6, now).map((row) => row.id)).toEqual([
      "capturing-recent", "unknown-mta", "blind-0", "blind-1", "blind-2", "blind-3",
    ]);
    // Nothing to prefer: plain recency.
    expect(preferCapturingCandidates(rows.slice(0, 7), captures, 3, now).map((row) => row.id)).toEqual(["blind-0", "blind-1", "blind-2"]);
  });

  it("looks the brand's MTAs up before capping its history, so a capturing send is not cut off by seven newer blind ones", async () => {
    const kammaspeed = { id: "mta-k", name: "Kammaspeed" };
    const powermta = { id: "mta-p", name: "PowerMTA" };
    const mtaCapture = () => [
      { mta_id: "mta-k", mta_name: "Kammaspeed", delivered: "8000000", complaints: "2" },
      { mta_id: "mta-p", mta_name: "PowerMTA", delivered: "2000000", complaints: "3000" },
    ];
    const recent = (daysAgo: number) => new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
    historyCandidates.mockResolvedValueOnce([
      ...Array.from({ length: 7 }, (_, i) => ({ campaignId: `camp-blind-${i}`, segmentName: "FR - Cliqueurs", firstSentAt: recent(i + 1) })),
      { campaignId: "camp-capturing", segmentName: "FR - Cliqueurs", firstSentAt: recent(60) },
    ]);
    const statsIds: string[][] = [];
    const { runner } = fakeRunner({
      mtaCapture,
      brandMtas: (ids) => ids.map((id) => ({ id, mta_id: id === "camp-capturing" ? "mta-p" : "mta-k" })),
      stats: (ids) => {
        statsIds.push(ids);
        return ids.map((id) => statsRow(id, `Air France ${id}`, 100_000, 100_000, "completed", id === "camp-capturing" ? powermta : kammaspeed));
      },
      cohorts: (campaignId, divisor) => (campaignId === "camp-capturing" ? cohortRows(divisor) : (() => { throw new Error(`blind send ${campaignId} must not be sampled`); })()),
      tiers: () => [],
    });
    const evidence = await buildSmartSegmentEvidence(
      { campaignName: "Air France 21/09", excludeCampaignId: null, brand, family: "fai_fr", mtaId: "mta-k" },
      () => {},
      { config, runner },
    );
    expect(statsIds).toHaveLength(1);
    expect(statsIds[0]).toHaveLength(6);
    expect(statsIds[0][0]).toBe("camp-capturing");
    expect(evidence.calibrationCampaignIds).toEqual(["camp-capturing"]);
    expect(evidence.calibrationLevel).toBe("brand");
    expect(evidence.complaintFloor ?? null).toBeNull();
  });

  it("classifies the fallback candidates by MTA before computing the stats of the eight it keeps", async () => {
    const kammaspeed = { id: "mta-k", name: "Kammaspeed" };
    const powermta = { id: "mta-p", name: "PowerMTA" };
    historyCandidates.mockResolvedValueOnce([]);
    const statsIds: string[][] = [];
    const { runner } = fakeRunner({
      mtaCapture: () => [
        { mta_id: "mta-k", mta_name: "Kammaspeed", delivered: "8000000", complaints: "2" },
        { mta_id: "mta-p", mta_name: "PowerMTA", delivered: "2000000", complaints: "3000" },
      ],
      fallback: () => [
        ...Array.from({ length: 8 }, (_, i) => ({ id: `other-blind-${i}`, name: `Autre marque ${i}`, mta_id: "mta-k", first_send_at: "2026-09-20T08:00:00.000Z" })),
        { id: "other-capturing", name: "Encore une autre", mta_id: "mta-p", first_send_at: "2026-09-10T08:00:00.000Z" },
      ],
      stats: (ids) => {
        statsIds.push(ids);
        return ids.map((id) => statsRow(id, id, 100_000, 100_000, "completed", id === "other-capturing" ? powermta : kammaspeed));
      },
      cohorts: (campaignId, divisor) => (campaignId === "other-capturing" ? cohortRows(divisor) : (() => { throw new Error(`blind send ${campaignId} must not be sampled`); })()),
      tiers: () => [],
    });
    const evidence = await buildSmartSegmentEvidence(
      { campaignName: "Nouvelle Marque 21/09", excludeCampaignId: null, brand, family: "fai_fr", mtaId: null },
      () => {},
      { config, runner },
    );
    expect(statsIds).toHaveLength(1);
    expect(statsIds[0]).toHaveLength(8);
    expect(statsIds[0][0]).toBe("other-capturing");
    expect(evidence.calibrationLevel).toBe("global");
    expect(evidence.calibrationCampaignIds).toEqual(["other-capturing"]);
    expect(evidence.complaintFloor ?? null).toBeNull();
  });

  it("reduces the recency sample once after a statement timeout, then marks recency as unmeasured and skips the pool", async () => {
    const recencyRow = (cohort: string, delivered: number, clickers: number) =>
      ({ axis: "recency", cohort, delivered: String(delivered), human_clickers: String(clickers), bot_clickers: "0", complaints: "0" });
    const timeout = () => { throw new SmartSegmentError("QUERY_TIMEOUT", "Délai dépassé sur la requête « récence » (30 s).", 504); };

    // First attempt (1/50 of 1 M) times out, the reduced retry (1/200) answers.
    historyCandidates.mockResolvedValueOnce([{ campaignId: "camp-a", segmentName: "FR - Cliqueurs" }]);
    const reduced = fakeRunner({
      stats: (ids) => ids.map((id) => statsRow(id, "Air France 01/09", 1_000_000, 1_000_000)),
      cohorts: (campaignId, divisor) => (campaignId === "camp-a" ? cohortRows(divisor) : []),
      recency: (campaignId, divisor) => {
        if (campaignId !== "camp-a") throw new Error(`unexpected recency query for ${campaignId}`);
        if (divisor === 50) return timeout();
        return [recencyRow("engaged_60d", 4_800, 60), recencyRow("opened_61_180d", 1_200, 2), recencyRow("dormant_180d", 1_000, 0)];
      },
      tiers: () => [{ tier: "1", count: "9000" }],
      recencyMix: () => [],
    });
    const evidence = await buildSmartSegmentEvidence(
      { campaignName: "Air France 21/09", excludeCampaignId: "camp-new", brand, family: "fai_fr" },
      () => {},
      { config, runner: reduced.runner },
    );
    const recencyQueries = reduced.recorded.filter((entry) => entry.label.startsWith("récence"));
    expect(recencyQueries.map((entry) => entry.params[4])).toEqual([50, 50 * RECENCY_TIMEOUT_SAMPLE_SCALE]);
    expect(evidence.degraded).toBeUndefined();
    expect(evidence.recencyCalibration).toEqual({ level: "brand", campaignIds: ["camp-a"] });
    const lapsed = evidence.cohortRates.find((rate) => rate.axis === "recency" && rate.cohort === "opened_61_180d")!;
    expect(lapsed.observed).toBe(1_200);
    expect(lapsed.delivered).toBe(1_200 * 200);
    expect(evidence.notes.some((note) => note.startsWith("Récence mesurée sur un échantillon réduit"))).toBe(true);

    // Both attempts time out: the analysis still succeeds without non-active
    // blocks, the pool is not even attempted, and the dossier is flagged.
    historyCandidates.mockResolvedValueOnce([{ campaignId: "camp-a", segmentName: "FR - Cliqueurs" }]);
    const unmeasured = fakeRunner({
      stats: (ids) => ids.map((id) => statsRow(id, "Air France 01/09", 1_000_000, 1_000_000)),
      cohorts: (campaignId, divisor) => (campaignId === "camp-a" ? cohortRows(divisor) : []),
      recency: () => timeout(),
      recencyPool: () => { throw new Error("the pool must not run after a recency timeout"); },
      tiers: () => [{ tier: "1", count: "9000" }],
      recencyMix: () => [],
    });
    const degraded = await buildSmartSegmentEvidence(
      { campaignName: "Air France 21/09", excludeCampaignId: "camp-new", brand, family: "fai_fr" },
      () => {},
      { config, runner: unmeasured.runner },
    );
    expect(unmeasured.recorded.filter((entry) => entry.label.startsWith("récence"))).toHaveLength(2);
    expect(unmeasured.recorded.some((entry) => entry.label === "envois récents toutes marques (récence)")).toBe(false);
    expect(degraded.degraded).toEqual([{ stage: "recency", label: "Air France 01/09", message: expect.stringContaining("Délai dépassé") }]);
    expect(degraded.recencyCalibration).toBeNull();
    expect(degraded.blocks.some((block) => block.id.endsWith("_lapsed") || block.id.endsWith("_dormant"))).toBe(false);
    expect(degraded.blocks.length).toBeGreaterThan(0);
    expect(degraded.notes.some((note) => note.includes("Calibrage de la récence interrompu"))).toBe(true);

    // Any other failure of the recency statement still fails the analysis.
    historyCandidates.mockResolvedValueOnce([{ campaignId: "camp-a", segmentName: "FR - Cliqueurs" }]);
    const broken = fakeRunner({
      stats: (ids) => ids.map((id) => statsRow(id, "Air France 01/09", 1_000_000, 1_000_000)),
      cohorts: (campaignId, divisor) => (campaignId === "camp-a" ? cohortRows(divisor) : []),
      recency: () => { throw new SmartSegmentError("EVIDENCE_QUERY_FAILED", "colonne inconnue", 500); },
      tiers: () => [],
    });
    await expect(buildSmartSegmentEvidence(
      { campaignName: "Air France 21/09", excludeCampaignId: "camp-new", brand, family: "fai_fr" },
      () => {},
      { config, runner: broken.runner },
    )).rejects.toMatchObject({ code: "EVIDENCE_QUERY_FAILED" });
  });

  it("discards the bands measured before a recency timeout (brand send or pool) instead of attributing a partial calibration", async () => {
    const recencyRow = (cohort: string, delivered: number, clickers: number) =>
      ({ axis: "recency", cohort, delivered: String(delivered), human_clickers: String(clickers), bot_clickers: "0", complaints: "0" });
    const reliable = [recencyRow("engaged_60d", 40_000, 500), recencyRow("opened_61_180d", 3_000, 6), recencyRow("dormant_180d", 2_000, 2)];
    const timeout = () => { throw new SmartSegmentError("QUERY_TIMEOUT", "Délai dépassé sur la requête « récence » (30 s).", 504); };

    // Second brand send times out twice after the first one measured reliable bands.
    historyCandidates.mockResolvedValueOnce([{ campaignId: "camp-a", segmentName: "FR" }, { campaignId: "camp-b", segmentName: "FR" }]);
    const brandCase = fakeRunner({
      stats: (ids) => ids.map((id) => statsRow(id, id === "camp-a" ? "Air France 01/09" : "Air France 08/09", 50_000, 50_000)),
      cohorts: (_campaignId, divisor) => cohortRows(divisor),
      recency: (campaignId) => (campaignId === "camp-a" ? reliable : timeout()),
      recencyPool: () => { throw new Error("the pool must not run after a recency timeout"); },
      tiers: () => [{ tier: "1", count: "9000" }],
      recencyMix: () => [],
    });
    const brandEvidence = await buildSmartSegmentEvidence(
      { campaignName: "Air France 21/09", excludeCampaignId: "camp-new", brand, family: "fai_fr" },
      () => {},
      { config, runner: brandCase.runner },
    );
    expect(brandCase.recorded.filter((entry) => entry.label.startsWith("récence")).map((entry) => entry.params[0])).toEqual(["camp-a", "camp-b", "camp-b"]);
    expect(brandEvidence.degraded?.[0]).toMatchObject({ stage: "recency", label: "Air France 08/09" });
    expect(brandEvidence.recencyCalibration).toBeNull();
    expect(brandEvidence.cohortRates.some((rate) => rate.axis === "recency")).toBe(false);
    expect(brandEvidence.blocks.some((block) => block.id.endsWith("_lapsed") || block.id.endsWith("_dormant"))).toBe(false);
    expect(brandEvidence.notes.filter((note) => note.includes("interrompu"))).toHaveLength(1);
    expect(brandEvidence.notes.some((note) => note.startsWith("Récence mesurée sur un échantillon réduit"))).toBe(false);

    // Second pool send times out twice after the first pool send measured reliable bands.
    historyCandidates.mockResolvedValueOnce([{ campaignId: "camp-a", segmentName: "FR" }]);
    const poolCase = fakeRunner({
      stats: (ids) => ids.map((id) => statsRow(id, "Air France 01/09", 50_000, 50_000)),
      cohorts: (_campaignId, divisor) => cohortRows(divisor),
      recency: (campaignId) => campaignId === "camp-a"
        ? [recencyRow("engaged_60d", 49_000, 500), recencyRow("opened_61_180d", 30, 0), recencyRow("dormant_180d", 10, 0)]
        : campaignId === "pool-1" ? reliable : timeout(),
      recencyPool: () => [
        { id: "pool-1", name: "Autre 15/09", status: "completed", first_send_at: "2026-09-15T08:00:00.000Z", sent_count: "600000", delivered_rows: "600000" },
        { id: "pool-2", name: "Autre 14/09", status: "completed", first_send_at: "2026-09-14T08:00:00.000Z", sent_count: "600000", delivered_rows: "600000" },
      ],
      tiers: () => [{ tier: "1", count: "9000" }],
      recencyMix: () => [],
    });
    const poolEvidence = await buildSmartSegmentEvidence(
      { campaignName: "Air France 21/09", excludeCampaignId: "camp-new", brand, family: "fai_fr" },
      () => {},
      { config: { ...config, recencyPoolSampleTarget: 20_000, recencyPoolMaxCampaigns: 12 }, runner: poolCase.runner },
    );
    expect(poolCase.recorded.filter((entry) => entry.label.startsWith("récence")).map((entry) => entry.params[0])).toEqual(["camp-a", "pool-1", "pool-2", "pool-2"]);
    expect(poolEvidence.degraded?.[0]).toMatchObject({ stage: "recency", label: "Autre 14/09" });
    expect(poolEvidence.recencyCalibration).toBeNull();
    expect(poolEvidence.cohortRates.some((rate) => rate.axis === "recency")).toBe(false);
    expect(poolEvidence.blocks.some((block) => block.id.endsWith("_lapsed") || block.id.endsWith("_dormant"))).toBe(false);
    expect(poolEvidence.notes.some((note) => note.includes("envois récents toutes marques interrompu"))).toBe(true);
  });

  it("propagates runner failures as SmartSegmentError", async () => {
    historyCandidates.mockResolvedValue([]);
    const runner: EvidenceQueryRunner = {
      query: async () => { throw new SmartSegmentError("QUERY_TIMEOUT", "timeout", 504); },
      queryCount: async () => 0,
      elapsedMs: () => 0,
      queries: () => 0,
    };
    await expect(buildSmartSegmentEvidence(
      { campaignName: "Air France 21/09", excludeCampaignId: null, brand, family: "fai_fr" },
      () => {},
      { config, runner },
    )).rejects.toMatchObject({ code: "QUERY_TIMEOUT" });
  });
});

describe("createTransactionRunner", () => {
  it("runs every statement under a savepoint so a statement timeout leaves the transaction usable", async () => {
    const sent: string[] = [];
    const client = {
      query: vi.fn(async (text: string) => {
        sent.push(text);
        if (text.startsWith("SELECT slow")) throw Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });
        return { rows: [{ ok: 1 }] };
      }),
      release: vi.fn(),
    };
    poolConnect.mockResolvedValueOnce(client);
    const transaction = createTransactionRunner({ ...config, queryTimeoutMs: 30_000 });
    await transaction.open();
    await expect(transaction.runner.query("lente", "SELECT slow")).rejects.toMatchObject({ code: "QUERY_TIMEOUT", message: expect.stringContaining("30 s") });
    await expect(transaction.runner.query("rapide", "SELECT 1")).resolves.toEqual([{ ok: 1 }]);
    await transaction.close();
    expect(sent).toEqual([
      "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
      "SET LOCAL statement_timeout = '30000ms'",
      "SAVEPOINT evidence_query",
      "SELECT slow",
      "ROLLBACK TO SAVEPOINT evidence_query",
      "SAVEPOINT evidence_query",
      "SELECT 1",
      "RELEASE SAVEPOINT evidence_query",
      "ROLLBACK",
    ]);
    expect(transaction.runner.queries()).toBe(2);
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});
