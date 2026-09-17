import { describe, expect, it, vi } from "vitest";
import * as dns from "dns";
import * as http from "http";
import { access, unlink } from "fs/promises";
import { PassThrough } from "stream";
import {
  downloadImageWithNetworkForTest,
  isBlockedIP,
  requestPinnedImageForTest,
  resolvePublicImageAddresses,
} from "../server/utils";

async function listen(handler: http.RequestListener): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: (server.address() as any).port };
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("pinned image downloader DNS policy", () => {
  it("rejects IPv4-mapped private answers", () => {
    expect(isBlockedIP("::ffff:127.0.0.1")).toBe(true);
    expect(isBlockedIP("::ffff:10.20.30.40")).toBe(true);
    expect(isBlockedIP("::ffff:7f00:1")).toBe(true);
    expect(isBlockedIP("::ffff:a00:1")).toBe(true);
    expect(isBlockedIP("::ffff:203.0.113.4")).toBe(true);
    expect(isBlockedIP("::ffff:8.8.8.8")).toBe(false);
  });

  it("rejects IPv6 special-use ranges and allows public unicast only", () => {
    for (const address of [
      "::1", "::", "fc12::1", "fd12::1", "fe90::1", "febf::1",
      "ff02::1", "2001::1", "2002::1", "2001:db8::1",
    ]) {
      expect(isBlockedIP(address), address).toBe(true);
    }
    expect(isBlockedIP("2001:4860:4860::8888")).toBe(false);
  });

  it("rejects a mixed public/private answer instead of choosing the first", async () => {
    const lookup = vi.spyOn(dns.promises, "lookup").mockResolvedValue([
      { address: "203.0.113.4", family: 4 },
      { address: "192.168.1.20", family: 4 },
    ] as any);
    await expect(resolvePublicImageAddresses("cdn.example")).rejects.toThrow(/blocked address/);
    lookup.mockRestore();
  });

  it("re-resolves and rejects a public-to-private redirect destination", async () => {
    const lookup = vi.spyOn(dns.promises, "lookup")
      .mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }] as any)
      .mockResolvedValueOnce([{ address: "10.0.0.7", family: 4 }] as any);
    // The redirect handler calls the resolver for each destination.  Calling
    // the exported resolver twice models the same DNS rebinding/redirect
    // sequence without opening a network socket in this behavioral test.
    await expect(resolvePublicImageAddresses("public.example")).resolves.toHaveLength(1);
    await expect(resolvePublicImageAddresses("redirect.example")).rejects.toThrow(/blocked address/);
    lookup.mockRestore();
  });

  it("does not follow a public redirect when the destination has mixed answers", async () => {
    const resolve = vi.fn()
      .mockResolvedValueOnce([{ address: "203.0.113.4", family: 4 }])
      .mockRejectedValueOnce(new Error("DNS answer contains blocked private address"));
    const request = vi.fn().mockImplementation(async () => {
      const response = new PassThrough() as any;
      response.statusCode = 302;
      response.headers = { location: "http://redirect.example/private.png" };
      queueMicrotask(() => response.end());
      return response;
    });
    const ok = await downloadImageWithNetworkForTest("http://public.example/start.png", "/tmp/not-used.png", {
      resolve,
      request,
    } as any);
    expect(ok).toBe(false);
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("enforces a hard wall-clock deadline on a slow response stream", async () => {
    const request = vi.fn().mockImplementation(async () => {
      const response = new PassThrough() as any;
      response.statusCode = 200;
      response.headers = { "content-type": "image/png" };
      return response;
    });
    const ok = await downloadImageWithNetworkForTest("http://public.example/slow.png", "/tmp/slow-image.png", {
      resolve: async () => [{ address: "8.8.8.8", family: 4 }],
      request,
    } as any, 25);
    expect(ok).toBe(false);
    expect(request).toHaveBeenCalledOnce();
  });

  it("destroys never-ending redirect bodies instead of draining them", async () => {
    const responses: Array<{ destroy: ReturnType<typeof vi.spyOn>; requestDestroy: ReturnType<typeof vi.fn> }> = [];
    const request = vi.fn().mockImplementation(async () => {
      const requestDestroy = vi.fn();
      const response = new PassThrough() as any;
      response.statusCode = 302;
      response.headers = { location: "http://redirect.example/next.png" };
      const responseDestroy = vi.spyOn(response, "destroy");
      response.__imageRequest = { destroy: requestDestroy };
      responses.push({ destroy: responseDestroy, requestDestroy });
      return response;
    });
    const ok = await downloadImageWithNetworkForTest("http://public.example/start.png", "/tmp/never-ending.png", {
      resolve: async () => [{ address: "8.8.8.8", family: 4 }],
      request,
    } as any);
    expect(ok).toBe(false);
    expect(request).toHaveBeenCalledTimes(4);
    expect(responses).toHaveLength(4);
    for (const response of responses) {
      expect(response.destroy).toHaveBeenCalled();
      expect(response.requestDestroy).toHaveBeenCalled();
    }
  });

  it.each([
    { statusCode: 404, headers: { "content-type": "image/png" } },
    { statusCode: 200, headers: { "content-type": "text/html" } },
  ])("closes sockets immediately for rejected response %#", async ({ statusCode, headers }) => {
    const requestDestroy = vi.fn();
    const response = new PassThrough() as any;
    response.statusCode = statusCode;
    response.headers = headers;
    const responseDestroy = vi.spyOn(response, "destroy");
    response.__imageRequest = { destroy: requestDestroy };
    const request = vi.fn().mockResolvedValue(response);
    const ok = await downloadImageWithNetworkForTest("http://public.example/rejected", "/tmp/rejected.png", {
      resolve: async () => [{ address: "8.8.8.8", family: 4 }],
      request,
    } as any);
    expect(ok).toBe(false);
    expect(responseDestroy).toHaveBeenCalled();
    expect(requestDestroy).toHaveBeenCalled();
  });

  it("handles a real ClientRequest error after headers without uncaught process errors", async () => {
    const fixture = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "image/png" });
      res.write(Buffer.from([137, 80, 78, 71]));
      // Deliberately never end: the overall response deadline must destroy
      // both the IncomingMessage and its still-live ClientRequest.
    });
    const uncaught: unknown[] = [];
    const unhandled: unknown[] = [];
    const onUncaught = (error: unknown) => uncaught.push(error);
    const onUnhandled = (error: unknown) => unhandled.push(error);
    process.once("uncaughtException", onUncaught);
    process.once("unhandledRejection", onUnhandled);
    try {
      const ok = await downloadImageWithNetworkForTest("http://public.example/stall.png", "/tmp/stall-real.png", {
        resolve: async () => [{ address: "8.8.8.8", family: 4 }],
        request: (url, address, deadlineAt) => requestPinnedImageForTest(
          url.href,
          address,
          { hostname: "127.0.0.1", port: fixture.port },
          Math.max(1, deadlineAt! - Date.now()),
        ),
      } as any, 30);
      expect(ok).toBe(false);
      await new Promise((resolve) => setImmediate(resolve));
      expect(uncaught).toEqual([]);
      expect(unhandled).toEqual([]);
    } finally {
      process.removeListener("uncaughtException", onUncaught);
      process.removeListener("unhandledRejection", onUnhandled);
      await close(fixture.server);
    }
  });

  it("uses real pinned requests for redirect rejection and successful image cleanup", async () => {
    const fixture = await listen((req, res) => {
      if (req.url === "/redirect") {
        res.writeHead(302, { location: "/type" });
        res.end();
      } else if (req.url === "/type") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("not an image");
      } else {
        res.writeHead(200, { "content-type": "image/png" });
        res.end(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      }
    });
    const request = (url: URL, address: { address: string; family: 4 | 6 }, deadlineAt?: number) =>
      requestPinnedImageForTest(
        url.href,
        address,
        { hostname: "127.0.0.1", port: fixture.port },
        Math.max(1, (deadlineAt ?? Date.now() + 500) - Date.now()),
      );
    const network = {
      resolve: async () => [{ address: "8.8.8.8", family: 4 as const }],
      request,
    };
    try {
      await expect(downloadImageWithNetworkForTest("http://public.example/redirect", "/tmp/redirect-rejected.png", network)).resolves.toBe(false);
      const successPath = "/tmp/real-image-success.png";
      await expect(downloadImageWithNetworkForTest("http://public.example/ok", successPath, network)).resolves.toBe(true);
      await expect(access(successPath)).resolves.toBeUndefined();
      await unlink(successPath);
    } finally {
      await close(fixture.server);
    }
  });
});