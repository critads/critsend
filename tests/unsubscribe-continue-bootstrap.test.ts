import { describe, it, expect, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
}));

vi.mock("../server/db", () => ({
  pool: { connect: mocks.connect },
}));

vi.mock("../server/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe("unsubscribe continue schema bootstrap", () => {
  it("logs and resolves when database checkout fails so routes can register", async () => {
    mocks.connect.mockRejectedValueOnce(new Error("database unavailable"));
    const { ensureUnsubscribeContinueSchema } = await import("../server/unsubscribe-continue-bootstrap");
    await expect(ensureUnsubscribeContinueSchema()).resolves.toBeUndefined();
  });
});