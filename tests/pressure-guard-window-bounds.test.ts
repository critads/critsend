/**
 * Task #145 R14 boundary regression: PRESSURE_WINDOW_HOURS validation
 * must accept the documented "0.0833" (5-min) override and reject any
 * value below 5 real minutes — even though 0.0833 < 5/60 numerically.
 *
 * The module reads PRESSURE_WINDOW_HOURS at import time, so each case
 * uses an isolated module specifier (vi.resetModules + dynamic import).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

describe("PRESSURE_WINDOW_HOURS boundary validation (Task #145 R14)", () => {
  let originalEnv: string | undefined;
  let originalNodeEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.PRESSURE_WINDOW_HOURS;
    originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "test";
    vi.resetModules();
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.PRESSURE_WINDOW_HOURS;
    else process.env.PRESSURE_WINDOW_HOURS = originalEnv;
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    vi.resetModules();
  });

  it("accepts the documented 5-min decimal '0.0833'", async () => {
    process.env.PRESSURE_WINDOW_HOURS = "0.0833";
    const mod = await import("../server/services/pressure-guard");
    expect(mod.PRESSURE_WINDOW_HOURS).toBeCloseTo(0.0833, 4);
  });

  it("accepts an exact 5-min value (5/60)", async () => {
    process.env.PRESSURE_WINDOW_HOURS = String(5 / 60);
    const mod = await import("../server/services/pressure-guard");
    expect(mod.PRESSURE_WINDOW_HOURS).toBeCloseTo(5 / 60, 6);
  });

  it("accepts the upper bound (168h / 7d)", async () => {
    process.env.PRESSURE_WINDOW_HOURS = "168";
    const mod = await import("../server/services/pressure-guard");
    expect(mod.PRESSURE_WINDOW_HOURS).toBe(168);
  });

  it("rejects values below 5 real minutes (e.g. 4 minutes = 0.0666)", async () => {
    process.env.PRESSURE_WINDOW_HOURS = "0.0666";
    await expect(import("../server/services/pressure-guard")).rejects.toThrow(/PRESSURE_WINDOW_HOURS/);
  });

  it("rejects values above 7 days", async () => {
    process.env.PRESSURE_WINDOW_HOURS = "200";
    await expect(import("../server/services/pressure-guard")).rejects.toThrow(/PRESSURE_WINDOW_HOURS/);
  });

  it("rejects non-finite garbage", async () => {
    process.env.PRESSURE_WINDOW_HOURS = "not-a-number";
    await expect(import("../server/services/pressure-guard")).rejects.toThrow(/PRESSURE_WINDOW_HOURS/);
  });

  it("ignores the env in production and pins to 6h", async () => {
    process.env.NODE_ENV = "production";
    process.env.PRESSURE_WINDOW_HOURS = "0.0001";
    const mod = await import("../server/services/pressure-guard");
    expect(mod.PRESSURE_WINDOW_HOURS).toBe(6);
  });
});
