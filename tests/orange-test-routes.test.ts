import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../server/db", () => ({ db: { execute: vi.fn() }, pool: { query: vi.fn() } }));
vi.mock("../server/storage", () => ({ storage: { getMta: vi.fn() } }));
vi.mock("../server/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("../server/email-service", () => ({
  closeTransporter: vi.fn(),
  resolveSmtpSecurity: vi.fn(),
  invalidateDefaultHeadersCache: vi.fn(),
}));
vi.mock("../server/services/plain-test-sender", () => ({
  classifySmtpError: vi.fn(),
  sendPlainTestEmail: vi.fn(),
  PLAIN_TEST_SUBJECT: "Hello moon",
  PLAIN_TEST_BODY: "I'm the sun",
}));
vi.mock("nodemailer", () => ({ default: { createTransport: vi.fn() } }));
vi.mock("express-rate-limit", () => ({
  default: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  ipKeyGenerator: (ip: string) => ip,
}));

const service = {
  startOrangeTest: vi.fn(),
  getOrangeTest: vi.fn(),
  listOrangeTests: vi.fn(),
  getControlValues: vi.fn(),
  getMailboxHealth: vi.fn(),
  runCheckerTick: vi.fn(),
};
vi.mock("../server/services/orange-test-jobs", () => ({
  getOrangeTestService: () => service,
  OrangeTestError: class OrangeTestError extends Error {
    constructor(public readonly code: string, public readonly httpStatus: number, message: string) {
      super(message);
      this.name = "OrangeTestError";
    }
  },
}));

type Handler = (req: any, res: any) => Promise<void> | void;

function fakeApp() {
  const handlers = new Map<string, Handler>();
  const register = (method: string) => (path: string, ...fns: Handler[]) => {
    handlers.set(`${method} ${path}`, fns[fns.length - 1]);
  };
  return {
    handlers,
    get: register("GET"),
    post: register("POST"),
    put: register("PUT"),
    patch: register("PATCH"),
    delete: register("DELETE"),
  };
}

function fakeResponse() {
  const result: { statusCode: number; body?: unknown } = { statusCode: 200 };
  return {
    result,
    status(code: number) { result.statusCode = code; return this; },
    json(body: unknown) { result.body = body; return this; },
  };
}

async function setup() {
  const { registerMtaRoutes } = await import("../server/routes/mtas");
  const { validateId } = await import("../server/utils");
  const app = fakeApp();
  registerMtaRoutes(app as any, { parsePagination: () => ({ page: 1, limit: 20 }), validateId });
  return app;
}

async function call(app: ReturnType<typeof fakeApp>, key: string, req: Record<string, unknown>) {
  const handler = app.handlers.get(key);
  if (!handler) throw new Error(`route not registered: ${key}`);
  const res = fakeResponse();
  await handler({ params: {}, query: {}, body: {}, session: { userId: "user-1" }, ip: "127.0.0.1", ...req }, res);
  return res.result;
}

describe("Orange test routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.ORANGE_TEST_IMAP_PASSWORD;
  });

  it("registers the static orange-test paths before the /:id routes", async () => {
    const app = await setup();
    const keys = [...app.handlers.keys()];
    expect(keys.indexOf("GET /api/mtas/orange-test/config")).toBeGreaterThanOrEqual(0);
    expect(keys.indexOf("GET /api/mtas/orange-test/summary")).toBeLessThan(keys.indexOf("GET /api/mtas/:id"));
    expect(keys.indexOf("GET /api/mtas/orange-test/config")).toBeLessThan(keys.indexOf("GET /api/mtas/:id"));
  });

  it("exposes the public config without credentials", async () => {
    const app = await setup();
    const result = await call(app, "GET /api/mtas/orange-test/config", {});
    expect(result.statusCode).toBe(200);
    expect(result.body).toMatchObject({ enabled: false, mailbox: "ianisbaulle@orange.fr", maxWaitHours: 48, staleVerdictDays: 7 });
    expect(result.body).not.toHaveProperty("imapPassword");
  });

  it("returns control values plus the mailbox health for the requested ids and rejects malformed ids", async () => {
    const app = await setup();
    const mailbox = {
      mailbox: "ianisbaulle@orange.fr", state: "failing", lastSuccessAt: "2026-09-27T10:00:00.000Z",
      lastFailureAt: "2026-09-28T09:00:00.000Z", lastErrorClass: "AUTH", lastErrorMessage: "Authentication failed.",
      failingSince: "2026-09-28T08:00:00.000Z", consecutiveFailures: 12,
    };
    service.getControlValues.mockResolvedValue({ a: { latest: null, latestVerdict: null } });
    service.getMailboxHealth.mockResolvedValue(mailbox);
    const ok = await call(app, "GET /api/mtas/orange-test/summary", { query: { ids: "a, b" } });
    expect(ok.statusCode).toBe(200);
    expect(service.getControlValues).toHaveBeenCalledWith(["a", "b"]);
    expect(ok.body).toEqual({ values: { a: { latest: null, latestVerdict: null } }, mailbox });

    const bad = await call(app, "GET /api/mtas/orange-test/summary", { query: { ids: "a,not valid!" } });
    expect(bad.statusCode).toBe(400);
  });

  it("starts a test (202) with the session user and maps service errors to their status", async () => {
    const app = await setup();
    const { OrangeTestError } = await import("../server/services/orange-test-jobs");
    service.startOrangeTest.mockResolvedValueOnce({ test: { id: "t1", status: "sending" }, reused: false, completion: Promise.resolve() });
    const started = await call(app, "POST /api/mtas/:id/orange-test", { params: { id: "mta-1" } });
    expect(started.statusCode).toBe(202);
    expect(started.body).toEqual({ test: { id: "t1", status: "sending" }, reused: false });
    expect(service.startOrangeTest).toHaveBeenCalledWith("mta-1", "user-1");

    service.startOrangeTest.mockRejectedValueOnce(new OrangeTestError("NOT_CONFIGURED", 503, "not configured"));
    const off = await call(app, "POST /api/mtas/:id/orange-test", { params: { id: "mta-1" } });
    expect(off.statusCode).toBe(503);
    expect(off.body).toEqual({ error: "not configured", code: "NOT_CONFIGURED" });

    service.startOrangeTest.mockRejectedValueOnce(new OrangeTestError("MTA_NOT_ELIGIBLE", 400, "nullsink"));
    expect((await call(app, "POST /api/mtas/:id/orange-test", { params: { id: "mta-1" } })).statusCode).toBe(400);

    service.startOrangeTest.mockRejectedValueOnce(new Error("boom"));
    const crashed = await call(app, "POST /api/mtas/:id/orange-test", { params: { id: "mta-1" } });
    expect(crashed.statusCode).toBe(500);
    expect(JSON.stringify(crashed.body)).not.toContain("boom");

    expect((await call(app, "POST /api/mtas/:id/orange-test", { params: { id: "bad id" } })).statusCode).toBe(400);
  });

  it("lists the history with a bounded limit and serves a single test only under its own MTA", async () => {
    const app = await setup();
    service.listOrangeTests.mockResolvedValue([{ id: "t1" }]);
    const list = await call(app, "GET /api/mtas/:id/orange-tests", { params: { id: "mta-1" }, query: { limit: "5" } });
    expect(list.statusCode).toBe(200);
    expect(service.listOrangeTests).toHaveBeenCalledWith("mta-1", 5);
    expect(list.body).toEqual({ tests: [{ id: "t1" }] });

    await call(app, "GET /api/mtas/:id/orange-tests", { params: { id: "mta-1" }, query: { limit: "nope" } });
    expect(service.listOrangeTests).toHaveBeenLastCalledWith("mta-1", 10);

    service.getOrangeTest.mockResolvedValue({ id: "t1", mtaId: "mta-1" });
    const one = await call(app, "GET /api/mtas/:id/orange-tests/:testId", { params: { id: "mta-1", testId: "t1" } });
    expect(one.statusCode).toBe(200);
    const foreign = await call(app, "GET /api/mtas/:id/orange-tests/:testId", { params: { id: "mta-2", testId: "t1" } });
    expect(foreign.statusCode).toBe(404);
    service.getOrangeTest.mockResolvedValue(null);
    const missing = await call(app, "GET /api/mtas/:id/orange-tests/:testId", { params: { id: "mta-1", testId: "zzz" } });
    expect(missing.statusCode).toBe(404);
  });
});
