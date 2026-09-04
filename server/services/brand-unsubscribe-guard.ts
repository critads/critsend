import { storage } from "../storage";
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

export const BRAND_UNSUB_LIMIT = envInt("BRAND_UNSUB_LIMIT", 2_000, 0);
export const BRAND_UNSUB_WARN_THRESHOLD = Math.min(
  envInt("BRAND_UNSUB_WARN_THRESHOLD", 1_500, 0),
  BRAND_UNSUB_LIMIT,
);
export const BRAND_UNSUB_WINDOW_DAYS = envInt("BRAND_UNSUB_WINDOW_DAYS", 10, 1);

export type BrandUnsubscribeDecision = {
  brand: string | null;
  brandKey: string | null;
  count: number;
  warnThreshold: number;
  limit: number;
  windowDays: number;
  status: "ok" | "warn" | "blocked";
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
  if (count > limit) return "blocked";
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

export function brandUnsubscribeBlockPayload(decision: BrandUnsubscribeDecision) {
  return {
    error: `La marque ${decision.brand} a dépassé la limite de désabonnements`,
    code: "BRAND_UNSUB_LIMIT_EXCEEDED",
    brandGuard: decision,
  };
}