import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  compileSegmentRules,
  ENGAGEMENT_RECENCY_DAYS,
  TOP_CLICKER_MIN_CAMPAIGNS,
  ULTRA_CLICKER_MIN_CAMPAIGNS,
} from "../server/services/segment-compiler";
import {
  fieldOperatorsV2,
  operatorLabelsV2,
  segmentConditionSchema,
  segmentRulesV2Schema,
  type SegmentRulesV2,
} from "../shared/schema";

/**
 * Task #232 — "Top active clicker" / "Ultra active clicker" engagement
 * operators: subscribers who clicked in strictly more than 3 (resp. 5)
 * DISTINCT campaigns within the fixed 60-day window. Unary operators; the
 * compiler emits a correlated COUNT(DISTINCT campaign_id) subquery over
 * campaign_stats click events.
 */
const dialect = new PgDialect();

function rulesFor(operator: string): SegmentRulesV2 {
  return {
    version: 2,
    root: {
      type: "group",
      combinator: "AND",
      children: [
        { type: "condition", field: "engagement", operator, value: null, value2: null } as any,
      ],
    },
  };
}

function renderQuery(rules: SegmentRulesV2): { sql: string; params: unknown[] } {
  const q = dialect.sqlToQuery(compileSegmentRules(rules));
  return { sql: q.sql, params: q.params };
}

describe("Task #232 — clicker tier operators", () => {
  it("thresholds encode 'strictly more than 3 / 5' distinct campaigns", () => {
    expect(TOP_CLICKER_MIN_CAMPAIGNS).toBe(4);
    expect(ULTRA_CLICKER_MIN_CAMPAIGNS).toBe(6);
  });

  it("exposes both operators on the engagement field with labels", () => {
    expect(fieldOperatorsV2.engagement).toContain("top_active_clicker");
    expect(fieldOperatorsV2.engagement).toContain("ultra_active_clicker");
    expect(operatorLabelsV2.top_active_clicker).toMatch(/>3 campaigns/);
    expect(operatorLabelsV2.ultra_active_clicker).toMatch(/>5 campaigns/);
  });

  it("accepts the unary operators with a null value at the schema level", () => {
    for (const operator of ["top_active_clicker", "ultra_active_clicker"]) {
      const r = segmentConditionSchema.safeParse({
        type: "condition",
        field: "engagement",
        operator,
        value: null,
        value2: null,
      });
      expect(r.success).toBe(true);
      // Full V2 rules document validates too (create / edit / refresh paths).
      expect(segmentRulesV2Schema.safeParse(rulesFor(operator)).success).toBe(true);
    }
  });

  it("compiles a correlated COUNT(DISTINCT campaign_id) over recent clicks", () => {
    for (const [operator, threshold] of [
      ["top_active_clicker", TOP_CLICKER_MIN_CAMPAIGNS],
      ["ultra_active_clicker", ULTRA_CLICKER_MIN_CAMPAIGNS],
    ] as const) {
      const { sql: text, params } = renderQuery(rulesFor(operator));
      expect(text).toContain("COUNT(DISTINCT cs.campaign_id)");
      expect(text).toContain("FROM campaign_stats cs");
      expect(text).toContain("cs.type = 'click'");
      // Correlated on the outer subscribers row.
      expect(text).toMatch(/cs\.subscriber_id = "subscribers"\."id"/);
      // Window + threshold arrive as bind params (60, then 4 or 6).
      expect(params).toContain(ENGAGEMENT_RECENCY_DAYS);
      expect(params).toContain(threshold);
      // Clicks are floored at NOW() - window: older clicks are ignored.
      expect(text).toContain("cs.timestamp >= NOW() - INTERVAL '1 day'");
    }
  });

  it("is combinable with other conditions (AND group)", () => {
    const rules: SegmentRulesV2 = {
      version: 2,
      root: {
        type: "group",
        combinator: "AND",
        children: [
          { type: "condition", field: "engagement", operator: "top_active_clicker", value: null, value2: null } as any,
          { type: "condition", field: "tags", operator: "has_tag", value: "VIP", value2: null } as any,
        ],
      },
    };
    const { sql: text } = renderQuery(rules);
    expect(text).toContain("COUNT(DISTINCT cs.campaign_id)");
    expect(text.toLowerCase()).toContain(" and ");
  });
});
