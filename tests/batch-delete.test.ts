import { describe, it, expect, vi } from "vitest";
import { deleteInBatches } from "../server/services/batch-delete";

const noSleep = async () => {};

describe("deleteInBatches", () => {
  it("loops until a batch deletes fewer than batchSize (predicate drained) and sums the total", async () => {
    // 20k, 20k, 7k -> stops after the short batch
    const counts = [20_000, 20_000, 7_000];
    let i = 0;
    const runBatch = vi.fn(async () => counts[i++]);

    const total = await deleteInBatches(runBatch, { batchSize: 20_000 }, noSleep);

    expect(runBatch).toHaveBeenCalledTimes(3);
    expect(total).toBe(47_000);
  });

  it("passes batchSize as the limit to runBatch", async () => {
    const runBatch = vi.fn(async () => 0);
    await deleteInBatches(runBatch, { batchSize: 12_345 }, noSleep);
    expect(runBatch).toHaveBeenCalledWith(12_345);
  });

  it("stops at maxBatches even when every batch is full (bounded sweeper)", async () => {
    const runBatch = vi.fn(async () => 20_000); // never drains
    const total = await deleteInBatches(
      runBatch,
      { batchSize: 20_000, maxBatches: 3 },
      noSleep,
    );
    expect(runBatch).toHaveBeenCalledTimes(3);
    expect(total).toBe(60_000);
  });

  it("returns 0 and calls runBatch exactly once when there is nothing to delete", async () => {
    const runBatch = vi.fn(async () => 0);
    const total = await deleteInBatches(runBatch, { batchSize: 20_000 }, noSleep);
    expect(runBatch).toHaveBeenCalledTimes(1);
    expect(total).toBe(0);
  });

  it("is unbounded (maxBatches undefined) and keeps going until drained", async () => {
    const counts = [20_000, 20_000, 20_000, 20_000, 1];
    let i = 0;
    const runBatch = vi.fn(async () => counts[i++]);
    const total = await deleteInBatches(runBatch, { batchSize: 20_000 }, noSleep);
    expect(runBatch).toHaveBeenCalledTimes(5);
    expect(total).toBe(80_001);
  });

  it("sleeps BETWEEN iterations only (not after the final batch)", async () => {
    const counts = [20_000, 20_000, 5_000];
    let i = 0;
    const runBatch = async () => counts[i++];
    const sleep = vi.fn(async () => {});

    await deleteInBatches(runBatch, { batchSize: 20_000, sleepMs: 50 }, sleep);

    // 3 batches => 2 inter-batch sleeps, none after the short final batch
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(50);
  });

  it("does not sleep when sleepMs is 0", async () => {
    const counts = [20_000, 3_000];
    let i = 0;
    const runBatch = async () => counts[i++];
    const sleep = vi.fn(async () => {});
    await deleteInBatches(runBatch, { batchSize: 20_000, sleepMs: 0 }, sleep);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("stops at maxBatches=1 after a single full batch", async () => {
    const runBatch = vi.fn(async () => 20_000);
    const total = await deleteInBatches(
      runBatch,
      { batchSize: 20_000, maxBatches: 1 },
      noSleep,
    );
    expect(runBatch).toHaveBeenCalledTimes(1);
    expect(total).toBe(20_000);
  });
});
