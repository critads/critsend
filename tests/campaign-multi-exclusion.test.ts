import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { PgDialect } from "drizzle-orm/pg-core";

/**
 * Multiple exclusion segments per campaign.
 *
 * Covers the three layers that must agree on the array contract:
 *  1. request normalization (canonical `excludeSegmentIds[]`, legacy single key),
 *  2. zod schemas for drafts / PATCH / full create,
 *  3. the subscriber repository: every exclusion is subtracted with its own
 *     `NOT (...)`, and any overlap with the audience still short-circuits.
 */

const selectSpy = vi.fn();

vi.mock("../server/db", () => ({
  db: {
    select: (...args: unknown[]) => selectSpy(...args),
    transaction: vi.fn(),
  },
  pool: { query: vi.fn() },
}));
vi.mock("../server/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  exclusionAudienceOverlap,
  readExclusionSegmentIds,
  sameIdSets,
} from "../server/utils/campaign-exclusions";
import {
  insertCampaignDraftSchema,
  insertCampaignSchema,
  updateCampaignDraftSchema,
  segments,
  subscribers,
  type SegmentRulesV2,
} from "../shared/schema";
import * as repo from "../server/repositories/subscriber-repository";

const dialect = new PgDialect();

function tagRules(tag: string): SegmentRulesV2 {
  return {
    version: 2,
    root: {
      type: "group",
      combinator: "AND",
      children: [
        { type: "condition", field: "tags", operator: "has_tag", value: tag, value2: null } as any,
      ],
    },
  };
}

beforeEach(() => {
  selectSpy.mockReset();
});

describe("readExclusionSegmentIds", () => {
  it("prefers the canonical array over the legacy single key", () => {
    const r = readExclusionSegmentIds({ excludeSegmentIds: ["a", "b"], excludeSegmentId: "z" });
    expect(r).toEqual({ ok: true, provided: true, ids: ["a", "b"] });
  });

  it("maps the legacy key to a one-element list and blank values to an empty list", () => {
    expect(readExclusionSegmentIds({ excludeSegmentId: "a" })).toEqual({ ok: true, provided: true, ids: ["a"] });
    expect(readExclusionSegmentIds({ excludeSegmentId: "" })).toEqual({ ok: true, provided: true, ids: [] });
    expect(readExclusionSegmentIds({ excludeSegmentId: null })).toEqual({ ok: true, provided: true, ids: [] });
    expect(readExclusionSegmentIds({ excludeSegmentIds: null })).toEqual({ ok: true, provided: true, ids: [] });
    expect(readExclusionSegmentIds({ excludeSegmentIds: [] })).toEqual({ ok: true, provided: true, ids: [] });
  });

  it("reports an untouched exclusion when neither key is present", () => {
    expect(readExclusionSegmentIds({ name: "x" })).toEqual({ ok: true, provided: false, ids: [] });
    expect(readExclusionSegmentIds(undefined)).toEqual({ ok: true, provided: false, ids: [] });
  });

  it("rejects malformed lists", () => {
    expect(readExclusionSegmentIds({ excludeSegmentIds: "a" }).ok).toBe(false);
    expect(readExclusionSegmentIds({ excludeSegmentIds: ["a", "a"] }).ok).toBe(false);
    expect(readExclusionSegmentIds({ excludeSegmentIds: ["a", ""] }).ok).toBe(false);
    expect(readExclusionSegmentIds({ excludeSegmentIds: [1] }).ok).toBe(false);
    expect(readExclusionSegmentIds({ excludeSegmentId: 5 }).ok).toBe(false);
  });

  it("compares exclusion lists as sets and detects audience overlap", () => {
    expect(sameIdSets(["a", "b"], ["b", "a"])).toBe(true);
    expect(sameIdSets(["a"], ["a", "b"])).toBe(false);
    expect(sameIdSets([], [])).toBe(true);
    expect(exclusionAudienceOverlap(["s1", "s2"], ["x", "s2"])).toEqual(["s2"]);
    expect(exclusionAudienceOverlap(["s1"], [])).toEqual([]);
  });
});

describe("schemas accept excludeSegmentIds", () => {
  const baseDraft = { name: "Draft", mtaId: "mta_1", segmentId: "seg_main" };

  it("insertCampaignDraftSchema keeps a unique list and rejects duplicates", () => {
    const ok = insertCampaignDraftSchema.safeParse({ ...baseDraft, excludeSegmentIds: ["x", "y"] });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.excludeSegmentIds).toEqual(["x", "y"]);
    expect(insertCampaignDraftSchema.safeParse({ ...baseDraft, excludeSegmentIds: ["x", "x"] }).success).toBe(false);
    expect(insertCampaignDraftSchema.safeParse({ ...baseDraft, excludeSegmentIds: [""] }).success).toBe(false);
  });

  it("updateCampaignDraftSchema accepts, clears and leaves untouched", () => {
    const set = updateCampaignDraftSchema.safeParse({ excludeSegmentIds: ["x", "y"] });
    expect(set.success).toBe(true);
    if (set.success) expect(set.data.excludeSegmentIds).toEqual(["x", "y"]);
    const clear = updateCampaignDraftSchema.safeParse({ excludeSegmentIds: [] });
    expect(clear.success).toBe(true);
    if (clear.success) expect(clear.data.excludeSegmentIds).toEqual([]);
    const untouched = updateCampaignDraftSchema.safeParse({ name: "renamed" });
    expect(untouched.success).toBe(true);
    if (untouched.success) expect("excludeSegmentIds" in untouched.data).toBe(false);
  });

  it("insertCampaignSchema (full create) keeps segmentIds and excludeSegmentIds", () => {
    const r = insertCampaignSchema.safeParse({
      name: "Full",
      fromName: "Sender",
      fromEmail: "sender@example.com",
      subject: "Hello",
      htmlContent: "<p>hi</p>",
      mtaId: "mta_1",
      segmentId: "seg_a",
      segmentIds: ["seg_a", "seg_b"],
      excludeSegmentIds: ["seg_x", "seg_y"],
      status: "draft",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.segmentIds).toEqual(["seg_a", "seg_b"]);
      expect(r.data.excludeSegmentIds).toEqual(["seg_x", "seg_y"]);
    }
  });
});

describe("subscriber repository — multiple exclusions", () => {
  it("normalizes legacy single ids and de-duplicates lists", () => {
    expect(repo.normalizeExclusionSegmentIds(undefined)).toEqual([]);
    expect(repo.normalizeExclusionSegmentIds(null)).toEqual([]);
    expect(repo.normalizeExclusionSegmentIds("a")).toEqual(["a"]);
    expect(repo.normalizeExclusionSegmentIds(["a", "b", "a", ""])).toEqual(["a", "b"]);
    expect(repo.exclusionOverlapsAudience(["s1", "s2"], ["x", "s1"])).toBe(true);
    expect(repo.exclusionOverlapsAudience(["s1"], ["x"])).toBe(false);
  });

  it("short-circuits when ANY exclusion overlaps the audience (count, cursor)", async () => {
    selectSpy.mockImplementation(() => {
      throw new Error("db must not be queried for an always-empty audience");
    });
    expect(await repo.countSubscribersForSegments(["a", "b"], ["x", "b"])).toBe(0);
    expect(await repo.getSubscribersForSegmentsCursor(["a", "b"], 50, undefined, ["x", "a"])).toEqual([]);
    expect(selectSpy).not.toHaveBeenCalled();
  });

  it("refuses to plan a warm start when ANY exclusion overlaps the audience", async () => {
    // The warm planner compiles segments first (one lookup), then must abort
    // before opening its transaction: an overlapping exclusion is always empty.
    selectSpy.mockImplementation(() => ({
      from: (table: unknown) => {
        if (table !== segments) throw new Error("only the segment lookup may run");
        return {
          where: async () => [
            { id: "a", rules: tagRules("A") },
            { id: "b", rules: tagRules("B") },
            { id: "x", rules: tagRules("X") },
          ],
        };
      },
    }));
    await expect(
      repo.planCampaignWarmStart("camp", ["a", "b"], ["x", "b"], 1),
    ).rejects.toThrow(/cannot be compiled/);
  });

  function mockSegmentsAndCapture(rows: Array<{ id: string; rules: SegmentRulesV2 }>) {
    const captured: { where?: unknown } = {};
    selectSpy.mockImplementation(() => ({
      from: (table: unknown) => {
        if (table === segments) {
          return { where: async () => rows };
        }
        if (table === subscribers) {
          return {
            where: (cond: unknown) => {
              captured.where = cond;
              const result = Promise.resolve([{ count: 0 }]);
              return Object.assign(result, {
                orderBy: () => ({ limit: async () => [] }),
              });
            },
          };
        }
        throw new Error("unexpected table");
      },
    }));
    return captured;
  }

  it("subtracts every exclusion segment with its own NOT clause in the count", async () => {
    const captured = mockSegmentsAndCapture([
      { id: "aud", rules: tagRules("AUD") },
      { id: "ex1", rules: tagRules("EX1") },
      { id: "ex2", rules: tagRules("EX2") },
    ]);
    expect(await repo.countSubscribersForSegments(["aud"], ["ex1", "ex2"])).toBe(0);
    const rendered = dialect.sqlToQuery(captured.where as any);
    expect(rendered.params).toContain("AUD");
    expect(rendered.params).toContain("EX1");
    expect(rendered.params).toContain("EX2");
    // Exactly one `not (...)` per exclusion (the BCK guard renders as
    // `not 'BCK' = ANY(...)`, without a parenthesis).
    const notCount = (rendered.sql.match(/\bnot \(/g) ?? []).length;
    expect(notCount).toBe(2);
    // Structure: audience predicate (ANDed with its uploaded-hash exclusion),
    // then one negated exclusion segment each, in order — the audience
    // predicate itself is never negated.
    expect(rendered.sql).toMatch(
      /and \("subscribers"\."tags" @> ARRAY\[\$1\]::text\[\][\s\S]*\) and not \("subscribers"\."tags" @> ARRAY\[\$3\][\s\S]*\) and not \("subscribers"\."tags" @> ARRAY\[\$5\]/,
    );
    expect(rendered.params).toEqual(["AUD", "aud", "EX1", "ex1", "EX2", "ex2"]);
  });

  it("applies the same exclusions to the paged sending cursor", async () => {
    const captured = mockSegmentsAndCapture([
      { id: "aud", rules: tagRules("AUD") },
      { id: "ex1", rules: tagRules("EX1") },
      { id: "ex2", rules: tagRules("EX2") },
    ]);
    expect(await repo.getSubscribersForSegmentsCursor(["aud"], 100, "after-1", ["ex1", "ex2"])).toEqual([]);
    const rendered = dialect.sqlToQuery(captured.where as any);
    expect(rendered.params).toEqual(expect.arrayContaining(["AUD", "EX1", "EX2", "after-1"]));
  });

  it("still accepts the legacy single exclusion id", async () => {
    const captured = mockSegmentsAndCapture([
      { id: "aud", rules: tagRules("AUD") },
      { id: "ex1", rules: tagRules("EX1") },
    ]);
    expect(await repo.countSubscribersForSegments(["aud"], "ex1")).toBe(0);
    const rendered = dialect.sqlToQuery(captured.where as any);
    expect(rendered.params).toEqual(expect.arrayContaining(["AUD", "EX1"]));
  });
});

describe("campaign routes — lock-time consistency (source invariants)", () => {
  const routes = readFileSync("server/routes/campaigns.ts", "utf8");

  it("PATCH re-validates self-exclusion against the LOCKED audience/exclusion rows", () => {
    const patchTx = routes.slice(
      routes.indexOf("const lockedExcludeIds = await getCampaignExclusionSegmentIds(tx, locked);"),
      routes.indexOf("await replaceCampaignExclusionSegments(tx, updated.id, requestedExcludeIds);"),
    );
    expect(patchTx).toContain("const effectiveLockedExcludeIds = requestedExcludeIds ?? lockedExcludeIds;");
    expect(patchTx).toContain("if (exclusionAudienceOverlap(effectiveLockedIds, effectiveLockedExcludeIds).length) {");
    expect(patchTx).toContain("throw new ExclusionOverlapError(");
    expect(routes).toContain("if (error instanceof ExclusionOverlapError) {\n        return res.status(400)");
  });

  it("/send refuses to launch when unspecified audience/exclusions moved between preflight and lock", () => {
    const sendTx = routes.slice(
      routes.lastIndexOf("const lockedExcludeIds = await getCampaignExclusionSegmentIds(tx, locked);"),
      routes.indexOf("await replaceCampaignExclusionSegments(tx, campaignId, effectiveExcludeIds);"),
    );
    expect(sendTx).toContain("(!hasCanonicalSegments && !hasLegacySegment && audienceChanged)");
    expect(sendTx).toContain("(!exclusionRequest.provided && exclusionChanged)");
    expect(sendTx).toContain("throw new CampaignLaunchConflictError(");
    // Every exclusion (not just position 0) is frozen into the similarity snapshot.
    expect(sendTx).toContain(".from(segments).where(inArray(segments.id, segmentRefs))");
    expect(routes).toContain("const segmentRefs = [...new Set([...selectedSegmentIds, ...effectiveExcludeIds])];");
  });

  it("the ad-hoc Orange/Wanadoo preflight rejects malformed lists and self-exclusion like the launch paths", () => {
    const preflight = routes.slice(
      routes.indexOf('app.post("/api/campaigns/orange-wanadoo-preflight"'),
      routes.indexOf("await campaignRiskPreflight({ segmentIds, excludeSegmentIds })"),
    );
    expect(preflight).toContain("rawSegmentIds.some((id) => typeof id !== \"string\" || !validateId(id))");
    expect(preflight).toContain("new Set(rawSegmentIds).size !== rawSegmentIds.length");
    expect(preflight).toContain("if (exclusionAudienceOverlap(segmentIds, excludeSegmentIds).length) {");
  });
});
