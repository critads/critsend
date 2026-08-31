import { describe, expect, it, vi } from "vitest";
import { runAfterDurableFinalization } from "../server/services/step-durability";

describe("step cursor finalization barrier", () => {
  it("does not checkpoint when an outstanding async flush rejects", async () => {
    const checkpoint = vi.fn().mockResolvedValue(undefined);
    const failedFlush = Promise.reject(
      Object.assign(new Error("rows unresolved"), {
        senderFinalizationIncomplete: true,
      }),
    );

    await expect(
      runAfterDurableFinalization(failedFlush, checkpoint),
    ).rejects.toMatchObject({ senderFinalizationIncomplete: true });
    expect(checkpoint).not.toHaveBeenCalled();
  });

  it("checkpoints only after a successful outstanding flush", async () => {
    const order: string[] = [];
    const flush = Promise.resolve().then(() => {
      order.push("flush");
    });

    await runAfterDurableFinalization(flush, async () => {
      order.push("checkpoint");
    });

    expect(order).toEqual(["flush", "checkpoint"]);
  });
});