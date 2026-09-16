/**
 * The continue link is presentation-only. These route tests mock every
 * database-facing module and model the atomic INSERT ... RETURNING result in
 * memory, including the same-IP race.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import express from "express";
import type { Server } from "http";
import { signTrackingUrl } from "../server/tracking";

process.env.TRACKING_SECRET = process.env.TRACKING_SECRET || "test-tracking-secret";
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://test:test@127.0.0.1:1/test";

const mocks = vi.hoisted(() => ({
  enqueueTrackingEvent: vi.fn(),
  resolveToken: vi.fn(),
  safeTrackingQuery: vi.fn(),
  claimFailure: false,
  claimedHashes: new Set<string>(),
}));

vi.mock("../server/tracking-buffer", () => ({
  enqueueTrackingEvent: (...args: any[]) => mocks.enqueueTrackingEvent(...args),
  getLinkDestinationCached: vi.fn(async () => "https://example.com/dest"),
  isTrackingPoolUnavailable: () => false,
}));

vi.mock("../server/tracking-queries", () => ({
  resolveTrackingTokenViaTrackingPool: (...args: any[]) => mocks.resolveToken(...args),
  getCampaignTagsViaTrackingPool: vi.fn(async () => ({
    openTag: null,
    clickTag: null,
    unsubscribeTag: null,
  })),
}));

vi.mock("../server/tracking-pool", () => ({
  safeTrackingQuery: (...args: any[]) => mocks.safeTrackingQuery(...args),
}));

vi.mock("../server/bootstrap-lock", () => ({
  withAdvisoryLock: vi.fn(async () => {}),
  indexExistsAndValid: vi.fn(async () => true),
  columnHasData: vi.fn(async () => true),
  LOCK_KEYS: new Proxy({}, { get: () => 1 }),
  runIndexDdlNoTimeout: vi.fn(async () => {}),
}));

vi.mock("../server/db", () => ({
  db: { execute: vi.fn(async () => ({ rows: [] })) },
  pool: { connect: vi.fn() },
  isPoolCheckoutError: () => false,
}));

vi.mock("../server/storage", () => ({ storage: {} }));

const unsubscribeToken = {
  type: "unsubscribe",
  campaignId: "campaign-one",
  subscriberId: "subscriber-one",
  linkId: null,
};
const secondCampaignToken = {
  type: "unsubscribe",
  campaignId: "campaign-two",
  subscriberId: "subscriber-two",
  linkId: null,
};

let server: Server;
let base: string;

beforeAll(async () => {
  mocks.resolveToken.mockImplementation(async (token: string) => (
    token === "valid" ? unsubscribeToken
      : token === "valid-again" ? secondCampaignToken
        : null
  ));
  mocks.safeTrackingQuery.mockImplementation(async (_query: string, params: [string]) => {
    if (mocks.claimFailure) throw new Error("claim database unavailable");
    const [ipHash] = params;
    if (mocks.claimedHashes.has(ipHash)) return { rows: [] };
    // The set operation is synchronous, matching the atomic unique-key
    // decision made by PostgreSQL before a concurrent caller can return.
    mocks.claimedHashes.add(ipHash);
    return { rows: [{ ip_hash: ipHash }] };
  });

  const { registerTrackingRoutes } = await import("../server/routes/tracking");
  const app = express();
  // This mirrors the trusted proxy setting used by the production server and
  // lets the tests provide distinct client addresses without a real proxy.
  app.set("trust proxy", true);
  registerTrackingRoutes(app);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (typeof address === "object" && address) base = `http://127.0.0.1:${address.port}`;
}, 30000);

afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

beforeEach(() => {
  mocks.enqueueTrackingEvent.mockClear();
  mocks.safeTrackingQuery.mockClear();
  mocks.claimFailure = false;
  mocks.claimedHashes.clear();
});

describe("GET /u/:token continue presentation claim", () => {
  it("shows the button once, then hides it for every token/campaign at that IP", async () => {
    const first = await fetch(`${base}/u/valid`, {
      headers: { "x-forwarded-for": "198.51.100.10" },
    });
    const repeat = await fetch(`${base}/u/valid-again`, {
      headers: { "x-forwarded-for": "198.51.100.10" },
    });

    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("private, no-store");
    expect(await first.text()).toContain("Cliquez-ici pour continuer");
    expect(await repeat.text()).not.toContain("Cliquez-ici pour continuer");
    expect(mocks.safeTrackingQuery).toHaveBeenCalledTimes(2);
    expect(mocks.enqueueTrackingEvent).toHaveBeenCalledTimes(2);
  });

  it("allows a different IP to win its own global claim", async () => {
    const first = await fetch(`${base}/u/valid`, {
      headers: { "x-forwarded-for": "198.51.100.11" },
    });
    const differentIp = await fetch(`${base}/u/valid`, {
      headers: { "x-forwarded-for": "198.51.100.12" },
    });

    expect(await first.text()).toContain("Cliquez-ici pour continuer");
    expect(await differentIp.text()).toContain("Cliquez-ici pour continuer");
    expect(mocks.enqueueTrackingEvent).toHaveBeenCalledTimes(2);
  });

  it("lets the atomic claim decide a same-IP race", async () => {
    const [first, second] = await Promise.all([
      fetch(`${base}/u/valid`, { headers: { "x-forwarded-for": "198.51.100.20" } }),
      fetch(`${base}/u/valid-again`, { headers: { "x-forwarded-for": "198.51.100.20" } }),
    ]);
    const bodies = await Promise.all([first.text(), second.text()]);
    expect(bodies.filter((body) => body.includes("Cliquez-ici pour continuer"))).toHaveLength(1);
    expect(mocks.enqueueTrackingEvent).toHaveBeenCalledTimes(2);
  });

  it("normalizes IPv4-mapped IPv6 and equivalent IPv6 spellings", async () => {
    const mapped = await fetch(`${base}/u/valid`, {
      headers: { "x-forwarded-for": "::ffff:198.51.100.30" },
    });
    const expanded = await fetch(`${base}/u/valid-again`, {
      headers: { "x-forwarded-for": "198.51.100.30" },
    });
    expect(await mapped.text()).toContain("Cliquez-ici pour continuer");
    expect(await expanded.text()).not.toContain("Cliquez-ici pour continuer");
  });

  it("normalizes equivalent compressed and expanded IPv6 spellings", async () => {
    const compressed = await fetch(`${base}/u/valid`, {
      headers: { "x-forwarded-for": "2001:db8::42" },
    });
    const expanded = await fetch(`${base}/u/valid-again`, {
      headers: { "x-forwarded-for": "2001:0db8:0:0:0:0:0:0042" },
    });
    expect(await compressed.text()).toContain("Cliquez-ici pour continuer");
    expect(await expanded.text()).not.toContain("Cliquez-ici pour continuer");
  });

  it("hides the button on claim failure but still confirms and records unsubscribe", async () => {
    mocks.claimFailure = true;
    const response = await fetch(`${base}/u/valid`, {
      headers: { "x-forwarded-for": "198.51.100.40" },
    });
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain("Votre demande est enregistrée");
    expect(body).not.toContain("Cliquez-ici pour continuer");
    expect(mocks.enqueueTrackingEvent).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueTrackingEvent.mock.calls[0][0]).toMatchObject({ type: "unsubscribe" });
  });

  it("does not claim an invalid token", async () => {
    const response = await fetch(`${base}/u/not-a-token`, {
      headers: { "x-forwarded-for": "198.51.100.50" },
    });
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain("Cliquez-ici pour continuer");
    expect(mocks.safeTrackingQuery).not.toHaveBeenCalled();
    expect(mocks.enqueueTrackingEvent).not.toHaveBeenCalled();
  });

  it("hides the button for an invalid client IP without claiming", async () => {
    const response = await fetch(`${base}/u/valid`, {
      headers: { "x-forwarded-for": "not-an-ip" },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain("Cliquez-ici pour continuer");
    expect(mocks.safeTrackingQuery).not.toHaveBeenCalled();
    expect(mocks.enqueueTrackingEvent).toHaveBeenCalledTimes(1);
  });

  it("uses one presentation deadline when the claim never settles", async () => {
    const previousImplementation = mocks.safeTrackingQuery.getMockImplementation();
    mocks.safeTrackingQuery.mockImplementation(() => new Promise(() => {}));
    const startedAt = Date.now();
    try {
      const response = await fetch(`${base}/u/valid`, {
        headers: { "x-forwarded-for": "198.51.100.70" },
      });
      const elapsed = Date.now() - startedAt;
      expect(response.status).toBe(200);
      expect(elapsed).toBeLessThan(900);
      expect(await response.text()).not.toContain("Cliquez-ici pour continuer");
      expect(mocks.enqueueTrackingEvent).toHaveBeenCalledTimes(1);
    } finally {
      if (previousImplementation) {
        mocks.safeTrackingQuery.mockImplementation(previousImplementation);
      }
    }
  });
});

it("legacy GET unsubscribe still claims presentation and queues its event", async () => {
  const campaignId = "legacy-campaign";
  const subscriberId = "legacy-subscriber";
  const signature = signTrackingUrl(campaignId, subscriberId, "unsubscribe");
  const response = await fetch(
    `${base}/api/unsubscribe/${campaignId}/${subscriberId}?sig=${signature}`,
    { headers: { "x-forwarded-for": "198.51.100.80" } },
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(await response.text()).toContain("Cliquez-ici pour continuer");
  expect(mocks.enqueueTrackingEvent).toHaveBeenCalledTimes(1);
  expect(mocks.enqueueTrackingEvent.mock.calls[0][0]).toMatchObject({ type: "unsubscribe" });
});

it("POST /u/:token remains JSON unsubscribe processing and never claims", async () => {
  const response = await fetch(`${base}/u/valid`, {
    method: "POST",
    headers: {
      "x-forwarded-for": "198.51.100.60",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "List-Unsubscribe=One-Click",
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ unsubscribed: true });
  expect(mocks.safeTrackingQuery).not.toHaveBeenCalled();
  expect(mocks.enqueueTrackingEvent).toHaveBeenCalledTimes(1);
  expect(mocks.enqueueTrackingEvent.mock.calls[0][0]).toMatchObject({ type: "unsubscribe" });
});