// Task #304 — Smart segment (AI-assisted segment proposal) configuration.
//
// Production runs self-hosted under PM2, so the Anthropic credentials are
// plain environment variables (documented in .env.example / DEPLOY.md), never
// a Replit integration. The feature is visible-but-disabled when the key is
// absent; nothing else in the campaign wizard depends on it.
import {
  SMART_SEGMENT_COMPLAINT_HARD_CAP,
  SMART_SEGMENT_COMPLAINT_TARGET,
  SMART_SEGMENT_REUSE_WINDOW_MS,
} from "@shared/smart-segment";

function envInt(name: string, fallback: number, min: number, max = Number.MAX_SAFE_INTEGER): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export const SMART_SEGMENT_DEFAULT_MODEL = "claude-sonnet-4-5";
export const SMART_SEGMENT_PROMPT_VERSION = "smart-segment-v1";

export function getSmartSegmentConfig() {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim() || null;
  const model = process.env.SMART_SEGMENT_MODEL?.trim() || SMART_SEGMENT_DEFAULT_MODEL;
  return {
    apiKey,
    model,
    anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL?.trim() || "https://api.anthropic.com",
    /** Upper bound for one model call (the job retries once, so < half the budget). */
    aiTimeoutMs: envInt("SMART_SEGMENT_AI_TIMEOUT_MS", 60_000, 5_000, 180_000),
    /** Max tokens the model may emit for a proposal. */
    aiMaxTokens: envInt("SMART_SEGMENT_AI_MAX_TOKENS", 4_000, 512, 16_000),
    /** statement_timeout applied to every evidence query (SET LOCAL). */
    queryTimeoutMs: envInt("SMART_SEGMENT_QUERY_TIMEOUT_MS", 30_000, 1_000, 120_000),
    /** Whole evidence phase budget (all queries together). */
    evidenceBudgetMs: envInt("SMART_SEGMENT_EVIDENCE_BUDGET_MS", 240_000, 10_000, 600_000),
    /** Analyses running at the same time across every web instance (DB-enforced). */
    maxConcurrent: envInt("SMART_SEGMENT_MAX_CONCURRENT", 2, 1, 4),
    /** Refuse to start when the main pool is this saturated (matches backgroundQuery's guard). */
    poolSaturationLimit: 0.6,
    reuseWindowMs: SMART_SEGMENT_REUSE_WINDOW_MS,
    complaintHardCap: SMART_SEGMENT_COMPLAINT_HARD_CAP,
    complaintTarget: SMART_SEGMENT_COMPLAINT_TARGET,
    /** Recipients of brand sends newer than this are excluded from proposals. */
    recentBrandSendDays: envInt("SMART_SEGMENT_RECENT_SEND_DAYS", 30, 1, 365),
    /** Sends larger than this are measured on a deterministic 1/k sample. */
    cohortSampleTarget: envInt("SMART_SEGMENT_COHORT_SAMPLE_TARGET", 250_000, 20_000, 5_000_000),
    /** Recency cohorts cost one index probe per recipient: measured on a smaller sample per send. */
    recencySampleTarget: envInt("SMART_SEGMENT_RECENCY_SAMPLE_TARGET", 20_000, 5_000, 500_000),
    /** Fallback pool for the recency cohorts: recent finished sends of every brand. */
    recencyPoolDays: envInt("SMART_SEGMENT_RECENCY_POOL_DAYS", 60, 7, 365),
    recencyPoolMaxCampaigns: envInt("SMART_SEGMENT_RECENCY_POOL_MAX_CAMPAIGNS", 12, 1, 100),
    recencyPoolSampleTarget: envInt("SMART_SEGMENT_RECENCY_POOL_SAMPLE_TARGET", 30_000, 5_000, 500_000),
  };
}

export type SmartSegmentConfig = ReturnType<typeof getSmartSegmentConfig>;

export function smartSegmentFeatureStatus() {
  const config = getSmartSegmentConfig();
  if (!config.apiKey) {
    return {
      configured: false,
      model: null,
      reason: "ANTHROPIC_API_KEY n'est pas défini sur le serveur (voir .env.example : ANTHROPIC_API_KEY, SMART_SEGMENT_MODEL).",
    };
  }
  return { configured: true, model: config.model, reason: null };
}
