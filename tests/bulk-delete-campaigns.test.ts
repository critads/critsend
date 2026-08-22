import { describe, expect, it, vi } from "vitest";
import {
  CampaignDeleteTimeoutError,
  deleteCampaignsWithProgress,
} from "../client/src/lib/bulk-delete-campaigns";

describe("deleteCampaignsWithProgress", () => {
  it("deletes all campaigns with bounded concurrency and reports progress", async () => {
    let active = 0;
    let maxActive = 0;
    const progress: Array<{ completed: number; total: number }> = [];
    const request = vi.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return new Response(null, { status: 204 });
    });

    const result = await deleteCampaignsWithProgress(["a", "b", "c", "d"], {
      concurrency: 2,
      requestTimeoutMs: 1000,
      request,
      onProgress: (value) => progress.push(value),
    });

    expect(result).toEqual({ deletedIds: ["a", "b", "c", "d"], failures: [] });
    expect(maxActive).toBe(2);
    expect(progress[0]).toEqual({ completed: 0, total: 4 });
    expect(progress.at(-1)).toEqual({ completed: 4, total: 4 });
  });

  it("continues deleting other campaigns when one request fails", async () => {
    const request = vi.fn(async (_method: string, url: string) => {
      if (url.endsWith("/b")) throw new Error("409: follow-up pending");
      return new Response(null, { status: 204 });
    });

    const result = await deleteCampaignsWithProgress(["a", "b", "c"], {
      concurrency: 1,
      requestTimeoutMs: 1000,
      request,
    });

    expect(result.deletedIds).toEqual(["a", "c"]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].id).toBe("b");
  });

  it("times out a stuck request and finishes the bulk action", async () => {
    const request = vi.fn(
      () => new Promise<Response>(() => {
        // Simulate a fetch that never settles, even when its signal is aborted.
      }),
    );

    const result = await deleteCampaignsWithProgress(["stuck"], {
      concurrency: 1,
      requestTimeoutMs: 10,
      request,
    });

    expect(result.deletedIds).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].error).toBeInstanceOf(CampaignDeleteTimeoutError);
  });
});