import { describe, expect, it, vi } from "vitest";

vi.mock("../server/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("../server/db", () => ({ pool: { query: vi.fn(async () => { throw new Error("no db in unit tests"); }) }, db: {} }));
vi.mock("../server/storage", () => ({ storage: {} }));

import {
  brandNameKey,
  buildSimilarBrandsPrompt,
  excludedSimilarRefs,
  groupDirectoryRows,
  lookupSimilarBrands,
  selectSimilarBrands,
  similarBrandCacheKey,
  SimilarBrandsOutputMalformed,
  stripPerformanceFigures,
  SMART_SEGMENT_MAX_CONCURRENT_SIMILAR_LOOKUPS,
  describeAffinityRejections,
  validateAffinityRefs,
  validateSimilarRefs,
  withAffinityRefs,
  withSimilarRefs,
  type DirectoryBrand,
  type SimilarBrandDeps,
  type SimilarBrandLookupResult,
} from "../server/services/smart-segment-similar";
import { AnthropicClientError, type AnthropicMessageRequest, type AnthropicMessageResponse } from "../server/services/anthropic-client";
import { resolveSmartSegmentBrand } from "../server/services/smart-segment-brand";
import { SmartSegmentError } from "../server/services/smart-segment-evidence";
import { SMART_SEGMENT_SIMILAR_PROMPT_VERSION } from "../server/config/smart-segment";
import type { SmartSegmentBrandResolution } from "../shared/smart-segment";
import { smartSegmentAnalysisIdentity } from "../shared/smart-segment";

const brand: SmartSegmentBrandResolution = {
  detected: true, source: "directory", brandName: "Air France", coreRefs: ["4AF"], extensionRefs: ["US4AF", "E4AF"],
  unsubscribeTags: ["U4AF"], vertical: "4", verticalLabel: "Voyage", verticalRefs: ["4TUI", "4CLUB", "4PIE"], matchedKeys: [], similarRefs: [],
};

const directory: DirectoryBrand[] = [
  { name: "Morgan", refs: ["1MOR"] },
  { name: "Naf Naf", refs: ["1NAF", "1NAF2"] },
  { name: "Cache Cache", refs: ["1CC"] },
  { name: "Étam", refs: ["1ETAM"] },
  { name: "Pimkie", refs: ["1PIM"] },
  { name: "TUI", refs: ["4TUI"] },
  { name: "Maisons du Monde", refs: ["2MDM"] },
  { name: "H&M", refs: ["1HM"] },
];

/** Affinity brands the fixture model proposes for Morgan (vertical 1): another vertical each, as the prompt demands. */
const DEFAULT_AFFINITY = [{ nom: "Maisons du Monde", raison: "Mêmes jeunes femmes urbaines, budget déco comparable." }, { nom: "TUI" }];

function modelAnswer(
  marques: Array<{ nom: string; raison?: string }>,
  secteur = "Prêt-à-porter féminin, mode urbaine, femmes de 20 à 40 ans.",
  marquesAffinite: Array<{ nom: string; raison?: string }> | undefined = DEFAULT_AFFINITY,
): AnthropicMessageResponse {
  const body: Record<string, unknown> = {
    secteur,
    profil: "Femmes de 20 à 40 ans, urbaines, revenus moyens, achats mode fréquents.",
    marques: marques.map((m) => ({ nom: m.nom, raison: m.raison ?? "Même univers mode femme." })),
  };
  if (marquesAffinite) body.marques_affinite = marquesAffinite.map((m) => ({ nom: m.nom, raison: m.raison ?? "Même profil de clientes." }));
  return {
    text: `\`\`\`json\n${JSON.stringify(body)}\n\`\`\``,
    model: "claude-test",
    stopReason: "end_turn",
    usage: { inputTokens: 5_000, outputTokens: 200 },
    webSearches: 2,
    webSearchResults: 2,
    webSearchErrors: [],
  };
}

function makeDeps(overrides: Partial<SimilarBrandDeps> = {}): SimilarBrandDeps & { calls: AnthropicMessageRequest[]; timeouts: number[]; store: Map<string, SimilarBrandLookupResult> } {
  const calls: AnthropicMessageRequest[] = [];
  const timeouts: number[] = [];
  const store = new Map<string, SimilarBrandLookupResult>();
  return {
    calls,
    timeouts,
    store,
    loadDirectory: async () => directory,
    callModel: async (request, timeoutMs) => {
      calls.push(request);
      timeouts.push(timeoutMs);
      return modelAnswer([{ nom: "Naf Naf" }, { nom: "cache cache" }, { nom: "Etam" }]);
    },
    readCache: async (key) => store.get(key) ?? null,
    writeCache: async (key, result) => { store.set(key, result); },
    config: { model: "claude-test", similarAiTimeoutMs: 55_000, similarWebSearchMaxUses: 3, similarCacheDays: 30 },
    now: () => new Date("2026-09-22T10:00:00.000Z"),
    ...overrides,
  };
}

describe("brand directory matching", () => {
  it("groups directory rows by name, upper-cases refs and never offers DEL or the bot ref", () => {
    const grouped = groupDirectoryRows([
      { name: "Naf Naf", ref: "1naf" }, { name: "Naf Naf", ref: "1NAF2" }, { name: " Naf Naf ", ref: "1naf" },
      { name: "Poubelle", ref: "del" }, { name: "Vide", ref: "" }, { name: "Sans ref", ref: "   " },
    ]);
    expect(grouped).toEqual([{ name: "Naf Naf", refs: ["1NAF", "1NAF2"] }]);
  });

  it("matches names case-, accent- and punctuation-insensitively", () => {
    expect(brandNameKey("Étam")).toBe(brandNameKey("etam"));
    expect(brandNameKey("H&M")).toBe(brandNameKey("H & M"));
    expect(brandNameKey("Maisons du Monde")).toBe(brandNameKey("MAISONS-DU-MONDE"));
    expect(brandNameKey("Morgan")).not.toBe(brandNameKey("Morgan de Toi"));
  });
});

describe("model output selection", () => {
  it("keeps only directory brands, in the model's order, drops invented names and the brand's own refs, and caps the refs", () => {
    const raw = {
      secteur: "Mode femme",
      marques: [
        { nom: "Naf Naf", raison: "Même cible." },
        { nom: "Zara", raison: "Invented: not in the directory." },
        { nom: "Morgan", raison: "The brand itself." },
        { nom: "cache cache", raison: "Lower-case spelling." },
        { nom: "Naf Naf", raison: "Duplicate." },
        { nom: "Étam" },
        { nom: 42 },
      ],
    };
    const selected = selectSimilarBrands(raw, directory, excludedSimilarRefs(["1MOR"]));
    expect(selected.sector).toBe("Mode femme");
    expect(selected.brands.map((b) => b.name)).toEqual(["Naf Naf", "Cache Cache", "Étam"]);
    expect(selected.brands[0]).toEqual({ name: "Naf Naf", refs: ["1NAF", "1NAF2"], reason: "Même cible." });
    expect(selected.brands[2].reason).toBe("");
    expect(selected.hallucinated).toEqual(["Zara"]);
    expect(selected.dropped).toEqual(["Morgan"]);
  });

  it("applies the global ref cap in rank order (a later brand loses its refs, never an earlier one)", () => {
    const wide: DirectoryBrand[] = Array.from({ length: 6 }, (_, index) => ({ name: `Brand ${index}`, refs: [`1B${index}A`, `1B${index}B`] }));
    const raw = { marques: wide.map((b) => ({ nom: b.name, raison: "x" })) };
    const selected = selectSimilarBrands(raw, wide, excludedSimilarRefs([]), 5);
    expect(selected.brands.map((b) => b.refs)).toEqual([["1B0A", "1B0B"], ["1B1A", "1B1B"], ["1B2A"]]);
    expect(selected.dropped).toEqual(["Brand 3", "Brand 4", "Brand 5"]);
  });

  it("rejects an answer without the requested shape instead of reading it as « no comparable brand »", () => {
    expect(() => selectSimilarBrands({ marques: "nope" }, directory, new Set())).toThrow(SimilarBrandsOutputMalformed);
    expect(() => selectSimilarBrands(null, directory, new Set())).toThrow(SimilarBrandsOutputMalformed);
    expect(() => selectSimilarBrands([], directory, new Set())).toThrow(SimilarBrandsOutputMalformed);
    // An explicit empty list and junk items are tolerated: that IS an answer.
    expect(selectSimilarBrands({ marques: [] }, directory, new Set()).brands).toEqual([]);
    expect(selectSimilarBrands({ marques: [null, 3, { nom: "Naf Naf" }] }, directory, new Set()).brands.map((b) => b.name)).toEqual(["Naf Naf"]);
  });

  it("strips model sentences that quote a performance figure, keeps descriptive numbers and brand names", () => {
    expect(stripPerformanceFigures("Femmes de 25 à 45 ans. Taux de clic de 3,2 % sur nos envois. Même cible que 3 Suisses.")).toEqual({
      text: "Femmes de 25 à 45 ans. Même cible que 3 Suisses.",
      stripped: 1,
    });
    expect(stripPerformanceFigures("Panier moyen 45 € et 12 000 abonnés actifs.").text).toBe("");
    const selected = selectSimilarBrands({
      secteur: "Mode femme. 12 % de plaintes en moins.",
      marques: [{ nom: "Naf Naf", raison: "Même univers. Environ 5 000 clics par envoi." }],
    }, directory, new Set());
    expect(selected.sector).toBe("Mode femme.");
    expect(selected.brands[0].reason).toBe("Même univers.");
    expect(selected.strippedSentences).toBe(2);
  });

  it("keeps affinity brands of another vertical only, never one already similar, and reads a missing list as empty with a note", () => {
    const raw = {
      secteur: "Mode femme",
      profil: "Jeunes femmes urbaines. Taux de clic de 4 %.",
      marques: [{ nom: "Naf Naf" }],
      marques_affinite: [
        { nom: "Maisons du Monde", raison: "Même profil." },
        { nom: "Pimkie", raison: "Same vertical (1): refused by the server whatever the model says." },
        { nom: "Naf Naf", raison: "Already similar: kept there only." },
        { nom: "Morgan", raison: "The brand itself." },
        { nom: "Sephora", raison: "Invented: not in the directory." },
        { nom: "tui" },
      ],
    };
    const selected = selectSimilarBrands(raw, directory, excludedSimilarRefs(["1MOR"]), 8, { brandVertical: "1" });
    expect(selected.profile).toBe("Jeunes femmes urbaines.");
    expect(selected.brands.map((b) => b.name)).toEqual(["Naf Naf"]);
    expect(selected.affinityBrands.map((b) => `${b.name}:${b.refs.join("+")}:${b.vertical}`)).toEqual(["Maisons du Monde:2MDM:2", "TUI:4TUI:4"]);
    expect(selected.affinityBrands[0].verticalLabel).toBe("Maison");
    expect(selected.affinitySameVertical).toEqual(["Pimkie", "Morgan"]);
    expect(selected.affinityDropped).toEqual(["Naf Naf"]);
    expect(selected.hallucinated).toEqual(["Sephora"]);
    expect(selected.affinityListMissing).toBe(false);
    // Unknown brand vertical: the other-vertical rule cannot be enforced, every directory ref is eligible.
    const unknown = selectSimilarBrands(raw, directory, excludedSimilarRefs(["1MOR"]), 8, { brandVertical: null });
    expect(unknown.affinityBrands.map((b) => b.name)).toEqual(["Maisons du Monde", "Pimkie", "TUI"]);
    expect(unknown.affinitySameVertical).toEqual([]);
    // A missing list is an omission of the model, not a malformed answer; a non-array is.
    const missing = selectSimilarBrands({ marques: [{ nom: "Naf Naf" }] }, directory, new Set(), 8, { brandVertical: "1" });
    expect(missing.affinityBrands).toEqual([]);
    expect(missing.affinityListMissing).toBe(true);
    expect(() => selectSimilarBrands({ marques: [], marques_affinite: "nope" }, directory, new Set())).toThrow(SimilarBrandsOutputMalformed);
  });

  it("caps the affinity refs on their own budget, independent of the similar refs", () => {
    const wide: DirectoryBrand[] = [
      ...Array.from({ length: 3 }, (_, index) => ({ name: `Mode ${index}`, refs: [`1M${index}A`, `1M${index}B`] })),
      ...Array.from({ length: 4 }, (_, index) => ({ name: `Maison ${index}`, refs: [`2H${index}A`, `2H${index}B`] })),
    ];
    const raw = {
      marques: wide.slice(0, 3).map((b) => ({ nom: b.name })),
      marques_affinite: wide.slice(3).map((b) => ({ nom: b.name })),
    };
    const selected = selectSimilarBrands(raw, wide, new Set(), 6, { brandVertical: "1", maxRefs: 5 });
    expect(selected.brands).toHaveLength(3);
    expect(selected.affinityBrands.map((b) => b.refs)).toEqual([["2H0A", "2H0B"], ["2H1A", "2H1B"], ["2H2A"]]);
    expect(selected.affinityDropped).toEqual(["Maison 3"]);
  });

  it("never truncates a cache identity: an over-long key is hashed", () => {
    const longName = "M".repeat(120);
    const refs = Array.from({ length: 16 }, (_, i) => `${"R".repeat(28)}${i}`);
    const key = similarBrandCacheKey(longName, refs);
    expect(key.length).toBeLessThanOrEqual(512);
    expect(key).toMatch(new RegExp(`^${SMART_SEGMENT_SIMILAR_PROMPT_VERSION}\\|sha256:[0-9a-f]{64}$`));
    expect(similarBrandCacheKey(longName, refs.slice(0, 15))).not.toBe(key);
  });
});

describe("similar brands prompt", () => {
  it("lists the directory with refs, names the advertiser brand, its refs and vertical, and demands JSON from the directory only", () => {
    const prompt = buildSimilarBrandsPrompt({ brandName: "Morgan", coreRefs: ["1MOR"], directory: directory.filter((b) => b.name !== "Morgan"), webSearchAvailable: true, maxWebSearches: 3 });
    expect(prompt.system).toContain("PARMI L'ANNUAIRE UNIQUEMENT");
    expect(prompt.system).toContain("au plus 3 recherches");
    expect(prompt.system).toContain("UNIQUEMENT par un objet JSON");
    expect(prompt.user).toContain("Marque annonceur : Morgan");
    expect(prompt.user).toContain("1MOR");
    expect(prompt.user).toContain("1 = Mode");
    expect(prompt.user).toContain("Naf Naf — 1NAF, 1NAF2 — Mode");
    expect(prompt.user).toContain("Maisons du Monde — 2MDM — Maison");
    // Mission 2 asks for the customer profile and other-vertical affinity brands, in the same JSON answer.
    expect(prompt.system).toContain("Mission 2 — audience similaire hors secteur");
    expect(prompt.system).toContain("marques d'une AUTRE verticale que « Mode »");
    expect(prompt.system).toContain('"marques_affinite":[');
    expect(prompt.system).toContain("Interdit dans « marques_affinite » : une marque de la même verticale");
    expect(prompt.user).not.toMatch(/^Morgan — /m);
    const noWeb = buildSimilarBrandsPrompt({ brandName: "Morgan", coreRefs: [], directory, webSearchAvailable: false, maxWebSearches: 0 });
    expect(noWeb.system).not.toContain("recherche web");
    expect(noWeb.user).toContain("inconnues");
  });
});

describe("lookupSimilarBrands", () => {
  it("calls the model once with the web search tool, maps the answer to directory refs and persists it", async () => {
    const deps = makeDeps();
    const result = await lookupSimilarBrands({ brandName: "Morgan", coreRefs: ["1mor"] }, deps);
    expect(deps.calls).toHaveLength(1);
    expect(deps.calls[0].webSearch).toEqual({ maxUses: 3 });
    expect(deps.calls[0].user).not.toMatch(/^Morgan — /m);
    expect(deps.timeouts[0]).toBeGreaterThan(50_000);
    expect(deps.timeouts[0]).toBeLessThanOrEqual(55_000);
    expect(result.brands.map((b) => `${b.name}:${b.refs.join("+")}`)).toEqual(["Naf Naf:1NAF+1NAF2", "Cache Cache:1CC", "Étam:1ETAM"]);
    expect(result).toMatchObject({ brandName: "Morgan", coreRefs: ["1MOR"], webSearchUsed: true, webSearches: 2, cached: false, generatedAt: "2026-09-22T10:00:00.000Z", notes: [] });
    expect(result.sector).toContain("Prêt-à-porter");
    // Mission 2 of the same call: the customer profile and the other-vertical affinity brands, with their vertical named.
    expect(result.profile).toContain("Femmes de 20 à 40 ans");
    expect(result.affinityBrands).toEqual([
      { name: "Maisons du Monde", refs: ["2MDM"], reason: "Mêmes jeunes femmes urbaines, budget déco comparable.", vertical: "2", verticalLabel: "Maison" },
      { name: "TUI", refs: ["4TUI"], reason: "Même profil de clientes.", vertical: "4", verticalLabel: "Voyage / loisirs" },
    ]);
    const key = similarBrandCacheKey("Morgan", ["1MOR"]);
    expect(key).toBe(`${SMART_SEGMENT_SIMILAR_PROMPT_VERSION}|morgan|1MOR`);
    expect(deps.store.get(key)?.brands).toHaveLength(3);
    expect(deps.store.get(key)?.affinityBrands).toHaveLength(2);
  });

  it("serves the persisted answer without calling the model, and « refresh » bypasses it", async () => {
    const deps = makeDeps();
    await lookupSimilarBrands({ brandName: "Morgan", coreRefs: ["1MOR"] }, deps);
    const again = await lookupSimilarBrands({ brandName: " morgan ", coreRefs: ["1MOR"] }, deps);
    expect(deps.calls).toHaveLength(1);
    expect(again.cached).toBe(true);
    expect(again.brands).toHaveLength(3);
    const fresh = await lookupSimilarBrands({ brandName: "Morgan", coreRefs: ["1MOR"], refresh: true }, deps);
    expect(deps.calls).toHaveLength(2);
    expect(fresh.cached).toBe(false);
  });

  it("ignores a persisted answer written under another prompt version", async () => {
    const deps = makeDeps();
    const key = similarBrandCacheKey("Morgan", ["1MOR"]);
    deps.store.set(key, { ...(await lookupSimilarBrands({ brandName: "Morgan", coreRefs: ["1MOR"] }, deps)), promptVersion: "similar-brands-v0", model: "m", hallucinated: [], notes: [] } as SimilarBrandLookupResult);
    deps.calls.length = 0;
    const result = await lookupSimilarBrands({ brandName: "Morgan", coreRefs: ["1MOR"] }, deps);
    expect(deps.calls).toHaveLength(1);
    expect(result.cached).toBe(false);
  });

  it("falls back to model knowledge, with an explicit note, when the web search tool is refused for the key", async () => {
    const deps = makeDeps({
      callModel: async (request) => {
        deps.calls.push(request);
        if (request.webSearch) throw new AnthropicClientError("web_search tool not enabled", 400, false, "AI_TOOL_UNAVAILABLE");
        return { ...modelAnswer([{ nom: "Pimkie" }]), webSearches: undefined, webSearchErrors: undefined };
      },
    });
    const result = await lookupSimilarBrands({ brandName: "Morgan", coreRefs: ["1MOR"] }, deps);
    expect(deps.calls).toHaveLength(2);
    expect(deps.calls[1].webSearch).toBeUndefined();
    expect(deps.calls[1].system).not.toContain("recherche web");
    expect(result.webSearchUsed).toBe(false);
    expect(result.brands.map((b) => b.name)).toEqual(["Pimkie"]);
    expect(result.notes.some((note) => note.includes("Recherche web indisponible"))).toBe(true);
  });

  it("notes invented names, a search-less answer and a failed persistence instead of hiding them", async () => {
    const deps = makeDeps({
      callModel: async () => ({ ...modelAnswer([{ nom: "Zara" }, { nom: "Naf Naf" }]), webSearches: 0, webSearchResults: 0, webSearchErrors: ["max_uses_exceeded"] }),
      writeCache: async () => { throw new Error("relation does not exist"); },
    });
    const result = await lookupSimilarBrands({ brandName: "Morgan", coreRefs: ["1MOR"] }, deps);
    expect(result.brands.map((b) => b.name)).toEqual(["Naf Naf"]);
    expect(result.webSearchUsed).toBe(false);
    expect(result.notes.join("\n")).toContain("Zara");
    expect(result.notes.join("\n")).toContain("aucune recherche web");
    expect(result.notes.join("\n")).toContain("max_uses_exceeded");
    expect(result.notes.join("\n")).toContain("non mémorisé");
    // Billed searches that all failed are not « web search used ».
    const failedOnly = makeDeps({ callModel: async () => ({ ...modelAnswer([{ nom: "Naf Naf" }]), webSearches: 3, webSearchResults: 0, webSearchErrors: ["unavailable"] }) });
    const fallback = await lookupSimilarBrands({ brandName: "Morgan", coreRefs: ["1MOR"] }, failedOnly);
    expect(fallback.webSearchUsed).toBe(false);
    expect(fallback.notes.join("\n")).toContain("Aucune recherche web n'a abouti");
  });

  it("maps model failures to typed HTTP errors and refuses an empty directory", async () => {
    const timeout = makeDeps({ callModel: async () => { throw new AnthropicClientError("timeout", null, true, "AI_TIMEOUT"); } });
    await expect(lookupSimilarBrands({ brandName: "Morgan", coreRefs: ["1MOR"] }, timeout)).rejects.toMatchObject({ code: "AI_TIMEOUT", status: 504 });
    const auth = makeDeps({ callModel: async () => { throw new AnthropicClientError("bad key", 401, false, "AI_AUTH"); } });
    await expect(lookupSimilarBrands({ brandName: "Morgan", coreRefs: ["1MOR"] }, auth)).rejects.toMatchObject({ code: "AI_AUTH", status: 503 });
    const garbage = makeDeps({ callModel: async () => ({ text: "pas de json", model: "m", stopReason: null, usage: null }) });
    await expect(lookupSimilarBrands({ brandName: "Morgan", coreRefs: ["1MOR"] }, garbage)).rejects.toMatchObject({ code: "AI_BAD_RESPONSE", status: 502 });
    const empty = makeDeps({ loadDirectory: async () => [{ name: "Morgan", refs: ["1MOR"] }] });
    const error = await lookupSimilarBrands({ brandName: "Morgan", coreRefs: ["1MOR"] }, empty).catch((e) => e);
    expect(error).toBeInstanceOf(SmartSegmentError);
    expect(error.code).toBe("SMART_SEGMENT_DIRECTORY_EMPTY");
  });

  it("refuses a malformed model answer (never persisted) and gives the knowledge fallback only the remaining budget", async () => {
    const malformed = makeDeps({ callModel: async () => ({ ...modelAnswer([]), text: JSON.stringify({ secteur: "mode", marques: "aucune" }) }) });
    await expect(lookupSimilarBrands({ brandName: "Morgan", coreRefs: ["1MOR"] }, malformed)).rejects.toMatchObject({ code: "AI_BAD_RESPONSE", status: 502 });
    expect(malformed.store.size).toBe(0);

    const start = Date.parse("2026-09-22T10:00:00.000Z");
    vi.useFakeTimers({ now: start });
    try {
      const slow = makeDeps({
        config: { model: "claude-test", similarAiTimeoutMs: 20_000, similarWebSearchMaxUses: 3, similarCacheDays: 30 },
        callModel: async (request, timeoutMs) => {
          slow.calls.push(request);
          slow.timeouts.push(timeoutMs);
          if (request.webSearch) {
            // The web-enabled call burns most of the deadline before being refused.
            vi.setSystemTime(Date.now() + 14_000);
            throw new AnthropicClientError("web_search tool not available", 400, false, "AI_TOOL_UNAVAILABLE");
          }
          return modelAnswer([{ nom: "Naf Naf" }]);
        },
      });
      const result = await lookupSimilarBrands({ brandName: "Morgan", coreRefs: ["1MOR"] }, slow);
      expect(result.brands.map((b) => b.name)).toEqual(["Naf Naf"]);
      expect(slow.timeouts[0]).toBe(20_000);
      expect(slow.timeouts[1]).toBe(6_000);
      // With less than the minimum left, the fallback is not even attempted.
      const spent = makeDeps({
        config: { model: "claude-test", similarAiTimeoutMs: 20_000, similarWebSearchMaxUses: 3, similarCacheDays: 30 },
        callModel: async (request) => {
          if (request.webSearch) {
            vi.setSystemTime(Date.now() + 17_000);
            throw new AnthropicClientError("web_search tool not available", 400, false, "AI_TOOL_UNAVAILABLE");
          }
          throw new Error("fallback must not run");
        },
      });
      await expect(lookupSimilarBrands({ brandName: "Pimkie", coreRefs: [] }, spent)).rejects.toMatchObject({ code: "AI_TIMEOUT", status: 504 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("caps the fresh lookups running at once in this process", async () => {
    const resolvers: Array<(value: AnthropicMessageResponse) => void> = [];
    let hold = true;
    const deps = makeDeps({
      callModel: () => hold
        ? new Promise<AnthropicMessageResponse>((resolve) => { resolvers.push(resolve); })
        : Promise.resolve(modelAnswer([{ nom: "Naf Naf" }])),
    });
    const pending = ["Morgan", "Pimkie", "Etam"].map((brandName) => lookupSimilarBrands({ brandName, coreRefs: [] }, deps));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(resolvers).toHaveLength(SMART_SEGMENT_MAX_CONCURRENT_SIMILAR_LOOKUPS);
    await expect(lookupSimilarBrands({ brandName: "Jennyfer", coreRefs: [] }, deps)).rejects.toMatchObject({ code: "SMART_SEGMENT_BUSY", status: 429 });
    // A request for a brand already in flight joins it instead of counting as a fourth.
    const joined = lookupSimilarBrands({ brandName: "Morgan", coreRefs: [] }, deps);
    hold = false;
    resolvers.forEach((resolve) => resolve(modelAnswer([{ nom: "Naf Naf" }])));
    await Promise.all([...pending, joined]);
    const after = await lookupSimilarBrands({ brandName: "Jennyfer", coreRefs: [], refresh: true }, deps);
    expect(after.brands.map((b) => b.name)).toEqual(["Naf Naf"]);
  });

  it("shares one in-flight model call between concurrent requests for the same brand", async () => {
    let resolveModel: ((value: AnthropicMessageResponse) => void) | null = null;
    const deps = makeDeps({
      callModel: (request) => {
        deps.calls.push(request);
        return new Promise<AnthropicMessageResponse>((resolve) => { resolveModel = resolve; });
      },
    });
    const first = lookupSimilarBrands({ brandName: "Morgan", coreRefs: ["1MOR"] }, deps);
    const second = lookupSimilarBrands({ brandName: "Morgan", coreRefs: ["1MOR"] }, deps);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(deps.calls).toHaveLength(1);
    resolveModel!(modelAnswer([{ nom: "Pimkie" }]));
    const [a, b] = await Promise.all([first, second]);
    expect(a.brands).toEqual(b.brands);
    expect(deps.calls).toHaveLength(1);
  });
});

describe("similar-ref selection validation", () => {
  it("excludes the brand's own refs, their extensions, DEL and the bot ref from candidates", () => {
    const excluded = excludedSimilarRefs(["4AF"]);
    for (const ref of ["4AF", "US4AF", "E4AF", "DEL"]) expect(excluded.has(ref)).toBe(true);
    expect(excluded.has("4TUI")).toBe(false);
  });

  it("normalises and refuses the brand's own refs in the operator's selection", () => {
    const result = validateSimilarRefs(["4tui", "4AF", "e4af", "del", "4CLUB", "4TUI"], brand);
    expect(result.similarRefs).toEqual(["4CLUB", "4TUI"]);
    expect(result.rejected).toEqual(["4AF", "DEL", "E4AF"]);
  });

  it("moves a kept similar ref out of the vertical pool so it is never counted twice", () => {
    const resolved = withSimilarRefs(brand, ["4TUI"]);
    expect(resolved.similarRefs).toEqual(["4TUI"]);
    expect(resolved.verticalRefs).toEqual(["4CLUB", "4PIE"]);
    expect(resolved.coreRefs).toEqual(["4AF"]);
  });

  it("makes the selection part of the analysis identity", () => {
    const base = { campaignName: "Air France", campaignId: null, family: "fai_fr" as const, targetClicks: 1_000, complaintCap: 0.004 };
    expect(smartSegmentAnalysisIdentity({ ...base, similarRefs: ["4tui", "4CLUB"] })).toBe(smartSegmentAnalysisIdentity({ ...base, similarRefs: ["4CLUB", "4TUI"] }));
    expect(smartSegmentAnalysisIdentity({ ...base, similarRefs: ["4TUI"] })).not.toBe(smartSegmentAnalysisIdentity({ ...base }));
    // The affinity selection too: the same similar refs with another affinity list is another analysis.
    expect(smartSegmentAnalysisIdentity({ ...base, affinityRefs: ["1mor", "2MDM"] })).toBe(smartSegmentAnalysisIdentity({ ...base, affinityRefs: ["2MDM", "1MOR"] }));
    expect(smartSegmentAnalysisIdentity({ ...base, similarRefs: ["4TUI"], affinityRefs: ["2MDM"] })).not.toBe(smartSegmentAnalysisIdentity({ ...base, similarRefs: ["4TUI"] }));
  });
});

describe("affinity-ref selection validation (« hors secteur » is a server guarantee)", () => {
  it("refuses, with a reason each, the brand's own refs, refs of the brand's vertical and refs already kept as similar", () => {
    const result = validateAffinityRefs(["2mdm", "4AF", "e4af", "4CLUB", "4TUI", "1MOR", "del", "2MDM"], brand, ["4TUI"]);
    expect(result.affinityRefs).toEqual(["1MOR", "2MDM"]);
    expect(result.rejected).toEqual([
      { ref: "4AF", reason: "own_brand" },
      { ref: "4CLUB", reason: "same_vertical" },
      { ref: "4TUI", reason: "already_similar" },
      { ref: "DEL", reason: "own_brand" },
      { ref: "E4AF", reason: "own_brand" },
    ]);
    expect(describeAffinityRejections(result.rejected)).toBe("4AF (ref de la marque elle-même, DEL ou ref robot), 4CLUB (même verticale que la marque), 4TUI (déjà parmi les marques similaires), DEL (ref de la marque elle-même, DEL ou ref robot), E4AF (ref de la marque elle-même, DEL ou ref robot)");
    expect(validateAffinityRefs(undefined, brand, []).affinityRefs).toEqual([]);
  });

  it("cannot enforce the vertical rule for a brand without vertical digit, and still refuses its own refs", () => {
    const noVertical: SmartSegmentBrandResolution = { ...brand, coreRefs: ["AF"], extensionRefs: ["USAF"], vertical: null, verticalLabel: null, verticalRefs: [] };
    const result = validateAffinityRefs(["4TUI", "AF", "usaf"], noVertical, []);
    expect(result.affinityRefs).toEqual(["4TUI"]);
    expect(result.rejected.map((entry) => entry.ref)).toEqual(["AF", "USAF"]);
  });

  it("carries the affinity selection on the resolution and keeps it out of the vertical pool", () => {
    const resolved = withAffinityRefs(withSimilarRefs(brand, ["4TUI"]), ["2MDM", "4PIE"]);
    expect(resolved.similarRefs).toEqual(["4TUI"]);
    expect(resolved.affinityRefs).toEqual(["2MDM", "4PIE"]);
    expect(resolved.verticalRefs).toEqual(["4CLUB"]);
  });

  it("enforces the rule for a brand given through its US / E form: resolution, suggested candidates and the operator's selection all read the core vertical", async () => {
    // The operator types the US form of Morgan's ref: the brand still belongs to vertical 1 (Mode).
    const resolved = await resolveSmartSegmentBrand(
      { campaignName: "Whatever", brandOverride: { name: "Morgan", ref: "us1mor" } },
      { findBrandsByToken: async () => [], findCampaignBrandAnchor: async () => null, listVerticalRefs: async (prefix) => (prefix === "1" ? ["1PIM", "1NAF"] : []) },
    );
    expect(resolved).toMatchObject({ coreRefs: ["US1MOR"], vertical: "1", verticalRefs: ["1PIM", "1NAF"] });

    // Suggested candidates: a same-vertical brand proposed as affinity by the model is refused by the server.
    const deps = makeDeps({
      callModel: async (request) => {
        deps.calls.push(request);
        return modelAnswer([{ nom: "Naf Naf" }], undefined, [{ nom: "Pimkie", raison: "Même profil, mais même verticale." }, { nom: "Maisons du Monde" }]);
      },
    });
    const result = await lookupSimilarBrands({ brandName: resolved.brandName ?? "Morgan", coreRefs: resolved.coreRefs }, deps);
    expect(deps.calls[0].system).toContain("marques d'une AUTRE verticale que « Mode »");
    expect(result.affinityBrands.map((b) => `${b.name}:${b.vertical}`)).toEqual(["Maisons du Monde:2"]);
    expect(result.notes).toContain("Marques d'affinité écartées par le serveur car de la même verticale que la marque : Pimkie.");

    // The operator's own selection: the same rule, with the reason, whatever the UI let through.
    const checked = validateAffinityRefs(["1PIM", "e1naf", "2MDM", "1MOR"], resolved, []);
    expect(checked.affinityRefs).toEqual(["2MDM"]);
    expect(checked.rejected).toEqual([
      { ref: "1MOR", reason: "same_vertical" },
      { ref: "1PIM", reason: "same_vertical" },
      { ref: "E1NAF", reason: "same_vertical" },
    ]);
  });
});
