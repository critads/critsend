import { describe, expect, it, vi } from "vitest";

vi.mock("../server/db", () => ({ pool: {}, db: {}, getPoolSaturation: () => 0 }));
vi.mock("../server/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("../server/services/smart-segment-brand", () => ({ resolveSmartSegmentBrand: vi.fn() }));

import {
  assembleOutcomes,
  listSmartSegmentOutcomes,
  OUTCOME_ANALYSES_SQL,
  OUTCOME_CAMPAIGNS_SQL,
  OUTCOMES_MAX_ANALYSES,
  OUTCOMES_WINDOW_DAYS,
} from "../server/services/smart-segment-outcomes";
import { describeOutcomeCampaign } from "../client/src/components/campaign-wizard/smart-segment-outcomes";

const proposalSegment = (overrides: Record<string, unknown> = {}) => ({
  name: "Cliqueurs très actifs",
  rules: { version: 2, root: { type: "group", combinator: "AND", children: [] } },
  readableRules: [],
  blocksUsed: ["clickers_6plus"],
  audienceCount: 2_800,
  projectedClicks: { low: 200, high: 380 },
  projectedComplaintRate: 0.0003,
  projectedComplaints: { low: 0, high: 1 },
  rationale: "Parce que.",
  warnings: [],
  injectedExclusions: [],
  ...overrides,
});

const analysis = {
  id: "an-1",
  created_at: "2026-09-20T08:00:00.000Z",
  params: { campaignName: "Air France 20/09", family: "fai_fr" as const },
  evidence: { brand: { brandName: "Air France" }, mta: { name: "PowerMTA" } },
  proposal: {
    segments: [
      proposalSegment({ kind: "recommended", projectedUnsubscribeRate: 0.002, orangeWanadoo: { count: 700, share: 0.25, projectedComplaintRate: 0.0005, projectedComplaints: 0, status: "green", cohortReliable: true } }),
      proposalSegment({ name: "Avec marques similaires", kind: "similar_brands", audienceCount: 9_000, projectedClicks: { low: 400, high: 700 } }),
    ],
    model: "claude-test", promptVersion: "smart-segment-v1", attempts: 1, disclaimer: "Indicatif.", tokenUsage: { inputTokens: 1, outputTokens: 1 },
  },
  created_segments: [
    { index: 1, id: "seg-similar", name: "Smart · Air France · 20/09 · FR · marques similaires" },
    { index: 0, id: "seg-reco", name: "Smart · Air France · 20/09 · FR" },
  ],
} as any;

const campaignRow = (overrides: Record<string, unknown> = {}) => ({
  segment_id: "seg-reco",
  campaign_id: "camp-1",
  name: "Air France 21/09",
  status: "completed",
  mta_name: "PowerMTA",
  first_send_at: "2026-09-21T09:00:00.000Z",
  segment_count: "1",
  sent_count: "2750",
  unique_clicks_count: "310",
  complaints_count: "1",
  unsubscribes_count: "6",
  orange_wanadoo_sent_count: "690",
  orange_wanadoo_complaints_count: "1",
  ...overrides,
});

describe("assembleOutcomes", () => {
  it("lists every created segment of each analysis (by index) with its projection and the campaigns that used it", () => {
    const outcomes = assembleOutcomes([analysis], [
      campaignRow(),
      campaignRow({ campaign_id: "camp-2", name: "Air France 23/09", status: "sending", first_send_at: "2026-09-23T09:00:00.000Z", segment_count: "2", sent_count: "1200" }),
      campaignRow({ segment_id: "seg-unknown", campaign_id: "camp-x" }), // not one of ours
    ]);
    expect(outcomes.map((outcome) => [outcome.index, outcome.segmentId, outcome.kind, outcome.campaigns.length])).toEqual([
      [0, "seg-reco", "recommended", 2],
      [1, "seg-similar", "similar_brands", 0],
    ]);
    expect(outcomes[0]).toMatchObject({
      analysisId: "an-1",
      analysedAt: "2026-09-20T08:00:00.000Z",
      campaignName: "Air France 20/09",
      family: "fai_fr",
      mtaName: "PowerMTA",
      segmentName: "Smart · Air France · 20/09 · FR",
      projected: {
        audienceCount: 2_800,
        clicks: { low: 200, high: 380 },
        complaintRate: 0.0003,
        complaints: { low: 0, high: 1 },
        unsubscribeRate: 0.002,
        orangeWanadooShare: 0.25,
        orangeWanadooComplaintRate: 0.0005,
      },
    });
    expect(outcomes[0].campaigns[0]).toEqual({
      campaignId: "camp-1",
      name: "Air France 21/09",
      status: "completed",
      mtaName: "PowerMTA",
      firstSendAt: "2026-09-21T09:00:00.000Z",
      segmentCount: 1,
      sentCount: 2_750,
      uniqueClicks: 310,
      complaintsCount: 1,
      unsubscribesCount: 6,
      orangeWanadooSentCount: 690,
      orangeWanadooComplaintsCount: 1,
      finished: true,
    });
    // A campaign still sending is shown but flagged as not final; its figures cover two segments.
    expect(outcomes[0].campaigns[1]).toMatchObject({ campaignId: "camp-2", finished: false, segmentCount: 2 });
    // Older analyses without the newer projection fields still render.
    expect(outcomes[1].projected).toMatchObject({ unsubscribeRate: null, orangeWanadooShare: null, orangeWanadooComplaintRate: null });
  });

  it("skips created segments whose proposal index no longer exists and tolerates malformed rows", () => {
    const broken = { ...analysis, id: "an-2", created_segments: [{ index: 7, id: "seg-ghost", name: "?" }], evidence: null };
    expect(assembleOutcomes([broken], [])).toEqual([]);
    const noSegments = { ...analysis, id: "an-3", created_segments: null };
    expect(assembleOutcomes([noSegments], [])).toEqual([]);
  });
});

describe("listSmartSegmentOutcomes", () => {
  it("resolves the brand, queries its recent analyses then the campaigns that used their segments", async () => {
    const calls: Array<{ text: string; params: unknown[] }> = [];
    const query = vi.fn(async (text: string, params: unknown[]) => {
      calls.push({ text, params });
      if (text === OUTCOME_ANALYSES_SQL) return { rows: [analysis] };
      if (text === OUTCOME_CAMPAIGNS_SQL) return { rows: [campaignRow()] };
      throw new Error("unexpected query");
    });
    const resolveBrand = vi.fn(async () => ({ brandName: " Air France ", coreRefs: ["4AF", "E4AF"] }));
    const response = await listSmartSegmentOutcomes({ campaignName: "Air France 24/09", brandOverride: null }, { query: query as never, resolveBrand: resolveBrand as never });
    expect(resolveBrand).toHaveBeenCalledWith({ campaignName: "Air France 24/09", brandOverride: null });
    expect(calls[0].params).toEqual([OUTCOMES_WINDOW_DAYS, "Air France", ["4AF", "E4AF"], OUTCOMES_MAX_ANALYSES]);
    // Both segments of the analysis are looked up at once, de-duplicated.
    expect(calls[1].params).toEqual([["seg-similar", "seg-reco"]]);
    expect(response.brandName).toBe("Air France");
    expect(response.outcomes).toHaveLength(2);
    expect(response.outcomes[0].campaigns).toHaveLength(1);
  });

  it("returns nothing without a resolvable brand and never queries the campaigns without segments", async () => {
    const query = vi.fn(async (text: string) => (text === OUTCOME_ANALYSES_SQL ? { rows: [] } : (() => { throw new Error("unexpected"); })()));
    const unresolved = await listSmartSegmentOutcomes({ campaignName: "???" }, { query: query as never, resolveBrand: (async () => ({ brandName: null, coreRefs: [] })) as never });
    expect(unresolved).toEqual({ brandName: null, outcomes: [] });
    expect(query).not.toHaveBeenCalled();
    const empty = await listSmartSegmentOutcomes({ campaignName: "Nouvelle 24/09" }, { query: query as never, resolveBrand: (async () => ({ brandName: "Nouvelle", coreRefs: [] })) as never });
    expect(empty).toEqual({ brandName: "Nouvelle", outcomes: [] });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("binds every parameter it declares (PostgreSQL rejects unreferenced binds)", () => {
    for (const [sql, count] of [[OUTCOME_ANALYSES_SQL, 4], [OUTCOME_CAMPAIGNS_SQL, 1]] as const) {
      const referenced = new Set([...sql.matchAll(/\$(\d+)/g)].map((match) => Number(match[1])));
      expect([...referenced].sort()).toEqual(Array.from({ length: count }, (_, index) => index + 1));
    }
    // Drafts have nothing to compare; the legacy column only counts for campaigns without the relation.
    expect(OUTCOME_CAMPAIGNS_SQL).toContain("c.status <> 'draft'");
    expect(OUTCOME_CAMPAIGNS_SQL).toContain("NOT EXISTS (SELECT 1 FROM campaign_segments cs WHERE cs.campaign_id = c.id)");
  });
});

describe("describeOutcomeCampaign", () => {
  it("derives the real rates from the cached counters and leaves unmeasurable ones null", () => {
    const campaign = {
      campaignId: "camp-1", name: "Air France 21/09", status: "completed", mtaName: null, firstSendAt: null, segmentCount: 1,
      sentCount: 2_000, uniqueClicks: 300, complaintsCount: 2, unsubscribesCount: 10, orangeWanadooSentCount: 500, orangeWanadooComplaintsCount: 1, finished: true,
    };
    expect(describeOutcomeCampaign(campaign)).toEqual({
      complaintRate: 0.001,
      unsubscribeRate: 0.005,
      clickRate: 0.15,
      orangeWanadooShare: 0.25,
      orangeWanadooComplaintRate: 0.002,
    });
    expect(describeOutcomeCampaign({ ...campaign, sentCount: 0, orangeWanadooSentCount: 0 })).toEqual({
      complaintRate: null, unsubscribeRate: null, clickRate: null, orangeWanadooShare: null, orangeWanadooComplaintRate: null,
    });
  });
});
