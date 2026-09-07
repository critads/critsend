/**
 * IP-detected complaints temporarily suppress the subscriber without tagging.
 *
 * The current contract:
 *   • An open from a complaint-bot IP (195.154.17.225) is recorded as a
 *     campaign_stats(type='complaint') row and bumps the campaign's
 *     complaints_count (unique per subscriber).
 *   • The subscriber gets no tag, but suppressed_until is advanced to 15 days
 *     after the detection. An existing later deadline is never shortened.
 *   • The FBL/webhook complaint path keeps its current behavior: a complaint
 *     event carrying an unsubscribeTag enqueues the campaign's PLAIN
 *     unsubscribe tag (no STOP- prefix, no suppression window).
 *   • A second complaint from the same (campaign, subscriber) pair does NOT
 *     bump complaints_count again, but still refreshes the temporary window.
 *
 * No real DB: the tracking/flush pools and storage are mocked.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import express from "express";
import type { Server } from "http";

process.env.TRACKING_SECRET = process.env.TRACKING_SECRET || "test-tracking-secret";

// ─── Mocks shared by both suites ────────────────────────────────────────────

const enqueueTagOperation = vi.fn(async () => {});
vi.mock("../server/storage", () => ({
  storage: {
    enqueueTagOperation: (...args: any[]) => enqueueTagOperation(...(args as [])),
  },
}));

vi.mock("../server/services/automation-engine", () => ({
  checkAndEnrollForTrigger: vi.fn(async () => {}),
}));

// flushPool / trackingPool mock: records every query issued (pool-level and
// client-level) so assertions can inspect exactly which SQL ran.
const poolQueries: Array<{ sql: string; params: any[] }> = [];
// Pairs the "already counted?" SELECT should report as existing.
let existingComplaintPairs: Array<{ campaign_id: string; subscriber_id: string }> = [];

async function mockQuery(sql: string, params?: any[]) {
  poolQueries.push({ sql, params: params ?? [] });
  if (/FROM campaign_stats/i.test(sql) && /type = \$/i.test(sql)) {
    // insertBatchAndBumpCounters' pre-INSERT uniqueness probe.
    return { rows: existingComplaintPairs, rowCount: existingComplaintPairs.length };
  }
  return { rows: [], rowCount: 0 };
}

const mockClient = {
  query: (sql: string, params?: any[]) => mockQuery(sql, params),
  release: vi.fn(),
};

vi.mock("../server/tracking-pool", () => ({
  trackingPool: { query: (s: string, p?: any[]) => mockQuery(s, p), totalCount: 0, idleCount: 0 },
  flushPool: {
    query: (s: string, p?: any[]) => mockQuery(s, p),
    connect: async () => mockClient,
    totalCount: 0,
    idleCount: 0,
  },
  getTrackingPoolStats: () => ({ total: 0, idle: 0, max: 6, waiting: 0 }),
  getFlushPoolStats: () => ({ total: 0, idle: 0, max: 6, waiting: 0 }),
  safeTrackingQuery: vi.fn(async () => ({ rows: [], rowCount: 0 })),
}));

vi.mock("../server/tracking-queries", () => ({
  resolveTrackingTokenViaTrackingPool: vi.fn(async () => null),
  getCampaignTagsViaTrackingPool: vi.fn(async () => ({
    openTag: "OPENED-X",
    clickTag: null,
    unsubscribeTag: "UNSUB-X",
  })),
}));

vi.mock("../server/bootstrap-lock", () => ({
  withAdvisoryLock: vi.fn(async () => {}),
  indexExistsAndValid: vi.fn(async () => true),
  columnHasData: vi.fn(async () => true),
  LOCK_KEYS: new Proxy({}, { get: () => 1 }),
}));

const BOT_IP = "195.154.17.225";
const campaignId = "cafecafe-0000-0000-0000-000000000001";
const subscriberId = "cafecafe-0000-0000-0000-000000000002";

// ─── Helpers ────────────────────────────────────────────────────────────────

let buffer: typeof import("../server/tracking-buffer");

/** Drain the buffer queue + side effects, then flush coalesced counters. */
async function drainBuffer() {
  // stop() flushes coalesced counters FIRST, then the queue — so call twice:
  // first drains events (accumulating counter deltas), second writes deltas.
  await buffer.stopTrackingBufferFlusher();
  await buffer.stopTrackingBufferFlusher();
}

function queriesMatching(re: RegExp) {
  return poolQueries.filter((q) => re.test(q.sql));
}

beforeEach(() => {
  poolQueries.length = 0;
  existingComplaintPairs = [];
  enqueueTagOperation.mockClear();
});

// ─── 1. Route contract: bot IP → complaint event with NO tag ───────────────

describe("open pixel from complaint-bot IP — route contract", () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    buffer = await import("../server/tracking-buffer");
    const { signTrackingUrl } = await import("../server/tracking");
    const { registerTrackingRoutes } = await import("../server/routes/tracking");
    const app = express();
    app.set("trust proxy", 1);
    registerTrackingRoutes(app);
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address();
    if (typeof addr === "object" && addr) base = `http://127.0.0.1:${addr.port}`;
    (globalThis as any).__sign = signTrackingUrl;
  }, 30000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  });

  it("records a complaint and suppresses the subscriber for 15 days without a tag", async () => {
    const sig = (globalThis as any).__sign(campaignId, subscriberId, "open");
    const res = await fetch(`${base}/api/track/open/${campaignId}/${subscriberId}?sig=${sig}`, {
      headers: { "x-forwarded-for": BOT_IP },
    });
    expect(res.status).toBe(200);

    // Give the fire-and-forget enqueue a tick, then drain the buffer.
    await new Promise((r) => setTimeout(r, 100));
    await drainBuffer();

    // campaign_stats receives a type='complaint' row for the bot IP…
    const inserts = queriesMatching(/INSERT INTO campaign_stats/i);
    expect(inserts).toHaveLength(1);
    expect(inserts[0].params).toContain("complaint");
    expect(inserts[0].params).toContain(BOT_IP);
    expect(inserts[0].params).not.toContain("open");

    // …and complaints_count is bumped by exactly 1 for this campaign.
    const counterUpdates = queriesMatching(/UPDATE campaigns/i);
    expect(counterUpdates).toHaveLength(1);
    expect(counterUpdates[0].sql).toMatch(/complaints_count/);
    // params layout: (cid, d_total_opens, d_unique_opens, d_total_clicks, d_unique_clicks, d_unsubs, d_complaints)
    expect(counterUpdates[0].params).toEqual([campaignId, 0, 0, 0, 0, 0, 1]);

    // The subscriber receives no tag, but gets a 15-day temporary suppression
    // anchored to the event timestamp. The SQL preserves a later deadline.
    expect(enqueueTagOperation).not.toHaveBeenCalled();
    const suppressions = queriesMatching(/UPDATE subscribers s/i);
    expect(suppressions).toHaveLength(1);
    expect(suppressions[0].sql).toMatch(/suppressed_until\s*=\s*d\.detected_at\s*\+\s*make_interval/i);
    expect(suppressions[0].sql).toMatch(/suppressed_until\s+IS\s+NULL/i);
    expect(suppressions[0].sql).toMatch(/suppressed_until\s*<\s*d\.detected_at/i);
    expect(suppressions[0].params[0]).toEqual([subscriberId]);
    expect(suppressions[0].params[1]).toHaveLength(1);
    expect(suppressions[0].params[1][0]).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/,
    );
    expect(suppressions[0].params[2]).toBe(15);

    const insertIndex = poolQueries.findIndex((q) =>
      /INSERT INTO campaign_stats/i.test(q.sql)
    );
    const suppressionIndex = poolQueries.findIndex((q) =>
      /UPDATE subscribers s/i.test(q.sql)
    );
    const commitIndex = poolQueries.findIndex((q) => /^COMMIT$/i.test(q.sql));
    expect(insertIndex).toBeGreaterThan(-1);
    expect(suppressionIndex).toBeGreaterThan(insertIndex);
    expect(commitIndex).toBeGreaterThan(suppressionIndex);
  });

  it("a normal IP still records a plain open (control)", async () => {
    const sig = (globalThis as any).__sign(campaignId, subscriberId, "open");
    const res = await fetch(`${base}/api/track/open/${campaignId}/${subscriberId}?sig=${sig}`, {
      headers: { "x-forwarded-for": "203.0.113.10" },
    });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 100));
    await drainBuffer();

    const inserts = queriesMatching(/INSERT INTO campaign_stats/i);
    expect(inserts).toHaveLength(1);
    expect(inserts[0].params).toContain("open");
    expect(inserts[0].params).not.toContain("complaint");
  });

  it("does not trust a client-prepended complaint IP", async () => {
    const spoofTestSubscriberId = "cafecafe-0000-0000-0000-000000000003";
    const sig = (globalThis as any).__sign(campaignId, spoofTestSubscriberId, "open");
    const res = await fetch(`${base}/api/track/open/${campaignId}/${spoofTestSubscriberId}?sig=${sig}`, {
      // With one trusted proxy hop, Express uses the rightmost address as the
      // client and ignores the spoofed leftmost value.
      headers: { "x-forwarded-for": `${BOT_IP}, 203.0.113.10` },
    });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 100));
    await drainBuffer();

    const inserts = queriesMatching(/INSERT INTO campaign_stats/i);
    expect(inserts).toHaveLength(1);
    expect(inserts[0].params).toContain("open");
    expect(inserts[0].params).toContain("203.0.113.10");
    expect(inserts[0].params).not.toContain(BOT_IP);
    expect(queriesMatching(/UPDATE subscribers s/i)).toHaveLength(0);
  });
});

// ─── 2. Uniqueness: second complaint from same pair does not re-count ──────

describe("complaint uniqueness per (campaign, subscriber)", () => {
  it("refreshes suppression even when the complaint pair was already counted", async () => {
    existingComplaintPairs = [{ campaign_id: campaignId, subscriber_id: subscriberId }];

    buffer.enqueueTrackingEvent(
      {
        type: "complaint",
        campaignId,
        subscriberId,
        ctx: { ipAddress: BOT_IP },
        unsubscribeTag: null,
      } as any,
      { skipDedupe: true },
    );
    await drainBuffer();

    // The raw analytics row is still inserted (full event history)…
    expect(queriesMatching(/INSERT INTO campaign_stats/i)).toHaveLength(1);
    // …but NO campaigns counter update fires — the pair was already counted.
    expect(queriesMatching(/UPDATE campaigns/i)).toHaveLength(0);
    // Suppression is detection-based, not counter-based, so it is refreshed
    // even though this campaign/subscriber pair was already counted.
    expect(enqueueTagOperation).not.toHaveBeenCalled();
    const suppressions = queriesMatching(/UPDATE subscribers s/i);
    expect(suppressions).toHaveLength(1);
    expect(suppressions[0].params[0]).toEqual([subscriberId]);
    expect(suppressions[0].params[2]).toBe(15);
  });

  it("keeps the latest detection when the same pair fires twice in one batch", async () => {
    buffer.enqueueTrackingEvent(
      {
        type: "complaint",
        campaignId,
        subscriberId,
        ctx: { ipAddress: BOT_IP },
        unsubscribeTag: null,
      } as any,
      { skipDedupe: true },
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    const secondDetectionStartedAt = Date.now();
    buffer.enqueueTrackingEvent(
      {
        type: "complaint",
        campaignId,
        subscriberId,
        ctx: { ipAddress: BOT_IP },
        unsubscribeTag: null,
      } as any,
      { skipDedupe: true },
    );
    await drainBuffer();

    const inserts = queriesMatching(/INSERT INTO campaign_stats/i);
    expect(inserts).toHaveLength(1);
    expect(inserts[0].params.filter((value) => value === "complaint")).toHaveLength(2);

    const suppression = queriesMatching(/UPDATE subscribers s/i);
    expect(suppression).toHaveLength(1);
    expect(suppression[0].params[0]).toEqual([subscriberId]);
    expect(suppression[0].params[1]).toHaveLength(1);
    const latestDetection = Date.parse(
      `${suppression[0].params[1][0].replace(" ", "T")}Z`,
    );
    expect(latestDetection).toBeGreaterThanOrEqual(secondDetectionStartedAt);
  });
});

// ─── 3. FBL-style complaint (with unsubscribeTag) keeps current behavior ───

describe("complaint carrying an unsubscribeTag (FBL webhook path contract)", () => {
  it("enqueues the campaign's PLAIN unsubscribe tag, labelled 'unsubscribe' — no STOP prefix, no suppression", async () => {
    buffer.enqueueTrackingEvent(
      {
        type: "complaint",
        campaignId,
        subscriberId: "fbl-subscriber-1",
        unsubscribeTag: "UNSUB-X",
      } as any,
      { skipDedupe: true },
    );
    await drainBuffer();

    expect(enqueueTagOperation).toHaveBeenCalledTimes(1);
    expect(enqueueTagOperation).toHaveBeenCalledWith(
      "fbl-subscriber-1",
      "UNSUB-X", // plain tag, no STOP- prefix
      "unsubscribe",
      campaignId,
    );
    // FBL complaints without the configured source IP do not get this window.
    expect(queriesMatching(/suppressed_until/i)).toHaveLength(0);
  });

  it("control: a real unsubscribe DOES set suppressed_until (contrast with complaints)", async () => {
    buffer.enqueueTrackingEvent(
      {
        type: "unsubscribe",
        campaignId,
        subscriberId: "unsub-subscriber-1",
        unsubscribeTag: "UNSUB-X",
      } as any,
      { skipDedupe: true },
    );
    await drainBuffer();

    const suppress = queriesMatching(/suppressed_until/i).filter((q) =>
      /UPDATE subscribers/i.test(q.sql),
    );
    expect(suppress).toHaveLength(1);
    expect(suppress[0].params[0]).toEqual(["unsub-subscriber-1"]);
  });
});
