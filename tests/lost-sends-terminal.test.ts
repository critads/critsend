/**
 * Lot F — lost sends must be TERMINAL (never retried into duplicates).
 *
 * `tieredFinalizeFallback` (campaign-sender) is the last line of defense
 * when a bulk finalize write fails: tiered batch retries, then individual
 * `finalizeSend`, then `forceFailPendingSend`. If even the force-fail
 * write fails, the fallback throws a dedicated non-transient durability error.
 * The sender marks the campaign failed and does not advance a step cursor or
 * automatically replay possibly-delivered SMTP outcomes.
 *
 * The storage layer is fully mocked; no database required.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const bulkFinalizeSends = vi.fn();
const finalizeSend = vi.fn();
const forceFailPendingSend = vi.fn();

vi.mock("../server/storage", () => ({
  storage: new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === "bulkFinalizeSends") return bulkFinalizeSends;
        if (prop === "finalizeSend") return finalizeSend;
        if (prop === "forceFailPendingSend") return forceFailPendingSend;
        // Any other storage method reached by this test is a bug.
        return () => {
          throw new Error(`unexpected storage.${String(prop)} call in test`);
        };
      },
    },
  ),
}));

const CAMPAIGN_ID = "test-campaign-lost-sends";

async function callFallback(
  success: string[],
  failed: string[],
  ambiguous: string[] = [],
) {
  const { tieredFinalizeFallback } = await import("../server/services/campaign-sender");
  return tieredFinalizeFallback(
    CAMPAIGN_ID,
    success,
    failed,
    "[TEST]",
    new Error("simulated bulk finalize failure"),
    ambiguous,
  );
}

beforeEach(() => {
  bulkFinalizeSends.mockReset();
  finalizeSend.mockReset();
  forceFailPendingSend.mockReset();
});

describe("tieredFinalizeFallback — terminal handling of lost sends", () => {
  it("rejects with a durability error when every write path fails", async () => {
    bulkFinalizeSends.mockRejectedValue(new Error("bulk down"));
    finalizeSend.mockRejectedValue(new Error("row write down"));
    forceFailPendingSend.mockRejectedValue(new Error("force-fail down"));

    const ids = ["s1", "s2", "f1"];
    await expect(callFallback(["s1", "s2"], ["f1"])).rejects.toMatchObject({
      name: "FinalizationDurabilityError",
      lostRowCount: ids.length,
      senderFinalizationIncomplete: true,
    });

    // Every row went through the individual path then the force-fail path.
    expect(finalizeSend).toHaveBeenCalledTimes(ids.length);
    expect(forceFailPendingSend).toHaveBeenCalledTimes(ids.length);
    const forceFailed = forceFailPendingSend.mock.calls.map((c) => c[1]).sort();
    expect(forceFailed).toEqual(["f1", "s1", "s2"]);
  }, 30000);

  it("force-fails rows individually when finalizeSend fails but forceFail succeeds", async () => {
    bulkFinalizeSends.mockRejectedValue(new Error("bulk down"));
    finalizeSend.mockRejectedValue(new Error("row write down"));
    forceFailPendingSend.mockResolvedValue(true);

    await expect(callFallback(["a"], ["b"])).resolves.toBeUndefined();
    expect(forceFailPendingSend).toHaveBeenCalledTimes(2);
  }, 30000);

  it("treats a false force-fail result as unresolved durability", async () => {
    bulkFinalizeSends.mockRejectedValue(new Error("bulk down"));
    finalizeSend.mockRejectedValue(new Error("row write down"));
    forceFailPendingSend.mockResolvedValue(false);

    await expect(callFallback(["attempting-row"], [])).rejects.toMatchObject({
      name: "FinalizationDurabilityError",
      lostRowCount: 1,
      senderFinalizationIncomplete: true,
    });
  }, 30000);

  it("marks ambiguous rows terminal with outcomeClass 'ambiguous' on both fallback writes", async () => {
    bulkFinalizeSends.mockRejectedValue(new Error("bulk down"));
    finalizeSend.mockRejectedValue(new Error("row write down"));
    forceFailPendingSend.mockResolvedValue(true);

    await expect(callFallback([], [], ["amb1"])).resolves.toBeUndefined();

    // finalizeSend(campaignId, id, success=false, "ambiguous")
    const fCall = finalizeSend.mock.calls.find((c) => c[1] === "amb1");
    expect(fCall?.[2]).toBe(false);
    expect(fCall?.[3]).toBe("ambiguous");
    // forceFailPendingSend(campaignId, id, "ambiguous")
    const ffCall = forceFailPendingSend.mock.calls.find((c) => c[1] === "amb1");
    expect(ffCall?.[2]).toBe("ambiguous");
  }, 30000);

  it("does not touch the individual path when a tiered batch retry succeeds", async () => {
    bulkFinalizeSends.mockResolvedValue(undefined);

    // 30 rows > smallest tier (25) so at least one tier applies.
    const ids = Array.from({ length: 30 }, (_, i) => `s${i}`);
    await expect(callFallback(ids, [])).resolves.toBeUndefined();

    expect(bulkFinalizeSends).toHaveBeenCalled();
    expect(finalizeSend).not.toHaveBeenCalled();
    expect(forceFailPendingSend).not.toHaveBeenCalled();
  }, 30000);
});
