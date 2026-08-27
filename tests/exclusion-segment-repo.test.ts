import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Task #138 — repo-level coverage for the self-exclusion guarantee.
 *
 * The full include + exclude SQL composition is exercised in production
 * against real Postgres; here we lock down the most important invariant
 * that must hold without any DB at all: when the exclusion segment id
 * equals the include segment id, the audience is empty and the database
 * is never queried. That is the canonical "every subscriber is in both
 * segments → none should be sent" overlap case, and the short-circuit
 * is the only thing standing between a stale draft and an empty send.
 */

const dbSelectSpy = vi.fn();
const poolQuerySpy = vi.fn();

// Mock the db module so any accidental query becomes detectable.
vi.mock("../server/db", () => ({
  db: {
    select: (...args: any[]) => {
      dbSelectSpy(...args);
      throw new Error("db.select() must not be called for self-exclusion");
    },
    transaction: vi.fn(),
  },
  pool: {
    query: (...args: any[]) => {
      poolQuerySpy(...args);
      throw new Error("pool.query() must not be called for self-exclusion");
    },
  },
}));

import * as repo from "../server/repositories/subscriber-repository";

beforeEach(() => {
  dbSelectSpy.mockClear();
  poolQuerySpy.mockClear();
});

describe("Task #138 — exclusion segment short-circuit", () => {
  it("countSubscribersForSegment returns 0 when include === exclude", async () => {
    const n = await repo.countSubscribersForSegment("seg_x", "seg_x");
    expect(n).toBe(0);
    expect(dbSelectSpy).not.toHaveBeenCalled();
    expect(poolQuerySpy).not.toHaveBeenCalled();
  });

  it("getSubscribersForSegmentCursor returns [] when include === exclude", async () => {
    const rows = await repo.getSubscribersForSegmentCursor(
      "seg_x",
      100,
      undefined,
      "seg_x",
    );
    expect(rows).toEqual([]);
    expect(dbSelectSpy).not.toHaveBeenCalled();
    expect(poolQuerySpy).not.toHaveBeenCalled();
  });

  it("multi-segment count returns 0 when the exclusion overlaps any inclusion", async () => {
    const n = await repo.countSubscribersForSegments(["seg_a", "seg_b"], "seg_b");
    expect(n).toBe(0);
    expect(dbSelectSpy).not.toHaveBeenCalled();
    expect(poolQuerySpy).not.toHaveBeenCalled();
  });

  it("multi-segment cursor returns [] when the exclusion overlaps any inclusion", async () => {
    const rows = await repo.getSubscribersForSegmentsCursor(
      ["seg_a", "seg_b"],
      100,
      undefined,
      "seg_a",
    );
    expect(rows).toEqual([]);
    expect(dbSelectSpy).not.toHaveBeenCalled();
    expect(poolQuerySpy).not.toHaveBeenCalled();
  });

  it("empty multi-segment audiences short-circuit without querying", async () => {
    expect(await repo.countSubscribersForSegments([])).toBe(0);
    expect(await repo.getSubscribersForSegmentsCursor([], 100)).toEqual([]);
    expect(dbSelectSpy).not.toHaveBeenCalled();
    expect(poolQuerySpy).not.toHaveBeenCalled();
  });

  it("self-exclusion check is undefined-safe (no exclude → no short-circuit)", async () => {
    // We expect the function to attempt a real db call here, which our
    // mock turns into a thrown error — proving the short-circuit only
    // triggers on equality, not on any-exclude-supplied.
    await expect(repo.countSubscribersForSegment("seg_x")).rejects.toThrow(
      /db\.select\(\) must not be called/,
    );
  });
});
