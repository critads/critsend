import { describe, it, expect } from "vitest";
import { isTransientConnError, withConnRetry } from "../server/services/conn-retry";

const FAST = { baseMs: 0, maxMs: 0, maxRetries: 4 } as const;

describe("isTransientConnError", () => {
  it("matches node-postgres connect-timeout message", () => {
    expect(isTransientConnError(new Error("timeout exceeded when trying to connect"))).toBe(true);
  });

  it("matches dropped/reset connections by code", () => {
    expect(isTransientConnError({ code: "ECONNRESET" })).toBe(true);
    expect(isTransientConnError({ code: "ETIMEDOUT" })).toBe(true);
    expect(isTransientConnError({ code: "57P01" })).toBe(true);
    expect(isTransientConnError({ code: "08006" })).toBe(true);
  });

  it("matches 'Connection terminated' / 'server closed the connection' messages", () => {
    expect(isTransientConnError(new Error("Connection terminated unexpectedly"))).toBe(true);
    expect(isTransientConnError(new Error("server closed the connection unexpectedly"))).toBe(true);
  });

  it("does NOT match genuine data / SQL errors", () => {
    expect(isTransientConnError({ code: "23505", message: "duplicate key value" })).toBe(false);
    expect(isTransientConnError(new Error("null value in column violates not-null"))).toBe(false);
    expect(isTransientConnError(undefined)).toBe(false);
  });
});

describe("withConnRetry", () => {
  it("returns immediately on first success without retrying", async () => {
    let calls = 0;
    const result = await withConnRetry(async () => {
      calls++;
      return "ok";
    }, FAST);
    expect(result).toBe("ok");
    expect(calls).toBe(1);
  });

  it("retries transient connect-timeout failures then succeeds (no false failure)", async () => {
    let calls = 0;
    const result = await withConnRetry(async () => {
      calls++;
      if (calls < 3) throw new Error("timeout exceeded when trying to connect");
      return "recovered";
    }, FAST);
    expect(result).toBe("recovered");
    expect(calls).toBe(3);
  });

  it("re-throws non-transient errors immediately (fails fast on data errors)", async () => {
    let calls = 0;
    await expect(
      withConnRetry(async () => {
        calls++;
        throw Object.assign(new Error("duplicate key value"), { code: "23505" });
      }, FAST),
    ).rejects.toThrow("duplicate key value");
    expect(calls).toBe(1);
  });

  it("gives up after exhausting maxRetries and re-throws the transient error", async () => {
    let calls = 0;
    await expect(
      withConnRetry(async () => {
        calls++;
        throw new Error("timeout exceeded when trying to connect");
      }, { ...FAST, maxRetries: 2 }),
    ).rejects.toThrow("timeout exceeded when trying to connect");
    // 1 initial attempt + 2 retries = 3 total
    expect(calls).toBe(3);
  });
});
