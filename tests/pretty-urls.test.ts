import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { rewriteImageUrls, addTrackingToHtml } from "../server/email-service";

/**
 * Pretty/disguised tracking + image URLs (send-time rewrite).
 *
 * New sends emit neutral `/i/...` (images) and `/o/.../p.gif` (open pixel)
 * paths by default. Setting PRETTY_TRACKING_URLS=false reverts to the legacy
 * `/campaigns/...` and `/api/track/open/...` paths. Either way the legacy
 * serving routes stay registered, so already-sent emails keep resolving.
 */
describe("pretty tracking/image URLs", () => {
  const ORIG = process.env.PRETTY_TRACKING_URLS;
  afterEach(() => {
    if (ORIG === undefined) delete process.env.PRETTY_TRACKING_URLS;
    else process.env.PRETTY_TRACKING_URLS = ORIG;
  });

  const CAMPAIGN_ID = "11111111-1111-1111-1111-111111111111";
  const SUBSCRIBER_ID = "22222222-2222-2222-2222-222222222222";
  const trackingOpts = {
    campaignId: CAMPAIGN_ID,
    subscriberId: SUBSCRIBER_ID,
    trackOpens: true,
    trackClicks: false,
    trackingDomain: "https://track.example.test",
  };

  it("emits /i/ image paths and /o/ open pixel by default (pretty on)", () => {
    delete process.env.PRETTY_TRACKING_URLS;

    const img = rewriteImageUrls(
      `<img src="/campaigns/2026/06/cid/banner.png">`,
      "https://img.example.test",
      { campaignId: "cid", year: "2026", month: "06" },
    );
    expect(img).toContain('src="https://img.example.test/i/2026/06/cid/banner.png"');
    expect(img).not.toContain("/campaigns/");

    const tracked = addTrackingToHtml(`<html><body></body></html>`, trackingOpts);
    // Disguised as a static .gif; sig + mid remain query params (legacy contract).
    expect(tracked).toMatch(
      /<img[^>]+src="https:\/\/track\.example\.test\/o\/[^"]*\/p\.gif\?sig=[^"]*&mid=/,
    );
    expect(tracked).not.toContain("/api/track/open/");
  });

  it("reverts to legacy /campaigns/ and /api/track/open/ when PRETTY_TRACKING_URLS=false", () => {
    process.env.PRETTY_TRACKING_URLS = "false";

    const img = rewriteImageUrls(
      `<img src="/campaigns/2026/06/cid/banner.png">`,
      "https://img.example.test",
      { campaignId: "cid", year: "2026", month: "06" },
    );
    expect(img).toContain('src="https://img.example.test/campaigns/2026/06/cid/banner.png"');
    expect(img).not.toContain("/i/");

    const tracked = addTrackingToHtml(`<html><body></body></html>`, trackingOpts);
    expect(tracked).toMatch(/src="https:\/\/track\.example\.test\/api\/track\/open\//);
    expect(tracked).not.toMatch(/\/o\/[^"]*\/p\.gif/);
  });

  it("honours an explicit prettyUrls override regardless of env", () => {
    process.env.PRETTY_TRACKING_URLS = "false";
    // Explicit per-call override wins over the env default.
    const tracked = addTrackingToHtml(`<html><body></body></html>`, {
      ...trackingOpts,
      prettyUrls: true,
    });
    expect(tracked).toMatch(/src="https:\/\/track\.example\.test\/o\/[^"]*\/p\.gif/);

    const img = rewriteImageUrls(
      `<img src="/campaigns/2026/06/cid/banner.png">`,
      "https://img.example.test",
      { campaignId: "cid", year: "2026", month: "06" },
      false,
    );
    expect(img).toContain("/campaigns/2026/06/cid/banner.png");
  });
});

describe("pretty open route shares the legacy open route's rate limiter", () => {
  it("mounts trackingLimiter on /o/ (parity with /c/ and /u/)", () => {
    // Pretty mode is default ON, so every open pixel now hits /o/. It MUST be
    // rate-limited like the legacy /api/track/open/ path, or default-ON pretty
    // mode silently moves all open traffic onto an unbounded public route.
    const src = readFileSync(join(__dirname, "..", "server", "routes.ts"), "utf8");
    expect(src).toMatch(/app\.use\(["']\/o\/["'],\s*trackingLimiter\)/);
  });
});
