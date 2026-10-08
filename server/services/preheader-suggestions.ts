// AI preheader suggestions (campaign wizard, Content step).
//
// One synchronous model call per click, answered inside the wizard request:
// the newsletter HTML is reduced to its visible text (cheerio) and its main
// images are fetched and shown to the model (vision), which is asked for
// PREHEADER_SUGGESTION_COUNT distinct preheaders in the language of the
// newsletter. The answer is validated/normalised here before it reaches the
// browser. Images matter: many newsletters are picture-only (the offer, the
// prices and the dates are baked into the key visuals), so text extraction
// alone sees nothing usable. Nothing is persisted: a suggestion only becomes
// data once the operator clicks it and saves the campaign.
//
// Credentials and model come from the same environment as the smart segment
// assistant (ANTHROPIC_API_KEY, SMART_SEGMENT_MODEL, ANTHROPIC_BASE_URL): one
// AI configuration for the whole wizard.
import * as cheerio from "cheerio";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { randomUUID } from "crypto";
import { logger } from "../logger";
import { IMAGES_DIR, downloadImage, mapWithConcurrency } from "../utils";
import {
  PREHEADER_MAX_LENGTH,
  PREHEADER_RECOMMENDED_MAX,
  PREHEADER_RECOMMENDED_MIN,
  PREHEADER_SUGGESTION_COUNT,
  type PreheaderSuggestion,
  type PreheaderSuggestionsResponse,
} from "@shared/preheader-suggestions";
import { getSmartSegmentConfig } from "../config/smart-segment";
import {
  AnthropicClientError,
  anthropicCreateMessage,
  extractJsonObject,
  type AnthropicImageInput,
  type AnthropicMessageRequest,
  type AnthropicMessageResponse,
} from "./anthropic-client";

export class PreheaderSuggestionError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 500) {
    super(message);
    this.name = "PreheaderSuggestionError";
  }
}

/** Visible text handed to the model; ~2k tokens keeps the call fast and cheap. */
export const PREHEADER_TEXT_BUDGET_CHARS = 8_000;
/** Whole request budget, under the 60 s the production reverse proxy allows per request. */
export const PREHEADER_TOTAL_BUDGET_MS = 55_000;
/** Part of the budget spent fetching the newsletter images (the model gets the rest). */
export const PREHEADER_IMAGE_BUDGET_MS = 20_000;
/** The model call is never given less than this, whatever the images cost. */
const PREHEADER_MIN_MODEL_MS = 20_000;
/** Fresh calls running at once in this process; beyond it the wizard is told to retry. */
export const PREHEADER_MAX_CONCURRENT_CALLS = 3;
/** Bumped whenever the prompt contract changes (logged with every call). */
export const PREHEADER_PROMPT_VERSION = "preheader-v2";
/** Images shown to the model, in newsletter order (each one costs ~1k tokens). */
export const PREHEADER_MAX_IMAGES = 8;
/** One image above this is skipped (Anthropic refuses > 5 MB; base64 adds a third). */
export const PREHEADER_MAX_IMAGE_BYTES = 3 * 1024 * 1024;
/** All images together, raw bytes. */
export const PREHEADER_MAX_TOTAL_IMAGE_BYTES = 8 * 1024 * 1024;
/** Known-dimension images smaller than this are spacers, icons or pixels. */
const PREHEADER_MIN_IMAGE_EDGE_PX = 80;
const MODEL_MAX_TOKENS = 1_000;
/** Fewer usable suggestions than this is treated as a bad answer, not a result. */
const MIN_USABLE_SUGGESTIONS = 3;

export type PreheaderSuggestionInput = {
  subject: string;
  htmlContent: string;
  campaignName?: string | null;
};

export type ImageFetcher = (candidate: ImageCandidate, deadlineAt: number) => Promise<Buffer | null>;

export type PreheaderSuggestionDeps = {
  callModel: (request: AnthropicMessageRequest, timeoutMs: number) => Promise<AnthropicMessageResponse>;
  model: string;
  /** Fetches one newsletter image (default: SSRF-guarded download or local campaign file). */
  fetchImage?: ImageFetcher;
  now?: () => number;
};

// ====== HTML → text ======

export type ExtractedNewsletterText = {
  text: string;
  /** True when the visible text exceeded the budget and was cut. */
  truncated: boolean;
  /** Hidden « preview text » block found at the top of the HTML, when the template has one. */
  existingPreheader: string | null;
};

const WHITESPACE = /\s+/g;
const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF\u034F]/g;
const ALT_PLACEHOLDER = /\[image : [^\]]*\]/g;

/** Text worth reading on its own: image alt placeholders alone do not count. */
export function hasReadableText(text: string): boolean {
  return text.replace(ALT_PLACEHOLDER, "").replace(WHITESPACE, "").length >= 20;
}

function normalizeLine(value: string): string {
  return value.replace(ZERO_WIDTH, "").replace(WHITESPACE, " ").trim();
}

/** Inline styles email templates use to hide a block from the reader (preview text, mobile/desktop variants). */
function isHiddenStyle(style: string): boolean {
  const compact = style.toLowerCase().replace(WHITESPACE, "");
  return compact.includes("display:none") || /max-height:0(px)?(;|$)/.test(compact) || compact.includes("visibility:hidden");
}

/**
 * Reduces a newsletter to what a reader sees: title, body text, image alt
 * texts, link labels. Scripts, styles, comments and tracking pixels are
 * dropped. Repeated lines (desktop + mobile variants of the same block) are
 * kept once. The first PREHEADER_TEXT_BUDGET_CHARS are kept — the hero and
 * the main offer live at the top of every newsletter.
 *
 * Only `display:none` / `max-height:0` / `visibility:hidden` count as hidden:
 * MJML wraps every visible column in `font-size:0px` containers, so font
 * size must never be read as « invisible ».
 */
export function extractNewsletterText(html: string, budgetChars = PREHEADER_TEXT_BUDGET_CHARS): ExtractedNewsletterText {
  const $ = cheerio.load(html);
  $("script, style, noscript, template, head > meta, head > link").remove();

  // Candidate preview blocks, in document order. They stay in the text for
  // now: a hidden block is only « the preheader » when it opens the body —
  // hidden mobile variants further down are ordinary content.
  const hiddenBlocks: string[] = [];
  $("[style]").each((_, element) => {
    if (!isHiddenStyle(String($(element).attr("style") ?? ""))) return;
    const hidden = normalizeLine($(element).text());
    if (hidden.length >= 10 && hidden.length <= 300) hiddenBlocks.push(hidden);
  });

  // Alt texts describe the hero images, often the only place the offer is stated.
  $("img").each((_, element) => {
    const alt = normalizeLine(String($(element).attr("alt") ?? ""));
    const width = Number.parseInt(String($(element).attr("width") ?? ""), 10);
    if (alt && alt.length > 2 && !(Number.isFinite(width) && width <= 2)) {
      $(element).replaceWith(` [image : ${alt}] `);
    } else {
      $(element).remove();
    }
  });

  const title = normalizeLine($("title").first().text());
  // Block boundaries become line breaks so the model sees the structure.
  $("br, p, div, tr, td, th, li, h1, h2, h3, h4, h5, h6, table, section, article, header, footer").each((_, element) => {
    $(element).append("\n");
  });
  const bodyText = $("body").length ? $("body").first().text() : $.root().text();
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const rawLine of bodyText.split("\n")) {
    const line = normalizeLine(rawLine);
    if (!line) continue;
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(line);
  }

  let existingPreheader: string | null = null;
  if (hiddenBlocks.length > 0 && lines.length > 0) {
    const opening = normalizeLine(lines.slice(0, 3).join(" ")).toLowerCase();
    const first = hiddenBlocks[0];
    if (opening.startsWith(first.toLowerCase())) {
      existingPreheader = first;
      // Drop the lines that made it up (they are not newsletter copy).
      let consumed = "";
      while (lines.length > 0 && consumed.length < first.length) {
        consumed = normalizeLine(`${consumed} ${lines.shift()}`);
      }
    }
  }

  const body = lines.join("\n");
  let text = title ? `Titre : ${title}\n${body}` : body;
  let truncated = false;
  if (text.length > budgetChars) {
    text = `${text.slice(0, budgetChars)}\n[… contenu tronqué]`;
    truncated = true;
  }
  return { text, truncated, existingPreheader };
}

// ====== Images ======

export type ImageCandidate = {
  /** Position in the newsletter (1-based, after filtering). */
  index: number;
  src: string;
  alt: string | null;
  /** Declared width/height attributes when present. */
  width: number | null;
  height: number | null;
};

const TRACKING_PIXEL_SRC = /(\/imp\?|\/open\b|\/track|\/pixel|\/beacon|\.gif\?|\/o\/|\/wf\/open)/i;

/**
 * Picks the images worth showing to the model: unique sources in document
 * order, minus tracking pixels and declared-tiny images, capped at
 * PREHEADER_MAX_IMAGES. Dimensions declared in the HTML are hints only; the
 * decoded header is checked again after download.
 */
export function collectImageCandidates(html: string, maxImages = PREHEADER_MAX_IMAGES): ImageCandidate[] {
  const $ = cheerio.load(html);
  const seen = new Set<string>();
  const candidates: ImageCandidate[] = [];
  $("img").each((_, element) => {
    const src = String($(element).attr("src") ?? "").trim();
    if (!src || src.startsWith("data:") || src.startsWith("cid:")) return;
    const width = parseDimension($(element).attr("width"), $(element).attr("style"), "width");
    const height = parseDimension($(element).attr("height"), $(element).attr("style"), "height");
    if ((width !== null && width <= 2) || (height !== null && height <= 2)) return;
    if (width !== null && width < PREHEADER_MIN_IMAGE_EDGE_PX && height !== null && height < PREHEADER_MIN_IMAGE_EDGE_PX) return;
    if (TRACKING_PIXEL_SRC.test(src) && width === null && height === null) return;
    const key = src.split("#")[0];
    if (seen.has(key)) return;
    seen.add(key);
    const alt = normalizeLine(String($(element).attr("alt") ?? ""));
    candidates.push({ index: candidates.length + 1, src, alt: alt || null, width, height });
  });
  return candidates.slice(0, maxImages);
}

function parseDimension(attr: unknown, style: unknown, name: "width" | "height"): number | null {
  const fromAttr = Number.parseInt(String(attr ?? ""), 10);
  if (Number.isFinite(fromAttr) && fromAttr > 0) return fromAttr;
  const match = String(style ?? "").toLowerCase().replace(WHITESPACE, "").match(new RegExp(`(?:^|;)${name}:(\\d+)px`));
  if (match) return Number.parseInt(match[1], 10);
  return null;
}

export type DecodedImageHeader = {
  mediaType: AnthropicImageInput["mediaType"];
  width: number | null;
  height: number | null;
};

/** Reads the format and, when cheap, the dimensions from the first bytes. Unknown formats return null. */
export function decodeImageHeader(buffer: Buffer): DecodedImageHeader | null {
  if (buffer.length < 12) return null;
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return buffer.length >= 24
      ? { mediaType: "image/png", width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
      : { mediaType: "image/png", width: null, height: null };
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) { offset += 1; continue; }
      const marker = buffer[offset + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
      const length = buffer.readUInt16BE(offset + 2);
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) {
        return { mediaType: "image/jpeg", height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
      }
      if (length < 2) break;
      offset += 2 + length;
    }
    return { mediaType: "image/jpeg", width: null, height: null };
  }
  if (buffer.subarray(0, 6).toString("ascii") === "GIF87a" || buffer.subarray(0, 6).toString("ascii") === "GIF89a") {
    return { mediaType: "image/gif", width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }
  if (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") {
    const chunk = buffer.subarray(12, 16).toString("ascii");
    if (chunk === "VP8X" && buffer.length >= 30) {
      return { mediaType: "image/webp", width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) };
    }
    if (chunk === "VP8 " && buffer.length >= 30) {
      return { mediaType: "image/webp", width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
    }
    if (chunk === "VP8L" && buffer.length >= 25) {
      const bits = buffer.readUInt32LE(21);
      return { mediaType: "image/webp", width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
    }
    return { mediaType: "image/webp", width: null, height: null };
  }
  return null;
}

const LOCAL_IMAGE_PATH = /^(?:https?:\/\/[^/]+)?\/(?:campaigns|i)\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)\/([A-Za-z0-9._-]+)(?:[?#].*)?$/;

/**
 * Default fetcher: images already hosted by this app are read from disk;
 * anything else goes through the SSRF-guarded downloader (public addresses
 * only, 10 MB cap, redirects bounded) into a throwaway temp file.
 */
export async function fetchNewsletterImage(candidate: ImageCandidate, deadlineAt: number): Promise<Buffer | null> {
  if (Date.now() >= deadlineAt) return null;
  const local = candidate.src.match(LOCAL_IMAGE_PATH);
  if (local) {
    const filePath = path.resolve(IMAGES_DIR, local[3], local[4]);
    if (!filePath.startsWith(path.resolve(IMAGES_DIR) + path.sep)) return null;
    try {
      const stat = await fs.promises.stat(filePath);
      if (stat.size > PREHEADER_MAX_IMAGE_BYTES) return null;
      return await fs.promises.readFile(filePath);
    } catch {
      if (!/^https?:\/\//i.test(candidate.src)) return null;
      // Hosted on a domain we do not serve from this disk: fall through to HTTP.
    }
  }
  const src = candidate.src.startsWith("//") ? `https:${candidate.src}` : candidate.src;
  if (!/^https?:\/\//i.test(src)) return null;
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "preheader-ai-"));
  const tmpFile = path.join(tmpDir, `${randomUUID()}.img`);
  try {
    const ok = await Promise.race([
      downloadImage(src, tmpFile),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), Math.max(1, deadlineAt - Date.now()))),
    ]);
    if (!ok) return null;
    const stat = await fs.promises.stat(tmpFile);
    if (stat.size > PREHEADER_MAX_IMAGE_BYTES) return null;
    return await fs.promises.readFile(tmpFile);
  } catch {
    return null;
  } finally {
    fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export type PreparedImages = {
  images: AnthropicImageInput[];
  /** Candidates found in the HTML (before fetching). */
  candidates: number;
  /** Candidates that could not be fetched or were not a usable raster image. */
  skipped: number;
  /** True when the time budget ran out before every candidate was tried. */
  timedOut: boolean;
};

/**
 * Fetches the candidates (4 at a time) under one deadline and turns the
 * usable ones into vision inputs: raster formats the API accepts, not tiny,
 * within the per-image and total size caps.
 */
export async function prepareNewsletterImages(
  candidates: ImageCandidate[],
  fetchImage: ImageFetcher,
  deadlineAt: number,
  now: () => number = Date.now,
): Promise<PreparedImages> {
  type Fetched = { candidate: ImageCandidate; buffer: Buffer | null; attempted: boolean };
  const fetched: Fetched[] = await mapWithConcurrency(candidates, 4, async (candidate) => {
    if (now() >= deadlineAt) return { candidate, buffer: null, attempted: false };
    try {
      return { candidate, buffer: await fetchImage(candidate, deadlineAt), attempted: true };
    } catch {
      return { candidate, buffer: null, attempted: true };
    }
  });
  const images: AnthropicImageInput[] = [];
  let skipped = 0;
  let totalBytes = 0;
  for (const { candidate, buffer } of fetched) {
    const header = buffer ? decodeImageHeader(buffer) : null;
    if (!buffer || !header) { skipped += 1; continue; }
    const tiny = header.width !== null && header.height !== null
      && header.width < PREHEADER_MIN_IMAGE_EDGE_PX && header.height < PREHEADER_MIN_IMAGE_EDGE_PX;
    const oversized = (header.width ?? 0) > 8_000 || (header.height ?? 0) > 8_000;
    if (tiny || oversized || buffer.length > PREHEADER_MAX_IMAGE_BYTES || totalBytes + buffer.length > PREHEADER_MAX_TOTAL_IMAGE_BYTES) {
      skipped += 1;
      continue;
    }
    totalBytes += buffer.length;
    images.push({
      mediaType: header.mediaType,
      data: buffer.toString("base64"),
      label: `Image ${candidate.index} de la newsletter${candidate.alt ? ` (alt : ${candidate.alt})` : ""} :`,
    });
  }
  return { images, candidates: candidates.length, skipped, timedOut: fetched.some((entry) => !entry.attempted) };
}

// ====== Prompt ======

export function buildPreheaderPrompt(
  input: PreheaderSuggestionInput,
  extracted: ExtractedNewsletterText,
  images: AnthropicImageInput[] = [],
): AnthropicMessageRequest {
  const system = [
    "Tu es un expert en emailing B2C francophone et international. On te donne l'objet, le texte visible et les principales images d'une newsletter ;",
    `tu proposes ${PREHEADER_SUGGESTION_COUNT} preheaders (texte d'aperçu affiché après l'objet dans la boîte de réception).`,
    "",
    "Les images font partie du contenu : lis le texte qu'elles contiennent (offre, remise, dates, noms de produits ou de collections, prix, slogans)",
    "et observe ce qu'elles montrent (produits, ambiance, saison). Beaucoup de newsletters ne disent l'essentiel que dans leurs visuels.",
    "",
    "Règles impératives :",
    "- Même langue que la newsletter (déduis-la du contenu, pas de l'objet seul).",
    `- Entre ${PREHEADER_RECOMMENDED_MIN} et ${PREHEADER_RECOMMENDED_MAX} caractères chacun, jamais plus de ${PREHEADER_MAX_LENGTH}.`,
    "- Chaque preheader complète l'objet : il ne le répète pas, ne le paraphrase pas.",
    "- 5 angles différents, par exemple : bénéfice concret, urgence ou date limite réelle, curiosité, détail de l'offre ou produit phare, preuve ou réassurance.",
    "- Tu n'inventes rien : pas de prix, de remise, de date, de marque ou de produit qui ne soit ni dans le texte ni lisible dans les images.",
    "- Pas d'emoji sauf si la newsletter en utilise ; pas de majuscules criardes ; pas de guillemets autour du texte ; pas de point final obligatoire.",
    "- Jamais de mention technique (« voir la version en ligne », « se désabonner », « cliquez ici », « cet email est envoyé par un partenaire »).",
    "",
    "Réponds UNIQUEMENT avec un objet JSON, sans texte autour :",
    '{"language":"fr","suggestions":[{"text":"…","angle":"bénéfice"}, …]}',
    "« language » est le code ISO 639-1 de la newsletter ; « angle » est un mot ou deux, dans la même langue que la newsletter.",
  ].join("\n");

  const parts: string[] = [];
  if (input.campaignName?.trim()) parts.push(`Campagne : ${input.campaignName.trim()}`);
  parts.push(`Objet : ${input.subject.trim() || "(non renseigné)"}`);
  if (extracted.existingPreheader) {
    parts.push(`Preheader déjà présent dans le template (à améliorer, pas à recopier) : ${extracted.existingPreheader}`);
  }
  if (images.length > 0) {
    parts.push(`${images.length} image(s) de la newsletter sont jointes ci-dessus, dans l'ordre d'apparition.`);
  }
  const text = extracted.text.trim();
  parts.push("", "Texte visible de la newsletter :", "<<<");
  if (text) parts.push(text);
  if (!hasReadableText(extracted.text)) parts.push("(aucun texte : tout le contenu est dans les images)");
  parts.push(">>>");
  return { system, user: parts.join("\n"), maxTokens: MODEL_MAX_TOKENS, temperature: 0.7, ...(images.length > 0 ? { images } : {}) };
}

// ====== Answer validation ======

function cleanSuggestionText(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let text = raw.replace(WHITESPACE, " ").trim();
  // Models sometimes wrap the text in quotes or number it despite the rules.
  text = text.replace(/^\d+[.)]\s*/, "").replace(/^["'«“]\s*/, "").replace(/\s*["'»”]$/, "").trim();
  if (!text) return null;
  if (text.length > PREHEADER_MAX_LENGTH) {
    const cut = text.slice(0, PREHEADER_MAX_LENGTH);
    const lastSpace = cut.lastIndexOf(" ");
    text = (lastSpace > PREHEADER_MAX_LENGTH * 0.6 ? cut.slice(0, lastSpace) : cut).trim();
  }
  return text;
}

function cleanAngle(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const angle = raw.replace(WHITESPACE, " ").trim().toLowerCase();
  return angle ? angle.slice(0, 40) : null;
}

/**
 * Validates and normalises the model's JSON. Duplicates (case/space
 * insensitive) and copies of the subject are dropped; fewer than
 * MIN_USABLE_SUGGESTIONS usable lines is an AI_BAD_RESPONSE so the wizard
 * offers a retry instead of a half-empty list.
 */
export function parsePreheaderModelOutput(text: string, subject: string): { suggestions: PreheaderSuggestion[]; language: string | null } {
  const parsed = extractJsonObject(text) as { language?: unknown; suggestions?: unknown };
  const rawList = Array.isArray(parsed.suggestions) ? parsed.suggestions : [];
  const normalizedSubject = subject.replace(WHITESPACE, " ").trim().toLowerCase();
  const seen = new Set<string>();
  const suggestions: PreheaderSuggestion[] = [];
  for (const item of rawList) {
    const record: { text?: unknown; angle?: unknown } = item && typeof item === "object"
      ? (item as { text?: unknown; angle?: unknown })
      : { text: item };
    const cleaned = cleanSuggestionText(record.text);
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key) || (normalizedSubject && key === normalizedSubject)) continue;
    seen.add(key);
    suggestions.push({ text: cleaned, angle: cleanAngle(record.angle) });
    if (suggestions.length >= PREHEADER_SUGGESTION_COUNT) break;
  }
  if (suggestions.length < MIN_USABLE_SUGGESTIONS) {
    throw new AnthropicClientError(
      `le modèle n'a renvoyé que ${suggestions.length} preheader(s) exploitable(s)`,
      null,
      true,
      "AI_BAD_RESPONSE",
    );
  }
  const language = typeof parsed.language === "string" && /^[a-z]{2}$/i.test(parsed.language.trim())
    ? parsed.language.trim().toLowerCase()
    : null;
  return { suggestions, language };
}

// ====== Entry point ======

function defaultDeps(): PreheaderSuggestionDeps {
  const config = getSmartSegmentConfig();
  if (!config.apiKey) {
    throw new PreheaderSuggestionError(
      "AI_NOT_CONFIGURED",
      "ANTHROPIC_API_KEY n'est pas défini sur le serveur : les suggestions de preheader sont indisponibles.",
      503,
    );
  }
  const apiKey = config.apiKey;
  return {
    model: config.model,
    callModel: (request, timeoutMs) => anthropicCreateMessage(
      { apiKey, model: config.model, baseUrl: config.anthropicBaseUrl, timeoutMs },
      request,
    ),
    fetchImage: fetchNewsletterImage,
  };
}

function toPreheaderError(error: unknown): Error {
  if (error instanceof PreheaderSuggestionError) return error;
  if (error instanceof AnthropicClientError) {
    if (error.code === "AI_BAD_RESPONSE") {
      return new PreheaderSuggestionError("AI_BAD_RESPONSE", `Réponse du modèle inexploitable : ${error.message}. Relancez la suggestion.`, 502);
    }
    const status = error.status === 401 || error.status === 403 ? 503 : error.code === "AI_TIMEOUT" ? 504 : 502;
    return new PreheaderSuggestionError(error.code, error.message, status);
  }
  return error instanceof Error ? error : new Error(String(error));
}

let inflightCalls = 0;

export async function suggestPreheaders(
  input: PreheaderSuggestionInput,
  deps: PreheaderSuggestionDeps = defaultDeps(),
): Promise<PreheaderSuggestionsResponse> {
  const now = deps.now ?? Date.now;
  const extracted = extractNewsletterText(input.htmlContent);
  const candidates = collectImageCandidates(input.htmlContent);
  const hasText = hasReadableText(extracted.text);
  if (!hasText && candidates.length === 0) {
    throw new PreheaderSuggestionError(
      "CONTENT_EMPTY",
      "Le HTML ne contient ni texte lisible ni image à analyser : impossible de proposer un preheader.",
      422,
    );
  }
  if (inflightCalls >= PREHEADER_MAX_CONCURRENT_CALLS) {
    throw new PreheaderSuggestionError(
      "AI_BUSY",
      "Trop de suggestions de preheader en cours : réessayez dans quelques secondes.",
      429,
    );
  }
  inflightCalls += 1;
  const startedAt = now();
  const overallDeadline = startedAt + PREHEADER_TOTAL_BUDGET_MS;
  try {
    const prepared = candidates.length > 0 && deps.fetchImage
      ? await prepareNewsletterImages(candidates, deps.fetchImage, Math.min(overallDeadline, startedAt + PREHEADER_IMAGE_BUDGET_MS), now)
      : { images: [], candidates: candidates.length, skipped: candidates.length, timedOut: false } satisfies PreparedImages;
    if (!hasText && prepared.images.length === 0) {
      throw new PreheaderSuggestionError(
        "CONTENT_EMPTY",
        `Le HTML ne contient pas de texte lisible et aucune de ses ${candidates.length} image(s) n'a pu être chargée pour analyse${prepared.timedOut ? " (délai dépassé)" : ""}. Essayez après « Re-process images » ou ajoutez du texte.`,
        422,
      );
    }
    const modelTimeoutMs = Math.max(PREHEADER_MIN_MODEL_MS, overallDeadline - now());
    const request = buildPreheaderPrompt(input, extracted, prepared.images);
    const answer = await deps.callModel(request, modelTimeoutMs);
    const { suggestions, language } = parsePreheaderModelOutput(answer.text, input.subject);
    const notes: string[] = [];
    if (extracted.truncated) notes.push("Newsletter longue : seule la première partie du texte a été analysée.");
    if (prepared.candidates > 0 && prepared.images.length < prepared.candidates) {
      const unseen = prepared.candidates - prepared.images.length;
      notes.push(prepared.images.length === 0
        ? `Aucune des ${prepared.candidates} image(s) n'a pu être analysée${prepared.timedOut ? " (délai de chargement dépassé)" : ""} : propositions basées sur le texte seul.`
        : `${unseen} image(s) sur ${prepared.candidates} non analysée(s)${prepared.timedOut ? " (délai de chargement dépassé)" : ""}.`);
    }
    if (suggestions.length < PREHEADER_SUGGESTION_COUNT) {
      notes.push(`${suggestions.length} propositions distinctes au lieu de ${PREHEADER_SUGGESTION_COUNT} (doublons écartés).`);
    }
    logger.info("[PREHEADER_AI] suggestions produced", {
      promptVersion: PREHEADER_PROMPT_VERSION,
      model: answer.model || deps.model,
      count: suggestions.length,
      language,
      textChars: extracted.text.length,
      truncated: extracted.truncated,
      imageCandidates: prepared.candidates,
      imagesAnalyzed: prepared.images.length,
      imagesSkipped: prepared.skipped,
      imageTimedOut: prepared.timedOut,
      durationMs: now() - startedAt,
      inputTokens: answer.usage?.inputTokens ?? null,
      outputTokens: answer.usage?.outputTokens ?? null,
    });
    return { suggestions, language, model: answer.model || deps.model, notes, imagesAnalyzed: prepared.images.length };
  } catch (error) {
    const mapped = toPreheaderError(error);
    logger.warn("[PREHEADER_AI] suggestion failed", {
      promptVersion: PREHEADER_PROMPT_VERSION,
      code: (mapped as PreheaderSuggestionError).code ?? "INTERNAL",
      error: mapped.message,
      durationMs: now() - startedAt,
    });
    throw mapped;
  } finally {
    inflightCalls -= 1;
  }
}
