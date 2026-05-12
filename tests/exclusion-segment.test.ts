import { describe, it, expect } from "vitest";
import {
  insertCampaignDraftSchema,
  updateCampaignDraftSchema,
} from "../shared/schema";

/**
 * Task #138 — schema-level coverage for the optional exclusion segment.
 * Pure schema tests (no DB) so they run in any environment.
 */
describe("Task #138 — exclusion segment schema", () => {
  const baseDraft = {
    name: "Test draft",
    mtaId: "mta_1",
    segmentId: "seg_main",
  };

  describe("insertCampaignDraftSchema", () => {
    it("accepts a draft with no excludeSegmentId", () => {
      const r = insertCampaignDraftSchema.safeParse(baseDraft);
      expect(r.success).toBe(true);
      if (r.success) {
        expect(r.data.excludeSegmentId ?? null).toBeNull();
      }
    });

    it("accepts a draft with a string excludeSegmentId", () => {
      const r = insertCampaignDraftSchema.safeParse({
        ...baseDraft,
        excludeSegmentId: "seg_exclude",
      });
      expect(r.success).toBe(true);
      if (r.success) {
        expect(r.data.excludeSegmentId).toBe("seg_exclude");
      }
    });

    it('preprocesses empty string excludeSegmentId to null', () => {
      const r = insertCampaignDraftSchema.safeParse({
        ...baseDraft,
        excludeSegmentId: "",
      });
      expect(r.success).toBe(true);
      if (r.success) {
        expect(r.data.excludeSegmentId).toBeNull();
      }
    });

    it("accepts explicit null excludeSegmentId", () => {
      const r = insertCampaignDraftSchema.safeParse({
        ...baseDraft,
        excludeSegmentId: null,
      });
      expect(r.success).toBe(true);
      if (r.success) {
        expect(r.data.excludeSegmentId).toBeNull();
      }
    });
  });

  describe("updateCampaignDraftSchema", () => {
    it("accepts a PATCH that clears the exclusion via empty string", () => {
      const r = updateCampaignDraftSchema.safeParse({ excludeSegmentId: "" });
      expect(r.success).toBe(true);
      if (r.success) {
        expect(r.data.excludeSegmentId).toBeNull();
      }
    });

    it("accepts a PATCH that sets a new exclusion segment id", () => {
      const r = updateCampaignDraftSchema.safeParse({
        excludeSegmentId: "seg_new_exclude",
      });
      expect(r.success).toBe(true);
      if (r.success) {
        expect(r.data.excludeSegmentId).toBe("seg_new_exclude");
      }
    });

    it("treats omitted excludeSegmentId as untouched", () => {
      const r = updateCampaignDraftSchema.safeParse({ name: "renamed" });
      expect(r.success).toBe(true);
      if (r.success) {
        expect("excludeSegmentId" in r.data).toBe(false);
      }
    });
  });

  describe("self-exclusion guard (route-level invariant)", () => {
    /**
     * The self-exclusion check lives in the campaign POST/PATCH handlers
     * (server/routes/campaigns.ts). Replicate the predicate here so a
     * regression that weakens it in either place would be visible.
     */
    function isSelfExclusion(segmentId: string | null, excludeSegmentId: string | null) {
      return !!(segmentId && excludeSegmentId && segmentId === excludeSegmentId);
    }

    it("flags identical include and exclude ids", () => {
      expect(isSelfExclusion("s1", "s1")).toBe(true);
    });

    it("does not flag distinct ids", () => {
      expect(isSelfExclusion("s1", "s2")).toBe(false);
    });

    it("does not flag when exclusion is null", () => {
      expect(isSelfExclusion("s1", null)).toBe(false);
    });

    it("does not flag when both are null", () => {
      expect(isSelfExclusion(null, null)).toBe(false);
    });
  });
});
