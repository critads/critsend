// AI preheader suggestions (campaign wizard, Content step).
//
// One synchronous model call per click, answered inside the wizard request:
// the newsletter HTML is reduced to its visible text (cheerio), the model is
// asked for PREHEADER_SUGGESTION_COUNT distinct preheaders in the language of
// the newsletter, and the answer is validated/normalised here before it
// reaches the browser. The model never sees raw HTML (cheaper, less noise)
// and nothing is persisted: a suggestion only becomes data once the operator
// clicks it and saves the campaign.
//
// Credentials and model come from the same environment as the smart segment
// assistant (ANTHROPIC_API_KEY, SMART_SEGMENT_MODEL, ANTHROPIC_BASE_URL): one
// AI configuration for the whole wizard.
import * as cheerio from "cheerio";
import { logger } from "../logger";
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
/** Whole call budget, under the 60 s the production reverse proxy allows per request. */
export const PREHEADER_AI_TIMEOUT_MS = 40_000;
/** Fresh calls running at once in this process; beyond it the wizard is told to retry. */
export const PREHEADER_MAX_CONCURRENT_CALLS = 3;
/** Bumped whenever the prompt contract changes (logged with every call). */
export const PREHEADER_PROMPT_VERSION = "preheader-v1";
const MODEL_MAX_TOKENS = 1_000;
/** Fewer usable suggestions than this is treated as a bad answer, not a result. */
const MIN_USABLE_SUGGESTIONS = 3;

export type PreheaderSuggestionInput = {
  subject: string;
  htmlContent: string;
  campaignName?: string | null;
};

export type PreheaderSuggestionDeps = {
  callModel: (request: AnthropicMessageRequest) => Promise<AnthropicMessageResponse>;
  model: string;
};

// ====== HTML → text ======

export type ExtractedNewsletterText = {
  text: string;
  /** True when the visible text exceeded the budget and was cut. */
  truncated: boolean;
  /** Hidden « preview text » block found in the HTML, when the template has one. */
  existingPreheader: string | null;
};

const WHITESPACE = /\s+/g;

/**
 * Reduces a newsletter to what a reader sees: title, body text, image alt
 * texts, link labels. Scripts, styles, comments and tracking pixels are
 * dropped. The first PREHEADER_TEXT_BUDGET_CHARS are kept — the hero and the
 * main offer live at the top of every newsletter.
 */
export function extractNewsletterText(html: string, budgetChars = PREHEADER_TEXT_BUDGET_CHARS): ExtractedNewsletterText {
  const $ = cheerio.load(html);
  $("script, style, noscript, template, head > meta, head > link").remove();

  // Many templates carry a hidden preview block; surface it to the model as
  // context (it must do better than it, not copy it) and keep it out of the
  // visible text so it is not mistaken for body copy.
  let existingPreheader: string | null = null;
  $("[style]").each((_, element) => {
    const style = String($(element).attr("style") ?? "").toLowerCase().replace(WHITESPACE, "");
    if (!style.includes("display:none") && !style.includes("max-height:0") && !style.includes("font-size:0")) return;
    const hidden = $(element).text().replace(WHITESPACE, " ").trim();
    if (hidden.length >= 10 && hidden.length <= 300 && existingPreheader === null) {
      existingPreheader = hidden;
    }
    $(element).remove();
  });

  // Alt texts describe the hero images, often the only place the offer is stated.
  $("img").each((_, element) => {
    const alt = String($(element).attr("alt") ?? "").trim();
    const width = Number.parseInt(String($(element).attr("width") ?? ""), 10);
    if (alt && alt.length > 2 && !(Number.isFinite(width) && width <= 2)) {
      $(element).replaceWith(` [image : ${alt}] `);
    } else {
      $(element).remove();
    }
  });

  const title = $("title").first().text().replace(WHITESPACE, " ").trim();
  // Block boundaries become line breaks so the model sees the structure.
  $("br, p, div, tr, td, th, li, h1, h2, h3, h4, h5, h6, table, section, article, header, footer").each((_, element) => {
    $(element).append("\n");
  });
  const bodyText = $("body").length ? $("body").first().text() : $.root().text();
  const body = bodyText
    .split("\n")
    .map((line) => line.replace(WHITESPACE, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n");

  let text = title ? `Titre : ${title}\n${body}` : body;
  let truncated = false;
  if (text.length > budgetChars) {
    text = `${text.slice(0, budgetChars)}\n[… contenu tronqué]`;
    truncated = true;
  }
  return { text, truncated, existingPreheader };
}

// ====== Prompt ======

export function buildPreheaderPrompt(input: PreheaderSuggestionInput, extracted: ExtractedNewsletterText): AnthropicMessageRequest {
  const system = [
    "Tu es un expert en emailing B2C francophone et international. On te donne l'objet et le texte visible d'une newsletter ;",
    `tu proposes ${PREHEADER_SUGGESTION_COUNT} preheaders (texte d'aperçu affiché après l'objet dans la boîte de réception).`,
    "",
    "Règles impératives :",
    "- Même langue que la newsletter (déduis-la du contenu, pas de l'objet seul).",
    `- Entre ${PREHEADER_RECOMMENDED_MIN} et ${PREHEADER_RECOMMENDED_MAX} caractères chacun, jamais plus de ${PREHEADER_MAX_LENGTH}.`,
    "- Chaque preheader complète l'objet : il ne le répète pas, ne le paraphrase pas.",
    "- 5 angles différents, par exemple : bénéfice concret, urgence ou date limite réelle, curiosité, détail de l'offre, preuve ou réassurance.",
    "- Tu n'inventes rien : pas de prix, de remise, de date, de marque ou de produit absents du contenu.",
    "- Pas d'emoji sauf si la newsletter en utilise ; pas de majuscules criardes ; pas de guillemets autour du texte ; pas de point final obligatoire.",
    "- Jamais de mention technique (« voir la version en ligne », « se désabonner », « cliquez ici »).",
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
  parts.push("", "Texte visible de la newsletter :", "<<<", extracted.text, ">>>");
  return { system, user: parts.join("\n"), maxTokens: MODEL_MAX_TOKENS, temperature: 0.7 };
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
    callModel: (request) => anthropicCreateMessage(
      { apiKey, model: config.model, baseUrl: config.anthropicBaseUrl, timeoutMs: PREHEADER_AI_TIMEOUT_MS },
      request,
    ),
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
  const extracted = extractNewsletterText(input.htmlContent);
  if (extracted.text.replace(WHITESPACE, "").length < 20) {
    throw new PreheaderSuggestionError(
      "CONTENT_EMPTY",
      "Le HTML ne contient pas assez de texte lisible pour proposer un preheader.",
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
  const startedAt = Date.now();
  try {
    const request = buildPreheaderPrompt(input, extracted);
    const answer = await deps.callModel(request);
    const { suggestions, language } = parsePreheaderModelOutput(answer.text, input.subject);
    const notes: string[] = [];
    if (extracted.truncated) notes.push("Newsletter longue : seule la première partie du texte a été analysée.");
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
      durationMs: Date.now() - startedAt,
      inputTokens: answer.usage?.inputTokens ?? null,
      outputTokens: answer.usage?.outputTokens ?? null,
    });
    return { suggestions, language, model: answer.model || deps.model, notes };
  } catch (error) {
    const mapped = toPreheaderError(error);
    logger.warn("[PREHEADER_AI] suggestion failed", {
      promptVersion: PREHEADER_PROMPT_VERSION,
      code: (mapped as PreheaderSuggestionError).code ?? "INTERNAL",
      error: mapped.message,
      durationMs: Date.now() - startedAt,
    });
    throw mapped;
  } finally {
    inflightCalls -= 1;
  }
}
