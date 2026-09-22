import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("../server/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { anthropicCreateMessage, AnthropicClientError, extractJsonObject } from "../server/services/anthropic-client";

const options = { apiKey: "test-key", model: "claude-test", timeoutMs: 5_000 };
const request = { system: "sys", user: "usr", maxTokens: 100 };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("anthropic client", () => {
  it("posts the messages payload with the API key header and returns the text blocks", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://api.anthropic.com/v1/messages");
      expect((init?.headers as Record<string, string>)["x-api-key"]).toBe("test-key");
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({ model: "claude-test", max_tokens: 100, temperature: 0, system: "sys", messages: [{ role: "user", content: "usr" }] });
      return jsonResponse(200, { model: "claude-test-2", stop_reason: "end_turn", content: [{ type: "text", text: "{\"a\":1}" }], usage: { input_tokens: 12, output_tokens: 3 } });
    });
    const response = await anthropicCreateMessage({ ...options, fetchImpl: fetchImpl as unknown as typeof fetch }, request);
    expect(response).toEqual({ text: "{\"a\":1}", model: "claude-test-2", stopReason: "end_turn", usage: { inputTokens: 12, outputTokens: 3 } });
  });

  it("honours a custom base URL", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toBe("https://proxy.example/anthropic/v1/messages");
      return jsonResponse(200, { content: [{ type: "text", text: "{}" }] });
    });
    await anthropicCreateMessage({ ...options, baseUrl: "https://proxy.example/anthropic/", fetchImpl: fetchImpl as unknown as typeof fetch }, request);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("maps HTTP failures to typed, retryable-aware errors", async () => {
    const cases: Array<[number, string, boolean]> = [[401, "AI_AUTH", false], [429, "AI_RATE_LIMITED", true], [529, "AI_UNAVAILABLE", true], [400, "AI_REQUEST_REJECTED", false]];
    for (const [status, code, retryable] of cases) {
      const fetchImpl = async () => jsonResponse(status, { error: { type: "x", message: `status ${status}` } });
      const error = await anthropicCreateMessage({ ...options, fetchImpl: fetchImpl as unknown as typeof fetch }, request).catch((e) => e);
      expect(error).toBeInstanceOf(AnthropicClientError);
      expect(error.code).toBe(code);
      expect(error.retryable).toBe(retryable);
      expect(error.message).toContain(`status ${status}`);
    }
  });

  it("times out through the abort signal and flags empty answers", async () => {
    const fetchImpl = (_url: unknown, init?: RequestInit) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    });
    const timeout = await anthropicCreateMessage({ ...options, timeoutMs: 20, fetchImpl: fetchImpl as unknown as typeof fetch }, request).catch((e) => e);
    expect(timeout.code).toBe("AI_TIMEOUT");
    expect(timeout.retryable).toBe(true);

    const empty = await anthropicCreateMessage({ ...options, fetchImpl: (async () => jsonResponse(200, { content: [] })) as unknown as typeof fetch }, request).catch((e) => e);
    expect(empty.code).toBe("AI_BAD_RESPONSE");
  });

  it("keeps the timeout armed while the body streams: a stalled body is a timeout, not a hung job", async () => {
    // Headers arrive at once, the body never ends until the signal aborts.
    const fetchImpl = (_url: unknown, init?: RequestInit) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"content":[{"type":"text","text":"'));
          init?.signal?.addEventListener("abort", () => controller.error(Object.assign(new Error("aborted"), { name: "AbortError" })));
        },
      });
      return Promise.resolve(new Response(stream, { status: 200, headers: { "content-type": "application/json" } }));
    };
    const started = Date.now();
    const error = await anthropicCreateMessage({ ...options, timeoutMs: 30, fetchImpl: fetchImpl as unknown as typeof fetch }, request).catch((e) => e);
    expect(error).toBeInstanceOf(AnthropicClientError);
    expect(error.code).toBe("AI_TIMEOUT");
    expect(error.retryable).toBe(true);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("sends the web search tool when asked, counts the searches and keeps only the text blocks", async () => {
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.tools).toEqual([{ type: "web_search_20250305", name: "web_search", max_uses: 3 }]);
      return jsonResponse(200, {
        model: "claude-test-2",
        stop_reason: "end_turn",
        content: [
          { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "Morgan mode femme" } },
          { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: [{ type: "web_search_result", url: "https://example.com", title: "Morgan" }] },
          { type: "text", text: "Voici :" },
          { type: "web_search_tool_result", tool_use_id: "srvtoolu_2", content: { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" } },
          { type: "text", text: "{\"secteur\":\"mode\",\"marques\":[]}" },
        ],
        usage: { input_tokens: 40, output_tokens: 9, server_tool_use: { web_search_requests: 2 } },
      });
    });
    const response = await anthropicCreateMessage({ ...options, fetchImpl: fetchImpl as unknown as typeof fetch }, { ...request, webSearch: { maxUses: 3 } });
    expect(response.text).toBe("Voici :\n{\"secteur\":\"mode\",\"marques\":[]}");
    expect(response.webSearches).toBe(2);
    expect(response.webSearchErrors).toEqual(["max_uses_exceeded"]);
    expect(response.usage).toEqual({ inputTokens: 40, outputTokens: 9 });
    // Without the tool nothing tool-related is reported (existing callers unchanged).
    const plain = await anthropicCreateMessage({ ...options, fetchImpl: (async () => jsonResponse(200, { content: [{ type: "text", text: "ok" }] })) as unknown as typeof fetch }, request);
    expect(plain.webSearches).toBeUndefined();
  });

  it("resumes a pause_turn a bounded number of times under the same deadline, accumulating usage and never re-granting the search budget", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      calls += 1;
      const body = JSON.parse(String(init?.body));
      expect(body.messages).toHaveLength(1 + (calls - 1) * 2);
      // 5 allowed in total: 5, then 4 after one search, then 3.
      expect(body.tools[0].max_uses).toBe(5 - (calls - 1));
      if (calls < 3) {
        return jsonResponse(200, { stop_reason: "pause_turn", content: [{ type: "server_tool_use", id: `s${calls}`, name: "web_search", input: { query: "q" } }], usage: { input_tokens: 10, output_tokens: 1, server_tool_use: { web_search_requests: 1 } } });
      }
      return jsonResponse(200, { stop_reason: "end_turn", content: [{ type: "text", text: "{}" }], usage: { input_tokens: 10, output_tokens: 2, server_tool_use: { web_search_requests: 1 } } });
    });
    const response = await anthropicCreateMessage({ ...options, fetchImpl: fetchImpl as unknown as typeof fetch }, { ...request, webSearch: { maxUses: 5 } });
    expect(calls).toBe(3);
    expect(response.text).toBe("{}");
    expect(response.webSearches).toBe(3);
    expect(response.usage).toEqual({ inputTokens: 30, outputTokens: 4 });

    // A loop that never ends stops after the allowed continuations and is an
    // unfinished (bad) answer, not a hang — even when partial text exists.
    let endlessCalls = 0;
    const endless = (async () => {
      endlessCalls += 1;
      return jsonResponse(200, { stop_reason: "pause_turn", content: [{ type: "text", text: "{\"partial\":true}" }, { type: "server_tool_use", id: "s", name: "web_search", input: {} }] });
    }) as unknown as typeof fetch;
    const error = await anthropicCreateMessage({ ...options, fetchImpl: endless }, { ...request, webSearch: { maxUses: 5 } }).catch((e) => e);
    expect(error).toBeInstanceOf(AnthropicClientError);
    expect(error.code).toBe("AI_BAD_RESPONSE");
    expect(endlessCalls).toBe(3);
  });

  it("never grants a search beyond the caller's ceiling: a paused turn that spent the whole budget is not continued", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, {
      stop_reason: "pause_turn",
      content: [{ type: "text", text: "{\"partial\":true}" }, { type: "server_tool_use", id: "s1", name: "web_search", input: { query: "q" } }],
      usage: { input_tokens: 10, output_tokens: 1, server_tool_use: { web_search_requests: 2 } },
    }));
    const error = await anthropicCreateMessage({ ...options, fetchImpl: fetchImpl as unknown as typeof fetch }, { ...request, webSearch: { maxUses: 2 } }).catch((e) => e);
    expect(error).toBeInstanceOf(AnthropicClientError);
    expect(error.code).toBe("AI_BAD_RESPONSE");
    expect(error.message).toContain("budget de recherches");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body)).tools[0].max_uses).toBe(2);
  });

  it("tells billed searches apart from searches that returned results", async () => {
    const fetchImpl = (async () => jsonResponse(200, {
      stop_reason: "end_turn",
      content: [
        { type: "web_search_tool_result", tool_use_id: "a", content: [{ type: "web_search_result", url: "https://a" }] },
        { type: "web_search_tool_result", tool_use_id: "b", content: { type: "web_search_tool_result_error", error_code: "unavailable" } },
        { type: "text", text: "{}" },
      ],
      usage: { input_tokens: 1, output_tokens: 1, server_tool_use: { web_search_requests: 2 } },
    })) as unknown as typeof fetch;
    const response = await anthropicCreateMessage({ ...options, fetchImpl }, { ...request, webSearch: { maxUses: 2 } });
    expect(response.webSearches).toBe(2);
    expect(response.webSearchResults).toBe(1);
    expect(response.webSearchErrors).toEqual(["unavailable"]);
  });

  it("flags a web search tool refused by the API as AI_TOOL_UNAVAILABLE (not retryable), only when the tool was requested", async () => {
    const refused = (async () => jsonResponse(400, { error: { type: "invalid_request_error", message: "web_search tool is not available for this organization" } })) as unknown as typeof fetch;
    const withTool = await anthropicCreateMessage({ ...options, fetchImpl: refused }, { ...request, webSearch: { maxUses: 1 } }).catch((e) => e);
    expect(withTool.code).toBe("AI_TOOL_UNAVAILABLE");
    expect(withTool.retryable).toBe(false);
    const withoutTool = await anthropicCreateMessage({ ...options, fetchImpl: refused }, request).catch((e) => e);
    expect(withoutTool.code).toBe("AI_REQUEST_REJECTED");
    // A 400 unrelated to the tool keeps its generic code even with the tool on.
    const other = (async () => jsonResponse(400, { error: { type: "invalid_request_error", message: "max_tokens too large" } })) as unknown as typeof fetch;
    const unrelated = await anthropicCreateMessage({ ...options, fetchImpl: other }, { ...request, webSearch: { maxUses: 1 } }).catch((e) => e);
    expect(unrelated.code).toBe("AI_REQUEST_REJECTED");
  });

  it("extracts the JSON object from fenced or chatty answers", () => {
    expect(extractJsonObject("```json\n{\"segments\":[]}\n```")).toEqual({ segments: [] });
    expect(extractJsonObject("Voici : {\"a\":{\"b\":1}} merci")).toEqual({ a: { b: 1 } });
    expect(() => extractJsonObject("aucun json")).toThrow(AnthropicClientError);
    expect(() => extractJsonObject("{oops}")).toThrow(/invalide/);
  });

  it("never reads the API key from anywhere but the environment and never logs it", () => {
    const source = readFileSync(new URL("../server/services/anthropic-client.ts", import.meta.url), "utf8");
    const config = readFileSync(new URL("../server/config/smart-segment.ts", import.meta.url), "utf8");
    expect(config).toContain("process.env.ANTHROPIC_API_KEY");
    expect(source).not.toMatch(/logger\.[a-z]+\([^)]*apiKey/);
    expect(source).not.toContain("@anthropic-ai/sdk");
  });
});
