import { beforeEach, describe, expect, it, vi } from "vitest";

// ---- In-memory stand-in for smart_segment_analyses (+ the tables touched by
// materialisation). Both pool.query and client.query go through handleQuery;
// client statements are also recorded so tests can assert the transaction
// shape.
type Row = Record<string, any>;
const table = new Map<string, Row>();
const campaigns = new Map<string, Row>();
const campaignSegments: Array<{ campaignId: string; segmentId: string; position: number }> = [];
const segmentsTable: Array<{ id: string; name: string; description: string; rules: unknown; cached_count: number }> = [];
let sequence = 0;
let segmentSequence = 0;
const clientQueries: Array<{ text: string; params: unknown[] }> = [];
let clock = () => Date.now();

function ms(value: unknown): number { return Number(value); }
function fresh(row: Row, staleMs: number): boolean {
  return row.heartbeat_at instanceof Date && clock() - row.heartbeat_at.getTime() < staleMs;
}

function handleQuery(text: string, params: unknown[] = []): { rows: Row[]; rowCount: number } {
  const sql = text.replace(/\s+/g, " ").trim();
  if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [], rowCount: 0 };
  if (sql.startsWith("SELECT pg_advisory_xact_lock")) return { rows: [{}], rowCount: 1 };
  if (sql.startsWith("INSERT INTO smart_segment_analyses")) {
    const id = `an-${++sequence}`;
    const row: Row = {
      id, fingerprint: params[0], status: "queued", stage: "brand_history", progress: 0, error: null, error_code: null,
      params: JSON.parse(params[1] as string), evidence: null, proposal: null, created_segments: null,
      created_at: new Date(clock()), finished_at: null, created_by: params[2], owner: params[3], heartbeat_at: new Date(clock()),
    };
    table.set(id, row);
    return { rows: [row], rowCount: 1 };
  }
  if (sql.includes("FROM smart_segment_analyses WHERE fingerprint = $1")) {
    const rows = [...table.values()]
      .filter((row) => row.fingerprint === params[0])
      .filter((row) => clock() - row.created_at.getTime() <= ms(params[1]))
      .filter((row) => row.status === "succeeded" || (["queued", "running"].includes(row.status) && fresh(row, ms(params[2]))))
      .sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
    return { rows: rows.slice(0, 1), rowCount: rows.length ? 1 : 0 };
  }
  if (sql.startsWith("SELECT COUNT(*)::text AS count FROM smart_segment_analyses")) {
    const count = [...table.values()].filter((row) => ["queued", "running"].includes(row.status) && fresh(row, ms(params[0]))).length;
    return { rows: [{ count: String(count) }], rowCount: 1 };
  }
  if (sql.includes("FROM smart_segment_analyses WHERE id = $1")) {
    const row = table.get(params[0] as string);
    return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
  }
  if (sql.startsWith("UPDATE smart_segment_analyses")) {
    if (sql.includes("WHERE status IN ('queued', 'running') AND (heartbeat_at IS NULL")) {
      let count = 0;
      for (const row of table.values()) {
        if (["queued", "running"].includes(row.status) && !fresh(row, ms(params[0]))) {
          row.status = "failed"; row.error_code = row.error_code ?? "INTERRUPTED"; row.error = row.error ?? "interrompue"; row.finished_at = new Date(clock()); count += 1;
        }
      }
      return { rows: [], rowCount: count };
    }
    const row = table.get(params[0] as string);
    if (!row) return { rows: [], rowCount: 0 };
    const guardRunning = sql.includes("AND status = 'running'");
    const guardQueued = sql.includes("AND status = 'queued'");
    if ((guardRunning && row.status !== "running") || (guardQueued && row.status !== "queued")) return { rows: [], rowCount: 0 };
    if (sql.includes("SET heartbeat_at = NOW() WHERE")) {
      if (!["queued", "running"].includes(row.status)) return { rows: [], rowCount: 0 };
      row.heartbeat_at = new Date(clock());
    } else if (sql.includes("SET status = 'running'")) { row.status = "running"; row.heartbeat_at = new Date(clock()); }
    else if (sql.includes("SET stage = $2, progress = $3")) { row.stage = params[1]; row.progress = params[2]; row.heartbeat_at = new Date(clock()); }
    else if (sql.includes("SET evidence = $2::jsonb")) { row.evidence = JSON.parse(params[1] as string); row.stage = "ai_proposal"; row.progress = 80; }
    else if (sql.includes("SET status = 'succeeded'")) { row.status = "succeeded"; row.stage = "done"; row.progress = 100; row.proposal = JSON.parse(params[1] as string); row.finished_at = new Date(clock()); }
    else if (sql.includes("SET status = 'failed'")) { row.status = "failed"; row.error = params[1]; row.error_code = params[2]; row.finished_at = new Date(clock()); }
    else if (sql.includes("SET created_segments = $2::jsonb")) row.created_segments = JSON.parse(params[1] as string);
    else throw new Error(`unhandled update: ${sql}`);
    return { rows: [row], rowCount: 1 };
  }
  if (sql.startsWith("INSERT INTO segments")) {
    const segment = { id: `seg-${++segmentSequence}`, name: params[0] as string, description: params[1] as string, rules: JSON.parse(params[2] as string), cached_count: params[3] as number };
    segmentsTable.push(segment);
    return { rows: [{ id: segment.id, name: segment.name }], rowCount: 1 };
  }
  if (sql.startsWith("SELECT id, status FROM campaigns")) {
    const campaign = campaigns.get(params[0] as string);
    return { rows: campaign ? [campaign] : [], rowCount: campaign ? 1 : 0 };
  }
  if (sql.includes("MAX(position)")) {
    const positions = campaignSegments.filter((entry) => entry.campaignId === params[0]).map((entry) => entry.position);
    return { rows: [{ next: String(positions.length ? Math.max(...positions) + 1 : 0) }], rowCount: 1 };
  }
  if (sql.startsWith("INSERT INTO campaign_segments")) {
    if (campaignSegments.some((entry) => entry.campaignId === params[0] && entry.segmentId === params[1])) return { rows: [], rowCount: 0 };
    campaignSegments.push({ campaignId: params[0] as string, segmentId: params[1] as string, position: params[2] as number });
    return { rows: [], rowCount: 1 };
  }
  if (sql.startsWith("UPDATE campaigns SET segment_id")) {
    const campaign = campaigns.get(params[0] as string);
    if (campaign) campaign.segment_id = campaign.segment_id ?? params[1];
    return { rows: [], rowCount: campaign ? 1 : 0 };
  }
  throw new Error(`unhandled query: ${sql}`);
}

let failClientQuery: ((text: string) => Error | null) | null = null;

vi.mock("../server/db", () => ({
  db: {},
  getPoolSaturation: () => 0,
  pool: {
    query: async (text: string, params?: unknown[]) => handleQuery(text, params),
    connect: async () => ({
      query: async (text: string, params: unknown[] = []) => {
        clientQueries.push({ text, params });
        const failure = failClientQuery?.(text);
        if (failure) throw failure;
        return handleQuery(text, params);
      },
      release: vi.fn(),
    }),
  },
}));
vi.mock("../server/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const resolveBrand = vi.fn();
vi.mock("../server/services/smart-segment-brand", () => ({
  resolveSmartSegmentBrand: (...args: unknown[]) => resolveBrand(...args),
}));

const buildEvidence = vi.fn();
vi.mock("../server/services/smart-segment-evidence", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/services/smart-segment-evidence")>();
  return {
    ...actual,
    buildSmartSegmentEvidence: (...args: unknown[]) => buildEvidence(...args),
    createTransactionRunner: () => ({
      open: async () => {},
      close: async () => {},
      runner: {
        queryCount: async () => 1_234,
        // Tier partition of the recounted audience (non-clickers = remainder).
        query: async (label: string) => (label.includes("tranche") ? [{ tier: "6+", count: "1000" }, { tier: "2-3", count: "200" }] : []),
        elapsedMs: () => 0,
        queries: () => 0,
      },
    }),
  };
});

const generateProposal = vi.fn();
vi.mock("../server/services/smart-segment-proposal", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/services/smart-segment-proposal")>();
  return { ...actual, generateSmartSegmentProposal: (...args: unknown[]) => generateProposal(...args) };
});

import type { SmartSegmentAnalysisRequest } from "../shared/smart-segment";
import { getSmartSegmentConfig } from "../server/config/smart-segment";
import {
  analysisFingerprint,
  getSmartSegmentAnalysis,
  materializeSmartSegmentProposal,
  SMART_SEGMENT_OWNER,
  STALE_HEARTBEAT_MS,
  startSmartSegmentAnalysis,
  startSmartSegmentJanitor,
  stopSmartSegmentJanitor,
  sweepStaleSmartSegmentAnalyses,
  waitForSmartSegmentAnalysis,
} from "../server/services/smart-segment-jobs";
import { SmartSegmentError } from "../server/services/smart-segment-evidence";

const params: SmartSegmentAnalysisRequest = {
  campaignName: "Air France 21/09",
  campaignId: "camp-draft",
  mtaId: "mta-1",
  family: "fai_fr",
  targetClicks: 500,
  complaintCap: 0.0045,
  brandOverride: null,
};

const brand = { detected: true, source: "directory", brandName: "Air France", coreRefs: ["4AF"], extensionRefs: [], unsubscribeTags: [], vertical: "4", verticalLabel: "Voyage", verticalRefs: [], matchedKeys: [] };
const evidence = { version: 1, brand, family: "fai_fr", blocks: [], cohortRates: [], brandSends: [], recentBrandCampaignIds: [], campaignNames: {}, calibrationLevel: "brand", calibrationCampaignIds: [], mandatoryExclusions: [], budget: { elapsedMs: 10, queries: 3, sampledCampaigns: [] }, notes: [], generatedAt: "2026-09-21T00:00:00.000Z" };
const proposal = {
  segments: [
    { name: "Cliqueurs très actifs", rules: { version: 2, root: { type: "group", combinator: "AND", children: [] } }, readableRules: [], blocksUsed: ["clickers_6plus"], audienceCount: 2_800, projectedClicks: { low: 200, high: 380 }, projectedComplaintRate: 0.0003, projectedComplaints: { low: 0, high: 1 }, rationale: "Parce que.", warnings: [], injectedExclusions: [] },
    { name: "Variante volumique", rules: { version: 2, root: { type: "group", combinator: "AND", children: [] } }, readableRules: [], blocksUsed: ["clickers_1plus"], audienceCount: 20_000, projectedClicks: { low: 400, high: 700 }, projectedComplaintRate: 0.0012, projectedComplaints: { low: 10, high: 30 }, rationale: "Plus large.", warnings: [], injectedExclusions: [] },
  ],
  model: "claude-test", promptVersion: "smart-segment-v1", attempts: 1, disclaimer: "Indicatif.", tokenUsage: { inputTokens: 10, outputTokens: 5 },
};

const config = { ...getSmartSegmentConfig(), apiKey: null, maxConcurrent: 2, reuseWindowMs: 6 * 60 * 60 * 1000 };
const callModel = vi.fn(async () => ({ text: "{}", model: "m", stopReason: null, usage: null }));

function statements(): string[] {
  return clientQueries.map((entry) => entry.text.replace(/\s+/g, " ").trim().split(" ").slice(0, 3).join(" "));
}

beforeEach(() => {
  table.clear();
  campaigns.clear();
  campaignSegments.length = 0;
  segmentsTable.length = 0;
  clientQueries.length = 0;
  sequence = 0;
  segmentSequence = 0;
  failClientQuery = null;
  clock = () => Date.now();
  vi.clearAllMocks();
  resolveBrand.mockResolvedValue(brand);
  buildEvidence.mockImplementation(async (_input: unknown, onProgress: (stage: string, progress: number) => Promise<void>) => {
    await onProgress("cohorts", 40);
    return evidence;
  });
  generateProposal.mockResolvedValue(proposal);
  campaigns.set("camp-draft", { id: "camp-draft", status: "draft", segment_id: null });
});

describe("analysisFingerprint", () => {
  it("normalises case/whitespace and ignores the refresh flag, but distinguishes the campaign and the cap", () => {
    const base = analysisFingerprint(params);
    expect(analysisFingerprint({ ...params, campaignName: "  air france 21/09 ", refresh: true })).toBe(base);
    expect(analysisFingerprint({ ...params, campaignId: "other" })).not.toBe(base);
    expect(analysisFingerprint({ ...params, complaintCap: 0.006 })).not.toBe(base);
    expect(analysisFingerprint({ ...params, brandOverride: { name: "X", ref: "4x" } }))
      .toBe(analysisFingerprint({ ...params, brandOverride: { name: "x ", ref: "4X" } }));
  });
});

describe("startSmartSegmentAnalysis", () => {
  it("refuses to start without an API key or injected model", async () => {
    await expect(startSmartSegmentAnalysis(params, "user-1", { config })).rejects.toMatchObject({ code: "SMART_SEGMENT_NOT_CONFIGURED", status: 503 });
  });

  it("refuses to start when the brand is not resolved (no refs, no manual override)", async () => {
    resolveBrand.mockResolvedValueOnce({ ...brand, detected: false, coreRefs: [], source: "none" });
    await expect(startSmartSegmentAnalysis(params, "user-1", { config, callModel })).rejects.toMatchObject({ code: "BRAND_UNRESOLVED", status: 422 });
    expect(table.size).toBe(0);
    expect(buildEvidence).not.toHaveBeenCalled();
  });

  it("runs the pipeline in the background, persists progress, evidence and the proposal", async () => {
    const { view, created } = await startSmartSegmentAnalysis(params, "user-1", { config, callModel });
    expect(created).toBe(true);
    expect(view.status).toBe("queued");
    expect(table.get(view.id)?.created_by).toBe("user-1");
    expect(table.get(view.id)?.owner).toBe(SMART_SEGMENT_OWNER);
    expect(table.get(view.id)?.params.refresh).toBeUndefined();
    // Admission runs in one short transaction under an advisory lock.
    expect(statements().slice(0, 2)).toEqual(["BEGIN", "SELECT pg_advisory_xact_lock(hashtext('smart_segment_analyses_start'))"]);
    expect(statements().at(-1)).toBe("COMMIT");
    expect(clientQueries.some((entry) => entry.text.includes("pg_advisory_lock(") && !entry.text.includes("xact"))).toBe(false);
    await waitForSmartSegmentAnalysis(view.id);
    const done = await getSmartSegmentAnalysis(view.id);
    expect(done?.status).toBe("succeeded");
    expect(done?.stage).toBe("done");
    expect(done?.progress).toBe(100);
    expect(done?.evidence?.calibrationLevel).toBe("brand");
    expect(done?.proposal?.segments).toHaveLength(2);
    expect(done?.createdSegments).toEqual([]);
    expect(buildEvidence).toHaveBeenCalledWith(
      expect.objectContaining({ campaignName: params.campaignName, excludeCampaignId: "camp-draft", family: "fai_fr" }),
      expect.any(Function),
      expect.objectContaining({ config }),
    );
    // The proposal layer receives the injected model caller and a server
    // recount partitioned by clicker tier (tier 0 = remainder), both from
    // the same isolated snapshot transaction.
    const [, , deps] = generateProposal.mock.calls[0] as [unknown, unknown, { callModel: unknown; measureAudience: (rules: unknown) => Promise<unknown> }];
    expect(deps.callModel).toBe(callModel);
    await expect(deps.measureAudience(proposal.segments[0].rules)).resolves.toEqual({
      total: 1_234,
      tierCounts: { "6+": 1_000, "2-3": 200, "0": 34 },
      recencyCounts: {},
    });
  });

  it("reuses a fresh identical analysis unless refresh is requested, and enforces the cap from the database", async () => {
    const first = await startSmartSegmentAnalysis(params, "user-1", { config, callModel });
    await waitForSmartSegmentAnalysis(first.view.id);
    const again = await startSmartSegmentAnalysis(params, "user-2", { config, callModel });
    expect(again.created).toBe(false);
    expect(again.view.id).toBe(first.view.id);
    expect(again.view.reused).toBe(true);

    const refreshed = await startSmartSegmentAnalysis({ ...params, refresh: true }, "user-2", { config, callModel });
    expect(refreshed.created).toBe(true);
    expect(refreshed.view.id).not.toBe(first.view.id);
    await waitForSmartSegmentAnalysis(refreshed.view.id);

    // Two slow analyses occupy the slots; a third distinct request is refused.
    const releases: Array<() => void> = [];
    buildEvidence.mockImplementation(() => new Promise<typeof evidence>((resolve) => { releases.push(() => resolve(evidence)); }));
    const slowA = await startSmartSegmentAnalysis({ ...params, campaignName: "Marque A 21/09" }, null, { config, callModel });
    const slowB = await startSmartSegmentAnalysis({ ...params, campaignName: "Marque B 21/09" }, null, { config, callModel });
    await expect(startSmartSegmentAnalysis({ ...params, campaignName: "Marque C 21/09" }, null, { config, callModel }))
      .rejects.toMatchObject({ code: "SMART_SEGMENT_BUSY", status: 409 });
    // Re-asking for a running one is a reuse, not a new slot — even when the
    // row is driven by another instance (only the heartbeat matters).
    const rejoin = await startSmartSegmentAnalysis({ ...params, campaignName: "Marque A 21/09" }, null, { config, callModel });
    expect(rejoin.created).toBe(false);
    expect(rejoin.view.id).toBe(slowA.view.id);
    table.get(slowA.view.id)!.owner = "other-host:1:999";
    const rejoinForeign = await startSmartSegmentAnalysis({ ...params, campaignName: "Marque A 21/09" }, null, { config, callModel });
    expect(rejoinForeign.view.id).toBe(slowA.view.id);

    // A row whose heartbeat went stale neither blocks a slot nor is reused.
    table.get(slowB.view.id)!.heartbeat_at = new Date(Date.now() - STALE_HEARTBEAT_MS - 1);
    const replacesStale = await startSmartSegmentAnalysis({ ...params, campaignName: "Marque B 21/09" }, null, { config, callModel });
    expect(replacesStale.created).toBe(true);
    expect(replacesStale.view.id).not.toBe(slowB.view.id);

    // The third job reaches the evidence stage a tick after start() returns.
    await vi.waitFor(() => expect(releases).toHaveLength(3));
    for (const release of releases) release();
    await waitForSmartSegmentAnalysis(slowA.view.id);
    await waitForSmartSegmentAnalysis(slowB.view.id);
    await waitForSmartSegmentAnalysis(replacesStale.view.id);
  });

  it("persists an explicit failure with its code and never leaves the row running", async () => {
    buildEvidence.mockRejectedValueOnce(new SmartSegmentError("NO_CALIBRATION", "Aucun envoi terminé.", 422));
    const { view } = await startSmartSegmentAnalysis(params, null, { config, callModel });
    await waitForSmartSegmentAnalysis(view.id);
    const failed = await getSmartSegmentAnalysis(view.id);
    expect(failed).toMatchObject({ status: "failed", errorCode: "NO_CALIBRATION", error: "Aucun envoi terminé." });

    generateProposal.mockRejectedValueOnce(new Error("boom"));
    const second = await startSmartSegmentAnalysis({ ...params, refresh: true }, null, { config, callModel });
    await waitForSmartSegmentAnalysis(second.view.id);
    expect(await getSmartSegmentAnalysis(second.view.id)).toMatchObject({ status: "failed", errorCode: "ANALYSIS_FAILED" });
  });

  it("fails rows without a fresh heartbeat (any instance), and a late finish cannot resurrect them", async () => {
    handleQuery("INSERT INTO smart_segment_analyses (fingerprint, status, stage, progress, params, created_by, owner, heartbeat_at) VALUES ($1, 'queued', 'brand_history', 0, $2::jsonb, $3, $4, NOW()) RETURNING id", ["fp", JSON.stringify(params), null, "dead-host:0:1"]);
    table.get("an-1")!.status = "running";
    table.get("an-1")!.heartbeat_at = null; // pre-heartbeat row
    handleQuery("INSERT INTO smart_segment_analyses (fingerprint, status, stage, progress, params, created_by, owner, heartbeat_at) VALUES ($1, 'queued', 'brand_history', 0, $2::jsonb, $3, $4, NOW()) RETURNING id", ["fp2", JSON.stringify(params), null, "dead-host:0:1"]);
    table.get("an-2")!.heartbeat_at = new Date(Date.now() - STALE_HEARTBEAT_MS - 5);
    handleQuery("INSERT INTO smart_segment_analyses (fingerprint, status, stage, progress, params, created_by, owner, heartbeat_at) VALUES ($1, 'queued', 'brand_history', 0, $2::jsonb, $3, $4, NOW()) RETURNING id", ["fp3", JSON.stringify(params), null, "live-host:1:2"]);
    table.get("an-3")!.status = "running"; // fresh heartbeat: untouched
    expect(await sweepStaleSmartSegmentAnalyses()).toBe(2);
    expect(table.get("an-1")).toMatchObject({ status: "failed", error_code: "INTERRUPTED" });
    expect(table.get("an-2")).toMatchObject({ status: "failed", error_code: "INTERRUPTED" });
    expect(table.get("an-3")).toMatchObject({ status: "running" });

    // A frozen instance whose analysis was swept must not overwrite the failure.
    let release: () => void = () => {};
    buildEvidence.mockImplementation(() => new Promise<typeof evidence>((resolve) => { release = () => resolve(evidence); }));
    const { view } = await startSmartSegmentAnalysis({ ...params, campaignName: "Gelée 21/09" }, null, { config, callModel });
    table.get(view.id)!.heartbeat_at = new Date(Date.now() - STALE_HEARTBEAT_MS - 5);
    expect(await sweepStaleSmartSegmentAnalyses()).toBe(1);
    release();
    await waitForSmartSegmentAnalysis(view.id);
    expect(table.get(view.id)).toMatchObject({ status: "failed", error_code: "INTERRUPTED" });
    expect(table.get(view.id)!.proposal).toBeNull();
  });

  it("runs the janitor periodically without keeping the process alive", async () => {
    vi.useFakeTimers();
    try {
      handleQuery("INSERT INTO smart_segment_analyses (fingerprint, status, stage, progress, params, created_by, owner, heartbeat_at) VALUES ($1, 'queued', 'brand_history', 0, $2::jsonb, $3, $4, NOW()) RETURNING id", ["fp", JSON.stringify(params), null, "dead"]);
      table.get("an-1")!.heartbeat_at = null;
      startSmartSegmentJanitor(1_000);
      startSmartSegmentJanitor(1_000); // idempotent
      await vi.advanceTimersByTimeAsync(1_050);
      expect(table.get("an-1")).toMatchObject({ status: "failed", error_code: "INTERRUPTED" });
    } finally {
      stopSmartSegmentJanitor();
      vi.useRealTimers();
    }
  });
});

describe("materializeSmartSegmentProposal", () => {
  async function succeededAnalysis(overrides: Partial<SmartSegmentAnalysisRequest> = {}) {
    const { view } = await startSmartSegmentAnalysis({ ...params, ...overrides }, "user-1", { config, callModel });
    await waitForSmartSegmentAnalysis(view.id);
    clientQueries.length = 0;
    return view.id;
  }

  it("creates the segment with the conventional name and the recounted size, and attaches it to the draft campaign in one transaction", async () => {
    const id = await succeededAnalysis();
    const now = new Date("2026-09-21T10:00:00.000Z");
    const result = await materializeSmartSegmentProposal(id, { campaignId: "camp-draft", proposalIndexes: [0] }, { now: () => now });
    expect(segmentsTable).toHaveLength(1);
    expect(segmentsTable[0]).toMatchObject({ name: "Smart · Air France · 21/09 · FR", cached_count: 2_800, rules: proposal.segments[0].rules });
    expect(segmentsTable[0].description).toContain("claude-test");
    expect(result).toEqual({ segments: [{ index: 0, id: "seg-1", name: "Smart · Air France · 21/09 · FR" }], attached: true, createdSegmentIds: ["seg-1"] });
    expect(statements()).toEqual([
      "BEGIN",
      "SELECT id, fingerprint,", // analysis row locked FOR UPDATE
      "INSERT INTO segments",
      "UPDATE smart_segment_analyses SET",
      "SELECT id, status", // campaign locked FOR UPDATE
      "SELECT COALESCE(MAX(position) +",
      "INSERT INTO campaign_segments",
      "UPDATE campaigns SET",
      "COMMIT",
    ]);
    expect(clientQueries[1].text).toContain("FOR UPDATE");
    expect(clientQueries[4].text).toContain("FOR UPDATE");
    expect(campaignSegments).toEqual([{ campaignId: "camp-draft", segmentId: "seg-1", position: 0 }]);
    expect(campaigns.get("camp-draft")!.segment_id).toBe("seg-1");
    const view = await getSmartSegmentAnalysis(id);
    expect(view?.createdSegments).toEqual([{ index: 0, id: "seg-1", name: "Smart · Air France · 21/09 · FR" }]);
    expect(view?.createdSegmentIds).toEqual(["seg-1"]);
  });

  it("is idempotent per proposal index and numbers the variant", async () => {
    const id = await succeededAnalysis();
    const now = () => new Date("2026-09-21T10:00:00.000Z");
    await materializeSmartSegmentProposal(id, { campaignId: null, proposalIndexes: [0] }, { now });
    const second = await materializeSmartSegmentProposal(id, { campaignId: null, proposalIndexes: [0, 1] }, { now });
    expect(segmentsTable).toHaveLength(2);
    expect(second.segments.map((segment) => segment.name)).toEqual([
      "Smart · Air France · 21/09 · FR",
      "Smart · Air France · 21/09 · FR · 2",
    ]);
    expect(second.attached).toBe(false);
    expect(campaignSegments).toHaveLength(0);
    // Nothing to create the third time: no write at all.
    clientQueries.length = 0;
    await materializeSmartSegmentProposal(id, { campaignId: null, proposalIndexes: [0, 1] }, { now });
    expect(statements()).toEqual(["BEGIN", "SELECT id, fingerprint,", "COMMIT"]);
  });

  it("does not attach to a campaign that is no longer a draft, and rejects unfinished analyses", async () => {
    const id = await succeededAnalysis();
    campaigns.set("camp-draft", { id: "camp-draft", status: "sending", segment_id: null });
    const result = await materializeSmartSegmentProposal(id, { campaignId: "camp-draft", proposalIndexes: [1] });
    expect(result.attached).toBe(false);
    expect(segmentsTable).toHaveLength(1);
    expect(campaignSegments).toHaveLength(0);

    buildEvidence.mockImplementation(() => new Promise(() => {}));
    const pending = await startSmartSegmentAnalysis({ ...params, campaignName: "Autre 21/09" }, null, { config, callModel });
    await expect(materializeSmartSegmentProposal(pending.view.id, {})).rejects.toMatchObject({ code: "NOT_READY", status: 409 });
    await expect(materializeSmartSegmentProposal("missing", {})).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
  });

  it("refuses to attach an analysis made for another campaign", async () => {
    const id = await succeededAnalysis();
    await expect(materializeSmartSegmentProposal(id, { campaignId: "camp-other", proposalIndexes: [0] }))
      .rejects.toMatchObject({ code: "CAMPAIGN_MISMATCH", status: 409 });
    expect(segmentsTable).toHaveLength(0);
    // An analysis started before the draft existed (no campaign) still creates
    // its segments but is never bound to whatever draft is supplied: the
    // wizard attaches them through its own save path.
    const unbound = await succeededAnalysis({ campaignId: undefined, campaignName: "Air France sans brouillon 21/09" });
    const result = await materializeSmartSegmentProposal(unbound, { campaignId: "camp-draft", proposalIndexes: [0] });
    expect(result.segments).toHaveLength(1);
    expect(result.attached).toBe(false);
    expect(statements().some((text) => text.startsWith("INSERT INTO campaign_segments"))).toBe(false);
    // Conversely a bound analysis materialised without campaign is not attached either.
    const bound = await succeededAnalysis({ campaignName: "Air France liée 21/09" });
    const detached = await materializeSmartSegmentProposal(bound, { campaignId: null, proposalIndexes: [0] });
    expect(detached.attached).toBe(false);
  });

  it("rolls everything back when the attach fails: no orphan segment, no created_segments entry", async () => {
    const id = await succeededAnalysis();
    failClientQuery = (text) => (text.startsWith("INSERT INTO campaign_segments") ? new Error("deadlock detected") : null);
    await expect(materializeSmartSegmentProposal(id, { campaignId: "camp-draft", proposalIndexes: [0] }))
      .rejects.toMatchObject({ code: "MATERIALIZE_FAILED", status: 500 });
    expect(statements().at(-1)).toBe("ROLLBACK");
    // The fake has no real rollback; the contract is that the analysis row is
    // only updated inside the same transaction as the segment insert.
    const writes = statements().filter((entry) => entry.startsWith("INSERT") || entry.startsWith("UPDATE"));
    expect(writes).toEqual(["INSERT INTO segments", "UPDATE smart_segment_analyses SET", "INSERT INTO campaign_segments"]);
  });
});
