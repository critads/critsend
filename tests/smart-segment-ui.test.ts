import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { smartSegmentAnalysisIdentity } from "../shared/smart-segment";
import {
  clampComplaintCapPercent,
  complaintRateColor,
  formatSmartSegmentPercent,
  parseSmartSegmentApiError,
} from "../client/src/lib/smart-segment-ui";

describe("Smart segment UI helpers", () => {
  it("formats fractional rates as French percentages", () => {
    expect(formatSmartSegmentPercent(0.0045)).toBe("0,45");
  });

  it("extracts API errors and busy codes", () => {
    expect(parseSmartSegmentApiError(new Error('409: {"error":"Deux analyses sont déjà en cours","code":"SMART_SEGMENT_BUSY"}'))).toEqual({
      status: 409,
      message: "Deux analyses sont déjà en cours",
      code: "SMART_SEGMENT_BUSY",
    });
  });

  it("clamps the complaint cap at 0.6 percent", () => {
    expect(clampComplaintCapPercent(0.9)).toBe(0.6);
    expect(clampComplaintCapPercent(0.45)).toBe(0.45);
  });

  it("selects complaint risk colours at the target and hard cap", () => {
    expect(complaintRateColor(0.0044)).toContain("green");
    expect(complaintRateColor(0.0045)).toContain("amber");
    expect(complaintRateColor(0.006)).toContain("red");
  });
});

describe("Smart segment source wiring", () => {
  const component = readFileSync(new URL("../client/src/components/campaign-wizard/smart-segment-assistant.tsx", import.meta.url), "utf8");
  const newPage = readFileSync(new URL("../client/src/pages/campaign-new.tsx", import.meta.url), "utf8");
  const editPage = readFileSync(new URL("../client/src/pages/campaign-edit.tsx", import.meta.url), "utf8");

  it.each([newPage, editPage])("imports and renders the assistant with wizard props", (source) => {
    expect(source).toContain('import { SmartSegmentAssistant }');
    expect(source).toContain("<SmartSegmentAssistant");
    expect(source).toContain("campaignName={formData.name");
    expect(source).toContain("mtaId={formData.mtaId || null}");
    expect(source).toContain("selectedSegmentIds={segmentIds}");
    expect(source).toContain("onSegmentsCreated=");
  });

  it("polls analyses and posts materialization", () => {
    expect(component).toContain("`/api/smart-segments/analyses/${analysisId}`");
    expect(component).toContain("refetchInterval:");
    expect(component).toContain("`/api/smart-segments/analyses/${analysis.id}/materialize`");
  });

  it("ties the displayed analysis to the exact current inputs (identity shared with the server fingerprint)", () => {
    // Identity built from the immediate request body (name, campaign, family,
    // target, cap, override) — never from the debounced name.
    expect(component).toContain("const requestKey = analysisIdentity(requestBody)");
    expect(component).toMatch(/campaignName: campaignName\.trim\(\),\s+campaignId,\s+mtaId,\s+family,\s+targetClicks: Math\.max\(50, Math\.round\(targetClicks\)\),\s+complaintCap: clampComplaintCapPercent\(complaintCapPercent\) \/ 100,\s+brandOverride: override,/);
    // Reset on any change, fence for late responses, materialisation gated.
    expect(component).toContain("if (key !== currentRequestKey.current) return;");
    expect(component).toContain("const analysisMatchesInputs = !!analysis && analysisIdentity(analysis.params) === requestKey;");
    expect(component.match(/disabled=\{materializeMutation\.isPending \|\| !analysisMatchesInputs\}/g)).toHaveLength(2);
  });
});

describe("smartSegmentAnalysisIdentity", () => {
  it("normalises exactly what the server de-duplicates on, and nothing else", () => {
    const base = { campaignName: " Air France 21/09 ", campaignId: "camp-1", mtaId: "mta-a", family: "fai_fr" as const, targetClicks: 500, complaintCap: 0.0045, brandOverride: { name: " Air France ", ref: "4af" } };
    const same = smartSegmentAnalysisIdentity({ ...base, campaignName: "air france 21/09", mtaId: "mta-b", brandOverride: { name: "air france", ref: "4AF" } });
    expect(smartSegmentAnalysisIdentity(base)).toBe(same);
    expect(smartSegmentAnalysisIdentity({ ...base, complaintCap: 0.006 })).not.toBe(same);
    expect(smartSegmentAnalysisIdentity({ ...base, targetClicks: 501 })).not.toBe(same);
    expect(smartSegmentAnalysisIdentity({ ...base, campaignId: null })).not.toBe(same);
    expect(smartSegmentAnalysisIdentity({ ...base, brandOverride: null })).not.toBe(same);
  });
});