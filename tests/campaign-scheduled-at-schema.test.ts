import { describe, expect, it } from "vitest";
import {
  insertCampaignDraftSchema,
  insertCampaignSchema,
  updateCampaignDraftSchema,
} from "../shared/schema";

const scheduledAt = "2026-09-02T06:54:00.000Z";

describe("campaign scheduledAt API schemas", () => {
  it.each([
    ["campaign creation", insertCampaignSchema],
    ["draft creation", insertCampaignDraftSchema],
    ["draft update", updateCampaignDraftSchema],
  ])("coerces an ISO string to Date for %s", (_label, schema) => {
    const result = schema.pick({ scheduledAt: true }).parse({ scheduledAt });

    expect(result.scheduledAt).toBeInstanceOf(Date);
    expect(result.scheduledAt?.toISOString()).toBe(scheduledAt);
  });

  it("rejects an invalid scheduled date", () => {
    expect(() => insertCampaignSchema.pick({ scheduledAt: true }).parse({
      scheduledAt: "not-a-date",
    })).toThrow();
  });
});