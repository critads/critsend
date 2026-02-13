import { sql, type SQL } from "drizzle-orm";
import { subscribers } from "@shared/schema";
import type { SegmentCondition, SegmentGroup, SegmentRulesV2 } from "@shared/schema";
import { logger } from "../logger";

function escapeLikeValue(value: string): string {
  return value.replace(/[%_\\]/g, "\\$&");
}

function compileCondition(cond: SegmentCondition): SQL {
  const { field, operator, value, value2 } = cond;

  const unaryOps = ["is_empty", "is_not_empty", "has_any_tag", "has_no_tags"];
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
      default:
        logger.warn("Unknown operator for tags field", { operator, field });
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

export function compileCountQuery(rules: SegmentRulesV2): SQL {
  const where = compileSegmentRules(rules);
  return sql`SELECT count(*) FROM subscribers WHERE ${where} AND NOT ('BCK' = ANY(tags))`;
}

export function compilePreviewQuery(rules: SegmentRulesV2, limit: number): SQL {
  const where = compileSegmentRules(rules);
  return sql`SELECT * FROM subscribers WHERE ${where} AND NOT ('BCK' = ANY(tags)) ORDER BY import_date DESC LIMIT ${limit}`;
}

export function compileCursorQuery(rules: SegmentRulesV2, limit: number, afterId?: string): SQL {
  const where = compileSegmentRules(rules);
  if (afterId) {
    return sql`SELECT * FROM subscribers WHERE ${where} AND NOT ('BCK' = ANY(tags)) AND id > ${afterId} ORDER BY id ASC LIMIT ${limit}`;
  }
  return sql`SELECT * FROM subscribers WHERE ${where} AND NOT ('BCK' = ANY(tags)) ORDER BY id ASC LIMIT ${limit}`;
}

export { escapeLikeValue };
