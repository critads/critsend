// Task #304 — isolated Anthropic Messages API client.
//
// Deliberately a raw fetch (no SDK dependency): the production lockfile has
// already been broken once by Replit proxy URLs written during dependency
// updates, and the surface we need is one POST. Nothing here knows about
// segments; the caller owns the prompt and validates the output.
//
// Task #315 — optional server-side web search tool. The API runs the searches
// itself inside the same request (no callback loop on our side); the only
// extra work is reading the mixed content blocks, counting the searches and
// resuming a `pause_turn` a bounded number of times under ONE deadline.
import { logger } from "../logger";

export class AnthropicClientError extends Error {
  constructor(
    message: string,
    public readonly status: number | null,
    public readonly retryable: boolean,
    public readonly code: string,
  ) {
    super(message);
    this.name = "AnthropicClientError";
  }
}

export type AnthropicMessageRequest = {
  system: string;
  user: string;
  maxTokens: number;
  temperature?: number;
  /**
   * Ask the API to ground the answer with its web search tool. `maxUses`
   * bounds the searches per request (each one is billed and takes seconds).
   */
  webSearch?: { maxUses: number } | null;
};

export type AnthropicMessageResponse = {
  text: string;
  model: string;
  stopReason: string | null;
  usage: { inputTokens: number; outputTokens: number } | null;
  /** Web searches the API billed for this answer (0 when the tool was not requested). */
  webSearches?: number;
  /** Searches that returned results (a billed search can still fail: see webSearchErrors). */
  webSearchResults?: number;
  /** Error codes of failed searches (e.g. max_uses_exceeded, unavailable), for the caller's notes. */
  webSearchErrors?: string[];
};

export type AnthropicClientOptions = {
  apiKey: string;
  model: string;
  baseUrl?: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
};

const ANTHROPIC_VERSION = "2023-06-01";
const WEB_SEARCH_TOOL_TYPE = "web_search_20250305";
/** A `pause_turn` (long tool loop) is resumed at most this many times. */
const MAX_PAUSE_TURN_CONTINUATIONS = 2;

type ContentBlock = {
  type: string;
  text?: string;
  content?: unknown;
  [key: string]: unknown;
};

type ParsedMessage = {
  model?: string;
  stop_reason?: string | null;
  content?: ContentBlock[];
  usage?: { input_tokens?: number; output_tokens?: number; server_tool_use?: { web_search_requests?: number } };
};

/** True when a 4xx answer says the web search tool itself is not usable for this key/model. */
export function isWebSearchToolRejection(status: number, detail: string): boolean {
  if (status !== 400 && status !== 403 && status !== 404) return false;
  return /web[\s_-]?search|tool/i.test(detail);
}

/** Splits the tool result blocks of one turn into successful searches and error codes. */
function collectWebSearchOutcomes(blocks: ContentBlock[]): { results: number; errors: string[] } {
  const errors: string[] = [];
  let results = 0;
  for (const block of blocks) {
    if (block.type !== "web_search_tool_result") continue;
    const content = block.content as { type?: string; error_code?: string } | unknown[] | undefined;
    if (Array.isArray(content)) {
      results += 1;
    } else if (content && content.type === "web_search_tool_result_error") {
      errors.push(String(content.error_code ?? "unknown"));
    }
  }
  return { results, errors };
}

export async function anthropicCreateMessage(
  options: AnthropicClientOptions,
  request: AnthropicMessageRequest,
): Promise<AnthropicMessageResponse> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = `${(options.baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "")}/v1/messages`;
  const startedAt = Date.now();
  const deadline = startedAt + options.timeoutMs;
  const timeoutError = () => new AnthropicClientError(
    `Le modèle n'a pas répondu en ${Math.round(options.timeoutMs / 1000)} s.`,
    null,
    true,
    "AI_TIMEOUT",
  );
  // `max_uses` is a per-request ceiling: a continuation must only be granted
  // what is left of the caller's budget, never a fresh allowance.
  const searchBudget = request.webSearch ? Math.max(1, Math.floor(request.webSearch.maxUses)) : 0;
  let webSearches = 0;
  const tools = request.webSearch ? () => [{ type: WEB_SEARCH_TOOL_TYPE, name: "web_search", max_uses: searchBudget - webSearches }] : undefined;

  // One round trip. The abort timer stays armed until the body is fully
  // consumed: headers can arrive quickly while the body stalls, which must
  // not pin a job (and its global analysis slot) forever. Continuations share
  // the same deadline, so the whole call still ends within `timeoutMs`.
  const postOnce = async (messages: Array<{ role: "user" | "assistant"; content: unknown }>): Promise<ParsedMessage> => {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw timeoutError();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remainingMs);
    let response: Response;
    let rawBody: string;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          "x-api-key": options.apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model: options.model,
          max_tokens: request.maxTokens,
          temperature: request.temperature ?? 0,
          system: request.system,
          messages,
          ...(tools ? { tools: tools() } : {}),
        }),
      });
      try {
        rawBody = await response.text();
      } catch (error) {
        if (controller.signal.aborted || (error as Error)?.name === "AbortError") throw timeoutError();
        throw new AnthropicClientError(`Réponse du modèle interrompue : ${(error as Error)?.message ?? String(error)}`, response.status, true, "AI_NETWORK");
      }
    } catch (error) {
      if (error instanceof AnthropicClientError) throw error;
      if (controller.signal.aborted || (error as Error)?.name === "AbortError") throw timeoutError();
      throw new AnthropicClientError(`Appel au modèle impossible : ${(error as Error)?.message ?? String(error)}`, null, true, "AI_NETWORK");
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      let detail = rawBody.slice(0, 300);
      try {
        const parsed = JSON.parse(rawBody) as { error?: { type?: string; message?: string } };
        detail = parsed.error?.message ?? detail;
      } catch {
        // keep the raw excerpt
      }
      const retryable = response.status === 429 || response.status === 529 || response.status >= 500;
      const code = tools && isWebSearchToolRejection(response.status, detail)
        ? "AI_TOOL_UNAVAILABLE"
        : response.status === 401 || response.status === 403
        ? "AI_AUTH"
        : response.status === 429 ? "AI_RATE_LIMITED"
        : response.status === 529 || response.status >= 500 ? "AI_UNAVAILABLE"
        : "AI_REQUEST_REJECTED";
      logger.warn("[SMART_SEGMENT] Anthropic call failed", { status: response.status, code, elapsedMs: Date.now() - startedAt });
      throw new AnthropicClientError(`Le modèle a refusé la requête (${response.status}) : ${detail}`, response.status, retryable, code);
    }

    try {
      return JSON.parse(rawBody) as ParsedMessage;
    } catch {
      throw new AnthropicClientError("Réponse du modèle illisible (JSON invalide).", response.status, true, "AI_BAD_RESPONSE");
    }
  };

  const messages: Array<{ role: "user" | "assistant"; content: unknown }> = [{ role: "user", content: request.user }];
  const usage = { inputTokens: 0, outputTokens: 0 };
  let usageSeen = false;
  let webSearchResults = 0;
  const webSearchErrors: string[] = [];
  let parsed: ParsedMessage;
  let continuations = 0;
  for (;;) {
    parsed = await postOnce(messages);
    if (parsed.usage) {
      usageSeen = true;
      usage.inputTokens += Number(parsed.usage.input_tokens ?? 0);
      usage.outputTokens += Number(parsed.usage.output_tokens ?? 0);
      webSearches += Number(parsed.usage.server_tool_use?.web_search_requests ?? 0);
    }
    const outcomes = collectWebSearchOutcomes(parsed.content ?? []);
    webSearchResults += outcomes.results;
    webSearchErrors.push(...outcomes.errors);
    if (parsed.stop_reason !== "pause_turn") break;
    // The API paused a long tool loop: hand its partial turn back unchanged
    // and let it continue, a bounded number of times. A turn still paused
    // after that is an unfinished answer, never a usable one.
    if (continuations >= MAX_PAUSE_TURN_CONTINUATIONS) {
      throw new AnthropicClientError("Le modèle n'a pas terminé sa réponse (boucle d'outils trop longue).", null, true, "AI_BAD_RESPONSE");
    }
    // `max_uses` is the caller's ceiling for the whole answer: once the paused
    // turn has spent it, no continuation may be granted another search.
    if (searchBudget - webSearches <= 0) {
      throw new AnthropicClientError("Le modèle a épuisé son budget de recherches web sans terminer sa réponse.", null, true, "AI_BAD_RESPONSE");
    }
    continuations += 1;
    messages.push({ role: "assistant", content: parsed.content ?? [] });
    messages.push({ role: "user", content: "Continue et termine ta réponse au format demandé." });
  }

  const text = (parsed.content ?? [])
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n")
    .trim();
  if (!text) {
    throw new AnthropicClientError("Le modèle a renvoyé une réponse vide.", null, true, "AI_BAD_RESPONSE");
  }
  logger.info("[SMART_SEGMENT] Anthropic call ok", {
    model: parsed.model ?? options.model,
    elapsedMs: Date.now() - startedAt,
    inputTokens: usageSeen ? usage.inputTokens : undefined,
    outputTokens: usageSeen ? usage.outputTokens : undefined,
    stopReason: parsed.stop_reason,
    ...(tools ? { webSearches, webSearchResults, webSearchErrors, continuations } : {}),
  });
  return {
    text,
    model: parsed.model ?? options.model,
    stopReason: parsed.stop_reason ?? null,
    usage: usageSeen ? { ...usage } : null,
    ...(tools ? { webSearches, webSearchResults, webSearchErrors } : {}),
  };
}

/** Extracts the first JSON object from a model answer (tolerates code fences). */
export function extractJsonObject(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : text).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new AnthropicClientError("La réponse du modèle ne contient pas d'objet JSON.", null, true, "AI_BAD_RESPONSE");
  }
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch (error) {
    throw new AnthropicClientError(`JSON du modèle invalide : ${(error as Error).message}`, null, true, "AI_BAD_RESPONSE");
  }
}
