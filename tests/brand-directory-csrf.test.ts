import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchCsrfToken, invalidateCsrfToken } from "../client/src/lib/queryClient";

describe("CSRF token cache", () => {
  afterEach(() => {
    invalidateCsrfToken();
    vi.unstubAllGlobals();
  });

  it("fetches a fresh token after invalidation for an import retry", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ csrfToken: "expired-token" })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ csrfToken: "fresh-token" })));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchCsrfToken()).resolves.toBe("expired-token");
    invalidateCsrfToken();
    await expect(fetchCsrfToken()).resolves.toBe("fresh-token");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});