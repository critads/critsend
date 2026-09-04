import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const routesSource = readFileSync(
  new URL("../server/routes/campaigns.ts", import.meta.url),
  "utf8",
);
const senderSource = readFileSync(
  new URL("../server/services/campaign-sender.ts", import.meta.url),
  "utf8",
);
const wizardSource = readFileSync(
  new URL("../client/src/pages/campaign-new.tsx", import.meta.url),
  "utf8",
);

function routeBody(path: string, nextPath: string): string {
  const start = routesSource.indexOf(path);
  const end = routesSource.indexOf(nextPath, start + path.length);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return routesSource.slice(start, end);
}

describe("brand unsubscribe enforcement coverage", () => {
  it("guards every explicit campaign activation route", () => {
    expect(routeBody('app.post("/api/campaigns/:id/resume"', 'app.post("/api/campaigns/:id/end"'))
      .toContain("rejectBlockedBrand");
    expect(routeBody('app.post("/api/campaigns/:id/retry-failed"', 'app.post("/api/campaigns/:id/requeue"'))
      .toContain("rejectBlockedBrand");
    expect(routeBody('app.post("/api/campaigns/:id/requeue"', 'app.post("/api/campaigns/:id/send"'))
      .toContain("rejectBlockedBrand");
    expect(routesSource.slice(routesSource.indexOf('app.post("/api/campaigns/:id/send"')))
      .toContain("rejectBlockedBrand(res, effectiveCampaign.name)");
    expect(routesSource).toContain('data.status === "sending" || data.status === "scheduled"');
    expect(routesSource).toContain("shouldEvaluateBrandGuardForPatch(");
  });

  it("checks again in the sender before any campaign processing", () => {
    const guard = senderSource.indexOf("evaluateBrandUnsubscribeGuard(campaign.name)");
    const retryWindow = senderSource.indexOf("const nowMs = Date.now()", guard);
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(retryWindow).toBeGreaterThan(guard);
    expect(senderSource.slice(guard, retryWindow)).toContain('status: "paused"');
    expect(senderSource.slice(guard, retryWindow)).toContain('pauseReason: "brand_unsubscribe_limit"');
  });

  it("uses the campaign name in the wizard and fails closed when unavailable", () => {
    expect(wizardSource).toContain("brand-unsub-check?name=");
    expect(wizardSource).not.toContain("brand-unsub-check?subject=");
    expect(wizardSource).toContain("setBrandCheckUnavailable(true)");
    expect(wizardSource).toContain("Impossible de vérifier actuellement");
  });
});