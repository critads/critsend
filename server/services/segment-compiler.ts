import { sql, type SQL } from "drizzle-orm";
import { subscribers } from "@shared/schema";
import type { SegmentCondition, SegmentGroup, SegmentRulesV2, SegmentSimilarity } from "@shared/schema";
import { COMPLAINT_IP } from "../config/suppression";
import { logger } from "../logger";

export class SimilaritySnapshotMismatchError extends Error {
  constructor(message = "Campaign similarity snapshot no longer matches the segment structure") {
    super(message);
    this.name = "SimilaritySnapshotMismatchError";
  }
}

function escapeLikeValue(value: string): string {
  return value.replace(/[%_\\]/g, "\\$&");
}

// Fixed re-engagement window (days) for the "engagement" segment field.
// Single source of truth so the window is trivial to change later.
export const ENGAGEMENT_RECENCY_DAYS = 60;
// Outer bound of the « lapsed » band (61–180 days without open/click); beyond
// it a subscriber is « dormant ». Shared by the smart-segment recency blocks.
export const ENGAGEMENT_LAPSED_DAYS = 180;

// Task #232 — clicker-tier thresholds: minimum number of DISTINCT campaigns
// clicked within the 60-day window. "Top" = strictly more than 3 (>= 4),
// "Ultra" = strictly more than 5 (>= 6). Multiple clicks in the same
// campaign count once (COUNT(DISTINCT campaign_id)).
export const TOP_CLICKER_MIN_CAMPAIGNS = 4;
export const ULTRA_CLICKER_MIN_CAMPAIGNS = 6;

// The fixed complaint-detection IP (single source of truth: config/suppression).
// It is rendered as a SQL *literal* — never a bind parameter — because the two
// partial indexes that serve the exclusion below
// (campaign_stats_bot_open_subscriber_idx and
// campaign_stats_complaint_ip_timestamp_subscriber_idx) are defined with the
// exact predicate `ip_address = '195.154.17.225' AND type IN ('open','complaint')`
// and PostgreSQL only picks a partial index when the query predicate matches
// it textually. If the IP ever changes, those index predicates (shared/schema.ts
// + the bootstrap DDL in routes/tracking.ts) must change in lockstep.
export const EXCLUDED_BOT_OPEN_IP = COMPLAINT_IP;
if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(EXCLUDED_BOT_OPEN_IP)) {
  // Defensive: the literal is inlined into SQL below, so it must be a plain IPv4.
  throw new Error(`Invalid COMPLAINT_IP literal for segment compiler: ${EXCLUDED_BOT_OPEN_IP}`);
}
const botOpenIpLiteral = sql.raw(`'${EXCLUDED_BOT_OPEN_IP}'`);

/**
 * Subscribers detected by the complaint IP: any open or counting-only complaint
 * row recorded from that IP, at any time. Same population as the
 * `not_opened_from_bot_ip` operator.
 */
function botDetectedSubscriberIds(): SQL {
  return sql`SELECT cs.subscriber_id
          FROM campaign_stats cs
          WHERE cs.ip_address = ${botOpenIpLiteral}
            AND cs.type IN ('open', 'complaint')`;
}

/**
 * Bot-attributed clicks are ignored by every click-based engagement operator.
 *
 * Production finding (2026-09-17): the Orange/Wanadoo scanning infrastructure
 * never clicks from the complaint IP — its clicks arrive from hundreds of
 * rotating cloud IPs with realistic user agents, hours after delivery — so a
 * per-click ip_address/latency filter would remove nothing (and would force
 * heap fetches on millions of click rows, since the click partial index does
 * not cover ip_address). The only reliable marker is subscriber-level: on the
 * 2026-09-12 send, 100% of Orange/Wanadoo clickers were complaint-IP-detected
 * subscribers and the ~93K non-detected ones produced 0 clicks. A "bot click"
 * is therefore any click by a subscriber with at least one complaint-IP
 * detection.
 *
 * Shape (perf): NOT EXISTS, planned as a hash anti-join fed by an index-only
 * scan of the complaint-IP partial index. Deliberately NOT `NOT IN (subquery)`:
 * that form only stays fast while the subquery result fits in work_mem as a
 * hashed SubPlan and silently degrades to a per-row scan beyond that — a cliff
 * the click operators must not sit on, since the detection set keeps growing.
 */
function notBotDetected(): SQL {
  return sql`NOT EXISTS (
          SELECT 1
          FROM campaign_stats bot
          WHERE bot.subscriber_id = ${subscribers.id}
            AND bot.ip_address = ${botOpenIpLiteral}
            AND bot.type IN ('open', 'complaint')
        )`;
}


const CAMPAIGN_ID_PATTERN = /^[A-Za-z0-9_-]{1,255}$/;
export const MAX_NOT_RECEIVED_CAMPAIGN_IDS = 50;

/** Normalises a campaign id or id list; null when anything is malformed. */
function campaignIdList(value: unknown): string[] | null {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? [value] : null;
  if (!raw || raw.length === 0 || raw.length > MAX_NOT_RECEIVED_CAMPAIGN_IDS) return null;
  const ids = [...new Set(raw.map((entry) => String(entry).trim()))];
  return ids.every((id) => CAMPAIGN_ID_PATTERN.test(id)) ? ids : null;
}

function compileCondition(cond: SegmentCondition): SQL {
  const { field, operator, value, value2 } = cond;

  const unaryOps = ["is_empty", "is_not_empty", "has_any_tag", "has_no_tags", "has_any_ref", "has_no_refs", "engaged_recently", "not_engaged_recently", "engaged_lapsed", "dormant", "clicked_recently", "top_active_clicker", "ultra_active_clicker", "not_opened_from_bot_ip"];
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
  if (
    operator === "unsubscribed_from_fewer_campaigns" &&
    (!Number.isInteger(Number(value)) || Number(value) < 1)
  ) {
    logger.warn("Invalid unsubscribe campaign count threshold", { field, operator, value });
    return sql`FALSE`;
  }
  if (
    (operator === "opened_campaign" || operator === "clicked_campaign") &&
    (typeof value !== "string" || !CAMPAIGN_ID_PATTERN.test(value))
  ) {
    logger.warn("Invalid campaign ID for campaign engagement segment", { field, operator });
    return sql`FALSE`;
  }
  // not_received_campaign accepts one id or a bounded list (Smart segment
  // excludes every recent send of a brand with a single anti-join).
  const notReceivedIds = operator === "not_received_campaign" ? campaignIdList(value) : null;
  if (operator === "not_received_campaign" && !notReceivedIds) {
    logger.warn("Invalid campaign ID list for not_received_campaign", { field, operator });
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
      // Recency bands used by the smart-segment « non-active » blocks: lapsed =
      // last open/click between 61 and 180 days ago; dormant = none in 180 days
      // (or never). The three bands (recent / lapsed / dormant) partition the base.
      case "engaged_lapsed":
        return sql`(${subscribers.lastEngagedAt} < NOW() - INTERVAL '1 day' * ${ENGAGEMENT_RECENCY_DAYS}::int AND ${subscribers.lastEngagedAt} >= NOW() - INTERVAL '1 day' * ${ENGAGEMENT_LAPSED_DAYS}::int)`;
      case "dormant":
        return sql`(${subscribers.lastEngagedAt} IS NULL OR ${subscribers.lastEngagedAt} < NOW() - INTERVAL '1 day' * ${ENGAGEMENT_LAPSED_DAYS}::int)`;
      // Clicker tiers (Task #232): distinct campaigns clicked in the window.
      // IMPORTANT (perf): use a SEMI-JOIN (IN + GROUP BY/HAVING) — one single
      // index scan over the recent click slice, hashed against subscribers —
      // NOT a correlated per-subscriber subquery, which degenerates into
      // millions of index probes on the multi-GB stats table and made
      // count/preview effectively hang in production.
      //
      // Index selection: the timestamp-first partial index
      // campaign_stats_click_ts_subscriber_campaign_idx
      // (timestamp, subscriber_id, campaign_id) WHERE type='click'
      // lets PostgreSQL bound the scan to the 60-day window immediately via
      // a range scan on the leading timestamp column, then covers
      // subscriber_id and campaign_id without a heap fetch.  The older
      // subscriber-first index campaign_stats_click_subscriber_ts_idx
      // (subscriber_id, timestamp, campaign_id) WHERE type='click' is kept
      // for queries that probe by subscriber first (e.g. per-subscriber
      // click-history lookups). Both are bootstrapped in routes/tracking.ts.
      //
      // All three click operators additionally ignore bot-attributed clicks
      // (see notBotDetected): the click semi-join is untouched and the
      // complaint-IP-detected subscribers are removed with a subscriber-level
      // anti-join, combined with AND. The whole expression is parenthesised
      // so it composes safely inside OR groups.
      //
      // Clicked at least once in the window — same semi-join shape as the
      // clicker tiers (served by campaign_stats_click_subscriber_ts_idx),
      // just without the distinct-campaign threshold.
      case "clicked_recently":
        return sql`(${subscribers.id} IN (SELECT cs.subscriber_id FROM campaign_stats cs WHERE cs.type = 'click' AND cs.timestamp >= NOW() - INTERVAL '1 day' * ${ENGAGEMENT_RECENCY_DAYS}::int GROUP BY cs.subscriber_id) AND ${notBotDetected()})`;
      case "opened_campaign":
        return sql`${subscribers.id} IN (
          SELECT cs.subscriber_id
          FROM campaign_sends cs
          WHERE cs.campaign_id = ${String(value)}
            AND cs.first_open_at IS NOT NULL
        )`;
      case "clicked_campaign":
        return sql`${subscribers.id} IN (
          SELECT cs.subscriber_id
          FROM campaign_sends cs
          WHERE cs.campaign_id = ${String(value)}
            AND cs.first_click_at IS NOT NULL
        )`;
      case "not_received_campaign":
        // Excludes every recipient of a previous send (Task #304). Any
        // campaign_sends row counts as "received" — including failed/pending
        // reservations — so a resumed or retried send never re-solicits the
        // same mailbox. NOT EXISTS is a hash anti-join served by the unique
        // (campaign_id, subscriber_id) index; campaign_sends.subscriber_id is
        // NOT NULL so no NULL-safety wrapper is needed.
        return notReceivedIds!.length === 1
          ? sql`NOT EXISTS (
              SELECT 1
              FROM campaign_sends cs
              WHERE cs.campaign_id = ${notReceivedIds![0]}
                AND cs.subscriber_id = ${subscribers.id}
            )`
          : sql`NOT EXISTS (
              SELECT 1
              FROM campaign_sends cs
              WHERE cs.campaign_id = ANY(${sql.param(notReceivedIds)}::text[])
                AND cs.subscriber_id = ${subscribers.id}
            )`;
      case "top_active_clicker":
        return sql`(${subscribers.id} IN (SELECT cs.subscriber_id FROM campaign_stats cs WHERE cs.type = 'click' AND cs.timestamp >= NOW() - INTERVAL '1 day' * ${ENGAGEMENT_RECENCY_DAYS}::int GROUP BY cs.subscriber_id HAVING COUNT(DISTINCT cs.campaign_id) >= ${TOP_CLICKER_MIN_CAMPAIGNS}) AND ${notBotDetected()})`;
      case "ultra_active_clicker":
        return sql`(${subscribers.id} IN (SELECT cs.subscriber_id FROM campaign_stats cs WHERE cs.type = 'click' AND cs.timestamp >= NOW() - INTERVAL '1 day' * ${ENGAGEMENT_RECENCY_DAYS}::int GROUP BY cs.subscriber_id HAVING COUNT(DISTINCT cs.campaign_id) >= ${ULTRA_CLICKER_MIN_CAMPAIGNS}) AND ${notBotDetected()})`;
      case "not_opened_from_bot_ip":
        // Opens from this robot IP are stored either as normal opens or as
        // counting-only complaints. Keep the IP as a SQL literal so PostgreSQL
        // can use campaign_stats_bot_open_subscriber_idx's exact predicate.
        // (campaign_stats.subscriber_id is NOT NULL, so NOT IN is NULL-safe.)
        return sql`${subscribers.id} NOT IN (
          ${botDetectedSubscriberIds()}
        )`;
      case "unsubscribed_from_fewer_campaigns": {
        const threshold = Number(value);
        // NOT IN includes subscribers with no unsubscribe rows. The partial
        // covering index serves the grouped distinct-campaign threshold.
        return sql`${subscribers.id} NOT IN (
          SELECT cs.subscriber_id
          FROM campaign_stats cs
          WHERE cs.type = 'unsubscribe'
          GROUP BY cs.subscriber_id
          HAVING COUNT(DISTINCT cs.campaign_id) >= ${threshold}
        )`;
      }
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

function compileSimilarity(rule: SegmentSimilarity, frozen?: SegmentSimilarity[]): SQL {
  // Once a campaign supplies a snapshot, that snapshot is authoritative. An
  // explicit empty snapshot or a missing/replaced ruleId must never fall back
  // to the current segment rule.
  const resolved = frozen === undefined
    ? rule
    : frozen.find((item) => item.ruleId === rule.ruleId);
  if (!resolved && frozen !== undefined) throw new SimilaritySnapshotMismatchError();
  if (!resolved || !resolved.resolvedRefs.length) return sql`FALSE`;
  // Array operators are exact-case, matching existing has_ref behavior and the
  // analysis query. The source exclusion is inseparable from this block.
  return sql`(
    ${subscribers.refs} && ${sql.param(resolved.resolvedRefs)}::text[]
    AND NOT (${resolved.sourceRef} = ANY(${subscribers.refs}))
  )`;
}

function compileGroup(group: SegmentGroup, frozen?: SegmentSimilarity[]): SQL {
  if (!group.children || group.children.length === 0) {
    return sql`TRUE`;
  }

  const compiled: SQL[] = [];

  for (const child of group.children) {
    if (child.type === "group") {
      compiled.push(compileGroup(child as SegmentGroup, frozen));
    } else if (child.type === "similarity") {
      compiled.push(compileSimilarity(child as SegmentSimilarity, frozen));
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

function collectSimilarityRuleIds(group: SegmentGroup, output: string[]): void {
  for (const child of group.children) {
    if (child.type === "group") collectSimilarityRuleIds(child, output);
    else if (child.type === "similarity") output.push(child.ruleId);
  }
}

export function compileSegmentRules(rules: SegmentRulesV2, frozenSimilarity?: SegmentSimilarity[]): SQL {
  if (frozenSimilarity !== undefined) {
    const liveRuleIds: string[] = [];
    collectSimilarityRuleIds(rules.root, liveRuleIds);
    const frozenRuleIds = frozenSimilarity.map((rule) => rule.ruleId);
    if (
      liveRuleIds.length !== frozenRuleIds.length
      || new Set(liveRuleIds).size !== liveRuleIds.length
      || new Set(frozenRuleIds).size !== frozenRuleIds.length
      || liveRuleIds.some((ruleId) => !frozenRuleIds.includes(ruleId))
    ) {
      throw new SimilaritySnapshotMismatchError();
    }
  }
  return compileGroup(rules.root, frozenSimilarity);
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
