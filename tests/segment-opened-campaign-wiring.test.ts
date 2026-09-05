import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const routeSource = readFileSync(
  new URL("../server/routes/campaigns.ts", import.meta.url),
  "utf8",
);
const repositorySource = readFileSync(
  new URL("../server/repositories/campaign-repository.ts", import.meta.url),
  "utf8",
);
const builderSource = readFileSync(
  new URL("../client/src/components/segment-builder.tsx", import.meta.url),
  "utf8",
);

describe("selected campaign opener segment wiring", () => {
  it("registers the recent-sent endpoint before the campaign id endpoint", () => {
    const recentRoute = routeSource.indexOf(
      'app.get("/api/campaigns/recent-sent"',
    );
    const idRoute = routeSource.indexOf('app.get("/api/campaigns/:id"');
    expect(recentRoute).toBeGreaterThanOrEqual(0);
    expect(recentRoute).toBeLessThan(idRoute);
  });

  it("only offers campaigns with sends in the last 60 days", () => {
    const methodStart = repositorySource.indexOf(
      "export async function getRecentSentCampaignOptions",
    );
    const nextMethod = repositorySource.indexOf(
      "\nexport ",
      methodStart + 1,
    );
    const implementation = repositorySource.slice(methodStart, nextMethod);
    expect(implementation).toContain("NOW() - INTERVAL '60 days'");
    expect(implementation).toContain("gt(campaigns.sentCount, 0)");
    expect(implementation).toContain(
      "COALESCE(${campaigns.firstSendAt}, ${campaigns.startedAt})",
    );
    expect(implementation).toContain("firstSendAt: effectiveFirstSendAt");
    expect(implementation).not.toContain("isNotNull(campaigns.firstSendAt)");
  });

  it("keeps an aged persisted selection available to the editor", () => {
    expect(builderSource).toContain(
      "recent-sent?include=${encodeURIComponent(selectedCampaignId)}",
    );
    expect(builderSource).toContain("selectedCampaignMissing");
    expect(builderSource).toContain("Previously selected campaign");
    expect(repositorySource).toContain("eq(campaigns.id, includeCampaignId)");
  });

  it("provides campaign search at the top of the dropdown", () => {
    expect(builderSource).toContain('placeholder="Search campaigns..."');
    expect(builderSource).toContain("<CommandInput");
    expect(builderSource).toContain("No campaigns found");
    expect(builderSource).toContain("last 60 days");
  });
});