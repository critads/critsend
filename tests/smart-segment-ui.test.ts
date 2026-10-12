import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SMART_SEGMENT_PROPOSAL_KIND_LABELS, normalizeSimilarRefs, smartSegmentAnalysisIdentity } from "../shared/smart-segment";
import {
  clampComplaintCapPercent,
  complaintRateColor,
  defaultAffinityBrandRefs,
  defaultSimilarBrandRefs,
  formatSmartSegmentPercent,
  isTransientSimilarBrandsError,
  parseSmartSegmentApiError,
  validateManualAffinityRef,
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

  it("checks every affinity-brand candidate by default, capped at eight", () => {
    const candidates = [
      { name: "Maisons du Monde", refs: ["2mdm"], reason: "Même clientèle, autre secteur." },
      { name: "Club Med", refs: ["4CM", "4cmed"], reason: "Voyages haut de gamme." },
    ];
    expect(defaultAffinityBrandRefs(candidates)).toEqual(["2MDM", "4CM", "4CMED"]);
    const many = Array.from({ length: 9 }, (_, index) => ({ name: `Brand ${index}`, refs: [`${(index % 3) + 1}R${index}`], reason: "" }));
    expect(defaultAffinityBrandRefs(many)).toHaveLength(8);
  });

  it("refuses a manual affinity ref of the brand's own vertical or already kept as similar, before the server does", () => {
    const context = { brandVertical: "6", similarRefs: ["6DJ"] };
    expect(validateManualAffinityRef(" 2mdm ", ["6MB", "E6MB"], [], context)).toEqual({ ref: "2MDM", error: null });
    // Same vertical digit as the brand (6 = Bijoux): belongs to the similar selection.
    expect(validateManualAffinityRef("6xyz", ["6MB"], [], context)).toEqual({ ref: null, error: "Cette ref est du même secteur que la marque : ajoutez-la plutôt aux marques similaires." });
    // US / E extensions carry the vertical of their core ref.
    expect(validateManualAffinityRef("US6XYZ", ["6MB"], [], context).ref).toBeNull();
    expect(validateManualAffinityRef("E2MDM", ["6MB"], [], context)).toEqual({ ref: "E2MDM", error: null });
    // Already in the similar selection, own brand, DEL, duplicates and the cap.
    expect(validateManualAffinityRef("6dj", ["6MB"], [], context)).toEqual({ ref: null, error: "Cette ref figure déjà parmi les marques similaires." });
    expect(validateManualAffinityRef("6MB", ["6MB"], [], context)).toEqual({ ref: null, error: "Cette ref ne peut pas être ajoutée." });
    expect(validateManualAffinityRef("del", ["6MB"], [], context).ref).toBeNull();
    expect(validateManualAffinityRef("2MDM", ["6MB"], ["2MDM"], context)).toEqual({ ref: null, error: "Cette ref est déjà sélectionnée." });
    expect(validateManualAffinityRef("1CAR", ["6MB"], Array.from({ length: 8 }, (_, index) => `2R${index}`), context)).toEqual({ ref: null, error: "8 refs maximum" });
    // Brand without a vertical (manual override with an unknown prefix): the sector check cannot apply, the ref is accepted.
    expect(validateManualAffinityRef("6XYZ", ["XMB"], [], { brandVertical: null, similarRefs: [] })).toEqual({ ref: "6XYZ", error: null });
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

  it("labels proposals by their server-derived kind and lets the operator attach several proposals of one analysis as distinct segments", () => {
    expect(component).toContain("SMART_SEGMENT_PROPOSAL_KIND_LABELS[segment.kind]");
    // The third segment is labelled by what it contains, not as the recommendation widened.
    expect(SMART_SEGMENT_PROPOSAL_KIND_LABELS.similar_brands).toBe("Marques similaires uniquement");
    expect(SMART_SEGMENT_PROPOSAL_KIND_LABELS.similar_brands).not.toMatch(/^Avec /);
    expect(component).not.toContain("audiences imbriquées");
    expect(component).not.toContain("« avec marques similaires »");
    expect(component).toContain("Cette sélection sert au segment « marques similaires uniquement »");
    // The help text describes the server composition: actives 60 d + last open/click 61–180 d, band dropped only for the cap or missing history.
    expect(component).toContain("dont la dernière ouverture / clic date de 61 à 180 jours");
    expect(component).toContain("La bande 61–180 j n'est retirée que si le plafond de plaintes l'impose ou si l'historique ne permet pas de la projeter");
    expect(component).not.toContain("les actifs 60 j porteurs d'une de ces refs, sans");
    // Per card: a tick box (2+ proposals), an additive « Utiliser / Ajouter / Attacher », and « Créer sans attacher ».
    expect(component).toContain('data-testid={`checkbox-smart-segment-select-${index}`}');
    expect(component).toContain("materializeMutation.mutate({ indexes: [index], attach: true })");
    expect(component).toContain("materializeMutation.mutate({ indexes: [index], attach: false })");
    expect(component).toContain('data-testid={`button-smart-segment-create-only-${index}`}');
    expect(component).toContain('{createdEntry ? "Attacher ce segment" : attachedIndexes.size > 0 ? "Ajouter ce segment" : "Utiliser ce segment"}');
    expect(component).not.toContain("Utiliser ce segment à la place");
    expect(component).not.toContain("détache la précédente");
    // Bulk action on the ticked proposals; already attached ones cannot be ticked again.
    expect(component).toContain('data-testid="button-smart-segment-attach-selection"');
    expect(component).toContain("materializeMutation.mutate({ indexes: [...selectableIndexes].sort((a, b) => a - b), attach: true })");
    expect(component).toContain("checkedIndexes.filter((index) => !attachedIndexes.has(index)");
    expect(component).toContain("Cochez 2 à 4 propositions pour les attacher ensemble");
    // Recommendation + variant are nested: allowed, but said out loud.
    expect(component).toContain('data-testid="text-smart-segment-nested-warning"');
    expect(component).toContain('kinds.has("recommendation") && kinds.has("variant")');
    // The request carries the attach flag; nothing is detached on the wizard side.
    expect(component).toMatch(/proposalIndexes: indexes,\s+attach,/);
    expect(component).toContain("if (attach) onSegmentsCreated(data.segments);");
    expect(component).not.toContain("detachSegmentIds");
    // A late response (inputs or analysis changed meanwhile) never enters the audience,
    // and a refused server attach (campaign left 'draft') is reported, not mirrored.
    expect(component).toContain("if (forAnalysisId !== analysis?.id || forRequestKey !== currentRequestKey.current) return;");
    expect(component).toContain("if (attach && serverBindable && !data.attached) {");
  });

  it("offers the « similar audience, other sector » selection next to the similar brands and sends it as affinityRefs", () => {
    // Its own panel, fed by the same lookup (profile + affinity brands), checked by default.
    expect(component).toContain('data-testid="smart-segment-affinity-brands"');
    expect(component).toContain("setCheckedAffinityRefs(defaultAffinityBrandRefs(similarBrandsQuery.data.affinityBrands ?? []))");
    expect(component).toContain('data-testid="text-smart-segment-affinity-profile"');
    expect(component).toContain("data-testid={`checkbox-smart-segment-affinity-${refs[0] ?? candidate.name}`}");
    expect(component).toContain('data-testid="input-smart-segment-affinity-ref"');
    expect(component).toContain("validateManualAffinityRef(manualAffinityInput, ownBrandRefs, affinityRefs, { brandVertical, similarRefs })");
    // The help text says what the 4th proposal is and that the server enforces « other sector ».
    expect(component).toContain("mais qui vendent dans un AUTRE secteur");
    expect(component).toContain("Cette sélection sert à une 4e proposition, « audience similaire hors secteur », composée uniquement des porteurs d'une de ces refs");
    expect(component).toContain("Le serveur refuse toute ref du secteur de la marque.");
    // A ref kept as similar never reaches the affinity list; the request carries the list only when non-empty, and it is part of the identity.
    expect(component).toContain("const affinityRefs = normalizeSimilarRefs([...checkedAffinityRefs, ...manualAffinityRefs]).filter((ref) => !similarRefs.includes(ref));");
    expect(component).toContain("...(affinityRefs.length > 0 ? { affinityRefs } : {})");
    expect(component).toMatch(/similarRefs\.join\(","\), affinityRefs\.join\(","\)\]/);
    // Proposal cards and the dossier name the 4th kind and the kept affinity brands.
    expect(SMART_SEGMENT_PROPOSAL_KIND_LABELS.affinity_brands).toBe("Audience similaire hors secteur");
    expect(component).toContain('segment.kind === "similar_brands" || segment.kind === "affinity_brands" ? "default" : "secondary"');
    expect(component).toContain('data-testid="text-smart-segment-evidence-affinity"');
    expect(component).toContain("Marques d'affinité hors secteur retenues :");
  });

  it("renders the « Projeté vs réel » panel for the resolved brand", () => {
    const panel = readFileSync(new URL("../client/src/components/campaign-wizard/smart-segment-outcomes.tsx", import.meta.url), "utf8");
    expect(component).toContain("<SmartSegmentOutcomesPanel campaignName={debouncedName} brandOverride={override} enabled={configured && brandReady} />");
    expect(panel).toContain('queryKey: ["/api/smart-segments/outcomes", campaignName, brandOverride]');
    expect(panel).toContain("/api/smart-segments/outcomes?");
    expect(panel).toContain("staleTime:");
  });

  it.each([newPage, editPage])("adds attached proposals to the wizard selection without dropping what is already selected", (source) => {
    expect(source).toContain("onSegmentsCreated={(createdSegments) => {");
    expect(source).toContain("const next = [...current, ...createdIds.filter((id) => !current.includes(id))];");
    expect(source).not.toContain("detachSegmentIds");
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
    // Tick box, « Utiliser/Ajouter/Attacher » and « Créer sans attacher » per card.
    expect(component.match(/disabled=\{busy\}/g)).toHaveLength(3);
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

  it("changes when the affinity-brand selection changes, independently of the similar one", () => {
    const base = { campaignName: "Mauboussin", campaignId: "camp-1", family: "fai_fr" as const, targetClicks: 500, complaintCap: 0.0045, brandOverride: null, similarRefs: ["6DJ"] };
    const withAffinity = smartSegmentAnalysisIdentity({ ...base, affinityRefs: ["2MDM", "4CM"] });
    expect(withAffinity).not.toBe(smartSegmentAnalysisIdentity(base));
    expect(withAffinity).not.toBe(smartSegmentAnalysisIdentity({ ...base, affinityRefs: ["2MDM"] }));
    expect(smartSegmentAnalysisIdentity({ ...base, affinityRefs: ["4cm", "2mdm"] })).toBe(withAffinity);
    // The same refs as similar instead of affinity are another analysis.
    expect(smartSegmentAnalysisIdentity({ ...base, similarRefs: ["6DJ", "2MDM", "4CM"] })).not.toBe(withAffinity);
  });

  it("changes when the similar-brand selection changes", () => {
    const base = { campaignName: "Air France", campaignId: "camp-1", family: "fai_fr" as const, targetClicks: 500, complaintCap: 0.0045, brandOverride: null };
    expect(smartSegmentAnalysisIdentity({ ...base, similarRefs: ["A1"] }))
      .not.toBe(smartSegmentAnalysisIdentity({ ...base, similarRefs: ["A1", "B2"] }));
    expect(smartSegmentAnalysisIdentity({ ...base, similarRefs: ["b2", "A1"] }))
      .toBe(smartSegmentAnalysisIdentity({ ...base, similarRefs: ["A1", "B2"] }));
  });
});