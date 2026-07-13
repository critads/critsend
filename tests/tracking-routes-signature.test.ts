/**
 * Route-level tests for tracking signature verification (Lot F).
 *
 * Verifies the HTTP contract of the tracking endpoints when the HMAC
 * signature is missing, invalid, or valid:
 *   - open pixel: ALWAYS returns the 1×1 gif (no information leak), but
 *     only enqueues an event when the signature verifies;
 *   - click (lid + legacy): 403 on bad signature, redirect on good one;
 *   - legacy click: non-http(s) URL blocked (open-redirect prevention)
 *     BEFORE any signature work;
 *   - unsubscribe: 403 page on bad signature.
 *
 * The tracking buffer, tracking-pool queries and the bootstrap migration
 * block are mocked so the test never touches the database.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import express from "express";
import type { Server } from "http";

process.env.TRACKING_SECRET = process.env.TRACKING_SECRET || "test-tracking-secret";

const enqueueTrackingEvent = vi.fn();
const getLinkDestinationCached = vi.fn(async (_lid: string) => "https://example.com/dest");

vi.mock("../server/tracking-buffer", () => ({
  enqueueTrackingEvent: (...args: any[]) => enqueueTrackingEvent(...args),
  getLinkDestinationCached: (...args: any[]) => getLinkDestinationCached(...(args as [string])),
  isTrackingPoolUnavailable: () => false,
}));

vi.mock("../server/tracking-queries", () => ({
  resolveTrackingTokenViaTrackingPool: vi.fn(async () => null),
  getCampaignTagsViaTrackingPool: vi.fn(async () => ({
    openTag: null,
    clickTag: null,
    unsubscribeTag: null,
  })),
}));

vi.mock("../server/bootstrap-lock", () => ({
  withAdvisoryLock: vi.fn(async () => {}),
  indexExistsAndValid: vi.fn(async () => true),
  columnHasData: vi.fn(async () => true),
  LOCK_KEYS: new Proxy({}, { get: () => 1 }),
}));

const campaignId = "cafecafe-0000-0000-0000-000000000001";
const subscriberId = "cafecafe-0000-0000-0000-000000000002";

let server: Server;
let base: string;
let signTrackingUrl: typeof import("../server/tracking").signTrackingUrl;

beforeAll(async () => {
  ({ signTrackingUrl } = await import("../server/tracking"));
  const { registerTrackingRoutes } = await import("../server/routes/tracking");
  const app = express();
  registerTrackingRoutes(app);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  if (typeof addr === "object" && addr) base = `http://127.0.0.1:${addr.port}`;
}, 30000);

afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

beforeEach(() => {
  enqueueTrackingEvent.mockClear();
  getLinkDestinationCached.mockClear();
});

describe("open pixel — signature contract", () => {
  it("returns the pixel but records NOTHING on a bad signature", async () => {
    const res = await fetch(`${base}/api/track/open/${campaignId}/${subscriberId}?sig=deadbeef`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/gif");
    // Give the fire-and-forget enqueue path a tick to (not) run.
    await new Promise((r) => setTimeout(r, 50));
    expect(enqueueTrackingEvent).not.toHaveBeenCalled();
  });

  it("returns the pixel and records NOTHING when sig is missing entirely", async () => {
    const res = await fetch(`${base}/o/${campaignId}/${subscriberId}/p.gif`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/gif");
    await new Promise((r) => setTimeout(r, 50));
    expect(enqueueTrackingEvent).not.toHaveBeenCalled();
  });

  it("enqueues an open event on a valid signature (both route aliases)", async () => {
    const sig = signTrackingUrl(campaignId, subscriberId, "open");
    const res = await fetch(`${base}/api/track/open/${campaignId}/${subscriberId}?sig=${sig}`);
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(enqueueTrackingEvent).toHaveBeenCalledTimes(1));
    expect(enqueueTrackingEvent.mock.calls[0][0]).toMatchObject({
      type: "open",
      campaignId,
      subscriberId,
    });

    enqueueTrackingEvent.mockClear();
    const res2 = await fetch(`${base}/o/${campaignId}/${subscriberId}/p.gif?sig=${sig}`);
    expect(res2.status).toBe(200);
    await vi.waitFor(() => expect(enqueueTrackingEvent).toHaveBeenCalledTimes(1));
  });
});

describe("click redirect — signature contract", () => {
  it("403s a bad signature on the lid format and does not redirect", async () => {
    const res = await fetch(
      `${base}/api/track/click/${campaignId}/${subscriberId}?lid=some-link&sig=deadbeef`,
      { redirect: "manual" },
    );
    expect(res.status).toBe(403);
    expect(enqueueTrackingEvent).not.toHaveBeenCalled();
    expect(getLinkDestinationCached).not.toHaveBeenCalled();
  });

  it("redirects on a valid lid signature and enqueues a click", async () => {
    const lid = "lid-123";
    const sig = signTrackingUrl(campaignId, subscriberId, "click", lid);
    const res = await fetch(
      `${base}/api/track/click/${campaignId}/${subscriberId}?lid=${lid}&sig=${sig}`,
      { redirect: "manual" },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://example.com/dest");
    await vi.waitFor(() => expect(enqueueTrackingEvent).toHaveBeenCalledTimes(1));
    expect(enqueueTrackingEvent.mock.calls[0][0]).toMatchObject({ type: "click" });
  });

  it("403s a bad signature on the legacy url format", async () => {
    const url = encodeURIComponent("https://example.com/page");
    const res = await fetch(
      `${base}/api/track/click/${campaignId}/${subscriberId}?url=${url}&sig=deadbeef`,
      { redirect: "manual" },
    );
    expect(res.status).toBe(403);
    expect(enqueueTrackingEvent).not.toHaveBeenCalled();
  });

  it("403s when the signature was made for a DIFFERENT destination url (tamper)", async () => {
    const sig = signTrackingUrl(campaignId, subscriberId, "click", "https://example.com/legit");
    const res = await fetch(
      `${base}/api/track/click/${campaignId}/${subscriberId}?url=${encodeURIComponent("https://evil.example/")}&sig=${sig}`,
      { redirect: "manual" },
    );
    expect(res.status).toBe(403);
  });

  it("blocks non-http(s) redirect targets with 400 (open-redirect prevention)", async () => {
    const bad = "javascript:alert(1)";
    const sig = signTrackingUrl(campaignId, subscriberId, "click", bad);
    const res = await fetch(
      `${base}/api/track/click/${campaignId}/${subscriberId}?url=${encodeURIComponent(bad)}&sig=${sig}`,
      { redirect: "manual" },
    );
    expect(res.status).toBe(400);
    expect(enqueueTrackingEvent).not.toHaveBeenCalled();
  });

  it("redirects on a valid legacy signature", async () => {
    const url = "https://example.com/page?a=1";
    const sig = signTrackingUrl(campaignId, subscriberId, "click", url);
    const res = await fetch(
      `${base}/api/track/click/${campaignId}/${subscriberId}?url=${encodeURIComponent(url)}&sig=${sig}`,
      { redirect: "manual" },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(url);
  });
});

describe("unsubscribe — signature contract", () => {
  it("403s a bad signature without touching subscriber state", async () => {
    const res = await fetch(
      `${base}/api/unsubscribe/${campaignId}/${subscriberId}?sig=deadbeef`,
      { redirect: "manual" },
    );
    expect(res.status).toBe(403);
    expect(enqueueTrackingEvent).not.toHaveBeenCalled();
  });
});
