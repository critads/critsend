import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  processHtmlImages,
  normalizeImageHostingDomain,
} from "../server/services/html-image-processor";
import { IMAGES_DIR } from "../server/utils";

const TEST_CAMPAIGN_ID = "test-img-proc-campaign";

function cleanup() {
  fs.rmSync(path.join(IMAGES_DIR, TEST_CAMPAIGN_ID), { recursive: true, force: true });
}

describe("normalizeImageHostingDomain", () => {
  it("returns null for empty values", () => {
    expect(normalizeImageHostingDomain(null)).toBeNull();
    expect(normalizeImageHostingDomain(undefined)).toBeNull();
    expect(normalizeImageHostingDomain("")).toBeNull();
  });

  it("prefixes https:// and strips trailing slash", () => {
    expect(normalizeImageHostingDomain("img.example.com/")).toBe("https://img.example.com");
    expect(normalizeImageHostingDomain("http://img.example.com")).toBe("http://img.example.com");
    expect(normalizeImageHostingDomain("https://img.example.com")).toBe("https://img.example.com");
  });
});

describe("processHtmlImages", () => {
  it("leaves HTML without external images untouched (no downloads)", async () => {
    cleanup();
    const html = `<html><body><img src="/campaigns/2026/08/abc/logo.png"><p>hi</p></body></html>`;
    const result = await processHtmlImages({
      html,
      campaignId: TEST_CAMPAIGN_ID,
      imageHostingDomain: "https://img.example.com",
    });
    expect(result.total).toBe(0);
    expect(result.downloaded).toBe(0);
    expect(result.failed).toBe(0);
    // Local src preserved as-is
    expect(result.html).toContain('src="/campaigns/2026/08/abc/logo.png"');
    cleanup();
  });

  it("keeps original src when download fails (SSRF-blocked host) and counts it failed", async () => {
    cleanup();
    // localhost is blocked by downloadImage's anti-SSRF checks → guaranteed failure without network.
    const blockedUrl = "http://localhost:1/img.png";
    const html = `<html><body><img src="${blockedUrl}"></body></html>`;
    const progress: Array<[number, number]> = [];
    const result = await processHtmlImages({
      html,
      campaignId: TEST_CAMPAIGN_ID,
      imageHostingDomain: "https://img.example.com",
      onProgress: (p, t) => progress.push([p, t]),
    });
    expect(result.total).toBe(1);
    expect(result.downloaded).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.failedUrls).toEqual([blockedUrl]);
    expect(result.html).toContain(`src="${blockedUrl}"`);
    // Initial 0/N event then 1/1
    expect(progress[0]).toEqual([0, 1]);
    expect(progress[progress.length - 1]).toEqual([1, 1]);
    cleanup();
  });

  it("respects cancellation (no processing when cancelled)", async () => {
    cleanup();
    const html = `<html><body><img src="http://localhost:1/a.png"><img src="http://localhost:1/b.png"></body></html>`;
    const result = await processHtmlImages({
      html,
      campaignId: TEST_CAMPAIGN_ID,
      imageHostingDomain: null,
      isCancelled: () => true,
    });
    expect(result.downloaded).toBe(0);
    expect(result.failed).toBe(0);
    cleanup();
  });
});
