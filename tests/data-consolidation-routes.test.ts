/**
 * Data Consolidation routes — HTTP contract against a mocked service:
 *   POST /run    → 401 without a session, 403 for a non-admin, 202 + run when started,
 *                  409 (already_running / not_leader) otherwise, 400 on a bad mode
 *   POST /cancel → same admin gate; 200 + run, 404 when nothing is running
 *   GET  /status → service status + canManage (admin flag for the page buttons)
 *
 * The admin policy is the established one (users.is_admin, ADMIN_USER_IDS
 * bootstrap fallback, fail-closed in production); the DB is mocked so every
 * branch of the gate is exercised without a database.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../server/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("../server/storage", () => ({ storage: { getUserById: vi.fn(async () => ({ username: "ianis" })) } }));

const dbExecute = vi.fn();
vi.mock("../server/db", () => ({ db: { execute: (...args: unknown[]) => dbExecute(...args) } }));
vi.mock("drizzle-orm", () => ({
  // Tagged template → a plain string so the mock can tell the two admin queries apart.
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => strings.raw.map((s, i) => s + (i < values.length ? String(values[i]) : "")).join(""),
    { raw: (s: string) => s },
  ),
}));

const service = {
  getStatus: vi.fn(),
  listRuns: vi.fn(),
  ensureSchema: vi.fn(async () => undefined),
  startRun: vi.fn(),
  requestCancel: vi.fn(),
};
vi.mock("../server/services/data-consolidation", () => ({
  getDataConsolidationService: () => service,
}));

type Handler = (req: any, res: any) => Promise<void> | void;

function fakeApp() {
  const handlers = new Map<string, Handler>();
  const register = (method: string) => (path: string, ...fns: Handler[]) => {
    handlers.set(`${method} ${path}`, fns[fns.length - 1]);
  };
  return { handlers, get: register("GET"), post: register("POST"), put: register("PUT"), patch: register("PATCH"), delete: register("DELETE") };
}

function fakeResponse() {
  const result: { statusCode: number; body?: unknown } = { statusCode: 200 };
  const res: any = {
    status(code: number) { result.statusCode = code; return res; },
    json(body: unknown) { result.body = body; return res; },
  };
  return { res, result };
}

/** Admin table state seen by the gate: who is admin, and whether any admin exists at all. */
function mockUsers(admins: string[]) {
  dbExecute.mockImplementation(async (query: string) => {
    if (query.includes("WHERE is_admin = true")) return { rows: admins.length ? [{ "?column?": 1 }] : [] };
    const m = /WHERE id = (\S+)/.exec(query);
    const uid = m?.[1];
    return { rows: uid ? [{ is_admin: admins.includes(uid) }] : [] };
  });
}

const run = { id: "r1", status: "running", mode: "incremental" };
const asAdmin = { session: { userId: "admin-1" } };
const asUser = { session: { userId: "user-2" } };

describe("data-consolidation routes", () => {
  let app: ReturnType<typeof fakeApp>;
  const envBackup = { NODE_ENV: process.env.NODE_ENV, ADMIN_USER_IDS: process.env.ADMIN_USER_IDS };

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.NODE_ENV = "production";
    delete process.env.ADMIN_USER_IDS;
    mockUsers(["admin-1"]);
    app = fakeApp();
    const { registerDataConsolidationRoutes } = await import("../server/routes/data-consolidation");
    registerDataConsolidationRoutes(app as any);
  });

  afterEach(() => {
    process.env.NODE_ENV = envBackup.NODE_ENV;
    if (envBackup.ADMIN_USER_IDS === undefined) delete process.env.ADMIN_USER_IDS;
    else process.env.ADMIN_USER_IDS = envBackup.ADMIN_USER_IDS;
  });

  it("starts a run (202) for an admin with the operator's username and the requested mode", async () => {
    service.startRun.mockResolvedValue({ started: true, run });
    const { res, result } = fakeResponse();
    await app.handlers.get("POST /api/data-consolidation/run")!({ body: { mode: "full" }, ...asAdmin }, res);
    expect(result.statusCode).toBe(202);
    expect(result.body).toEqual({ run });
    expect(service.startRun).toHaveBeenCalledWith({ mode: "full", triggeredBy: "ianis" });
  });

  it("rejects run and cancel without a session (401) and for a signed-in non-admin (403), without touching the service", async () => {
    for (const path of ["POST /api/data-consolidation/run", "POST /api/data-consolidation/cancel"]) {
      const anon = fakeResponse();
      await app.handlers.get(path)!({ body: { mode: "full" }, session: {} }, anon.res);
      expect(anon.result.statusCode).toBe(401);

      const user = fakeResponse();
      await app.handlers.get(path)!({ body: { mode: "full" }, ...asUser }, user.res);
      expect(user.result.statusCode).toBe(403);
      expect(user.result.body).toMatchObject({ error: expect.stringMatching(/admin/i) });
    }
    expect(service.startRun).not.toHaveBeenCalled();
    expect(service.requestCancel).not.toHaveBeenCalled();
  });

  it("fails closed in production when the admin check itself errors, and honours the ADMIN_USER_IDS bootstrap fallback only when no DB admin exists", async () => {
    dbExecute.mockRejectedValue(Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" }));
    service.startRun.mockResolvedValue({ started: true, run });
    const broken = fakeResponse();
    await app.handlers.get("POST /api/data-consolidation/run")!({ body: {}, ...asAdmin }, broken.res);
    expect(broken.result.statusCode).toBe(403);

    // No admin row anywhere + allowlist → bootstrap path accepts the listed id only.
    mockUsers([]);
    process.env.ADMIN_USER_IDS = "user-2";
    const listed = fakeResponse();
    await app.handlers.get("POST /api/data-consolidation/run")!({ body: {}, ...asUser }, listed.res);
    expect(listed.result.statusCode).toBe(202);
    const unlisted = fakeResponse();
    await app.handlers.get("POST /api/data-consolidation/run")!({ body: {}, session: { userId: "user-3" } }, unlisted.res);
    expect(unlisted.result.statusCode).toBe(403);

    // A DB admin exists → the allowlist no longer grants anything.
    mockUsers(["admin-1"]);
    const superseded = fakeResponse();
    await app.handlers.get("POST /api/data-consolidation/run")!({ body: {}, ...asUser }, superseded.res);
    expect(superseded.result.statusCode).toBe(403);
    expect(service.startRun).toHaveBeenCalledTimes(1);
  });

  it("defaults to incremental mode and rejects an unknown mode", async () => {
    service.startRun.mockResolvedValue({ started: true, run });
    const ok = fakeResponse();
    await app.handlers.get("POST /api/data-consolidation/run")!({ body: {}, ...asAdmin }, ok.res);
    expect(ok.result.statusCode).toBe(202);
    expect(service.startRun).toHaveBeenCalledWith(expect.objectContaining({ mode: "incremental" }));

    const bad = fakeResponse();
    await app.handlers.get("POST /api/data-consolidation/run")!({ body: { mode: "everything" }, ...asAdmin }, bad.res);
    expect(bad.result.statusCode).toBe(400);
    expect(service.startRun).toHaveBeenCalledTimes(1);
  });

  it("answers 409 while a run is active or the lease is held elsewhere", async () => {
    service.startRun.mockResolvedValueOnce({ started: false, reason: "already_running", run });
    const busy = fakeResponse();
    await app.handlers.get("POST /api/data-consolidation/run")!({ body: { mode: "incremental" }, ...asAdmin }, busy.res);
    expect(busy.result.statusCode).toBe(409);
    expect(busy.result.body).toMatchObject({ error: "already_running", run });

    service.startRun.mockResolvedValueOnce({ started: false, reason: "not_leader", run: null });
    const leased = fakeResponse();
    await app.handlers.get("POST /api/data-consolidation/run")!({ body: { mode: "incremental" }, ...asAdmin }, leased.res);
    expect(leased.result.statusCode).toBe(409);
    expect(leased.result.body).toMatchObject({ error: "not_leader" });
  });

  it("cancel flags the active run for an admin or answers 404", async () => {
    service.requestCancel.mockResolvedValueOnce({ ...run, cancelRequested: true });
    const ok = fakeResponse();
    await app.handlers.get("POST /api/data-consolidation/cancel")!({ body: { runId: "r1" }, ...asAdmin }, ok.res);
    expect(ok.result.statusCode).toBe(200);
    expect(service.requestCancel).toHaveBeenCalledWith("r1");

    service.requestCancel.mockResolvedValueOnce(null);
    const none = fakeResponse();
    await app.handlers.get("POST /api/data-consolidation/cancel")!({ body: {}, ...asAdmin }, none.res);
    expect(none.result.statusCode).toBe(404);
  });

  it("status carries canManage (true for admins, false otherwise) and runs proxy the service", async () => {
    service.getStatus.mockResolvedValue({ current: null, last: null });
    service.listRuns.mockResolvedValue([run]);
    const admin = fakeResponse();
    await app.handlers.get("GET /api/data-consolidation/status")!({ ...asAdmin }, admin.res);
    expect(admin.result.body).toEqual({ current: null, last: null, canManage: true });
    const user = fakeResponse();
    await app.handlers.get("GET /api/data-consolidation/status")!({ ...asUser }, user.res);
    expect(user.result.body).toEqual({ current: null, last: null, canManage: false });

    const rs = fakeResponse();
    await app.handlers.get("GET /api/data-consolidation/runs")!({ query: { limit: "5" }, ...asUser }, rs.res);
    expect(service.listRuns).toHaveBeenCalledWith(5);
    expect(rs.result.body).toEqual([run]);
  });
});
