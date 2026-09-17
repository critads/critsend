import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../server/db", () => ({ db: { execute: vi.fn() } }));
vi.mock("../server/services/campaign-mta-transfer", () => ({
  CampaignMtaTransferError: class CampaignMtaTransferError extends Error {
    code = "TRANSFER_FAILED";
    httpStatus = 409;
    details?: Record<string, unknown>;
  },
  prepareTransfer: vi.fn(),
  previewCampaignMtaTransfer: vi.fn(),
}));
vi.mock("../server/repositories/campaign-mta-transfer-repository", () => ({
  commitCampaignMtaTransfer: vi.fn(),
}));
vi.mock("../server/repositories/campaigns-list-cache", () => ({
  publishCampaignsListInvalidation: vi.fn(),
}));

type Handler = (req: any, res: any) => Promise<void>;

function fakeApp() {
  const handlers = new Map<string, Handler>();
  return {
    handlers,
    post(path: string, handler: Handler) { handlers.set(`POST ${path}`, handler); },
    patch(path: string, handler: Handler) { handlers.set(`PATCH ${path}`, handler); },
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

describe("campaign MTA transfer commit outcome handling", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { db } = await import("../server/db");
    vi.mocked(db.execute).mockReset()
      .mockResolvedValueOnce({ rows: [] } as any)
      .mockResolvedValue({ rows: [{ user_id: "owner-1" }] } as any);
  });

  async function invoke(
    commitResult: unknown,
    commitError?: Error,
    options: { ownerUserId?: string | null; sessionUserId?: string; preview?: boolean } = {},
  ) {
    const { prepareTransfer } = await import("../server/services/campaign-mta-transfer");
    const { previewCampaignMtaTransfer } = await import("../server/services/campaign-mta-transfer");
    const { commitCampaignMtaTransfer } = await import("../server/repositories/campaign-mta-transfer-repository");
    const { db } = await import("../server/db");
    vi.mocked(db.execute).mockReset().mockResolvedValueOnce({ rows: [] } as any);
    if (options.ownerUserId !== undefined) {
      vi.mocked(db.execute).mockResolvedValue({ rows: [{ user_id: options.ownerUserId }] } as any);
    } else {
      vi.mocked(db.execute).mockResolvedValue({ rows: [{ user_id: "owner-1" }] } as any);
    }
    const cleanup = vi.fn().mockResolvedValue(undefined);
    vi.mocked(prepareTransfer).mockResolvedValue({
      campaign: {} as any,
      name: "Campaign",
      fromName: "Sender",
      fromEmail: "sender@example.com",
      replyEmail: null,
      images: { cleanup, preparedFiles: [], externalCount: 1, managedCount: 0, unsupported: [], html: "<img>" },
    });
    vi.mocked(previewCampaignMtaTransfer).mockResolvedValue({ status: "scheduled" } as any);
    if (commitError) vi.mocked(commitCampaignMtaTransfer).mockRejectedValue(commitError);
    else vi.mocked(commitCampaignMtaTransfer).mockResolvedValue(commitResult as any);

    const { registerCampaignMtaTransferRoutes } = await import("../server/routes/campaign-mta-transfer");
    const app = fakeApp();
    registerCampaignMtaTransferRoutes(app as any);
    const response = fakeResponse();
    const key = options.preview
      ? "POST /api/campaigns/:campaignId/mta-transfer/preview"
      : "POST /api/campaigns/:campaignId/mta-transfer";
    await app.handlers.get(key)!({
      params: { campaignId: "opaque-campaign-1" },
      session: options.sessionUserId === undefined ? { userId: "owner-1" } : (
        options.sessionUserId ? { userId: options.sessionUserId } : undefined
      ),
      body: { targetMtaId: "target-1", expectedRevision: "a".repeat(64) },
    }, response);
    return { response: response.result, cleanup };
  }

  it("cleans prepared files on a known CAS conflict", async () => {
    const { response, cleanup } = await invoke({ ok: false, reason: "conflict" });
    expect(response.statusCode).toBe(409);
    expect(response.body).toMatchObject({ code: "CONFLICT" });
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("preserves prepared files when the commit acknowledgement is lost", async () => {
    const { response, cleanup } = await invoke(undefined, new Error("socket reset after commit"));
    expect(response.statusCode).toBe(503);
    expect(response.body).toMatchObject({ code: "TRANSFER_COMMIT_UNKNOWN" });
    expect(cleanup).not.toHaveBeenCalled();
  });

  it("allows an authenticated non-admin to preview and commit a NULL-owned campaign", async () => {
    const campaign = {
      id: "opaque-campaign-1",
      sourceMta: null,
      mtaId: "target-1",
      revision: "b".repeat(64),
      name: "Campaign",
      fromName: "Sender",
      fromEmail: "sender@example.com",
      replyEmail: null,
      htmlContent: "<p>hello</p>",
      scheduledAt: new Date(Date.now() + 60_000),
    };
    const preview = await invoke(undefined, undefined, {
      ownerUserId: null,
      sessionUserId: "shared-user",
      preview: true,
    });
    expect(preview.response.statusCode).toBe(200);
    const commit = await invoke({ ok: true, campaign }, undefined, {
      ownerUserId: null,
      sessionUserId: "shared-user",
    });
    expect(commit.response.statusCode).toBe(200);
  });

  it("rejects a non-admin authenticated user for an explicitly foreign-owned campaign", async () => {
    const result = await invoke({ ok: true }, undefined, {
      ownerUserId: "different-user",
      sessionUserId: "requesting-user",
    });
    expect(result.response.statusCode).toBe(403);
    expect(result.response.body).toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects unauthenticated transfer requests", async () => {
    const result = await invoke({ ok: true }, undefined, {
      ownerUserId: null,
      sessionUserId: "",
    });
    expect(result.response.statusCode).toBe(401);
    expect(result.response.body).toMatchObject({ code: "UNAUTHORIZED" });
  });
});