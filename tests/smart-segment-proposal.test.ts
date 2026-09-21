import { describe, expect, it, vi } from "vitest";

vi.mock("../server/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../server/db", () => ({ pool: {}, db: {}, getPoolSaturation: () => 0 }));
vi.mock("../server/repositories/campaign-repository", () => ({ getSegmentPerformanceHistoryCandidates: vi.fn() }));

import type { SmartSegmentAnalysisRequest, SmartSegmentEvidence } from "../shared/smart-segment";
import { SMART_SEGMENT_ALLOWED_OPERATORS } from "../shared/smart-segment";
import {
  auditModelRules,
  buildSmartSegmentPrompt,
  expandBlockMacros,
  generateSmartSegmentProposal,
  sanitizeModelText,
  validateAndProject,
  ModelOutputRejected,
} from "../server/services/smart-segment-proposal";
import type { AudienceMeasure } from "../server/services/smart-segment-projection";
import type { SegmentRulesV2 } from "../shared/schema";
import { SmartSegmentError } from "../server/services/smart-segment-evidence";
import { AnthropicClientError } from "../server/services/anthropic-client";
import { aggregateCohortRates, buildBlockLibrary,
  splitProjectableBlocks, condition, group, projectBlock } from "../server/services/smart-segment-projection";

const brand = {
  detected: true,
  source: "directory" as const,
  brandName: "Air France",
  coreRefs: ["4AF"],
  extensionRefs: ["US4AF", "E4AF"],
  unsubscribeTags: ["U4AF", "UUS4AF"],
  vertical: "4",
  verticalLabel: "Voyage",
  verticalRefs: ["4TUI"],
  matchedKeys: ["air\u001ffrance"],
};

const cohortRates = aggregateCohortRates([
  { axis: "clicker_tier", cohort: "0", delivered: 100_000, humanClickers: 500, botClickers: 0, complaints: 60 },
  { axis: "clicker_tier", cohort: "6+", delivered: 4_000, humanClickers: 480, botClickers: 0, complaints: 1 },
  { axis: "clicker_tier", cohort: "4-5", delivered: 5_000, humanClickers: 400, botClickers: 0, complaints: 1 },
  { axis: "clicker_tier", cohort: "1", delivered: 20_000, humanClickers: 600, botClickers: 0, complaints: 8 },
  { axis: "clicker_tier", cohort: "2-3", delivered: 10_000, humanClickers: 500, botClickers: 0, complaints: 3 },
  { axis: "ref_relation", cohort: "core", delivered: 30_000, humanClickers: 900, botClickers: 0, complaints: 300 },
  { axis: "ref_relation", cohort: "extension", delivered: 10_000, humanClickers: 200, botClickers: 0, complaints: 12 },
  { axis: "ref_relation", cohort: "none", delivered: 99_000, humanClickers: 900, botClickers: 0, complaints: 40 },
]);

function makeEvidence(): SmartSegmentEvidence {
  const { projectable: definitions } = splitProjectableBlocks(buildBlockLibrary(brand), cohortRates);
  const availability: Record<string, number> = {
    clickers_6plus: 3_000, clickers_4plus: 6_000, clickers_1plus: 25_000, warm_openers: 90_000,
    openers_vertical: 20_000, brand_core_refs: 40_000, brand_extension_refs: 8_000,
  };
  const blocks = definitions.map((definition) => projectBlock(definition, availability[definition.id] ?? 0, cohortRates, "brand", { "6+": 3_000, "4-5": 3_000, "2-3": 9_000, "1": 10_000 }));
  return {
    version: 1,
    generatedAt: "2026-09-21T00:00:00.000Z",
    brand,
    family: "fai_fr",
    brandSends: [{
      campaignId: "camp-old", name: "Air France 01/09", firstSendAt: "2026-09-01T08:00:00.000Z", delivered: 120_000,
      segmentNames: ["FR - Cliqueurs"], humanClickers: 2_400, botClickers: 300, complaints: 90, unsubscribes: 40,
      humanCtr: 0.02, complaintRate: 0.00075, finished: true, usedForCalibration: true,
    }],
    recentBrandCampaignIds: ["camp-recent"],
    campaignNames: { "camp-old": "Air France 01/09", "camp-recent": "Air France 15/09" },
    calibrationLevel: "brand",
    calibrationCampaignIds: ["camp-old"],
    cohortRates,
    blocks,
    mandatoryExclusions: ["Exclusion des boîtes détectées par l'IP de plainte"],
    budget: { elapsedMs: 1200, queries: 12, sampledCampaigns: [] },
    notes: [],
  };
}

const params: SmartSegmentAnalysisRequest = {
  campaignName: "Air France 21/09",
  campaignId: null,
  mtaId: null,
  family: "fai_fr",
  targetClicks: 500,
  complaintCap: 0.0045,
  brandOverride: null,
};

function modelOutput(children: unknown[], extra: Partial<{ name: string; blocksUsed: string[]; warnings: string[]; rationale: string }> = {}) {
  return JSON.stringify({
    segments: [{
      name: extra.name ?? "Cliqueurs très actifs",
      rules: { version: 2, root: { type: "group", combinator: "AND", children } },
      blocksUsed: extra.blocksUsed ?? [],
      rationale: extra.rationale ?? "Les cliqueurs les plus assidus de la marque : le meilleur rendement pour le moins de plaintes.",
      warnings: extra.warnings ?? [],
    }],
  });
}

/**
 * Fake recount: the whole audience lands in the most specific clicker tier
 * named by the rules (a real recount partitions by measured clicks).
 */
function measureAs(total: number | ((rules: SegmentRulesV2) => number)) {
  return async (rules: SegmentRulesV2): Promise<AudienceMeasure> => {
    const count = typeof total === "function" ? total(rules) : total;
    const json = JSON.stringify(rules);
    const tier = json.includes("ultra_active_clicker") ? "6+" : json.includes("top_active_clicker") ? "4-5" : json.includes("clicked_recently") ? "2-3" : "0";
    return { total: count, tierCounts: count > 0 ? { [tier]: count } : {} };
  };
}

describe("smart segment prompt", () => {
  it("contains the dossier, the operator whitelist and no SQL, and stays under a bounded size", () => {
    const evidence = makeEvidence();
    const prompt = buildSmartSegmentPrompt(evidence, params, null);
    expect(prompt.system).toContain("UNIQUEMENT par un objet JSON");
    for (const operator of SMART_SEGMENT_ALLOWED_OPERATORS) expect(prompt.system).toContain(operator);
    expect(prompt.user).toContain('"objectifClics":500');
    expect(prompt.user).toContain("clickers_6plus");
    expect(prompt.user).toContain("camp-recent");
    expect(prompt.user).not.toMatch(/\bSELECT\b/i);
    expect(prompt.user.length).toBeLessThan(40_000);
    const withFeedback = buildSmartSegmentPrompt(evidence, params, "taux de plaintes projeté trop élevé");
    expect(withFeedback.user).toContain("refusée par le serveur : taux de plaintes projeté trop élevé");
  });
});

describe("smart segment model output validation", () => {
  it("expands {block} macros into the exact block rules and reports unknown ids", () => {
    const evidence = makeEvidence();
    const raw = { segments: [{ rules: { version: 2, root: { type: "group", combinator: "AND", children: [{ block: "clickers_6plus" }, { block: "nope" }] } } }] };
    const expanded = expandBlockMacros(raw, evidence);
    expect(expanded.blockIds).toEqual(["clickers_6plus"]);
    expect(expanded.unknown).toEqual(["nope"]);
    const root = (expanded.output as any).segments[0].rules.root;
    expect(root.children[0]).toEqual(evidence.blocks[0].rules);
  });

  it("rejects unknown operators, tag-based inclusion, foreign refs and unknown campaigns", () => {
    const evidence = makeEvidence();
    const reasons = auditModelRules({
      version: 2,
      root: group("AND", [
        condition("tags", "has_tag", "C4AF"),
        condition("tags", "not_has_tag", "CLICKERS"),
        condition("refs", "has_ref", "9ZZZ"),
        condition("engagement", "opened_campaign", "camp-unknown"),
        condition("email", "ends_with", "@gmail.com"),
        { type: "condition", field: "date_added", operator: "equals", value: "2026-01-01", value2: null } as any,
        condition("email", "contains" as any, "x"),
      ]),
    }, evidence);
    expect(reasons.some((r) => r.includes("inclusion par tag interdite"))).toBe(true);
    expect(reasons.some((r) => r.includes("tag inconnu « CLICKERS »"))).toBe(true);
    expect(reasons.some((r) => r.includes("ref « 9ZZZ » absente"))).toBe(true);
    expect(reasons.some((r) => r.includes("campagne « camp-unknown » absente"))).toBe(true);
    expect(reasons.some((r) => r.includes("domaine « @gmail.com » hors de la famille"))).toBe(true);
    expect(reasons.some((r) => r.includes("champ non autorisé « date_added »"))).toBe(true);
    expect(reasons.some((r) => r.includes("opérateur non autorisé « contains »"))).toBe(true);
  });

  it("accepts block rules plus known refs, campaigns and unsubscribe tags", () => {
    const evidence = makeEvidence();
    const reasons = auditModelRules({
      version: 2,
      root: group("AND", [
        evidence.blocks[0].rules,
        condition("refs", "has_ref", "4TUI"),
        condition("refs", "not_has_ref", "DEL"),
        condition("tags", "not_has_tag", "U4AF"),
        condition("engagement", "not_received_campaign", "camp-recent"),
        condition("engagement", "clicked_campaign", "camp-old"),
        condition("email", "ends_with", "@orange.fr"),
      ]),
    }, evidence);
    expect(reasons).toEqual([]);
  });

  it("injects the mandatory exclusions, recounts through the server and projects from the blocks used", async () => {
    const evidence = makeEvidence();
    const counted: number[] = [];
    const segments = await validateAndProject(
      "```json\n" + modelOutput([{ block: "clickers_6plus" }]) + "\n```",
      evidence,
      params,
      async (rules) => {
        counted.push(rules.root.children.length);
        // The recount receives the rules WITH the injected exclusions.
        expect(JSON.stringify(rules)).toContain("not_opened_from_bot_ip");
        expect(JSON.stringify(rules)).toContain("not_received_campaign");
        return { total: 2_800, tierCounts: { "6+": 2_800 } };
      },
    );
    expect(counted).toHaveLength(1);
    expect(segments).toHaveLength(1);
    expect(segments[0].audienceCount).toBe(2_800);
    expect(segments[0].blocksUsed).toEqual(["clickers_6plus"]);
    expect(segments[0].injectedExclusions.length).toBeGreaterThanOrEqual(5);
    expect(segments[0].projectedClicks.high).toBe(Math.round(2_800 * 0.12 * 1.15));
    expect(segments[0].readableRules[0]).toBe("Tous les critères suivants :");
    expect(segments[0].readableRules.join("\n")).toContain("a pas reçu la campagne « Air France 15/09 »");
  });

  it("attributes blocks per segment from the expanded macros only, never from the declaration or a sibling", async () => {
    const evidence = makeEvidence();
    const rawOutput = JSON.stringify({
      segments: [
        {
          name: "Cliqueurs très actifs",
          rules: { version: 2, root: { type: "group", combinator: "AND", children: [{ block: "clickers_6plus" }] } },
          blocksUsed: ["clickers_6plus"],
          rationale: "Bloc mesuré.",
          warnings: [],
        },
        {
          // Raw rules dressed up as the safe block: the declaration must not
          // borrow the 6+ clickers' rates.
          name: "Refs de la marque",
          rules: { version: 2, root: { type: "group", combinator: "AND", children: [condition("refs", "has_ref", "4AF")] } },
          blocksUsed: ["clickers_6plus"],
          rationale: "Large.",
          warnings: [],
        },
      ],
    });
    const counted: unknown[] = [];
    const segments = await validateAndProject(rawOutput, evidence, params, async (rules) => { counted.push(rules); return { total: 2_800, tierCounts: { "6+": 2_800 } }; });
    // The raw-inclusion segment is refused outright (fail closed): it is never
    // even counted, so its unmeasured population cannot borrow any rate.
    expect(segments).toHaveLength(1);
    expect(counted).toHaveLength(1);
    expect(segments[0].blocksUsed).toEqual(["clickers_6plus"]);
    expect(segments[0].projectedClicks.high).toBe(Math.round(2_800 * 0.12 * 1.15));

    const onlyRaw = JSON.stringify({ segments: [JSON.parse(rawOutput).segments[1]] });
    await expect(validateAndProject(onlyRaw, evidence, params, measureAs(3_000))).rejects.toMatchObject({
      name: "ModelOutputRejected",
      reasons: [expect.stringContaining("critère d'inclusion hors bibliothèque « refs has_ref 4AF »")],
    });
  });

  it("accepts hand-written exclusions on a block but refuses any hand-written inclusion or block-less segment", async () => {
    const evidence = makeEvidence();
    const withExclusions = JSON.stringify({
      segments: [{
        name: "6+ sans extension",
        rules: { version: 2, root: { type: "group", combinator: "AND", children: [
          { block: "clickers_6plus" },
          condition("refs", "not_has_ref", "4AF"),
          condition("engagement", "not_received_campaign", "camp-old"),
        ] } },
        blocksUsed: ["clickers_6plus"],
        rationale: "Exclusions seulement.",
        warnings: [],
      }],
    });
    const ok = await validateAndProject(withExclusions, evidence, params, measureAs(2_000));
    expect(ok).toHaveLength(1);
    expect(ok[0].blocksUsed).toEqual(["clickers_6plus"]);

    for (const [label, children] of [
      ["clicked_campaign", [{ block: "clickers_6plus" }, condition("engagement", "clicked_campaign", "camp-old")]],
      ["ends_with", [{ block: "clickers_6plus" }, condition("email", "ends_with", "@orange.fr")]],
      ["not_engaged_recently", [{ block: "clickers_6plus" }, condition("engagement", "not_engaged_recently")]],
      ["no block", [condition("refs", "not_has_ref", "4AF")]],
    ] as const) {
      const output = JSON.stringify({ segments: [{ name: label, rules: { version: 2, root: { type: "group", combinator: "AND", children } }, blocksUsed: [], rationale: "x", warnings: [] }] });
      await expect(validateAndProject(output, evidence, params, measureAs(2_000)), label).rejects.toMatchObject({ name: "ModelOutputRejected" });
    }
  });

  it("refuses an allowed exclusion placed under an OR, which would widen beyond the calibrated blocks", async () => {
    const evidence = makeEvidence();
    const segmentWith = (root: unknown) => JSON.stringify({ segments: [{ name: "x", rules: { version: 2, root }, blocksUsed: ["clickers_6plus"], rationale: "x", warnings: [] }] });
    const widened = segmentWith({ type: "group", combinator: "OR", children: [{ block: "clickers_6plus" }, condition("tags", "not_has_tag", "U4AF")] });
    await expect(validateAndProject(widened, evidence, params, measureAs(900_000))).rejects.toMatchObject({
      name: "ModelOutputRejected",
      reasons: [expect.stringContaining("n'impliquent pas l'appartenance à un bloc calibré")],
    });
    const nestedWidening = segmentWith({ type: "group", combinator: "AND", children: [
      condition("refs", "not_has_ref", "4AF"),
      { type: "group", combinator: "OR", children: [{ block: "clickers_6plus" }, { type: "group", combinator: "AND", children: [condition("tags", "not_has_tag", "U4AF")] }] },
    ] });
    await expect(validateAndProject(nestedWidening, evidence, params, measureAs(900_000))).rejects.toMatchObject({ name: "ModelOutputRejected" });

    // Legitimate shapes: OR of blocks, exclusions in AND at any level.
    for (const root of [
      { type: "group", combinator: "AND", children: [{ type: "group", combinator: "OR", children: [{ block: "clickers_6plus" }, { block: "clickers_4plus" }] }, condition("tags", "not_has_tag", "U4AF")] },
      { type: "group", combinator: "OR", children: [{ type: "group", combinator: "AND", children: [{ block: "clickers_6plus" }, condition("refs", "not_has_ref", "4AF")] }, { block: "clickers_4plus" }] },
    ]) {
      const accepted = await validateAndProject(segmentWith(root), evidence, params, measureAs(2_000));
      expect(accepted).toHaveLength(1);
    }
  });

  it("rejects a composition whose projected complaint rate exceeds the cap", async () => {
    const evidence = makeEvidence();
    await expect(validateAndProject(
      modelOutput([{ block: "brand_core_refs" }]),
      evidence,
      params,
      measureAs(40_000),
    )).rejects.toBeInstanceOf(ModelOutputRejected);
  });

  it("rejects a zero-audience proposal and a schema-invalid answer", async () => {
    const evidence = makeEvidence();
    await expect(validateAndProject(modelOutput([{ block: "clickers_6plus" }]), evidence, params, measureAs(0)))
      .rejects.toThrow(/effectif nul/);
    await expect(validateAndProject('{"segments":[]}', evidence, params, measureAs(10)))
      .rejects.toThrow(/schéma/);
  });
});

describe("model-authored text never carries a figure", () => {
  it("strips figure-bearing sentences, replaces a numeric name and lets server block labels through", () => {
    const evidence = makeEvidence();
    const cleaned = sanitizeModelText({
      name: "Cliqueurs 6+ premium",
      rationale: "Le bloc clickers_6plus est le plus sûr. Il compte 3 000 abonnés à 12 % de CTR humain ; le plafond de 0,45 % est respecté. On y ajoute « Cliqueurs très actifs (6+ campagnes en 60 j) » pour le volume.\nRien d'autre n'est nécessaire.",
      warnings: ["Objectif de 5 000 clics hors de portée.", "Créa et objet comptent beaucoup."],
    }, ["clickers_6plus"], evidence);
    expect(cleaned.name).toBe(evidence.blocks[0].label);
    expect(cleaned.rationale).toBe("Le bloc clickers_6plus est le plus sûr. On y ajoute « Cliqueurs très actifs (6+ campagnes en 60 j) » pour le volume. Rien d'autre n'est nécessaire.");
    expect(cleaned.warnings).toEqual(["Créa et objet comptent beaucoup."]);
    expect(cleaned.strippedSentences).toBe(3);
    expect(/\d/.test(cleaned.rationale.replace(evidence.blocks[0].label, "").replace("clickers_6plus", ""))).toBe(false);
  });

  it("displays only server figures: hallucinated numbers are dropped and the recount-based explanation is appended", async () => {
    const evidence = makeEvidence();
    const output = modelOutput([{ block: "clickers_6plus" }], {
      name: "Cliqueurs assidus",
      rationale: "Ce bloc regroupe 250 000 abonnés avec 40 % de CTR et zéro plainte. C'est la base la plus sûre de la marque.",
      warnings: ["Le taux de plaintes réel sera de 0,01 %."],
    });
    const [segment] = await validateAndProject(output, evidence, params, measureAs(2_800));
    expect(segment.name).toBe("Cliqueurs assidus");
    expect(segment.rationale).not.toContain("250 000");
    expect(segment.rationale).not.toContain("40 %");
    expect(segment.rationale).toContain("C'est la base la plus sûre de la marque.");
    expect(segment.rationale).toContain("Chiffres serveur");
    expect(segment.rationale).toContain(`${(2_800).toLocaleString("fr-FR")} abonnés`);
    expect(segment.rationale).toContain(`${segment.projectedClicks.low.toLocaleString("fr-FR")} – ${segment.projectedClicks.high.toLocaleString("fr-FR")} clics humains`);
    expect(segment.warnings.some((w) => w.includes("0,01 %"))).toBe(false);
    expect(segment.warnings.some((w) => w.includes("phrases chiffrées"))).toBe(true);
  });

  it("asks the model for figure-free text", () => {
    const prompt = buildSmartSegmentPrompt(makeEvidence(), params, null);
    expect(prompt.system + prompt.user).toContain("AUCUN chiffre");
  });
});

describe("generateSmartSegmentProposal", () => {
  it("retries once with the server's feedback, then succeeds", async () => {
    const evidence = makeEvidence();
    const prompts: string[] = [];
    const callModel = vi.fn(async (prompt: { system: string; user: string }) => {
      prompts.push(prompt.user);
      const first = prompts.length === 1;
      return {
        text: first ? modelOutput([{ block: "brand_core_refs" }]) : modelOutput([{ block: "clickers_6plus" }]),
        model: "claude-test",
        stopReason: "end_turn",
        usage: { inputTokens: 1_000, outputTokens: 200 },
      };
    });
    const proposal = await generateSmartSegmentProposal(evidence, params, {
      callModel,
      measureAudience: measureAs((rules) => (JSON.stringify(rules).includes("ultra_active_clicker") ? 2_800 : 40_000)),
    }, { model: "claude-config" });
    expect(callModel).toHaveBeenCalledTimes(2);
    expect(prompts[1]).toContain("refusée par le serveur");
    expect(prompts[1]).toContain("plafond");
    expect(proposal.attempts).toBe(2);
    expect(proposal.model).toBe("claude-test");
    expect(proposal.tokenUsage).toEqual({ inputTokens: 2_000, outputTokens: 400 });
    expect(proposal.segments[0].blocksUsed).toEqual(["clickers_6plus"]);
  });

  it("fails explicitly after two rejected attempts", async () => {
    const evidence = makeEvidence();
    const callModel = vi.fn(async () => ({ text: "je ne sais pas", model: "m", stopReason: null, usage: null }));
    await expect(generateSmartSegmentProposal(evidence, params, { callModel, measureAudience: measureAs(1) }, { model: "m" }))
      .rejects.toMatchObject({ code: "AI_PROPOSAL_REJECTED", status: 422 });
    expect(callModel).toHaveBeenCalledTimes(2);
  });

  it("maps a non-retryable client error to a SmartSegmentError without retrying", async () => {
    const evidence = makeEvidence();
    const callModel = vi.fn(async () => { throw new AnthropicClientError("clé invalide", 401, false, "AI_AUTH"); });
    const error = await generateSmartSegmentProposal(evidence, params, { callModel, measureAudience: measureAs(1) }, { model: "m" }).catch((e) => e);
    expect(error).toBeInstanceOf(SmartSegmentError);
    expect(error.code).toBe("AI_AUTH");
    expect(error.status).toBe(503);
    expect(callModel).toHaveBeenCalledTimes(1);
  });

  it("retries a retryable transport error once", async () => {
    const evidence = makeEvidence();
    let calls = 0;
    const callModel = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new AnthropicClientError("529", 529, true, "AI_UNAVAILABLE");
      return { text: modelOutput([{ block: "clickers_6plus" }]), model: "m", stopReason: null, usage: null };
    });
    const proposal = await generateSmartSegmentProposal(evidence, params, { callModel, measureAudience: measureAs(2_000) }, { model: "m" });
    expect(proposal.attempts).toBe(2);
    expect(proposal.tokenUsage).toBeNull();
  });
});
