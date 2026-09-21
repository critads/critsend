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
