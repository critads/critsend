import { sql, type SQL } from "drizzle-orm";
import { subscribers } from "@shared/schema";
import type { SegmentCondition, SegmentGroup, SegmentRulesV2 } from "@shared/schema";
import { logger } from "../logger";

function escapeLikeValue(value: string): string {
  return value.replace(/[%_\\]/g, "\\$&");
}

// Fixed re-engagement window (days) for the "engagement" segment field.
// Single source of truth so the window is trivial to change later.
export const ENGAGEMENT_RECENCY_DAYS = 60;

// Task #232 — clicker-tier thresholds: minimum number of DISTINCT campaigns
// clicked within the 60-day window. "Top" = strictly more than 3 (>= 4),
// "Ultra" = strictly more than 5 (>= 6). Multiple clicks in the same
// campaign count once (COUNT(DISTINCT campaign_id)).
export const TOP_CLICKER_MIN_CAMPAIGNS = 4;
export const ULTRA_CLICKER_MIN_CAMPAIGNS = 6;

function compileCondition(cond: SegmentCondition): SQL {
  const { field, operator, value, value2 } = cond;

  const unaryOps = ["is_empty", "is_not_empty", "has_any_tag", "has_no_tags", "has_any_ref", "has_no_refs", "engaged_recently", "not_engaged_recently", "clicked_recently", "top_active_clicker", "ultra_active_clicker"];
  if (!unaryOps.includes(operator)) {
    if (value === null || value === undefined || (typeof value === "string" && value.trim() === "")) {
      logger.warn("Empty value for non-unary segment operator", { field, operator });
      return sql`FALSE`;
    }
  }
  if (operator === "between" && (!value2 || value2.trim() === "")) {
    logger.warn("Missing value2 for between operator", { field, operator });
    return sql`FALSE`;
  }
  if ((operator === "in_last_days" || operator === "not_in_last_days") && isNaN(Number(value))) {
    logger.warn("Invalid number for days operator", { field, operator, value });
    return sql`FALSE`;
  }

  if (field === "email") {
    const v = String(value);
    switch (operator) {
      case "equals":
        return sql`LOWER(${subscribers.email}) = LOWER(${v})`;
      case "not_equals":
        return sql`LOWER(${subscribers.email}) != LOWER(${v})`;
      case "contains":
        return sql`${subscribers.email} ILIKE ${"%" + escapeLikeValue(v) + "%"}`;
      case "not_contains":
        return sql`${subscribers.email} NOT ILIKE ${"%" + escapeLikeValue(v) + "%"}`;
      case "starts_with":
        return sql`${subscribers.email} ILIKE ${escapeLikeValue(v) + "%"}`;
      case "ends_with":
        return sql`${subscribers.email} ILIKE ${"%" + escapeLikeValue(v)}`;
      case "is_empty":
        return sql`(${subscribers.email} IS NULL OR ${subscribers.email} = '')`;
      case "is_not_empty":
        return sql`(${subscribers.email} IS NOT NULL AND ${subscribers.email} != '')`;
      default:
        logger.warn("Unknown operator for email field", { operator, field });
        return sql`FALSE`;
    }
  }

  if (field === "tags") {
    const v = String(value);
    switch (operator) {
      case "has_tag":
        return sql`${subscribers.tags} @> ARRAY[${v}]::text[]`;
      case "not_has_tag":
        return sql`NOT (${subscribers.tags} @> ARRAY[${v}]::text[])`;
      case "has_any_tag":
        return sql`(${subscribers.tags} IS NOT NULL AND array_length(${subscribers.tags}, 1) > 0)`;
      case "has_no_tags":
        return sql`(${subscribers.tags} IS NULL OR array_length(${subscribers.tags}, 1) IS NULL OR array_length(${subscribers.tags}, 1) = 0)`;
      case "tag_contains":
        return sql`EXISTS (SELECT 1 FROM unnest(${subscribers.tags}) AS t WHERE t ILIKE ${'%' + escapeLikeValue(v) + '%'})`;
      case "tag_not_contains":
        // True when NO tag contains the substring — including subscribers
        // with no tags at all (unnest of NULL/empty yields no rows). The
        // global BCK exclusion is COALESCE'd NULL-safe so NULL-tag rows
        // are not silently dropped by the outer WHERE.
        return sql`NOT EXISTS (SELECT 1 FROM unnest(${subscribers.tags}) AS t WHERE t ILIKE ${'%' + escapeLikeValue(v) + '%'})`;
      default:
        logger.warn("Unknown operator for tags field", { operator, field });
        return sql`FALSE`;
    }
  }

  if (field === "refs") {
    const v = String(value);
    switch (operator) {
      case "has_ref":
        return sql`${v} = ANY(${subscribers.refs})`;
      case "not_has_ref":
        return sql`NOT (${v} = ANY(${subscribers.refs}))`;
      case "has_any_ref":
        return sql`(${subscribers.refs} IS NOT NULL AND array_length(${subscribers.refs}, 1) > 0)`;
      case "has_no_refs":
        return sql`(${subscribers.refs} IS NULL OR array_length(${subscribers.refs}, 1) IS NULL OR array_length(${subscribers.refs}, 1) = 0)`;
      case "ref_contains":
        return sql`EXISTS (SELECT 1 FROM unnest(${subscribers.refs}) AS r WHERE r ILIKE ${'%' + escapeLikeValue(v) + '%'})`;
      default:
        logger.warn("Unknown operator for refs field", { operator, field });
        return sql`FALSE`;
    }
  }

  if (field === "date_added") {
    const v = String(value);
    switch (operator) {
      case "before":
        return sql`${subscribers.importDate} < ${v}::timestamp`;
      case "after":
        return sql`${subscribers.importDate} > ${v}::timestamp`;
      case "between": {
        const v2 = String(value2 ?? value);
        return sql`${subscribers.importDate} BETWEEN ${v}::timestamp AND ${v2}::timestamp`;
      }
      case "in_last_days":
        return sql`${subscribers.importDate} >= NOW() - INTERVAL '1 day' * ${v}::int`;
      case "not_in_last_days":
        return sql`${subscribers.importDate} < NOW() - INTERVAL '1 day' * ${v}::int`;
      default:
        logger.warn("Unknown operator for date_added field", { operator, field });
        return sql`FALSE`;
    }
  }

  if (field === "engagement") {
    // Recency filter on the maintained per-subscriber engagement timestamp
    // (analytics rollup keeps `last_engaged_at` fresh for type IN ('open','click')).
    // Unary operators — the window is fixed, no value input.
    switch (operator) {
      case "engaged_recently":
        return sql`${subscribers.lastEngagedAt} >= NOW() - INTERVAL '1 day' * ${ENGAGEMENT_RECENCY_DAYS}::int`;
      case "not_engaged_recently":
        return sql`(${subscribers.lastEngagedAt} IS NULL OR ${subscribers.lastEngagedAt} < NOW() - INTERVAL '1 day' * ${ENGAGEMENT_RECENCY_DAYS}::int)`;
      // Clicker tiers (Task #232): distinct campaigns clicked in the window.
      // IMPORTANT (perf): use a SEMI-JOIN (IN + GROUP BY/HAVING) — one single
      // index scan over the recent click slice, hashed against subscribers —
      // NOT a correlated per-subscriber subquery, which degenerates into
      // millions of index probes on the multi-GB stats table and made
      // count/preview effectively hang in production. Served by the partial
      // index campaign_stats_click_subscriber_ts_idx (subscriber_id,
      // timestamp, campaign_id) WHERE type='click' — bootstrapped in
      // routes/tracking.ts.
      // Clicked at least once in the window — same semi-join shape as the
      // clicker tiers (served by campaign_stats_click_subscriber_ts_idx),
      // just without the distinct-campaign threshold.
      case "clicked_recently":
        return sql`${subscribers.id} IN (SELECT cs.subscriber_id FROM campaign_stats cs WHERE cs.type = 'click' AND cs.timestamp >= NOW() - INTERVAL '1 day' * ${ENGAGEMENT_RECENCY_DAYS}::int GROUP BY cs.subscriber_id)`;
      case "top_active_clicker":
        return sql`${subscribers.id} IN (SELECT cs.subscriber_id FROM campaign_stats cs WHERE cs.type = 'click' AND cs.timestamp >= NOW() - INTERVAL '1 day' * ${ENGAGEMENT_RECENCY_DAYS}::int GROUP BY cs.subscriber_id HAVING COUNT(DISTINCT cs.campaign_id) >= ${TOP_CLICKER_MIN_CAMPAIGNS})`;
      case "ultra_active_clicker":
        return sql`${subscribers.id} IN (SELECT cs.subscriber_id FROM campaign_stats cs WHERE cs.type = 'click' AND cs.timestamp >= NOW() - INTERVAL '1 day' * ${ENGAGEMENT_RECENCY_DAYS}::int GROUP BY cs.subscriber_id HAVING COUNT(DISTINCT cs.campaign_id) >= ${ULTRA_CLICKER_MIN_CAMPAIGNS})`;
      default:
        logger.warn("Unknown operator for engagement field", { operator, field });
        return sql`FALSE`;
    }
  }

  if (field === "ip_address") {
    const v = String(value);
    switch (operator) {
      case "equals":
        return sql`${subscribers.ipAddress} = ${v}`;
      case "not_equals":
        return sql`${subscribers.ipAddress} != ${v}`;
      case "starts_with":
        return sql`${subscribers.ipAddress} LIKE ${escapeLikeValue(v) + "%"}`;
      case "contains":
        return sql`${subscribers.ipAddress} LIKE ${"%" + escapeLikeValue(v) + "%"}`;
      case "is_empty":
        return sql`(${subscribers.ipAddress} IS NULL OR ${subscribers.ipAddress} = '')`;
      case "is_not_empty":
        return sql`(${subscribers.ipAddress} IS NOT NULL AND ${subscribers.ipAddress} != '')`;
      default:
        logger.warn("Unknown operator for ip_address field", { operator, field });
        return sql`FALSE`;
    }
  }

  logger.warn("Unknown segment condition field", { field });
  return sql`FALSE`;
}

function compileGroup(group: SegmentGroup): SQL {
  if (!group.children || group.children.length === 0) {
    return sql`TRUE`;
  }

  const compiled: SQL[] = [];

  for (const child of group.children) {
    if (child.type === "group") {
      compiled.push(compileGroup(child as SegmentGroup));
    } else {
      compiled.push(compileCondition(child as SegmentCondition));
    }
  }

  if (compiled.length === 0) {
    return sql`TRUE`;
  }

  if (compiled.length === 1) {
    return compiled[0];
  }

  let result = compiled[0];
  for (let i = 1; i < compiled.length; i++) {
    if (group.combinator === "OR") {
      result = sql`(${result} OR ${compiled[i]})`;
    } else {
      result = sql`(${result} AND ${compiled[i]})`;
    }
  }

  return sql`(${result})`;
}

export function compileSegmentRules(rules: SegmentRulesV2): SQL {
  return compileGroup(rules.root);
}

// Suppression guard: excludes subscribers within their cooling-off window
// (duration = UNSUBSCRIBE_COOLING_OFF_DAYS, baked into suppressed_until at
// unsubscribe time; here we only check whether it is still in the future).
const notSuppressed = sql`(suppressed_until IS NULL OR suppressed_until < NOW())`;

export function compileCountQuery(rules: SegmentRulesV2): SQL {
  const where = compileSegmentRules(rules);
  return sql`SELECT count(*) FROM subscribers WHERE ${where} AND NOT COALESCE('BCK' = ANY(tags), false) AND ${notSuppressed}`;
}

export function compilePreviewQuery(rules: SegmentRulesV2, limit: number): SQL {
  const where = compileSegmentRules(rules);
  return sql`SELECT * FROM subscribers WHERE ${where} AND NOT COALESCE('BCK' = ANY(tags), false) AND ${notSuppressed} ORDER BY import_date DESC LIMIT ${limit}`;
}

export function compileCursorQuery(rules: SegmentRulesV2, limit: number, afterId?: string): SQL {
  const where = compileSegmentRules(rules);
  if (afterId) {
    return sql`SELECT * FROM subscribers WHERE ${where} AND NOT COALESCE('BCK' = ANY(tags), false) AND ${notSuppressed} AND id > ${afterId} ORDER BY id ASC LIMIT ${limit}`;
  }
  return sql`SELECT * FROM subscribers WHERE ${where} AND NOT COALESCE('BCK' = ANY(tags), false) AND ${notSuppressed} ORDER BY id ASC LIMIT ${limit}`;
}

export { escapeLikeValue };
