import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const routesSource = readFileSync(
  new URL("../server/routes/campaigns.ts", import.meta.url),
  "utf8",
);
const senderSource = readFileSync(
  new URL("../server/services/campaign-sender.ts", import.meta.url),
  "utf8",
);
// Both wizards: a new campaign and a saved draft edited then launched.
const wizardSources = {
  "campaign-new.tsx": readFileSync(new URL("../client/src/pages/campaign-new.tsx", import.meta.url), "utf8"),
  "campaign-edit.tsx": readFileSync(new URL("../client/src/pages/campaign-edit.tsx", import.meta.url), "utf8"),
};
const wizardLibSource = readFileSync(new URL("../client/src/lib/campaign-wizard.ts", import.meta.url), "utf8");
const noticesComponentSource = readFileSync(
  new URL("../client/src/components/campaign-wizard/brand-unsubscribe-notices.tsx", import.meta.url),
  "utf8",
);

function routeBody(path: string, nextPath: string): string {
  const start = routesSource.indexOf(path);
  const end = routesSource.indexOf(nextPath, start + path.length);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return routesSource.slice(start, end);
}

// The brand-unsubscribe thresholds are ALERT ONLY (2026-09-29). These checks
// fail if a refusal (409), a sender auto-pause or a wizard hard stop for the
// brand count reappears anywhere.
describe("brand unsubscribe alert-only coverage", () => {
  it("no activation route refuses for the brand count any more", () => {
    expect(routesSource).not.toContain("rejectBlockedBrand");
    expect(routesSource).not.toContain("BRAND_UNSUB_LIMIT_EXCEEDED");
    expect(routesSource).not.toContain("brandUnsubscribeBlockPayload");
    expect(routesSource).not.toMatch(/brandGuard\.status\s*===\s*"(blocked|exceeded)"/);
    // Whatever the variable is called, no non-2xx response statement in the
    // campaign routes may mention the brand notice — the only 4xx/5xx that
    // refers to it is the explicit check endpoint's own 503 ("unavailable").
    const errorStatements = routesSource.match(/res\s*\.status\(\s*[45]\d\d\s*\)[\s\S]*?\);/g) ?? [];
    const brandRefusals = errorStatements.filter((stmt) =>
      /brandGuard|brandUnsubscribe|BrandUnsub|BRAND_UNSUB(?!_CHECK_UNAVAILABLE)/.test(stmt),
    );
    expect(brandRefusals).toEqual([]);
    // The raw (throwing) evaluator is only allowed in the explicit check
    // endpoint; every activation path must go through the non-throwing notice.
    const evaluatorUses = routesSource.match(/evaluateBrandUnsubscribeGuard\(/g) ?? [];
    expect(evaluatorUses).toHaveLength(1);
    const checkRoute = routeBody('app.get("/api/campaigns/brand-unsub-check"', 'app.get("/api/campaigns/:id"');
    expect(checkRoute).toContain("evaluateBrandUnsubscribeGuard(");
  });

  it("no server module pauses a campaign or raises the old error code for the brand count", () => {
    const serverDir = new URL("../server/", import.meta.url).pathname;
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|js)$/.test(entry)) files.push(full);
      }
    };
    walk(serverDir);
    expect(files.length).toBeGreaterThan(50);
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toContain("BRAND_UNSUB_LIMIT_EXCEEDED");
      // Any pauseReason written by the server must not be the brand reason.
      const pauseWrites = source.match(/pauseReason\s*:\s*["'`][^"'`]*["'`]/g) ?? [];
      const brandPauses = pauseWrites.filter((w) => /brand/i.test(w));
      expect(brandPauses, file).toEqual([]);
    }
  });

  it("every activation route still evaluates the brand and carries the notice in its success payload", () => {
    const resume = routeBody('app.post("/api/campaigns/:id/resume"', 'app.post("/api/campaigns/:id/end"');
    expect(resume).toContain('brandUnsubscribeNotice(');
    expect(resume).toContain("withBrandGuard(campaign, resumeBrandNotice)");

    const retry = routeBody('app.post("/api/campaigns/:id/retry-failed"', 'app.post("/api/campaigns/:id/requeue"');
    expect(retry).toContain('brandUnsubscribeNotice(');
    expect(retry).toContain("withBrandGuard({ campaign, resetCount }, retryBrandNotice)");

    const requeue = routeBody('app.post("/api/campaigns/:id/requeue"', 'app.post("/api/campaigns/:id/send"');
    expect(requeue).toContain('brandUnsubscribeNotice(');
    expect(requeue).toContain("withBrandGuard(campaign, requeueBrandNotice)");

    const send = routesSource.slice(routesSource.indexOf('app.post("/api/campaigns/:id/send"'));
    expect(send).toContain('brandUnsubscribeNotice(');
    expect(send).toContain("sendBrandNotice));");

    expect(routesSource).toContain('data.status === "sending" || data.status === "scheduled"');
    expect(routesSource).toContain("createBrandNotice");
    expect(routesSource).toContain("shouldEvaluateBrandGuardForPatch(");
    expect(routesSource).toContain("patchBrandNotice");
  });

  it("the sender neither counts the brand nor pauses a campaign for it", () => {
    expect(senderSource).not.toContain("brand-unsubscribe-guard");
    expect(senderSource).not.toContain("evaluateBrandUnsubscribeGuard");
    expect(senderSource).not.toContain('pauseReason: "brand_unsubscribe_limit"');
  });

  it("the shared brand check reports, never throws, and the notices component renders every state", () => {
    expect(wizardLibSource).toContain("brand-unsub-check?name=");
    expect(wizardLibSource).not.toContain("brand-unsub-check?subject=");
    const checkStart = wizardLibSource.indexOf("export async function checkBrandUnsubscribes");
    const checkBody = wizardLibSource.slice(checkStart, wizardLibSource.indexOf("\n}\n", checkStart));
    expect(checkBody).toContain("unavailable: true");
    expect(checkBody).not.toMatch(/\bthrow\b/);
    for (const testId of ["alert-brand-exceeded", "alert-brand-warning", "alert-brand-check-unavailable"]) {
      expect(noticesComponentSource).toContain(`data-testid="${testId}"`);
    }
    expect(noticesComponentSource).not.toMatch(/disabled|onClick/);
  });

  for (const [file, wizardSource] of Object.entries(wizardSources)) {
    it(`${file}: shows the notices without stopping the progression, even when the check is unavailable`, () => {
      expect(wizardSource).toContain("checkBrandUnsubscribes(formData.name");
      expect(wizardSource).toContain("<BrandUnsubscribeNotices notices={brandNotices} />");
      expect(wizardSource).not.toContain("hard stop: do not advance");
      expect(wizardSource).not.toContain("setBrandBlock");

      const start = wizardSource.indexOf("checkBrandUnsubscribes(formData.name");
      const end = wizardSource.indexOf("setCurrentStep(currentStep + 1)", start);
      expect(end).toBeGreaterThan(start);
      // No early return between the brand check and the step advance.
      expect(wizardSource.slice(start, end)).not.toMatch(/\breturn\b/);
      // The Next button must not be disabled by a notice (only while checking).
      const nextIdx = wizardSource.indexOf('data-testid="button-next-step"');
      const nextButton = wizardSource.slice(nextIdx - 400, nextIdx);
      expect(nextButton).toMatch(/disabled=\{[^}]*brandCheckPending[^}]*\}/);
      expect(nextButton).not.toMatch(/brandNotices/);
      // The launch button is not gated on the notices either.
      const sendIdx = wizardSource.indexOf('data-testid="button-send-campaign"');
      expect(wizardSource.slice(sendIdx - 400, sendIdx)).not.toMatch(/brandNotices|brandCheckPending/);
    });

    it(`${file}: keeps the notices displayed from the check until the launch step`, () => {
      const nextStart = wizardSource.indexOf("const nextStep = async () => {");
      const checkGate = wizardSource.indexOf("if (currentStep === 3) {", wizardSource.indexOf("brand notice", nextStart));
      const firstReset = wizardSource.indexOf("setBrandNotices(EMPTY_BRAND_NOTICES)", nextStart);
      expect(nextStart).toBeGreaterThanOrEqual(0);
      expect(checkGate).toBeGreaterThan(nextStart);
      // Notices are only reset when the brand is re-checked (inside the step-3
      // gate), never on the Tracking → Schedule click.
      expect(firstReset).toBeGreaterThan(checkGate);
      // Going back from Schedule to Tracking keeps them too.
      const prevStart = wizardSource.indexOf("const prevStep = () => {");
      const prevBody = wizardSource.slice(prevStart, wizardSource.indexOf("};", prevStart));
      expect(prevBody).toContain("currentStep - 1 <= 3");
      // The notices render outside renderStepContent, i.e. on every step.
      const renderIdx = wizardSource.indexOf("{renderStepContent()}");
      expect(wizardSource.indexOf("<BrandUnsubscribeNotices notices={brandNotices} />")).toBeGreaterThan(renderIdx);
    });

    it(`${file}: shows the brand notice carried by the launch response`, () => {
      const sendStart = wizardSource.indexOf("const sendMutation = useMutation({");
      const sendBody = wizardSource.slice(sendStart, wizardSource.indexOf("onError", sendStart));
      expect(sendStart).toBeGreaterThanOrEqual(0);
      expect(sendBody).toContain("brandGuardNotice(result)");
      expect(sendBody).toContain("toast(brandGuardToast(guard))");
    });
  }

  it("campaign-edit.tsx: shows the brand notice when saving a rename / status change", () => {
    const editSource = wizardSources["campaign-edit.tsx"];
    const updateStart = editSource.indexOf("const updateMutation = useMutation({");
    const updateBody = editSource.slice(updateStart, editSource.indexOf("onError", updateStart));
    expect(updateStart).toBeGreaterThanOrEqual(0);
    expect(updateBody).toContain("return res.json()");
    expect(updateBody).toContain("brandGuardNotice(result)");
    expect(updateBody).toContain("toast(brandGuardToast(guard))");
  });

  it("keeps the historical pause reason only as a relabelled, resumable state", () => {
    const listSource = readFileSync(new URL("../client/src/pages/campaigns.tsx", import.meta.url), "utf8");
    expect(listSource).toContain('"brand_unsubscribe_limit"');
    expect(listSource).toContain("ancienne limite de désabonnements");
    expect(listSource).not.toContain("Envoi bloqué : cette marque");
  });
});