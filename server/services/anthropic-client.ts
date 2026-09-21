// Task #304 — isolated Anthropic Messages API client.
//
// Deliberately a raw fetch (no SDK dependency): the production lockfile has
// already been broken once by Replit proxy URLs written during dependency
// updates, and the surface we need is one POST. Nothing here knows about
// segments; the caller owns the prompt and validates the output.
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
};

export type AnthropicMessageResponse = {
  text: string;
  model: string;
  stopReason: string | null;
  usage: { inputTokens: number; outputTokens: number } | null;
};

export type AnthropicClientOptions = {
  apiKey: string;
  model: string;
  baseUrl?: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
};

const ANTHROPIC_VERSION = "2023-06-01";

export async function anthropicCreateMessage(
  options: AnthropicClientOptions,
  request: AnthropicMessageRequest,
): Promise<AnthropicMessageResponse> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  const url = `${(options.baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "")}/v1/messages`;
  const startedAt = Date.now();
  const timeoutError = () => new AnthropicClientError(
    `Le modèle n'a pas répondu en ${Math.round(options.timeoutMs / 1000)} s.`,
    null,
    true,
    "AI_TIMEOUT",
  );
  // The abort timer stays armed until the body is fully consumed: headers
  // can arrive quickly while the body stalls, which must not pin a job (and
  // its global analysis slot) forever.
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
        messages: [{ role: "user", content: request.user }],
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
    const code = response.status === 401 || response.status === 403
      ? "AI_AUTH"
      : response.status === 429 ? "AI_RATE_LIMITED"
      : response.status === 529 || response.status >= 500 ? "AI_UNAVAILABLE"
      : "AI_REQUEST_REJECTED";
    logger.warn("[SMART_SEGMENT] Anthropic call failed", { status: response.status, code, elapsedMs: Date.now() - startedAt });
    throw new AnthropicClientError(`Le modèle a refusé la requête (${response.status}) : ${detail}`, response.status, retryable, code);
  }

  let parsed: {
    model?: string;
    stop_reason?: string | null;
    content?: Array<{ type: string; text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new AnthropicClientError("Réponse du modèle illisible (JSON invalide).", response.status, true, "AI_BAD_RESPONSE");
  }
  const text = (parsed.content ?? [])
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n")
    .trim();
  if (!text) {
    throw new AnthropicClientError("Le modèle a renvoyé une réponse vide.", response.status, true, "AI_BAD_RESPONSE");
  }
  logger.info("[SMART_SEGMENT] Anthropic call ok", {
    model: parsed.model ?? options.model,
    elapsedMs: Date.now() - startedAt,
    inputTokens: parsed.usage?.input_tokens,
    outputTokens: parsed.usage?.output_tokens,
    stopReason: parsed.stop_reason,
  });
  return {
    text,
    model: parsed.model ?? options.model,
    stopReason: parsed.stop_reason ?? null,
    usage: parsed.usage
      ? { inputTokens: Number(parsed.usage.input_tokens ?? 0), outputTokens: Number(parsed.usage.output_tokens ?? 0) }
      : null,
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
