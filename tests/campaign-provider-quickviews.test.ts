import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildCampaignProviderQuickViews } from "../server/lib/campaign-provider-quick-views";

const repositorySource = readFileSync(
  new URL("../server/repositories/system-repository.ts", import.meta.url),
  "utf8",
);
const routeSource = readFileSync(
  new URL("../server/routes/analytics.ts", import.meta.url),
  "utf8",
);
const campaignsSource = readFileSync(
  new URL("../client/src/pages/campaigns.tsx", import.meta.url),
  "utf8",
);

describe("campaign provider metric quick views", () => {
  it("builds independent deterministic top 5 opener and top 3 complaint lists", () => {
    const result = buildCampaignProviderQuickViews([
      { provider: "zeta.test", recipients: 500, uniqueOpeners: 50, complaints: 0 },
      { provider: "alpha.test", recipients: 500, uniqueOpeners: 100, complaints: 1 },
      { provider: "bravo.test", recipients: 400, uniqueOpeners: 80, complaints: 4 },
      { provider: "charlie.test", recipients: 300, uniqueOpeners: 30, complaints: 4 },
      { provider: "delta.test", recipients: 200, uniqueOpeners: 10, complaints: 2 },
      { provider: "echo.test", recipients: 100, uniqueOpeners: 5, complaints: 9 },
      { provider: "foxtrot.test", recipients: 50, uniqueOpeners: 1, complaints: 8 },
    ]);

    expect(result.openers.map((row) => row.provider)).toEqual([
      "alpha.test",
      "zeta.test",
      "bravo.test",
      "charlie.test",
      "delta.test",
    ]);
    expect(result.complaints.map((row) => row.provider)).toEqual([
      "echo.test",
      "foxtrot.test",
      "bravo.test",
    ]);
    expect(result.openers[0]).toMatchObject({
      recipients: 500,
      uniqueOpeners: 100,
      openRate: 20,
    });
    expect(result.complaints[0]).toMatchObject({
      recipients: 100,
      complaints: 9,
      complaintRate: 9,
    });
  });

  it("uses recipient count then provider name to break complaint ties", () => {
    const result = buildCampaignProviderQuickViews([
      { provider: "zeta.test", recipients: 20, uniqueOpeners: 0, complaints: 2 },
      { provider: "bravo.test", recipients: 30, uniqueOpeners: 0, complaints: 2 },
      { provider: "alpha.test", recipients: 30, uniqueOpeners: 0, complaints: 2 },
    ]);

    expect(result.complaints.map((row) => row.provider)).toEqual([
      "alpha.test",
      "bravo.test",
      "zeta.test",
    ]);
  });

  it("limits aggregate inputs to sent campaign recipients", () => {
    expect(repositorySource).toContain("cs.status = 'sent'");
  });

  it("uses unique historical complaint detections", () => {
    expect(repositorySource).toContain("st.ip_address = '195.154.17.225'");
    expect(repositorySource).toContain("st.type IN ('open', 'complaint')");
    expect(repositorySource).toContain("COUNT(DISTINCT CASE");
  });

  it("exposes the validated analytics endpoint", () => {
    expect(routeSource).toContain(
      'app.get("/api/analytics/campaign/:id/provider-quick-views"',
    );
    expect(routeSource).toContain("validateId(req.params.id)");
    expect(routeSource).toContain("getCampaignProviderQuickViews(req.params.id)");
  });

  it("makes opener and complaint totals accessible quick-view triggers", () => {
    expect(campaignsSource).toContain("button-opens-quick-view-");
    expect(campaignsSource).toContain("button-complaints-quick-view-");
    expect(campaignsSource).toContain("event.stopPropagation()");
    expect(campaignsSource).toContain("dialog-provider-quick-view");
    expect(campaignsSource).toContain("provider-quick-view-loading");
    expect(campaignsSource).toContain("provider-quick-view-error");
    expect(campaignsSource).toContain("provider-quick-view-empty");
  });
});