import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  compileSegmentRules,
  ENGAGEMENT_RECENCY_DAYS,
  EXCLUDED_BOT_OPEN_IP,
  TOP_CLICKER_MIN_CAMPAIGNS,
  ULTRA_CLICKER_MIN_CAMPAIGNS,
} from "../server/services/segment-compiler";
import { COMPLAINT_IP } from "../server/config/suppression";
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

  describe("bot-attributed clicks are ignored by the click-based operators", () => {
    const clickOperators = ["clicked_recently", "top_active_clicker", "ultra_active_clicker"] as const;

    it("keeps the single-source complaint IP literal in sync with the suppression config", () => {
      expect(EXCLUDED_BOT_OPEN_IP).toBe(COMPLAINT_IP);
      expect(EXCLUDED_BOT_OPEN_IP).toBe("195.154.17.225");
    });

    it.each(clickOperators)("%s keeps the bounded click semi-join AND excludes complaint-IP-detected subscribers", (operator) => {
      const { sql: s, params } = renderQuery(rulesFor(operator));
      // Click semi-join, unchanged: single window-bounded scan grouped by subscriber.
      expect(s).toContain("IN (SELECT cs.subscriber_id FROM campaign_stats cs WHERE cs.type = 'click'");
      expect(s).toContain("INTERVAL '1 day' *");
      expect(params.map(String)).toContain(String(ENGAGEMENT_RECENCY_DAYS));
      // Subscriber-level anti-join on the exact partial-index predicate, as a
      // literal (never a bind parameter) so PostgreSQL can match the index.
      expect(s).toContain("NOT EXISTS");
      expect(s).toContain("bot.subscriber_id = \"subscribers\".\"id\"");
      expect(s).toContain("bot.ip_address = '195.154.17.225'");
      expect(s).toContain("bot.type IN ('open', 'complaint')");
      expect(params).not.toContain(EXCLUDED_BOT_OPEN_IP);
      // No per-click ip_address filter inside the click semi-join (it would
      // force heap fetches on the multi-GB stats table and remove nothing).
      expect(s).not.toMatch(/cs\.ip_address/);
      // Combined with AND and parenthesised so it composes inside OR groups.
      expect(s).toMatch(/^\(.*\) AND NOT EXISTS \(/s);
      expect(s.trim().endsWith(")")).toBe(true);
      expect(s).not.toContain("FALSE");
    });

    it("keeps the distinct-campaign thresholds on the tiers", () => {
      const top = renderQuery(rulesFor("top_active_clicker"));
      const ultra = renderQuery(rulesFor("ultra_active_clicker"));
      expect(top.sql).toContain("HAVING COUNT(DISTINCT cs.campaign_id) >=");
      expect(ultra.sql).toContain("HAVING COUNT(DISTINCT cs.campaign_id) >=");
      expect(top.params.map(Number)).toContain(TOP_CLICKER_MIN_CAMPAIGNS);
      expect(ultra.params.map(Number)).toContain(ULTRA_CLICKER_MIN_CAMPAIGNS);
      expect(renderSql(rulesFor("clicked_recently"))).not.toContain("HAVING");
    });

    it("labels tell the operator that complaint-IP bot subscribers are ignored", () => {
      for (const operator of clickOperators) {
        expect(operatorLabelsV2[operator]).toMatch(/bot subscribers ignored/i);
      }
      // Unchanged neighbours.
      expect(operatorLabelsV2.not_opened_from_bot_ip).toBe("never opened from IP 195.154.17.225");
      expect(operatorLabelsV2.engaged_recently).toBe("opened/clicked in last 60 days");
    });

    it("still composes with an explicit not_opened_from_bot_ip condition (same audience as before)", () => {
      const rules: SegmentRulesV2 = {
        version: 2,
        root: {
          type: "group",
          combinator: "AND",
          children: [
            { type: "condition", field: "engagement", operator: "clicked_recently", value: null, value2: null } as any,
            { type: "condition", field: "engagement", operator: "not_opened_from_bot_ip", value: null, value2: null } as any,
          ],
        },
      };
      const { sql: s, params } = renderQuery(rules);
      expect(s).toContain("NOT EXISTS");
      expect(s).toContain("NOT IN");
      expect(s.match(/ip_address = '195\.154\.17\.225'/g)).toHaveLength(2);
      expect(params).not.toContain(EXCLUDED_BOT_OPEN_IP);
      expect(s).not.toContain("FALSE");
    });

    it("composes inside an OR group without leaking the anti-join onto the sibling branch", () => {
      const rules: SegmentRulesV2 = {
        version: 2,
        root: {
          type: "group",
          combinator: "OR",
          children: [
            { type: "condition", field: "engagement", operator: "clicked_recently", value: null, value2: null } as any,
            { type: "condition", field: "refs", operator: "has_ref", value: "E1JT", value2: null } as any,
          ],
        },
      };
      const s = renderSql(rules);
      // The click operator is a single parenthesised term of the OR.
      expect(s).toMatch(/\(\("subscribers"\."id" IN \(SELECT cs\.subscriber_id[\s\S]*\) AND NOT EXISTS \([\s\S]*\)\) OR /);
      expect(s).not.toContain("FALSE");
    });

    it("segment builder shows the bot-click hint for exactly the three click operators", () => {
      const builderSource = readFileSync(
        new URL("../client/src/components/segment-builder.tsx", import.meta.url),
        "utf8",
      );
      const start = builderSource.indexOf("const isBotFilteredClickOperator =");
      expect(start).toBeGreaterThanOrEqual(0);
      const declaration = builderSource.slice(start, builderSource.indexOf(";", start));
      for (const operator of clickOperators) {
        expect(declaration).toContain(`"${operator}"`);
      }
      expect(declaration).not.toContain("not_opened_from_bot_ip");
      expect(declaration).not.toContain("engaged_recently");
      expect(builderSource).toContain("isBotFilteredClickOperator && (");
      expect(builderSource).toContain(`detected by the complaint IP ${EXCLUDED_BOT_OPEN_IP} are not counted`);
    });

    it("leaves the open-based and campaign-specific operators untouched", () => {
      for (const operator of ["engaged_recently", "not_engaged_recently"]) {
        expect(renderSql(rulesFor(operator))).not.toContain("NOT EXISTS");
      }
      const campaignId = "123e4567-e89b-42d3-a456-426614174000";
      for (const operator of ["opened_campaign", "clicked_campaign"]) {
        expect(renderSql(rulesForValue(operator, campaignId))).not.toContain("NOT EXISTS");
      }
    });
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

  it("exposes and validates the selected-campaign clicker condition", () => {
    const campaignId = "123e4567-e89b-42d3-a456-426614174000";
    expect(fieldOperatorsV2.engagement).toContain("clicked_campaign");
    expect(operatorLabelsV2.clicked_campaign).toBe("Clicked a specific campaign");
    expect(segmentConditionSchema.safeParse({
      type: "condition",
      field: "engagement",
      operator: "clicked_campaign",
      value: campaignId,
      value2: null,
    }).success).toBe(true);
    expect(segmentConditionSchema.safeParse({
      type: "condition",
      field: "engagement",
      operator: "clicked_campaign",
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

  it("matches unique campaign recipients with a recorded first click", () => {
    const campaignId = "123e4567-e89b-42d3-a456-426614174000";
    const { sql: s, params } = renderQuery(rulesForValue("clicked_campaign", campaignId));
    expect(s).toContain("campaign_sends");
    expect(s).toContain("campaign_id");
    expect(s).toContain("first_click_at IS NOT NULL");
    expect(s).not.toContain("campaign_stats");
    expect(params).toContain(campaignId);
    expect(s).not.toContain("FALSE");
  });

  it("fails closed when an invalid campaign ID bypasses schema validation", () => {
    expect(renderSql(rulesForValue("opened_campaign", "<invalid>"))).toContain("FALSE");
    expect(renderSql(rulesForValue("clicked_campaign", "<invalid>"))).toContain("FALSE");
  });
});
