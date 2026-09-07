import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const newCampaignSource = readFileSync(
  "client/src/pages/campaign-new.tsx",
  "utf8",
);
const editCampaignSource = readFileSync(
  "client/src/pages/campaign-edit.tsx",
  "utf8",
);

function audienceResetSection(source: string): string {
  const testIdIndex = source.indexOf('data-testid="button-reset-segments"');
  return source.slice(Math.max(0, testIdIndex - 600), testIdIndex + 200);
}

describe("campaign audience reset control", () => {
  it.each([
    ["creation", newCampaignSource],
    ["editing", editCampaignSource],
  ])("resets inclusions and exclusions while %s", (_screen, source) => {
    const reset = audienceResetSection(source);
    expect(reset).toContain("segmentIds: []");
    expect(reset).toContain('segmentId: ""');
    expect(reset).toContain('excludeSegmentId: ""');
    expect(reset).toContain("setShowExclusion(false)");
    expect(reset).toContain("segmentIds.length > 0");
  });
});