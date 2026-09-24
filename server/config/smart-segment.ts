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
// v2 (task #315): 1 to 3 segments, mandatory « with similar brands » segment
// when similar_refs_* blocks exist.
export const SMART_SEGMENT_PROMPT_VERSION = "smart-segment-v2";
/** Prompt of the « similar brands » web-search lookup; part of the persisted result key. */
export const SMART_SEGMENT_SIMILAR_PROMPT_VERSION = "similar-brands-v1";

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
    /**
     * A dossier built for the same brand / family / MTA / similar refs within
     * this window is copied instead of rebuilt when only the target or the cap
     * changes (« Actualiser » bypasses it). 0 disables the reuse.
     */
    evidenceReuseWindowMs: envInt("SMART_SEGMENT_EVIDENCE_REUSE_WINDOW_MS", 2 * 60 * 60 * 1000, 0, 24 * 60 * 60 * 1000),
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
    /**
     * « Similar brands » lookup (task #315): one synchronous model call with
     * the web search tool, answered inside the wizard request. Kept under the
     * 60 s the production reverse proxy allows for one HTTP request.
     */
    similarAiTimeoutMs: envInt("SMART_SEGMENT_SIMILAR_AI_TIMEOUT_MS", 55_000, 5_000, 55_000),
    /** Web searches the model may run per lookup (each one is billed and takes seconds). */
    similarWebSearchMaxUses: envInt("SMART_SEGMENT_SIMILAR_WEB_SEARCH_MAX_USES", 3, 1, 8),
    /** Persisted lookup results are reused for this many days (« Actualiser » bypasses them). */
    similarCacheDays: envInt("SMART_SEGMENT_SIMILAR_CACHE_DAYS", 30, 1, 365),
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
