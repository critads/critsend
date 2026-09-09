import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("campaign list performance guard", () => {
  it("does not backfill Orange/Wanadoo history in the list request", () => {
    const source = readFileSync(
      "server/repositories/campaign-repository.ts",
      "utf8",
    );
    const listStart = source.indexOf("export async function getCampaignsPaginated");
    const listEnd = source.indexOf("export async function getCampaignCalendar", listStart);
    const listSource = source.slice(listStart, listEnd);

    expect(listStart).toBeGreaterThanOrEqual(0);
    expect(listEnd).toBeGreaterThan(listStart);
    expect(listSource).not.toContain("orangeWanadooBackfillIds");
    expect(listSource).not.toContain("Lazy campaign counter backfill");
    expect(listSource).not.toContain("split_part(subscriber.email");
    expect(listSource).toContain("orangeWanadooSentCount: campaigns.orangeWanadooSentCount");
  });
});