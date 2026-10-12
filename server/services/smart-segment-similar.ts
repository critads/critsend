// Task #311 / #315 — « marques similaires » for the smart segment composer.
//
// Candidates are chosen by the model (Anthropic, web search tool enabled)
// STRICTLY INSIDE the brand directory (table brands: name + ref): it reads
// the campaign brand's sector, products and target on the web, then ranks
// the directory's brands by proximity. Nothing outside the directory can be
// proposed — a name the model invents is dropped and logged, never mapped.
// The audience co-occurrence engine (segment-similarity) is no longer used
// here: the operator asked for brand similarity, not audience overlap.
//
// The final selection (candidates + manual additions) is still validated
// against the brand's own refs and is part of the analysis identity, so any
// change re-runs the evidence engine. Results are persisted per brand for a
// few weeks: one lookup costs several web searches and tens of seconds.
//
// Task #343 — the same call also returns the « affinity » brands: directory
// brands of ANOTHER vertical (sector) whose customers share the profile of
// the brand's customers (a premium women's jeweller → premium women's
// ready-to-wear, luxury cosmetics, high-end home linen, upmarket travel).
// « Other vertical » is enforced by the server from the refs' first digit,
// whatever the model answered; affinity candidates never overlap the
// similar ones.
import crypto from "node:crypto";
import { pool } from "../db";
import { logger } from "../logger";
import {
  SMART_SEGMENT_MAX_AFFINITY_REFS,
  SMART_SEGMENT_MAX_SIMILAR_REFS,
  normalizeSimilarRefs,
  refVerticalDigit,
  type SmartSegmentAffinityBrand,
  type SmartSegmentBrandResolution,
  type SmartSegmentSimilarBrand,
  type SmartSegmentSimilarBrandsResponse,
} from "@shared/smart-segment";
import { BOT_OPENER_REF } from "../config/suppression";
import { getSmartSegmentConfig, SMART_SEGMENT_SIMILAR_PROMPT_VERSION, type SmartSegmentConfig } from "../config/smart-segment";
import { AnthropicClientError, anthropicCreateMessage, extractJsonObject, type AnthropicMessageRequest, type AnthropicMessageResponse } from "./anthropic-client";
import { deriveExtensionRefs, VERTICAL_LABELS, verticalOf } from "./smart-segment-brand";
import { SmartSegmentError } from "./smart-segment-evidence";

/** Brands the model may pick from: display name + uppercase refs (exact-case convention). */
export type DirectoryBrand = { name: string; refs: string[] };

/** What the model is asked to return (validated with zod-free checks: the shape is tiny). */
type ModelSimilarOutput = { secteur?: unknown; profil?: unknown; marques?: unknown; marques_affinite?: unknown };

export type SimilarBrandLookupResult = Omit<SmartSegmentSimilarBrandsResponse, "cached" | "notes"> & {
  promptVersion: string;
  model: string;
  /** Names the model proposed that are not in the directory (dropped). */
  hallucinated: string[];
  notes: string[];
};

export type SimilarBrandDeps = {
  loadDirectory: () => Promise<DirectoryBrand[]>;
  /** `timeoutMs` is what remains of the lookup's single deadline for this call. */
  callModel: (request: AnthropicMessageRequest, timeoutMs: number) => Promise<AnthropicMessageResponse>;
  readCache: (key: string, maxAgeMs: number) => Promise<SimilarBrandLookupResult | null>;
  writeCache: (key: string, result: SimilarBrandLookupResult) => Promise<void>;
  config: Pick<SmartSegmentConfig, "model" | "similarAiTimeoutMs" | "similarWebSearchMaxUses" | "similarCacheDays">;
  now?: () => Date;
};

/** Max brands the model may return; each brand can carry several refs, capped globally after. */
export const SMART_SEGMENT_MAX_SIMILAR_BRANDS = 6;
/** Max affinity (other-vertical) brands kept from the model's answer; refs capped globally after. */
export const SMART_SEGMENT_MAX_AFFINITY_BRANDS = 6;
/** Fresh (non-cached) lookups running at once in this process; beyond it the wizard is told to retry. */
export const SMART_SEGMENT_MAX_CONCURRENT_SIMILAR_LOOKUPS = 3;
/** A model call is not attempted with less than this left on the deadline. */
const MIN_CALL_BUDGET_MS = 4_000;

// ====== Directory ======

async function loadDirectoryFromDb(): Promise<DirectoryBrand[]> {
  const result = await pool.query<{ name: string; ref: string }>(
    `SELECT name, ref FROM brands ORDER BY lower(name), ref`,
  );
  return groupDirectoryRows(result.rows);
}

/** Groups (name, ref) rows by display name; refs upper-cased, DEL / bot ref never offered. */
export function groupDirectoryRows(rows: Array<{ name: string; ref: string }>): DirectoryBrand[] {
  const byKey = new Map<string, DirectoryBrand>();
  for (const row of rows) {
    const name = String(row.name ?? "").trim();
    const ref = String(row.ref ?? "").trim().toUpperCase();
    if (!name || !ref || ref === "DEL" || ref === BOT_OPENER_REF) continue;
    const key = brandNameKey(name);
    const entry = byKey.get(key) ?? { name, refs: [] };
    if (!entry.refs.includes(ref)) entry.refs.push(ref);
    byKey.set(key, entry);
  }
  return [...byKey.values()].filter((brand) => brand.refs.length > 0);
}

/** Case-, accent- and punctuation-insensitive key used to match model output against the directory. */
export function brandNameKey(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " et ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// ====== Exclusions ======

/** Refs that can never be « similar brand » candidates for this brand. */
export function excludedSimilarRefs(coreRefs: string[]): Set<string> {
  return new Set([...coreRefs, ...deriveExtensionRefs(coreRefs), BOT_OPENER_REF, "DEL"]);
}

// ====== Prompt ======

export function buildSimilarBrandsPrompt(input: {
  brandName: string;
  coreRefs: string[];
  directory: DirectoryBrand[];
  webSearchAvailable: boolean;
  maxWebSearches: number;
}): { system: string; user: string } {
  const vertical = verticalOf(input.coreRefs[0] ?? null);
  const verticalLabel = vertical ? (VERTICAL_LABELS[vertical] ?? "inconnue") : null;
  const system = [
    "Tu es l'assistant marketing d'une plateforme d'emailing B2C française. On te donne une MARQUE ANNONCEUR et l'ANNUAIRE des marques présentes dans la base d'abonnés, chacune avec sa verticale (secteur déclaré par le fournisseur de données).",
    "Mission 1 — marques similaires : identifier, PARMI L'ANNUAIRE UNIQUEMENT, les marques les plus comparables à la marque annonceur — même secteur, même type de produits ou services, même cible (genre, âge) et même positionnement prix — c'est-à-dire celles dont les clients ont le plus de chances d'être intéressés par une offre de la marque annonceur.",
    `Mission 2 — audience similaire hors secteur : décrire le PROFIL CLIENT de la marque annonceur (genre, tranche d'âge, niveau de revenus, style de vie, occasion d'achat), puis identifier, PARMI L'ANNUAIRE UNIQUEMENT, les marques d'une AUTRE verticale${verticalLabel ? ` que « ${verticalLabel} »` : ""} dont les clients ont ce même profil : ce sont des marques d'affinité, qui servent à toucher une audience semblable en dehors du secteur de la marque. Exemple : pour un joaillier haut de gamme (clientes CSP+ de 35 à 60 ans, achat plaisir ou cadeau), des marques de prêt-à-porter féminin premium, de cosmétiques de luxe, de linge de maison haut de gamme ou de voyages haut de gamme. Juge sur le positionnement prix et le profil des clients, pas sur le produit.`,
    input.webSearchAvailable
      ? `Méthode : 1) utilise l'outil de recherche web (au plus ${input.maxWebSearches} recherches) pour établir le secteur, les produits, la cible, le positionnement et le profil client de la marque annonceur, et lever les ambiguïtés sur les marques de l'annuaire que tu ne connais pas ; 2) classe les marques de l'annuaire par proximité décroissante pour chaque mission ; 3) ne retiens que les marques réellement pertinentes (au plus ${SMART_SEGMENT_MAX_SIMILAR_BRANDS} marques similaires, au plus ${SMART_SEGMENT_MAX_AFFINITY_BRANDS} marques d'affinité) — aucune si rien ne convient.`
      : `Méthode : à partir de ce que tu sais de la marque annonceur, classe les marques de l'annuaire par proximité décroissante pour chaque mission et ne retiens que les marques réellement pertinentes (au plus ${SMART_SEGMENT_MAX_SIMILAR_BRANDS} marques similaires, au plus ${SMART_SEGMENT_MAX_AFFINITY_BRANDS} marques d'affinité) — aucune si rien ne convient.`,
    "Une marque de l'annuaire peut être une enseigne, un site marchand ou un éditeur d'offres : juge sur ce qu'elle vend et à qui.",
    "Réponds UNIQUEMENT par un objet JSON valide, sans texte autour, au format :",
    '{"secteur":"<une phrase : secteur, produits et cible de la marque annonceur>","profil":"<une phrase : profil client de la marque annonceur (genre, âge, revenus, style de vie)>","marques":[{"nom":"<nom EXACT copié de l\'annuaire>","raison":"<une phrase en français expliquant la proximité, sans chiffre>"}],"marques_affinite":[{"nom":"<nom EXACT copié de l\'annuaire>","raison":"<une phrase en français expliquant pourquoi ses clients ont le même profil, sans chiffre>"}]}',
    "Interdit : proposer une marque absente de l'annuaire, proposer la marque annonceur elle-même ou l'une de ses variantes, modifier l'orthographe d'un nom de l'annuaire, écrire du texte hors du JSON.",
    "Interdit dans « marques_affinite » : une marque de la même verticale que la marque annonceur (le serveur l'écartera), une marque déjà citée dans « marques ». Les deux listes peuvent être vides.",
  ].join("\n");

  const directoryLines = input.directory.map((brand) => {
    const brandVertical = refVerticalDigit(brand.refs[0] ?? null);
    const label = brandVertical ? (VERTICAL_LABELS[brandVertical] ?? `verticale ${brandVertical}`) : "verticale inconnue";
    return `${brand.name} — ${brand.refs.join(", ")} — ${label}`;
  });
  const user = [
    `Marque annonceur : ${input.brandName}`,
    input.coreRefs.length ? `Refs de la marque annonceur dans la base (exclues d'office) : ${input.coreRefs.join(", ")}` : "Refs de la marque annonceur dans la base : inconnues",
    vertical
      ? `Verticale déclarée par le fournisseur de données (premier caractère des refs) : ${vertical} = ${verticalLabel} — indicative pour les marques similaires (elles peuvent venir d'une autre verticale) ; les marques d'affinité doivent toutes venir d'une AUTRE verticale.`
      : "Verticale de la marque annonceur : inconnue (aucun chiffre en tête de ref) — choisis les marques d'affinité dans des secteurs différents de celui de la marque.",
    "",
    `Annuaire (${input.directory.length} marques, format « nom — refs — verticale ») :`,
    ...directoryLines,
    "",
    "Réponds maintenant avec l'objet JSON.",
  ].filter((line) => line !== null).join("\n");
  return { system, user };
}

// ====== Output validation ======

export type SelectedSimilarBrands = {
  sector: string | null;
  /** The model's reading of the customer profile (display only). */
  profile: string | null;
  brands: SmartSegmentSimilarBrand[];
  /** Affinity brands kept: other vertical than the brand, not among `brands`, under their own cap. */
  affinityBrands: SmartSegmentAffinityBrand[];
  hallucinated: string[];
  /** Directory brands the model named but whose refs are all excluded (own brand / cap). */
  dropped: string[];
  /** Affinity candidates refused because every ref carries the brand's own vertical. */
  affinitySameVertical: string[];
  /** Affinity candidates refused because already similar, own refs or over the affinity cap. */
  affinityDropped: string[];
  /** True when the answer carried no « marques_affinite » list at all (read as empty, said in the notes). */
  affinityListMissing: boolean;
  /** Sentences of model prose removed because they carried a performance figure. */
  strippedSentences: number;
};

export type AffinitySelectionOptions = {
  /** Vertical digit of the advertiser brand; null = unknown, the other-vertical rule cannot be enforced. */
  brandVertical: string | null;
  maxRefs?: number;
};

/** Thrown when the model's JSON has not the requested shape (never cached: the caller maps it to AI_BAD_RESPONSE). */
export class SimilarBrandsOutputMalformed extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SimilarBrandsOutputMalformed";
  }
}

// No displayed figure may come from the model: a sentence quoting a rate,
// an amount or a count of clicks/complaints/subscribers is removed. Plain
// numbers (« 3 Suisses », « femmes de 25 à 45 ans ») are descriptive and kept.
const PERFORMANCE_FIGURE = /\d[\d\s.,]*\s*(?:%|€|\b(?:euros?|clics?|plaintes?|abonn[ée]s?|contacts?|ouvertures?|taux|ctr)\b)|\b(?:taux|ctr)\b[^.!?]*\d/i;

export function stripPerformanceFigures(text: string): { text: string; stripped: number } {
  const sentences = text.match(/[^.!?]+[.!?]*/g) ?? [];
  const kept = sentences.filter((sentence) => !PERFORMANCE_FIGURE.test(sentence));
  return { text: kept.join("").trim(), stripped: sentences.length - kept.length };
}

/**
 * Maps the model's names back to the directory (case/diacritics-insensitive
 * exact match), applies the exclusions and the global ref cap in rank order.
 * A name absent from the directory is never guessed at.
 */
export function selectSimilarBrands(
  raw: unknown,
  directory: DirectoryBrand[],
  excluded: Set<string>,
  maxRefs = SMART_SEGMENT_MAX_SIMILAR_REFS,
  affinity: AffinitySelectionOptions = { brandVertical: null },
): SelectedSimilarBrands {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new SimilarBrandsOutputMalformed("la réponse du modèle n'est pas un objet JSON");
  }
  const output = raw as ModelSimilarOutput;
  if (!Array.isArray(output.marques)) {
    throw new SimilarBrandsOutputMalformed("la réponse du modèle ne contient pas la liste « marques »");
  }
  // The affinity list is the newer half of the answer: a model that left it
  // out still gave usable similar brands, so the omission is reported to the
  // operator (empty affinity list, note) instead of failing the lookup.
  const affinityListMissing = output.marques_affinite === undefined || output.marques_affinite === null;
  if (!affinityListMissing && !Array.isArray(output.marques_affinite)) {
    throw new SimilarBrandsOutputMalformed("la liste « marques_affinite » de la réponse du modèle n'est pas un tableau");
  }
  let strippedSentences = 0;
  const cleanText = (value: unknown, max: number): string => {
    if (typeof value !== "string") return "";
    const cleaned = stripPerformanceFigures(value.trim());
    strippedSentences += cleaned.stripped;
    return cleaned.text.slice(0, max);
  };
  const sector = cleanText(output.secteur, 300) || null;
  const profile = cleanText(output.profil, 300) || null;
  const byKey = new Map(directory.map((brand) => [brandNameKey(brand.name), brand] as const));
  const hallucinated: string[] = [];

  /** Walks one model list, mapping names to the directory; `keepRefs` decides which refs of a match survive. */
  const walk = <T,>(
    list: unknown[],
    maxBrands: number,
    seen: Set<string>,
    keepRefs: (match: DirectoryBrand, kept: number) => { refs: string[]; drop?: "dropped" | "sameVertical" },
    build: (match: DirectoryBrand, refs: string[], reason: string) => T,
    onDrop: (match: DirectoryBrand, why: "dropped" | "sameVertical") => void,
  ): T[] => {
    const out: T[] = [];
    let kept = 0;
    for (const item of list) {
      if (out.length >= maxBrands) break;
      if (!item || typeof item !== "object") continue;
      const entry = item as { nom?: unknown; raison?: unknown };
      const name = typeof entry.nom === "string" ? entry.nom.trim() : "";
      if (!name) continue;
      const key = brandNameKey(name);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const match = byKey.get(key);
      if (!match) {
        hallucinated.push(name);
        continue;
      }
      const decision = keepRefs(match, kept);
      if (!decision.refs.length) {
        onDrop(match, decision.drop ?? "dropped");
        continue;
      }
      kept += decision.refs.length;
      out.push(build(match, normalizeSimilarRefs(decision.refs), cleanText(entry.raison, 300)));
    }
    return out;
  };

  const dropped: string[] = [];
  const similarSeen = new Set<string>();
  const brands = walk<SmartSegmentSimilarBrand>(
    output.marques,
    SMART_SEGMENT_MAX_SIMILAR_BRANDS,
    similarSeen,
    (match, kept) => {
      const refs: string[] = [];
      for (const ref of match.refs) {
        if (excluded.has(ref) || kept + refs.length >= maxRefs) continue;
        refs.push(ref);
      }
      return { refs };
    },
    (match, refs, reason) => ({ name: match.name, refs, reason }),
    (match) => dropped.push(match.name),
  );

  // Affinity: never a brand already kept as similar (the two segments must
  // measure different audiences), never a ref of the brand's own vertical —
  // the rule is enforced here per ref, whatever the model claimed.
  const affinitySameVertical: string[] = [];
  const affinityDropped: string[] = [];
  const maxAffinityRefs = affinity.maxRefs ?? SMART_SEGMENT_MAX_AFFINITY_REFS;
  const affinitySeen = new Set<string>(similarSeen);
  const affinityBrands = walk<SmartSegmentAffinityBrand>(
    affinityListMissing ? [] : (output.marques_affinite as unknown[]),
    SMART_SEGMENT_MAX_AFFINITY_BRANDS,
    affinitySeen,
    (match, kept) => {
      const otherVertical = match.refs.filter((ref) => affinity.brandVertical === null || refVerticalDigit(ref) !== affinity.brandVertical);
      if (!otherVertical.length) return { refs: [], drop: "sameVertical" };
      const refs: string[] = [];
      for (const ref of otherVertical) {
        if (excluded.has(ref) || kept + refs.length >= maxAffinityRefs) continue;
        refs.push(ref);
      }
      return { refs };
    },
    (match, refs, reason) => {
      const brandVertical = refVerticalDigit(refs[0] ?? null);
      return {
        name: match.name,
        refs,
        reason,
        vertical: brandVertical,
        verticalLabel: brandVertical ? (VERTICAL_LABELS[brandVertical] ?? `Verticale ${brandVertical}`) : null,
      };
    },
    (match, why) => (why === "sameVertical" ? affinitySameVertical : affinityDropped).push(match.name),
  );
  // A brand named in both lists is kept as similar only; the model is told
  // so through the notes (it is a "dropped" affinity, not a hallucination).
  if (!affinityListMissing) {
    for (const item of output.marques_affinite as unknown[]) {
      const entry = item && typeof item === "object" ? (item as { nom?: unknown }) : null;
      const name = typeof entry?.nom === "string" ? entry.nom.trim() : "";
      const key = name ? brandNameKey(name) : "";
      if (key && similarSeen.has(key) && byKey.has(key)) {
        const match = byKey.get(key)!;
        if (!affinityDropped.includes(match.name) && !affinitySameVertical.includes(match.name)) affinityDropped.push(match.name);
      }
    }
  }
  return { sector, profile, brands, affinityBrands, hallucinated, dropped, affinitySameVertical, affinityDropped, affinityListMissing, strippedSentences };
}

// ====== Persistence ======

/** Identity of a persisted lookup: prompt version + normalised brand name + the brand's own refs. */
export function similarBrandCacheKey(brandName: string, coreRefs: string[], promptVersion = SMART_SEGMENT_SIMILAR_PROMPT_VERSION): string {
  const identity = `${brandNameKey(brandName)}|${normalizeSimilarRefs(coreRefs).join(",")}`;
  const key = `${promptVersion}|${identity}`;
  if (key.length <= 512) return key;
  // Column is varchar(512): a very long identity is hashed rather than
  // truncated, so two brands can never share a persisted answer.
  return `${promptVersion}|sha256:${crypto.createHash("sha256").update(identity).digest("hex")}`;
}

async function readCacheFromDb(key: string, maxAgeMs: number): Promise<SimilarBrandLookupResult | null> {
  const result = await pool.query<{ result: SimilarBrandLookupResult }>(
    `SELECT result
       FROM smart_segment_similar_brand_analyses
      WHERE brand_key = $1
        AND created_at >= NOW() - ($2::bigint * INTERVAL '1 millisecond')
      ORDER BY created_at DESC
      LIMIT 1`,
    [key, Math.round(maxAgeMs)],
  );
  const row = result.rows[0]?.result;
  return row && Array.isArray(row.brands) ? row : null;
}

async function writeCacheToDb(key: string, result: SimilarBrandLookupResult): Promise<void> {
  await pool.query(
    `INSERT INTO smart_segment_similar_brand_analyses (brand_key, result) VALUES ($1, $2::jsonb)`,
    [key, JSON.stringify(result)],
  );
}

function defaultDeps(): SimilarBrandDeps {
  const config = getSmartSegmentConfig();
  if (!config.apiKey) {
    throw new SmartSegmentError("SMART_SEGMENT_NOT_CONFIGURED", "ANTHROPIC_API_KEY n'est pas défini sur le serveur.", 503);
  }
  const apiKey = config.apiKey;
  return {
    loadDirectory: loadDirectoryFromDb,
    callModel: (request, timeoutMs) => anthropicCreateMessage(
      { apiKey, model: config.model, baseUrl: config.anthropicBaseUrl, timeoutMs },
      request,
    ),
    readCache: readCacheFromDb,
    writeCache: writeCacheToDb,
    config,
  };
}

// In-process de-duplication only (correctness never depends on it: PM2 runs
// several instances). Two wizards asking for the same brand at the same time
// on one instance share one model call.
const inflight = new Map<string, Promise<SimilarBrandLookupResult>>();

// ====== Lookup ======

/**
 * Similar brands for a campaign brand: persisted answer when fresh enough,
 * else one model call (web search when the account allows it, plain model
 * knowledge otherwise — always said in the notes). Never throws for a cache
 * problem; throws a SmartSegmentError when no answer can be produced.
 */
export async function lookupSimilarBrands(
  input: { brandName: string; coreRefs?: readonly string[] | null; refresh?: boolean },
  deps: SimilarBrandDeps = defaultDeps(),
): Promise<SmartSegmentSimilarBrandsResponse> {
  const brandName = input.brandName.trim();
  const coreRefs = normalizeSimilarRefs(input.coreRefs).filter((ref) => ref !== "DEL");
  const key = similarBrandCacheKey(brandName, coreRefs);
  const notes: string[] = [];
  const maxAgeMs = deps.config.similarCacheDays * 24 * 60 * 60 * 1000;

  if (!input.refresh) {
    try {
      const cached = await deps.readCache(key, maxAgeMs);
      if (cached && cached.promptVersion === SMART_SEGMENT_SIMILAR_PROMPT_VERSION) {
        return { ...toResponse(cached), cached: true, notes: [...cached.notes] };
      }
    } catch (error) {
      logger.warn("[SMART_SEGMENT] similar-brand cache read failed", { key, error: (error as Error)?.message });
      notes.push("Résultat mémorisé inaccessible : nouvelle recherche lancée.");
    }
  }

  let pending = inflight.get(key);
  if (!pending) {
    // Each fresh lookup is a billed, tens-of-seconds model call: this process
    // never runs more than a few at once (the IP limiter is per process too).
    if (inflight.size >= SMART_SEGMENT_MAX_CONCURRENT_SIMILAR_LOOKUPS) {
      throw new SmartSegmentError("SMART_SEGMENT_BUSY", "Trop de recherches de marques similaires en cours : réessayez dans quelques secondes.", 429);
    }
    pending = runLookup(brandName, coreRefs, deps).finally(() => inflight.delete(key));
    inflight.set(key, pending);
  }
  const result = await pending;
  try {
    await deps.writeCache(key, result);
  } catch (error) {
    logger.warn("[SMART_SEGMENT] similar-brand cache write failed", { key, error: (error as Error)?.message });
    notes.push("Résultat non mémorisé (table smart_segment_similar_brand_analyses indisponible) : la recherche sera refaite à la prochaine ouverture.");
  }
  return { ...toResponse(result), cached: false, notes: [...result.notes, ...notes] };
}

function toResponse(result: SimilarBrandLookupResult): Omit<SmartSegmentSimilarBrandsResponse, "cached" | "notes"> {
  return {
    brandName: result.brandName,
    coreRefs: result.coreRefs,
    sector: result.sector,
    profile: result.profile ?? null,
    brands: result.brands,
    affinityBrands: Array.isArray(result.affinityBrands) ? result.affinityBrands : [],
    webSearchUsed: result.webSearchUsed,
    webSearches: result.webSearches,
    generatedAt: result.generatedAt,
  };
}

async function runLookup(brandName: string, coreRefs: string[], deps: SimilarBrandDeps): Promise<SimilarBrandLookupResult> {
  // One deadline for everything (directory, web-enabled call, knowledge
  // fallback): the wizard request must end before the reverse proxy's 60 s.
  const startedAt = Date.now();
  const deadline = startedAt + deps.config.similarAiTimeoutMs;
  const budget = (): number => {
    const remaining = deadline - Date.now();
    if (remaining < MIN_CALL_BUDGET_MS) {
      throw new SmartSegmentError("AI_TIMEOUT", `La recherche de marques similaires n'a pas abouti en ${Math.round(deps.config.similarAiTimeoutMs / 1000)} s.`, 504);
    }
    return remaining;
  };
  const excluded = excludedSimilarRefs(coreRefs);
  const ownKey = brandNameKey(brandName);
  const fullDirectory = await deps.loadDirectory();
  // The brand itself never appears in the list offered to the model: neither
  // by name nor through any of its refs.
  const directory = fullDirectory.filter((brand) => brandNameKey(brand.name) !== ownKey && !brand.refs.some((ref) => excluded.has(ref)));
  const notes: string[] = [];
  if (!directory.length) {
    throw new SmartSegmentError("SMART_SEGMENT_DIRECTORY_EMPTY", "L'annuaire des marques est vide : aucune marque similaire ne peut être proposée.", 409);
  }
  let response: AnthropicMessageResponse;
  let webSearchAvailable = true;
  try {
    response = await deps.callModel({
      ...buildSimilarBrandsPrompt({ brandName, coreRefs, directory, webSearchAvailable: true, maxWebSearches: deps.config.similarWebSearchMaxUses }),
      maxTokens: 1_500,
      webSearch: { maxUses: deps.config.similarWebSearchMaxUses },
    }, budget());
  } catch (error) {
    if (!(error instanceof AnthropicClientError) || error.code !== "AI_TOOL_UNAVAILABLE") throw toSmartSegmentError(error);
    // The account/model cannot use the web search tool: say so and answer
    // from model knowledge rather than failing the whole section.
    logger.warn("[SMART_SEGMENT] web search tool unavailable, falling back to model knowledge", { brandName, detail: error.message.slice(0, 200) });
    webSearchAvailable = false;
    notes.push("Recherche web indisponible pour cette clé API : marques proposées d'après les connaissances du modèle uniquement.");
    try {
      response = await deps.callModel({
        ...buildSimilarBrandsPrompt({ brandName, coreRefs, directory, webSearchAvailable: false, maxWebSearches: 0 }),
        maxTokens: 1_500,
      }, budget());
    } catch (fallbackError) {
      throw toSmartSegmentError(fallbackError);
    }
  }
  let selected: SelectedSimilarBrands;
  try {
    selected = selectSimilarBrands(extractJsonObject(response.text), directory, excluded, SMART_SEGMENT_MAX_SIMILAR_REFS, { brandVertical: verticalOf(coreRefs[0] ?? null) });
  } catch (error) {
    if (error instanceof SimilarBrandsOutputMalformed) {
      logger.warn("[SMART_SEGMENT] similar-brand model output malformed", { brandName, detail: error.message, excerpt: response.text.slice(0, 200) });
      throw new SmartSegmentError("AI_BAD_RESPONSE", `Réponse du modèle inexploitable : ${error.message}. Relancez la recherche.`, 502);
    }
    throw toSmartSegmentError(error);
  }
  const webSearches = response.webSearches ?? 0;
  const webSearchResults = response.webSearchResults ?? 0;
  if (webSearchAvailable && webSearches === 0) {
    notes.push("Le modèle n'a effectué aucune recherche web pour cette marque : proposition fondée sur ses connaissances.");
  } else if (webSearchAvailable && webSearchResults === 0) {
    notes.push("Aucune recherche web n'a abouti pour cette marque : proposition fondée sur les connaissances du modèle.");
  }
  if (response.webSearchErrors?.length) {
    notes.push(`Certaines recherches web ont échoué (${[...new Set(response.webSearchErrors)].join(", ")}).`);
  }
  if (selected.strippedSentences > 0) {
    notes.push("Des phrases chiffrées écrites par le modèle ont été retirées des descriptions.");
  }
  if (selected.hallucinated.length) {
    logger.warn("[SMART_SEGMENT] similar-brand names outside the directory dropped", { brandName, names: selected.hallucinated.slice(0, 10) });
    notes.push(`Marques citées par le modèle mais absentes de l'annuaire, ignorées : ${selected.hallucinated.slice(0, 6).join(", ")}.`);
  }
  if (selected.dropped.length) {
    notes.push(`Marques de l'annuaire écartées (refs de la marque elle-même ou plafond de ${SMART_SEGMENT_MAX_SIMILAR_REFS} refs atteint) : ${selected.dropped.slice(0, 6).join(", ")}.`);
  }
  if (!selected.brands.length) {
    notes.push("Aucune marque comparable trouvée dans l'annuaire pour cette marque.");
  }
  if (selected.affinityListMissing) {
    notes.push("Le modèle n'a pas renvoyé de liste de marques d'affinité : aucune audience similaire hors secteur proposée — relancez avec « Actualiser ».");
  }
  if (selected.affinitySameVertical.length) {
    notes.push(`Marques d'affinité écartées par le serveur car de la même verticale que la marque : ${selected.affinitySameVertical.slice(0, 6).join(", ")}.`);
  }
  if (selected.affinityDropped.length) {
    notes.push(`Marques d'affinité écartées (déjà parmi les marques similaires, refs de la marque elle-même ou plafond de ${SMART_SEGMENT_MAX_AFFINITY_REFS} refs atteint) : ${selected.affinityDropped.slice(0, 6).join(", ")}.`);
  }
  if (!selected.affinityListMissing && !selected.affinityBrands.length) {
    notes.push("Aucune marque d'affinité hors secteur trouvée dans l'annuaire pour cette marque.");
  }
  logger.info("[SMART_SEGMENT] similar-brand lookup ok", {
    brandName,
    coreRefs,
    brands: selected.brands.map((brand) => `${brand.name}:${brand.refs.join("+")}`),
    affinityBrands: selected.affinityBrands.map((brand) => `${brand.name}:${brand.refs.join("+")}`),
    webSearches,
    webSearchAvailable,
    elapsedMs: Date.now() - startedAt,
  });
  return {
    promptVersion: SMART_SEGMENT_SIMILAR_PROMPT_VERSION,
    model: response.model,
    brandName,
    coreRefs,
    sector: selected.sector,
    profile: selected.profile,
    brands: selected.brands,
    affinityBrands: selected.affinityBrands,
    webSearchUsed: webSearchAvailable && webSearchResults > 0,
    webSearches,
    generatedAt: (deps.now?.() ?? new Date()).toISOString(),
    hallucinated: selected.hallucinated,
    notes,
  };
}

function toSmartSegmentError(error: unknown): Error {
  if (error instanceof SmartSegmentError) return error;
  if (error instanceof AnthropicClientError) {
    const status = error.status === 401 || error.status === 403 ? 503 : error.code === "AI_TIMEOUT" ? 504 : 502;
    return new SmartSegmentError(error.code, error.message, status);
  }
  return error instanceof Error ? error : new Error(String(error));
}

// ====== Selection validation (unchanged contract) ======

/**
 * Validates the operator's selection for an analysis. Refs are normalised to
 * uppercase (exact-case convention of the base); the brand's own refs, its
 * extensions, the bot-opener ref and DEL are refused rather than silently
 * dropped, so the identity the client displays is the one the server used.
 */
export function validateSimilarRefs(
  refs: readonly string[] | null | undefined,
  brand: Pick<SmartSegmentBrandResolution, "coreRefs" | "extensionRefs">,
): { similarRefs: string[]; rejected: string[] } {
  const excluded = new Set([...brand.coreRefs, ...brand.extensionRefs, BOT_OPENER_REF, "DEL"]);
  const normalized = normalizeSimilarRefs(refs);
  const rejected = normalized.filter((ref) => excluded.has(ref));
  return { similarRefs: normalized.filter((ref) => !excluded.has(ref)), rejected };
}

/** Brand resolution carrying the operator's similar-ref selection. */
export function withSimilarRefs(brand: SmartSegmentBrandResolution, similarRefs: string[]): SmartSegmentBrandResolution {
  return {
    ...brand,
    similarRefs,
    // A similar ref is never counted twice: it leaves the vertical pool.
    verticalRefs: brand.verticalRefs.filter((ref) => !similarRefs.includes(ref)),
  };
}

export type AffinityRefRejection = { ref: string; reason: "own_brand" | "same_vertical" | "already_similar" };
export const AFFINITY_REF_REJECTION_LABELS: Record<AffinityRefRejection["reason"], string> = {
  own_brand: "ref de la marque elle-même, DEL ou ref robot",
  same_vertical: "même verticale que la marque",
  already_similar: "déjà parmi les marques similaires",
};

/**
 * Validates the operator's affinity selection for an analysis: same
 * exclusions as the similar refs, plus the two rules that make the segment
 * what it claims to be — a ref carrying the brand's own vertical is refused
 * (« hors secteur » is a server guarantee, not a model opinion), and a ref
 * already kept as similar is refused (the two segments must not overlap by
 * construction). Refused refs are reported, never silently dropped.
 */
export function validateAffinityRefs(
  refs: readonly string[] | null | undefined,
  brand: Pick<SmartSegmentBrandResolution, "coreRefs" | "extensionRefs" | "vertical">,
  similarRefs: readonly string[],
): { affinityRefs: string[]; rejected: AffinityRefRejection[] } {
  const own = new Set([...brand.coreRefs, ...brand.extensionRefs, BOT_OPENER_REF, "DEL"]);
  const similar = new Set(normalizeSimilarRefs(similarRefs));
  const affinityRefs: string[] = [];
  const rejected: AffinityRefRejection[] = [];
  for (const ref of normalizeSimilarRefs(refs)) {
    if (own.has(ref)) rejected.push({ ref, reason: "own_brand" });
    // A ref in both selections is told as such: that is the one the operator
    // can act on (most similar refs share the brand's vertical anyway).
    else if (similar.has(ref)) rejected.push({ ref, reason: "already_similar" });
    else if (brand.vertical !== null && refVerticalDigit(ref) === brand.vertical) rejected.push({ ref, reason: "same_vertical" });
    else affinityRefs.push(ref);
  }
  return { affinityRefs, rejected };
}

/** Operator sentence listing refused affinity refs with their reason. */
export function describeAffinityRejections(rejected: readonly AffinityRefRejection[]): string {
  return rejected.map((entry) => `${entry.ref} (${AFFINITY_REF_REJECTION_LABELS[entry.reason]})`).join(", ");
}

/** Brand resolution carrying the operator's affinity-ref selection (apply after withSimilarRefs). */
export function withAffinityRefs(brand: SmartSegmentBrandResolution, affinityRefs: string[]): SmartSegmentBrandResolution {
  return {
    ...brand,
    affinityRefs,
    // Another vertical by construction, but never counted twice should the
    // vertical pool ever carry one of them.
    verticalRefs: brand.verticalRefs.filter((ref) => !affinityRefs.includes(ref)),
  };
}
