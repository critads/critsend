import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  compileSegmentRules,
  ENGAGEMENT_RECENCY_DAYS,
  EXCLUDED_BOT_OPEN_IP,
} from "../server/services/segment-compiler";
import {
  fieldOperatorsV2,
  operatorLabelsV2,
  segmentConditionSchema,
  type SegmentRulesV2,
} from "../shared/schema";

/**
 * Task #214 — segment "engagement" recency field (fixed 60-day window).
 * The operators are unary (no value) and compile to a recency comparison on
 * the maintained `subscribers.last_engaged_at` aggregate.
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

function rulesForValue(operator: string, value: string): SegmentRulesV2 {
  return {
    version: 2,
    root: {
      type: "group",
      combinator: "AND",
      children: [
        { type: "condition", field: "engagement", operator, value, value2: null } as any,
      ],
    },
  };
}

function renderSql(rules: SegmentRulesV2): string {
  return dialect.sqlToQuery(compileSegmentRules(rules)).sql;
}

function renderQuery(rules: SegmentRulesV2): { sql: string; params: unknown[] } {
  const q = dialect.sqlToQuery(compileSegmentRules(rules));
  return { sql: q.sql, params: q.params };
}

describe("Task #214 — engagement recency compiler", () => {
  it("exposes the two engagement operators on the field map with labels", () => {
    // Task #232 added the clicker-tier operators; this test only asserts the
    // original recency pair is (still) present.
    expect(fieldOperatorsV2.engagement).toContain("engaged_recently");
    expect(fieldOperatorsV2.engagement).toContain("not_engaged_recently");
    expect(operatorLabelsV2.engaged_recently).toBeTruthy();
    expect(operatorLabelsV2.not_engaged_recently).toBeTruthy();
  });

  it("uses a fixed 60-day window constant", () => {
    expect(ENGAGEMENT_RECENCY_DAYS).toBe(60);
  });

  it("accepts the unary operators with a null value at the schema level", () => {
    for (const operator of ["engaged_recently", "not_engaged_recently"]) {
      const r = segmentConditionSchema.safeParse({
        type: "condition",
        field: "engagement",
        operator,
        value: null,
        value2: null,
      });
      expect(r.success).toBe(true);
    }
  });

  it("compiles engaged_recently to a >= recency check on last_engaged_at (not FALSE despite empty value)", () => {
    const { sql: s, params } = renderQuery(rulesFor("engaged_recently"));
    expect(s).toContain("last_engaged_at");
    expect(s).toContain(">=");
    expect(s).toContain("INTERVAL '1 day' *");
    expect(params.map(String)).toContain(String(ENGAGEMENT_RECENCY_DAYS));
    expect(s).not.toContain("FALSE");
  });

  it("compiles not_engaged_recently to include NULL and an older-than check", () => {
    const { sql: s, params } = renderQuery(rulesFor("not_engaged_recently"));
    expect(s).toContain("last_engaged_at");
    expect(s).toContain("IS NULL");
    expect(s).toContain("<");
    expect(s).toContain("INTERVAL '1 day' *");
    expect(params.map(String)).toContain(String(ENGAGEMENT_RECENCY_DAYS));
    expect(s).not.toContain("FALSE");
  });

  it("composes with ref + tag rules under AND without emitting FALSE", () => {
    const rules: SegmentRulesV2 = {
      version: 2,
      root: {
        type: "group",
        combinator: "AND",
        children: [
          { type: "condition", field: "refs", operator: "has_ref", value: "E1JT", value2: null } as any,
          { type: "condition", field: "tags", operator: "has_tag", value: "O1JT", value2: null } as any,
          { type: "condition", field: "engagement", operator: "engaged_recently", value: null, value2: null } as any,
        ],
      },
    };
    const s = renderSql(rules);
    expect(s).toContain("last_engaged_at");
    expect(s).not.toContain("FALSE");
  });

  it("exposes a unary condition that excludes every historical bot-IP opener", () => {
    expect(fieldOperatorsV2.engagement).toContain("not_opened_from_bot_ip");
    expect(operatorLabelsV2.not_opened_from_bot_ip).toContain(EXCLUDED_BOT_OPEN_IP);
    expect(segmentConditionSchema.safeParse({
      type: "condition",
      field: "engagement",
      operator: "not_opened_from_bot_ip",
      value: null,
      value2: null,
    }).success).toBe(true);
  });

  it("excludes both open and counting-only complaint events from the fixed IP", () => {
    const { sql: s, params } = renderQuery(rulesFor("not_opened_from_bot_ip"));
    expect(s).toContain("NOT IN");
    expect(s).toContain("campaign_stats");
    expect(s).toContain("ip_address = '195.154.17.225'");
    expect(s).toContain("type IN ('open', 'complaint')");
    expect(s).not.toContain("FALSE");
    expect(params).not.toContain(EXCLUDED_BOT_OPEN_IP);
  });

  it("exposes and validates the unsubscribe campaign-count condition", () => {
    expect(fieldOperatorsV2.engagement).toContain("unsubscribed_from_fewer_campaigns");
    expect(operatorLabelsV2.unsubscribed_from_fewer_campaigns).toContain("fewer than");

    for (const value of ["1", "3", "12"]) {
      expect(segmentConditionSchema.safeParse({
        type: "condition",
        field: "engagement",
        operator: "unsubscribed_from_fewer_campaigns",
        value,
        value2: null,
      }).success).toBe(true);
    }
    for (const value of ["0", "-1", "2.5", "three", "", null]) {
      expect(segmentConditionSchema.safeParse({
        type: "condition",
        field: "engagement",
        operator: "unsubscribed_from_fewer_campaigns",
        value,
        value2: null,
      }).success).toBe(false);
    }
  });

  it("matches subscribers below the distinct unsubscribe-campaign threshold, including zero", () => {
    const { sql: s, params } = renderQuery(
      rulesForValue("unsubscribed_from_fewer_campaigns", "3"),
    );
    expect(s).toContain("NOT IN");
    expect(s).toContain("campaign_stats");
    expect(s).toContain("type = 'unsubscribe'");
    expect(s).toContain("COUNT(DISTINCT cs.campaign_id)");
    expect(s).toContain(">=");
    expect(params.map(Number)).toContain(3);
    expect(s).not.toContain("complaint");
    expect(s).not.toContain("FALSE");
  });

  it("fails closed when an invalid unsubscribe threshold bypasses schema validation", () => {
    for (const value of ["0", "-1", "2.5", "nope"]) {
      expect(renderSql(rulesForValue("unsubscribed_from_fewer_campaigns", value))).toContain("FALSE");
    }
  });

  it("exposes and validates the selected-campaign opener condition", () => {
    const campaignId = "123e4567-e89b-42d3-a456-426614174000";
    expect(fieldOperatorsV2.engagement).toContain("opened_campaign");
    expect(operatorLabelsV2.opened_campaign).toContain("specific campaign");
    expect(segmentConditionSchema.safeParse({
      type: "condition",
      field: "engagement",
      operator: "opened_campaign",
      value: campaignId,
      value2: null,
    }).success).toBe(true);
    expect(segmentConditionSchema.safeParse({
      type: "condition",
      field: "engagement",
      operator: "opened_campaign",
      value: "<invalid>",
      value2: null,
    }).success).toBe(false);
  });

  it("matches unique campaign recipients with a recorded first open", () => {
    const campaignId = "123e4567-e89b-42d3-a456-426614174000";
    const { sql: s, params } = renderQuery(rulesForValue("opened_campaign", campaignId));
    expect(s).toContain("campaign_sends");
    expect(s).toContain("campaign_id");
    expect(s).toContain("first_open_at IS NOT NULL");
    expect(s).not.toContain("campaign_stats");
    expect(params).toContain(campaignId);
    expect(s).not.toContain("FALSE");
  });

  it("fails closed when an invalid campaign ID bypasses schema validation", () => {
    expect(renderSql(rulesForValue("opened_campaign", "<invalid>"))).toContain("FALSE");
  });
});
