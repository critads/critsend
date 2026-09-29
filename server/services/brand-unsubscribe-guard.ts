import { storage } from "../storage";
import { logger } from "../logger";
import {
  extractCampaignBrand,
  historicalBrandKeys,
  resolveHistoricalBrand,
} from "./tag-suggestions";

function envInt(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
}

// Brand-unsubscribe thresholds. Each value is a code default that an
// environment variable of the same name OVERRIDES — on the self-hosted
// deployment the `.env` loaded by PM2 wins over anything changed here, so a
// change of default must be paired with a check of that file (deploy.sh warns
// when `.env` still pins BRAND_UNSUB_WINDOW_DAYS to another value).
//
// The window is counted in Europe/Paris calendar days: the current day plus
// (N - 1) previous days (see countBrandUnsubscribes). 2026-09-20: default
// window reduced to 5 days (was 7 in production via .env, 10 in code) so the
// thresholds reflect more recent pressure.
//
// 2026-09-29: ALERT ONLY. Both thresholds are informational: above
// BRAND_UNSUB_WARN_THRESHOLD the operator is warned, above BRAND_UNSUB_LIMIT
// an alert is shown ("exceeded"). Nothing refuses a launch / resume / retry
// and the sender never pauses a campaign for this reason any more (the
// historical pause_reason 'brand_unsubscribe_limit' only survives on rows
// paused before this change). The variable names are kept so a production
// `.env` that pins them keeps working unchanged.
export const BRAND_UNSUB_LIMIT = envInt("BRAND_UNSUB_LIMIT", 2_500, 0);
export const BRAND_UNSUB_WARN_THRESHOLD = Math.min(
  envInt("BRAND_UNSUB_WARN_THRESHOLD", 1_500, 0),
  BRAND_UNSUB_LIMIT,
);
export const BRAND_UNSUB_WINDOW_DAYS = envInt("BRAND_UNSUB_WINDOW_DAYS", 5, 1);

export type BrandUnsubscribeDecision = {
  brand: string | null;
  brandKey: string | null;
  count: number;
  warnThreshold: number;
  limit: number;
  windowDays: number;
  status: "ok" | "warn" | "exceeded";
};

type BrandUnsubscribeStore = Pick<
  typeof storage,
  "findCampaignBrandAnchor" | "countBrandUnsubscribes"
>;

export function classifyBrandUnsubscribeCount(
  count: number,
  warnThreshold = BRAND_UNSUB_WARN_THRESHOLD,
  limit = BRAND_UNSUB_LIMIT,
): BrandUnsubscribeDecision["status"] {
  if (count > limit) return "exceeded";
  if (count > warnThreshold) return "warn";
  return "ok";
}

export function shouldEvaluateBrandGuardForPatch(
  currentStatus: string,
  nextStatus: string,
  currentName: string,
  nextName: string,
): boolean {
  const nextIsActive = nextStatus === "sending" || nextStatus === "scheduled";
  return nextIsActive && (
    currentStatus !== nextStatus
    || nextName !== currentName
  );
}

export async function evaluateBrandUnsubscribeGuard(
  campaignName: string | null | undefined,
  store: BrandUnsubscribeStore = storage,
): Promise<BrandUnsubscribeDecision> {
  const base = {
    warnThreshold: BRAND_UNSUB_WARN_THRESHOLD,
    limit: BRAND_UNSUB_LIMIT,
    windowDays: BRAND_UNSUB_WINDOW_DAYS,
  };
  const requestedBrand = extractCampaignBrand(campaignName || "");
  if (!requestedBrand) {
    return {
      brand: null,
      brandKey: null,
      count: 0,
      status: "ok",
      ...base,
    };
  }

  const anchorName = await store.findCampaignBrandAnchor(historicalBrandKeys(requestedBrand));
  const resolvedBrand = anchorName
    ? (resolveHistoricalBrand(requestedBrand, [{ name: anchorName }]) ?? requestedBrand)
    : requestedBrand;
  const count = await store.countBrandUnsubscribes(resolvedBrand.key, BRAND_UNSUB_WINDOW_DAYS);
  const status = classifyBrandUnsubscribeCount(count);

  return {
    brand: resolvedBrand.label,
    brandKey: resolvedBrand.key,
    count,
    status,
    ...base,
  };
}

// Non-blocking notice for the activation routes (create as sending/scheduled,
// PATCH to an active status or rename, resume, retry-failed, requeue, send).
// Returns the decision only when there is something to tell the operator
// (warn / exceeded) so the response shape of the common case is unchanged, and
// NEVER throws: an unavailable count must not fail the action it decorates.
// An exceeded brand is logged once per action for the audit trail.
export async function brandUnsubscribeNotice(
  campaignName: string | null | undefined,
  context: { action: string; campaignId?: string | null },
  store: BrandUnsubscribeStore = storage,
): Promise<BrandUnsubscribeDecision | null> {
  try {
    const decision = await evaluateBrandUnsubscribeGuard(campaignName, store);
    if (decision.status === "ok") return null;
    if (decision.status === "exceeded") {
      logger.warn(
        `[BRAND_UNSUB] ${context.action} allowed while brand exceeds the alert threshold: `
        + `campaign=${context.campaignId ?? "new"} brand=${decision.brand} count=${decision.count} `
        + `threshold=${decision.limit} windowDays=${decision.windowDays}`,
      );
    }
    return decision;
  } catch (error) {
    logger.warn(
      `[BRAND_UNSUB] Brand unsubscribe check unavailable during ${context.action} `
      + `(campaign=${context.campaignId ?? "new"}); continuing without notice:`,
      error,
    );
    return null;
  }
}