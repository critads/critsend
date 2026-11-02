import { describe, expect, it, vi } from "vitest";
import * as dns from "dns";
import * as http from "http";
import * as net from "net";
import { access, unlink, readFile } from "fs/promises";
import { PassThrough } from "stream";
import {
  downloadImageWithNetworkForTest,
  isBlockedIP,
  requestPinnedImageForTest,
  resolvePublicImageAddresses,
  imageAlternateDnsServers,
} from "../server/utils";
import { logger } from "../server/logger";

async function listen(handler: http.RequestListener): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: (server.address() as any).port };
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("pinned image downloader DNS policy", () => {
  it("defaults to two independent resolvers, supports overrides and disabling", () => {
    const previous = process.env.IMAGE_ALTERNATE_DNS_SERVERS;
    delete process.env.IMAGE_ALTERNATE_DNS_SERVERS;
    try {
      expect(imageAlternateDnsServers()).toEqual(["1.1.1.1", "8.8.8.8"]);
      expect(imageAlternateDnsServers("9.9.9.9, 8.8.4.4, 1.0.0.1")).toEqual(["9.9.9.9", "8.8.4.4"]);
      expect(imageAlternateDnsServers("")).toEqual([]);
      expect(imageAlternateDnsServers("off")).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.IMAGE_ALTERNATE_DNS_SERVERS;
      else process.env.IMAGE_ALTERNATE_DNS_SERVERS = previous;
    }
  });

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
          { address: "127.0.0.1", port: fixture.port },
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

  it("connects through the pinned lookup for a real hostname, whatever answer shape Node asks for", async () => {
    // public.example does not resolve: the only way to reach the fixture is
    // the lookup callback. Node ≥ 20 asks it with `all: true` (Happy
    // Eyeballs) and expects an array; a bare string answer used to fail every
    // real download with "Invalid IP address: undefined".
    const seenHosts: string[] = [];
    const fixture = await listen((req, res) => {
      seenHosts.push(String(req.headers.host));
      res.writeHead(200, { "content-type": "image/png" });
      res.end(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    });
    const previous = net.getDefaultAutoSelectFamily();
    try {
      for (const autoSelectFamily of [true, false]) {
        net.setDefaultAutoSelectFamily(autoSelectFamily);
        const response = await requestPinnedImageForTest(
          "http://public.example/pinned.png",
          { address: "8.8.8.8", family: 4 },
          { address: "127.0.0.1", port: fixture.port },
          2_000,
        );
        expect(response.statusCode, `autoSelectFamily=${autoSelectFamily}`).toBe(200);
        response.resume();
        await new Promise((resolve) => response.once("end", resolve));
      }
      expect(seenHosts).toEqual(["public.example", "public.example"]);
    } finally {
      net.setDefaultAutoSelectFamily(previous);
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
        { address: "127.0.0.1", port: fixture.port },
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

describe("independent DNS retries for foreign homepage redirects", () => {
  const origin = "http://vht.tradedoubler.com/creative/image.png";
  const image = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  async function fixtureNetwork(options: { nonRoot?: boolean; tracking?: boolean; slow?: boolean } = {}) {
    const bad = await listen((_req, res) => {
      if (options.tracking) {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("tracking pixel");
      } else {
        res.writeHead(301, { location: options.nonRoot ? "http://foreign.example/landing" : "http://www.tradedoubler.com/" });
        res.end();
      }
    });
    const good = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "image/png" });
      res.write(image);
      if (!options.slow) res.end();
    });
    const html = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("landing page");
    });
    const resolveAlternative = vi.fn().mockResolvedValue([{ address: "8.8.4.4", family: 4 }]);
    const request = vi.fn((url: URL, address: { address: string; family: 4 | 6 }, deadlineAt?: number) =>
      requestPinnedImageForTest(url.href, address, {
        address: "127.0.0.1",
        port: url.hostname === "foreign.example" ? html.port : address.address === "8.8.8.8" ? bad.port : good.port,
      }, Math.max(1, deadlineAt! - Date.now())));
    return {
      network: {
        resolve: vi.fn().mockResolvedValue([{ address: "8.8.8.8", family: 4 as const }]),
        request, resolveAlternative, alternateServers: ["1.1.1.1", "8.8.8.8"],
      },
      cleanup: () => Promise.all([close(bad.server), close(good.server), close(html.server)]),
    };
  }

  it.each([false, true])("retries the original URL on an independent public address (non-root HTML=%s)", async (nonRoot) => {
    const { network, cleanup } = await fixtureNetwork({ nonRoot });
    const log = vi.spyOn(logger, "info");
    const dest = `/tmp/dns-retry-${nonRoot}.png`;
    try {
      expect(await downloadImageWithNetworkForTest(origin, dest, network)).toBe(true);
      expect(await readFile(dest)).toEqual(image);
      expect(network.resolveAlternative).toHaveBeenCalledWith("vht.tradedoubler.com", "1.1.1.1", expect.any(Number));
      const last = network.request.mock.calls.at(-1)!;
      expect(last[0].href).toBe(origin);
      expect(last[1].address).toBe("8.8.4.4");
      expect(network.request).toHaveBeenCalledTimes(nonRoot ? 3 : 2);
      expect(log.mock.calls.some(([message]) => message.includes(`original=${origin}`) && message.includes("final=http://") && message.includes("pinned_ip=8.8.8.8"))).toBe(true);
      expect(log.mock.calls.some(([message]) => message.includes("Retry via alternative DNS resolver"))).toBe(true);
    } finally {
      log.mockRestore();
      await unlink(dest).catch(() => {});
      await cleanup();
    }
  });

  it.each(["10.0.0.1", "::ffff:127.0.0.1", "fc00::1"])("rejects the entire alternative answer if it includes %s", async (privateIp) => {
    const { network, cleanup } = await fixtureNetwork();
    network.resolveAlternative.mockResolvedValue([{ address: "8.8.4.4", family: 4 }, { address: privateIp, family: privateIp.includes(":") ? 6 : 4 }]);
    try {
      expect(await downloadImageWithNetworkForTest(origin, "/tmp/blocked-alternate.png", network)).toBe(false);
      expect(network.request).toHaveBeenCalledOnce();
      expect(network.resolveAlternative).toHaveBeenCalledOnce();
    } finally { await cleanup(); }
  });

  it("does not retry direct text/html tracking pixels", async () => {
    const { network, cleanup } = await fixtureNetwork({ tracking: true });
    try {
      expect(await downloadImageWithNetworkForTest("http://impfr.tradedoubler.com/imp?x=1", "/tmp/tracking.png", network)).toBe(false);
      expect(network.request).toHaveBeenCalledOnce();
      expect(network.resolveAlternative).not.toHaveBeenCalled();
    } finally { await cleanup(); }
  });

  it.each(["dns", "stream"])("shares the original hard deadline during alternative %s", async (stage) => {
    const { network, cleanup } = await fixtureNetwork({ slow: stage === "stream" });
    if (stage === "dns") network.resolveAlternative.mockImplementation(() => new Promise(() => {}));
    const start = Date.now();
    try {
      expect(await downloadImageWithNetworkForTest(origin, "/tmp/alternate-deadline.png", network, 100)).toBe(false);
      // A timer can fire just before its millisecond boundary; a second
      // resolver may get the final millisecond, but never a new full budget.
      expect(network.resolveAlternative.mock.calls.length).toBeGreaterThanOrEqual(1);
      expect(network.resolveAlternative.mock.calls.length).toBeLessThanOrEqual(2);
      expect(network.request).toHaveBeenCalledTimes(stage === "dns" ? 1 : 2);
      expect(Date.now() - start).toBeLessThan(500);
    } finally { await cleanup(); }
  });

  it("skips unavailable resolvers and duplicate answers", async () => {
    const { network, cleanup } = await fixtureNetwork();
    network.resolveAlternative.mockRejectedValueOnce(new Error("unreachable"))
      .mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }]);
    try {
      expect(await downloadImageWithNetworkForTest(origin, "/tmp/duplicate-answer.png", network)).toBe(false);
      expect(network.resolveAlternative).toHaveBeenCalledTimes(2);
      expect(network.request).toHaveBeenCalledOnce();
    } finally { await cleanup(); }
  });

  it("tries the second resolver when the first independent branch also redirects", async () => {
    const { network, cleanup } = await fixtureNetwork();
    // Send the first alternative request to the redirect fixture as well.
    const actualRequest = network.request.getMockImplementation()!;
    network.request.mockImplementation((url, address, deadlineAt) => actualRequest(url,
      address.address === "1.0.0.1" ? { address: "8.8.8.8", family: 4 } : address, deadlineAt));
    network.resolveAlternative.mockResolvedValueOnce([{ address: "1.0.0.1", family: 4 }])
      .mockResolvedValueOnce([{ address: "8.8.4.4", family: 4 }]);
    const dest = "/tmp/second-independent.png";
    try {
      expect(await downloadImageWithNetworkForTest(origin, dest, network)).toBe(true);
      expect(network.request).toHaveBeenCalledTimes(3);
      expect(network.resolveAlternative).toHaveBeenCalledTimes(2);
    } finally {
      await unlink(dest).catch(() => {});
      await cleanup();
    }
  });

  it("honors disabled independent DNS retries", async () => {
    const { network, cleanup } = await fixtureNetwork();
    network.alternateServers = [];
    try {
      expect(await downloadImageWithNetworkForTest(origin, "/tmp/disabled-retry.png", network)).toBe(false);
      expect(network.resolveAlternative).not.toHaveBeenCalled();
      expect(network.request).toHaveBeenCalledOnce();
    } finally { await cleanup(); }
  });

  it.each([false, true])("uses a dedicated DNS Resolver and validates both families (private IPv6=%s)", async (privateIpv6) => {
    const { network, cleanup } = await fixtureNetwork();
    const resolve4 = vi.spyOn(dns.promises.Resolver.prototype, "resolve4").mockResolvedValue(["8.8.4.4"] as any);
    const resolve6 = vi.spyOn(dns.promises.Resolver.prototype, "resolve6").mockResolvedValue(privateIpv6 ? ["fc00::1"] as any : []);
    const setServers = vi.spyOn(dns.promises.Resolver.prototype, "setServers");
    const cancel = vi.spyOn(dns.promises.Resolver.prototype, "cancel");
    const dest = `/tmp/native-resolver-${privateIpv6}.png`;
    try {
      expect(await downloadImageWithNetworkForTest(origin, dest, {
        ...network, resolveAlternative: undefined,
      })).toBe(!privateIpv6);
      expect(setServers).toHaveBeenCalledWith(["1.1.1.1"]);
      expect(resolve4).toHaveBeenCalledWith("vht.tradedoubler.com");
      expect(resolve6).toHaveBeenCalledWith("vht.tradedoubler.com");
      expect(cancel).toHaveBeenCalled();
      expect(network.request).toHaveBeenCalledTimes(privateIpv6 ? 1 : 2);
    } finally {
      resolve4.mockRestore();
      resolve6.mockRestore();
      setServers.mockRestore();
      cancel.mockRestore();
      await unlink(dest).catch(() => {});
      await cleanup();
    }
  });

  it("limits repeated homepage redirects to two extra attempts", async () => {
    const { network, cleanup } = await fixtureNetwork();
    const actualRequest = network.request.getMockImplementation()!;
    network.request.mockImplementation((url, _address, deadlineAt) =>
      actualRequest(url, { address: "8.8.8.8", family: 4 }, deadlineAt));
    network.resolveAlternative.mockResolvedValueOnce([{ address: "1.0.0.1", family: 4 }])
      .mockResolvedValueOnce([{ address: "8.8.4.4", family: 4 }]);
    try {
      expect(await downloadImageWithNetworkForTest(origin, "/tmp/repeated-homepage.png", network)).toBe(false);
      expect(network.request).toHaveBeenCalledTimes(3);
      expect(network.resolveAlternative).toHaveBeenCalledTimes(2);
    } finally { await cleanup(); }
  });
});