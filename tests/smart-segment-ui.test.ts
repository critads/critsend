import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { normalizeSimilarRefs, smartSegmentAnalysisIdentity } from "../shared/smart-segment";
import {
  clampComplaintCapPercent,
  complaintRateColor,
  defaultSimilarBrandRefs,
  formatSmartSegmentPercent,
  isTransientSimilarBrandsError,
  parseSmartSegmentApiError,
  validateManualSimilarRef,
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

  it("checks every similar-brand candidate by default and canonicalises request refs", () => {
    const candidates = [
      { name: "Zed", refs: ["z9"], reason: "Même cible." },
      { name: "Alpha", refs: ["a1", "A1B"], reason: "Même secteur." },
    ];
    const checked = defaultSimilarBrandRefs(candidates);
    expect(checked).toEqual(["A1", "A1B", "Z9"]);
    expect(normalizeSimilarRefs([...checked, "m2"])).toEqual(["A1", "A1B", "M2", "Z9"]);
  });

  it("uppercases manual refs and refuses own refs or DEL", () => {
    expect(validateManualSimilarRef(" 4tui ", ["CORE", "ECORE"], [])).toEqual({ ref: "4TUI", error: null });
    expect(validateManualSimilarRef("core", ["CORE", "ECORE"], []).ref).toBeNull();
    expect(validateManualSimilarRef("del", ["CORE"], []).ref).toBeNull();
  });

  it("retries the similar-brands lookup only on gateway / capacity errors", () => {
    expect(isTransientSimilarBrandsError({ status: 504, message: "504: gateway" })).toBe(true);
    expect(isTransientSimilarBrandsError({ status: 502, body: { error: "modèle indisponible", code: "AI_UNAVAILABLE" } })).toBe(true);
    expect(isTransientSimilarBrandsError({ status: 429, message: "429" })).toBe(true);
    expect(isTransientSimilarBrandsError({ status: 400, message: "400: bad request" })).toBe(false);
    expect(isTransientSimilarBrandsError({ status: 409, body: { error: "annuaire vide", code: "SMART_SEGMENT_DIRECTORY_EMPTY" } })).toBe(false);
    expect(isTransientSimilarBrandsError(new Error("boom"))).toBe(false);
  });

  it("caps the similar-ref selection at eight", () => {
    const selected = Array.from({ length: 8 }, (_, index) => `R${index}`);
    expect(validateManualSimilarRef("R9", [], selected)).toEqual({ ref: null, error: "8 refs maximum" });
    const candidates = Array.from({ length: 9 }, (_, index) => ({ name: `Brand ${index}`, refs: [`r${index}`], reason: "" }));
    expect(defaultSimilarBrandRefs(candidates)).toHaveLength(8);
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

  it("asks the server for AI similar brands by brand name (web search), with refresh, retry and bounded auto-retry", () => {
    expect(component).toContain('apiRequest("POST", "/api/smart-segments/similar-brands", {');
    expect(component).toContain("brandName: similarBrandName,");
    expect(component).toContain("...(similarRefreshNonce > 0 ? { refresh: true } : {})");
    expect(component).toContain('queryKey: ["/api/smart-segments/similar-brands", similarKey, similarRefreshNonce]');
    expect(component).toContain("enabled: similarBrandName.length > 0");
    // Billed lookup: no background refetch may re-run it or wipe the operator's ticks.
    expect(component).toContain("staleTime: Infinity");
    expect(component).toContain("refetchOnWindowFocus: false");
    expect(component).toContain("retry: (failureCount, error) => failureCount < 2 && isTransientSimilarBrandsError(error)");
    expect(component).toContain('data-testid="button-smart-segment-similar-refresh"');
    expect(component).toContain('data-testid="button-smart-segment-similar-retry"');
    expect(component).toContain("defaultSimilarBrandRefs(similarBrandsQuery.data.brands)");
    // The co-occurrence wording is gone: candidates are brands of the directory chosen by the model.
    expect(component).not.toContain("co-occurrence");
    expect(component).not.toContain("candidate.lift");
  });

  it("labels proposals by their server-derived kind and attaches ONE nested proposal at a time (no bulk create)", () => {
    expect(component).toContain("SMART_SEGMENT_PROPOSAL_KIND_LABELS[segment.kind]");
    // Nested audiences: one exclusive « Utiliser » per card, plus « Créer sans attacher ».
    expect(component).toContain("materializeMutation.mutate({ index, attach: true })");
    expect(component).toContain("materializeMutation.mutate({ index, attach: false })");
    expect(component).toContain('data-testid={`button-smart-segment-create-only-${index}`}');
    expect(component).toContain('{attachedIndex !== null ? "Utiliser ce segment à la place" : createdEntry ? "Attacher ce segment" : "Utiliser ce segment"}');
    expect(component).not.toContain("button-smart-segment-create-all");
    expect(component).not.toContain("Créer les {");
    // The request carries the attach flag; the wizard mirrors the server's exclusivity.
    expect(component).toMatch(/proposalIndexes: \[index\],\s+attach,/);
    expect(component).toContain("const detachSegmentIds = createdEntries.map((entry) => entry.id).filter((id) => !attachedIds.has(id));");
    expect(component).toContain("onSegmentsCreated(data.segments, { detachSegmentIds });");
    expect(component).toContain("const attachedIndex = createdEntries.find((entry) => selectedSegmentIds.includes(entry.id))?.index ?? null;");
  });

  it("renders the « Projeté vs réel » panel for the resolved brand", () => {
    const panel = readFileSync(new URL("../client/src/components/campaign-wizard/smart-segment-outcomes.tsx", import.meta.url), "utf8");
    expect(component).toContain("<SmartSegmentOutcomesPanel campaignName={debouncedName} brandOverride={override} enabled={configured && brandReady} />");
    expect(panel).toContain('queryKey: ["/api/smart-segments/outcomes", campaignName, brandOverride]');
    expect(panel).toContain("/api/smart-segments/outcomes?");
    expect(panel).toContain("staleTime:");
  });

  it.each([newPage, editPage])("drops the detached sibling from the wizard selection when a proposal is swapped", (source) => {
    expect(source).toContain("onSegmentsCreated={(createdSegments, { detachSegmentIds }) => {");
    expect(source).toContain("const kept = current.filter((id) => !detachSegmentIds.includes(id));");
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
    expect(component).toContain("...(similarRefs.length > 0 ? { similarRefs } : {})");
    // The cap is rounded at the identity's precision (0,45 / 100 ≠ 0,0045 in floating point).
    expect(component).toMatch(/campaignName: campaignName\.trim\(\),\s+campaignId,\s+mtaId,\s+family,\s+targetClicks: Math\.max\(50, Math\.round\(targetClicks\)\),\s+(\/\/[^\n]*\n\s+)*complaintCap: normalizeComplaintCap\(clampComplaintCapPercent\(complaintCapPercent\) \/ 100\),\s+brandOverride: override,/);
    // Reset on any change, fence for late responses, materialisation gated.
    expect(component).toContain("if (key !== currentRequestKey.current) return;");
    expect(component).toContain("const analysisMatchesInputs = !!analysis && analysisIdentity(analysis.params) === requestKey;");
    expect(component).toContain("const busy = materializeMutation.isPending || !analysisMatchesInputs;");
    expect(component.match(/disabled=\{busy\}/g)).toHaveLength(2);
  });
});

describe("smartSegmentAnalysisIdentity", () => {
  it("normalises exactly what the server de-duplicates on, and nothing else", () => {
    const base = { campaignName: " Air France 21/09 ", campaignId: "camp-1", mtaId: "mta-a", family: "fai_fr" as const, targetClicks: 500, complaintCap: 0.0045, brandOverride: { name: " Air France ", ref: "4af" } };
    const same = smartSegmentAnalysisIdentity({ ...base, campaignName: "air france 21/09", mtaId: " mta-a ", brandOverride: { name: "air france", ref: "4AF" } });
    expect(smartSegmentAnalysisIdentity(base)).toBe(same);
    // The cap is compared at 1e-6: 0,45 / 100 and 0,0045 are the same request.
    expect(smartSegmentAnalysisIdentity({ ...base, complaintCap: 0.45 / 100 })).toBe(same);
    expect(smartSegmentAnalysisIdentity({ ...base, complaintCap: 0.006 })).not.toBe(same);
    // The sending MTA changes the calibration (complaint capture): part of the identity.
    expect(smartSegmentAnalysisIdentity({ ...base, mtaId: "mta-b" })).not.toBe(same);
    expect(smartSegmentAnalysisIdentity({ ...base, targetClicks: 501 })).not.toBe(same);
    expect(smartSegmentAnalysisIdentity({ ...base, campaignId: null })).not.toBe(same);
    expect(smartSegmentAnalysisIdentity({ ...base, brandOverride: null })).not.toBe(same);
  });

  it("changes when the similar-brand selection changes", () => {
    const base = { campaignName: "Air France", campaignId: "camp-1", family: "fai_fr" as const, targetClicks: 500, complaintCap: 0.0045, brandOverride: null };
    expect(smartSegmentAnalysisIdentity({ ...base, similarRefs: ["A1"] }))
      .not.toBe(smartSegmentAnalysisIdentity({ ...base, similarRefs: ["A1", "B2"] }));
    expect(smartSegmentAnalysisIdentity({ ...base, similarRefs: ["b2", "A1"] }))
      .toBe(smartSegmentAnalysisIdentity({ ...base, similarRefs: ["A1", "B2"] }));
  });
});