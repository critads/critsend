// Task #304 — step 3: deterministic evidence engine.
//
// Produces the compact, versioned dossier the model reasons over: the brand's
// last finished sends, human CTR / complaint rate per cohort measured on the
// last 2–3 finished sends (fallback: same vertical, then all brands), and the
// size of every reservoir block after the mandatory exclusions. Everything
// runs in ONE read-only REPEATABLE READ transaction with a per-statement
// timeout and a global budget, and refuses to start when the main pool is
// saturated. The model never sees or writes SQL.
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { PoolClient } from "pg";
import { pool, getPoolSaturation } from "../db";
import { logger } from "../logger";
import type { SegmentGroup, SegmentRulesV2 } from "@shared/schema";
import {
  DOMAIN_FAMILIES,
  type CalibrationLevel,
  type DomainFamilyId,
  type SmartSegmentBaselines,
  type SmartSegmentBlock,
  type SmartSegmentBrandResolution,
  type SmartSegmentBrandSend,
  type SmartSegmentComplaintFloor,
  type SmartSegmentEvidence,
  type SmartSegmentMtaComplaintCapture,
  type SmartSegmentMtaEvidence,
  type SmartSegmentStage,
  type RecencyBand,
  NON_ACTIVE_RECENCY_BANDS,
  ORANGE_WANADOO_COHORT,
  RECENCY_BAND_LABELS,
  SMART_SEGMENT_MAX_RECENT_SEND_EXCLUSIONS,
  SMART_SEGMENT_MTA_CAPTURE_LABELS,
} from "@shared/smart-segment";
import { ORANGE_WANADOO_RISK_POLICY } from "../config/orange-wanadoo-risk";
import { compileCountQuery, compileSegmentRules, ENGAGEMENT_LAPSED_DAYS, ENGAGEMENT_RECENCY_DAYS, EXCLUDED_BOT_OPEN_IP } from "./segment-compiler";
import { getSegmentPerformanceHistoryCandidates } from "../repositories/campaign-repository";
import {
  campaignMatchesBrand,
  extractCampaignBrand,
  historicalBrandKeys,
  type CampaignBrand,
} from "./tag-suggestions";
import { getSmartSegmentConfig, type SmartSegmentConfig } from "../config/smart-segment";
import {
  aggregateCohortRates,
  buildBlockLibrary,
  classifyMtaComplaintCapture,
  group,
  mandatoryExclusions,
  MIN_RELIABLE_COHORT_DELIVERED,
  projectBlock,
  rateFor,
  recencyRateFor,
  ruleOfThreeRate,
  sampleDivisorFor,
  splitProjectableBlocks,
  type AudienceMeasure,
  type ClickerTier,
  type RawCohortRow,
  type TierCounts,
} from "./smart-segment-projection";

export class SmartSegmentError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 500) {
    super(message);
    this.name = "SmartSegmentError";
  }
}

const dialect = new PgDialect();
const MAX_BRAND_SENDS = 6;
const MAX_CALIBRATION_SENDS = 3;
const MIN_CALIBRATION_DELIVERED = 5_000;
const FINISHED_TOLERANCE_ABS = 5;
const FINISHED_TOLERANCE_REL = 0.002;

if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(EXCLUDED_BOT_OPEN_IP)) {
  throw new Error(`Invalid complaint IP literal for the smart segment evidence engine: ${EXCLUDED_BOT_OPEN_IP}`);
}
const BOT_IP = `'${EXCLUDED_BOT_OPEN_IP}'`;
/** Orange/Wanadoo domains (policy constants), as a bound array and as a literal list for the compiled-rules statements. */
export const ORANGE_WANADOO_DOMAINS: string[] = [...ORANGE_WANADOO_RISK_POLICY.domains];
for (const domain of ORANGE_WANADOO_DOMAINS) {
  if (!/^[a-z0-9.-]+$/.test(domain)) throw new Error(`Invalid Orange/Wanadoo domain literal for the smart segment evidence engine: ${domain}`);
}
const ORANGE_WANADOO_DOMAIN_LITERALS = ORANGE_WANADOO_DOMAINS.map((domain) => `'${domain}'`).join(", ");
/** Window of the per-MTA complaint-capture check (all brands). */
const MTA_CAPTURE_WINDOW_DAYS = 90;
/** Window of the baseline floor candidates (sends on complaint-capturing MTAs). */
const COMPLAINT_FLOOR_WINDOW_DAYS = 180;
const COMPLAINT_FLOOR_MAX_SENDS = 8;
/** Brand history candidates classified by MTA before the history cap applies (cheap PK lookup). */
const BRAND_CANDIDATE_LOOKAHEAD = 40;

export type EvidenceQueryRunner = {
  query<T extends Record<string, unknown> = Record<string, unknown>>(label: string, text: string, params?: unknown[]): Promise<T[]>;
  queryCount(label: string, statement: SQL): Promise<number>;
  elapsedMs(): number;
  queries(): number;
};

type ProgressFn = (stage: SmartSegmentStage, progress: number) => Promise<void> | void;

export type EvidenceInput = {
  campaignName: string;
  excludeCampaignId: string | null;
  brand: SmartSegmentBrandResolution;
  family: DomainFamilyId;
  /** MTA the campaign will be sent from (calibration prefers sends whose MTA captures complaints, same MTA first). */
  mtaId?: string | null;
};

/** Considered finished once the delivery counter has rejoined the send rows. */
export function isFinishedSend(status: string, sentCount: number, deliveredRows: number): boolean {
  if (!["completed", "sent"].includes(status)) return false;
  if (deliveredRows <= 0) return false;
  const tolerance = Math.max(FINISHED_TOLERANCE_ABS, Math.round(deliveredRows * FINISHED_TOLERANCE_REL));
  return Math.abs(sentCount - deliveredRows) <= tolerance;
}

type CampaignStatsRow = {
  id: string;
  name: string;
  status: string;
  first_send_at: Date | string;
  sent_count: string;
  complaints_count: string;
  unsubscribes_count: string;
  delivered_rows: string;
  clickers: string;
  bot_clickers: string;
  /** Absent on fixtures written before MTA-aware calibration. */
  mta_id?: string | null;
  mta_name?: string | null;
};

/** Complaint capture of every MTA seen in the last 90 days, keyed by MTA id. */
export type MtaCaptureMap = Map<string, { name: string | null; capture: SmartSegmentMtaComplaintCapture; delivered: number; complaints: number }>;

export function mtaCaptureOf(captures: MtaCaptureMap, mtaId: string | null | undefined): SmartSegmentMtaComplaintCapture {
  if (!mtaId) return "unknown";
  return captures.get(mtaId)?.capture ?? "unknown";
}

function toBrandSend(row: CampaignStatsRow, segmentNames: string[], captures: MtaCaptureMap): SmartSegmentBrandSend {
  const delivered = Number(row.sent_count) || 0;
  const deliveredRows = Number(row.delivered_rows) || 0;
  const clickers = Number(row.clickers) || 0;
  const botClickers = Number(row.bot_clickers) || 0;
  const humanClickers = Math.max(0, clickers - botClickers);
  const complaints = Number(row.complaints_count) || 0;
  const mtaId = row.mta_id ?? null;
  return {
    campaignId: row.id,
    name: row.name,
    firstSendAt: new Date(row.first_send_at).toISOString(),
    delivered,
    segmentNames,
    humanClickers,
    botClickers,
    complaints,
    unsubscribes: Number(row.unsubscribes_count) || 0,
    humanCtr: delivered > 0 ? humanClickers / delivered : 0,
    complaintRate: delivered > 0 ? complaints / delivered : 0,
    finished: isFinishedSend(row.status, delivered, deliveredRows),
    usedForCalibration: false,
    mtaId,
    mtaName: row.mta_name ?? captures.get(mtaId ?? "")?.name ?? null,
    mtaComplaintCapture: mtaCaptureOf(captures, mtaId),
  };
}

const CAMPAIGN_STATS_SQL = `
  SELECT c.id, c.name, c.status, c.first_send_at, c.mta_id, m.name AS mta_name,
         c.sent_count::text AS sent_count,
         c.complaints_count::text AS complaints_count,
         c.unsubscribes_count::text AS unsubscribes_count,
         (SELECT COUNT(*) FROM campaign_sends cs WHERE cs.campaign_id = c.id AND cs.status = 'sent')::text AS delivered_rows,
         (SELECT COUNT(*) FROM campaign_sends cs WHERE cs.campaign_id = c.id AND cs.first_click_at IS NOT NULL)::text AS clickers,
         (SELECT COUNT(*) FROM campaign_sends cs
           WHERE cs.campaign_id = c.id AND cs.first_click_at IS NOT NULL
             AND EXISTS (SELECT 1 FROM campaign_stats bot
                          WHERE bot.subscriber_id = cs.subscriber_id
                            AND bot.ip_address = ${BOT_IP}
                            AND bot.type IN ('open', 'complaint')))::text AS bot_clickers
    FROM campaigns c
    LEFT JOIN mtas m ON m.id = c.mta_id
   WHERE c.id = ANY($1::text[])
   ORDER BY c.first_send_at DESC, c.id ASC`;

/**
 * Complaint capture per MTA over the last N days, every brand, cached campaign
 * counters only (no campaign_sends scan). Params: $1 window days, $2 minimum
 * delivered per send.
 */
export const MTA_CAPTURE_SQL = `
  SELECT c.mta_id, MAX(m.name) AS mta_name,
         SUM(c.sent_count)::text AS delivered,
         SUM(c.complaints_count)::text AS complaints
    FROM campaigns c
    LEFT JOIN mtas m ON m.id = c.mta_id
   WHERE c.status IN ('completed', 'sent')
     AND c.first_send_at IS NOT NULL
     AND c.first_send_at >= NOW() - ($1::int * INTERVAL '1 day')
     AND c.sent_count >= $2
     AND c.mta_id IS NOT NULL
   GROUP BY c.mta_id`;

/**
 * Candidates for the baseline complaint floor: recent finished sends on
 * complaint-capturing MTAs (cached counters). Params: $1 window days,
 * $2 minimum delivered, $3 excluded campaign id, $4 capturing MTA ids.
 */
export const COMPLAINT_FLOOR_CANDIDATES_SQL = `
  SELECT c.id, c.name, c.mta_id,
         c.sent_count::text AS sent_count,
         c.complaints_count::text AS complaints_count
    FROM campaigns c
   WHERE c.status IN ('completed', 'sent')
     AND c.first_send_at IS NOT NULL
     AND c.first_send_at >= NOW() - ($1::int * INTERVAL '1 day')
     AND c.sent_count >= $2
     AND ($3::text IS NULL OR c.id <> $3)
     AND c.mta_id = ANY($4::text[])
   ORDER BY c.first_send_at DESC
   LIMIT 150`;

/**
 * Relation of a recipient's refs to the brand, first match wins: core,
 * extension (US/E), similar brands kept by the operator, other brands of the
 * vertical. Placeholders are passed in because the two statements that embed
 * this fragment do not bind the same parameters (every bound parameter MUST
 * be referenced, or PostgreSQL rejects the statement: "could not determine
 * data type of parameter").
 */
function refRelationSql(p: { core: string; extension: string; similar: string; vertical: string }): string {
  return `CASE WHEN s.refs && ${p.core}::text[] THEN 'core'
                WHEN s.refs && ${p.extension}::text[] THEN 'extension'
                WHEN s.refs && ${p.similar}::text[] THEN 'similar'
                WHEN s.refs && ${p.vertical}::text[] THEN 'vertical'
                ELSE 'none' END`;
}

/**
 * Recency band of a recipient AT SEND TIME (last open/click before the send,
 * looked up within 180 days). Same bands as the live `engagement` operators
 * (60 d / 180 d on last_engaged_at), reconstructed from campaign_stats because
 * last_engaged_at only holds the current value. One index probe per recipient
 * (campaign_stats_subscriber_idx), hence the dedicated, smaller sample.
 */
const RECENCY_BAND_SQL = `CASE WHEN le.last_ts >= $2::timestamp - INTERVAL '60 days' THEN 'engaged_60d'
                WHEN le.last_ts IS NOT NULL THEN 'opened_61_180d'
                ELSE 'dormant_180d' END`;

/**
 * Params: $1 campaign id, $2 first send at, $3 core refs, $4 extension refs,
 * $5 sample divisor, $6 similar refs, $7 vertical refs.
 */
export const RECENCY_COHORT_SQL = `
  WITH recipients AS (
    SELECT cs.subscriber_id, (cs.first_click_at IS NOT NULL) AS clicked
      FROM campaign_sends cs
     WHERE cs.campaign_id = $1
       AND cs.status = 'sent'
       AND ($5::int = 1 OR abs(hashtextextended(cs.subscriber_id, 0)) % $5::int = 0)
  ),
  detected AS (
    SELECT DISTINCT st.subscriber_id
      FROM campaign_stats st
     WHERE st.ip_address = ${BOT_IP}
       AND st.type IN ('open', 'complaint')
       AND st.subscriber_id IN (SELECT subscriber_id FROM recipients)
  ),
  campaign_detected AS (
    SELECT DISTINCT st.subscriber_id
      FROM campaign_stats st
     WHERE st.campaign_id = $1
       AND st.ip_address = ${BOT_IP}
       AND st.type IN ('open', 'complaint')
  ),
  campaign_unsubscribed AS (
    SELECT DISTINCT st.subscriber_id
      FROM campaign_stats st
     WHERE st.campaign_id = $1
       AND st.type = 'unsubscribe'
  ),
  enriched AS (
    SELECT r.clicked,
           ${RECENCY_BAND_SQL} AS recency,
           ${refRelationSql({ core: "$3", extension: "$4", similar: "$6", vertical: "$7" })} AS ref_relation,
           (d.subscriber_id IS NOT NULL) AS bot,
           (cd.subscriber_id IS NOT NULL) AS complained,
           (cu.subscriber_id IS NOT NULL) AS unsubscribed
      FROM recipients r
      JOIN subscribers s ON s.id = r.subscriber_id
      CROSS JOIN LATERAL (
        SELECT MAX(st.timestamp) AS last_ts
          FROM campaign_stats st
         WHERE st.subscriber_id = r.subscriber_id
           AND st.type IN ('open', 'click')
           AND st.timestamp < $2::timestamp
           AND st.timestamp >= $2::timestamp - INTERVAL '180 days'
      ) le
      LEFT JOIN detected d ON d.subscriber_id = r.subscriber_id
      LEFT JOIN campaign_detected cd ON cd.subscriber_id = r.subscriber_id
      LEFT JOIN campaign_unsubscribed cu ON cu.subscriber_id = r.subscriber_id
  )
  SELECT axis, cohort,
         COUNT(*)::text AS delivered,
         COUNT(*) FILTER (WHERE clicked AND NOT bot)::text AS human_clickers,
         COUNT(*) FILTER (WHERE clicked AND bot)::text AS bot_clickers,
         COUNT(*) FILTER (WHERE complained)::text AS complaints,
         COUNT(*) FILTER (WHERE unsubscribed)::text AS unsubscribes
    FROM (
      SELECT 'recency' AS axis, recency AS cohort, clicked, bot, complained, unsubscribed FROM enriched
      UNION ALL SELECT 'ref_recency', ref_relation || '|' || recency, clicked, bot, complained, unsubscribed FROM enriched
    ) x
   GROUP BY axis, cohort`;

/**
 * Recent sends of every brand, newest first: candidates for the recency
 * pool. Twice the wanted count is fetched with their delivered rows so the
 * SAME finished criterion as the brand calibration (`isFinishedSend`: counter
 * converged with the send rows) can drop a send whose outcomes are still
 * being finalised before it is used.
 */
export const RECENCY_POOL_CAMPAIGNS_SQL = `
  SELECT c.id, c.name, c.status, c.first_send_at, c.sent_count::text AS sent_count,
         (SELECT COUNT(*) FROM campaign_sends cs WHERE cs.campaign_id = c.id AND cs.status = 'sent')::text AS delivered_rows
    FROM campaigns c
   WHERE c.status IN ('completed', 'sent')
     AND c.first_send_at IS NOT NULL
     AND c.first_send_at >= NOW() - ($1::int * INTERVAL '1 day')
     AND c.sent_count >= $2
     AND ($3::text IS NULL OR c.id <> $3)
     AND NOT (c.id = ANY($4::text[]))
   ORDER BY c.first_send_at DESC
   LIMIT $5::int * 2`;

/**
 * Params: $1 campaign id, $2 first send at, $3 core refs, $4 extension refs,
 * $5 family domains, $6 sample divisor, $7 similar refs, $8 vertical refs,
 * $9 Orange/Wanadoo domains.
 */
export const COHORT_SQL = `
  WITH recipients AS (
    SELECT cs.subscriber_id, (cs.first_click_at IS NOT NULL) AS clicked
      FROM campaign_sends cs
     WHERE cs.campaign_id = $1
       AND cs.status = 'sent'
       AND ($6::int = 1 OR abs(hashtextextended(cs.subscriber_id, 0)) % $6::int = 0)
  ),
  prior AS (
    SELECT st.subscriber_id, COUNT(DISTINCT st.campaign_id) AS n
      FROM campaign_stats st
     WHERE st.type = 'click'
       AND st.timestamp >= $2::timestamp - INTERVAL '60 days'
       AND st.timestamp < $2::timestamp
       AND st.subscriber_id IN (SELECT subscriber_id FROM recipients)
     GROUP BY st.subscriber_id
  ),
  detected AS (
    SELECT DISTINCT st.subscriber_id
      FROM campaign_stats st
     WHERE st.ip_address = ${BOT_IP}
       AND st.type IN ('open', 'complaint')
       AND st.subscriber_id IN (SELECT subscriber_id FROM recipients)
  ),
  campaign_detected AS (
    SELECT DISTINCT st.subscriber_id
      FROM campaign_stats st
     WHERE st.campaign_id = $1
       AND st.ip_address = ${BOT_IP}
       AND st.type IN ('open', 'complaint')
  ),
  campaign_unsubscribed AS (
    SELECT DISTINCT st.subscriber_id
      FROM campaign_stats st
     WHERE st.campaign_id = $1
       AND st.type = 'unsubscribe'
  ),
  enriched AS (
    SELECT r.clicked,
           CASE WHEN p.n IS NULL THEN '0' WHEN p.n = 1 THEN '1' WHEN p.n <= 3 THEN '2-3' WHEN p.n <= 5 THEN '4-5' ELSE '6+' END AS tier,
           ${refRelationSql({ core: "$3", extension: "$4", similar: "$7", vertical: "$8" })} AS ref_relation,
           CASE WHEN lower(split_part(s.email, '@', 2)) = ANY($5::text[]) THEN 'in_family' ELSE 'other' END AS family,
           CASE WHEN lower(split_part(s.email, '@', 2)) = ANY($9::text[]) THEN '${ORANGE_WANADOO_COHORT}' ELSE 'other' END AS domain_group,
           (d.subscriber_id IS NOT NULL) AS bot,
           (cd.subscriber_id IS NOT NULL) AS complained,
           (cu.subscriber_id IS NOT NULL) AS unsubscribed
      FROM recipients r
      JOIN subscribers s ON s.id = r.subscriber_id
      LEFT JOIN prior p ON p.subscriber_id = r.subscriber_id
      LEFT JOIN detected d ON d.subscriber_id = r.subscriber_id
      LEFT JOIN campaign_detected cd ON cd.subscriber_id = r.subscriber_id
      LEFT JOIN campaign_unsubscribed cu ON cu.subscriber_id = r.subscriber_id
  )
  SELECT axis, cohort,
         COUNT(*)::text AS delivered,
         COUNT(*) FILTER (WHERE clicked AND NOT bot)::text AS human_clickers,
         COUNT(*) FILTER (WHERE clicked AND bot)::text AS bot_clickers,
         COUNT(*) FILTER (WHERE complained)::text AS complaints,
         COUNT(*) FILTER (WHERE unsubscribed)::text AS unsubscribes
    FROM (
      SELECT 'clicker_tier' AS axis, tier AS cohort, clicked, bot, complained, unsubscribed FROM enriched
      UNION ALL SELECT 'ref_relation', ref_relation, clicked, bot, complained, unsubscribed FROM enriched
      UNION ALL SELECT 'family', family, clicked, bot, complained, unsubscribed FROM enriched
      UNION ALL SELECT 'domain_group', domain_group, clicked, bot, complained, unsubscribed FROM enriched
    ) x
   GROUP BY axis, cohort`;

/** Tier mix of the still-available recent clickers (after exclusions). */
/**
 * Clicker-tier partition (60 d, distinct campaigns clicked) of the subscribers
 * matching a compiled rules fragment, under the same base filters as
 * `compileCountQuery` (BCK tag, suppression). Non-clickers are not returned:
 * tier "0" = total − Σ tiers.
 */
export function tierMixSql(rulesWhere: string): string {
  return `
  SELECT CASE WHEN k.n >= 6 THEN '6+' WHEN k.n >= 4 THEN '4-5' WHEN k.n >= 2 THEN '2-3' ELSE '1' END AS tier,
         COUNT(*)::text AS count
    FROM subscribers
    JOIN (
      SELECT st.subscriber_id, COUNT(DISTINCT st.campaign_id) AS n
        FROM campaign_stats st
       WHERE st.type = 'click' AND st.timestamp >= NOW() - INTERVAL '60 days'
       GROUP BY st.subscriber_id
    ) k ON k.subscriber_id = subscribers.id
   WHERE ${rulesWhere}
     AND NOT COALESCE('BCK' = ANY(subscribers.tags), false)
     AND (subscribers.suppressed_until IS NULL OR subscribers.suppressed_until < NOW())
   GROUP BY 1`;
}

/**
 * Exact measure of a composition's final audience: total recount plus its
 * disjoint clicker-tier partition, both from the same runner (one snapshot
 * transaction). This is what the projection and the complaint cap apply to.
 */
/**
 * Recency partition of an audience on the live `last_engaged_at` (same bands
 * as the engagement operators). Only the two non-active bands are returned:
 * the projection carves them out of the 0-click tier.
 */
export function recencyMixSql(rulesWhere: string): string {
  return `
  SELECT CASE WHEN subscribers.last_engaged_at >= NOW() - INTERVAL '${ENGAGEMENT_RECENCY_DAYS} days' THEN 'engaged_60d'
              WHEN subscribers.last_engaged_at >= NOW() - INTERVAL '${ENGAGEMENT_LAPSED_DAYS} days' THEN 'opened_61_180d'
              ELSE 'dormant_180d' END AS band,
         COUNT(*)::text AS count,
         COUNT(*) FILTER (WHERE lower(split_part(subscribers.email, '@', 2)) IN (${ORANGE_WANADOO_DOMAIN_LITERALS}))::text AS orange_wanadoo
    FROM subscribers
   WHERE ${rulesWhere}
     AND NOT COALESCE('BCK' = ANY(subscribers.tags), false)
     AND (subscribers.suppressed_until IS NULL OR subscribers.suppressed_until < NOW())
   GROUP BY 1`;
}

export async function measureAudienceWith(runner: EvidenceQueryRunner, rules: SegmentRulesV2, label = "proposition"): Promise<AudienceMeasure> {
  const total = await runner.queryCount(`recomptage de la ${label}`, compileCountQuery(rules));
  const tierCounts: TierCounts = {};
  if (total > 0) {
    const where = dialect.sqlToQuery(compileSegmentRules(rules));
    const rows = await runner.query<{ tier: string; count: string }>(`répartition par tranche de cliqueurs de la ${label}`, tierMixSql(where.sql), where.params);
    let clickers = 0;
    for (const row of rows) {
      const count = Number(row.count);
      tierCounts[row.tier as ClickerTier] = count;
      clickers += count;
    }
    tierCounts["0"] = Math.max(0, total - clickers);
    const recencyRows = await runner.query<{ band: string; count: string; orange_wanadoo?: string }>(`répartition par récence de la ${label}`, recencyMixSql(where.sql), where.params);
    const recencyCounts: NonNullable<AudienceMeasure["recencyCounts"]> = {};
    let orangeWanadooCount = 0;
    for (const row of recencyRows) {
      if ((NON_ACTIVE_RECENCY_BANDS as readonly string[]).includes(row.band) || row.band === "engaged_60d") {
        recencyCounts[row.band as RecencyBand] = Number(row.count);
      }
      orangeWanadooCount += Number(row.orange_wanadoo ?? 0);
    }
    return { total, tierCounts, recencyCounts, orangeWanadooCount };
  }
  return { total, tierCounts, orangeWanadooCount: 0 };
}

export function createTransactionRunner(config: SmartSegmentConfig): { runner: EvidenceQueryRunner; open: () => Promise<void>; close: () => Promise<void> } {
  let client: PoolClient | null = null;
  const startedAt = Date.now();
  let queries = 0;
  const elapsedMs = () => Date.now() - startedAt;
  const checkBudget = (label: string) => {
    if (elapsedMs() > config.evidenceBudgetMs) {
      throw new SmartSegmentError("EVIDENCE_BUDGET", `Budget d'analyse dépassé avant l'étape « ${label} » (${Math.round(config.evidenceBudgetMs / 1000)} s).`, 504);
    }
  };
  const translate = (label: string, error: unknown): never => {
    const code = (error as { code?: string })?.code;
    if (code === "57014") {
      throw new SmartSegmentError("QUERY_TIMEOUT", `Délai dépassé sur la requête « ${label} » (${Math.round(config.queryTimeoutMs / 1000)} s). Relancez plus tard ou réduisez la fenêtre.`, 504);
    }
    if (error instanceof SmartSegmentError) throw error;
    throw new SmartSegmentError("EVIDENCE_QUERY_FAILED", `Échec de la requête « ${label} » : ${(error as Error)?.message ?? String(error)}`, 500);
  };
  const runner: EvidenceQueryRunner = {
    async query(label, text, params = []) {
      if (!client) throw new SmartSegmentError("EVIDENCE_NOT_OPEN", "Transaction d'analyse non ouverte.");
      checkBudget(label);
      queries += 1;
      try {
        const result = await client.query(text, params);
        return result.rows as never;
      } catch (error) {
        return translate(label, error);
      }
    },
    async queryCount(label, statement) {
      const compiled = dialect.sqlToQuery(statement);
      const rows = await this.query<{ count: string }>(label, compiled.sql, compiled.params);
      return Number(rows[0]?.count ?? 0);
    },
    elapsedMs,
    queries: () => queries,
  };
  return {
    runner,
    async open() {
      const saturation = getPoolSaturation();
      if (saturation >= config.poolSaturationLimit) {
        throw new SmartSegmentError("DB_SATURATED", `Base de données saturée (${Math.round(saturation * 100)} % du pool utilisé) : analyse refusée pour protéger l'envoi. Réessayez dans quelques minutes.`, 503);
      }
      client = await pool.connect();
      try {
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        await client.query(`SET LOCAL statement_timeout = '${config.queryTimeoutMs}ms'`);
      } catch (error) {
        client.release();
        client = null;
        throw error;
      }
    },
    async close() {
      if (!client) return;
      try {
        await client.query("ROLLBACK");
      } catch {
        // read-only transaction: nothing to preserve
      } finally {
        client.release();
        client = null;
      }
    },
  };
}

function brandForHistory(input: Pick<EvidenceInput, "brand" | "campaignName">): CampaignBrand | null {
  return extractCampaignBrand(input.brand.brandName ?? input.campaignName) ?? extractCampaignBrand(input.campaignName);
}

type RecentSendQuery = <T extends Record<string, unknown>>(text: string, params: unknown[]) => Promise<T[]>;

/**
 * The ≤ N most recent sends of the brand (any live status, newest first):
 * their recipients are excluded from every proposal. Bounded, indexed
 * `campaigns` lookup — also run again when a dossier is reused, so a send
 * started since then is still excluded.
 */
export async function queryRecentBrandSends(
  query: RecentSendQuery,
  brand: CampaignBrand,
  excludeCampaignId: string | null,
  config: Pick<SmartSegmentConfig, "recentBrandSendDays">,
): Promise<Array<{ id: string; name: string }>> {
  // Raw first word of the label (not the normalised token) so accented
  // brand names still match ILIKE; campaignMatchesBrand does the exact
  // token comparison afterwards.
  const firstWord = (brand.label.split(/\s+/)[0] ?? brand.tokens[0]).replace(/[\\%_]/g, (c) => `\\${c}`);
  const pattern = `%${firstWord}%`;
  const recentRows = await query<{ id: string; name: string }>(
    `SELECT id, name FROM campaigns
      WHERE name ILIKE $1
        AND first_send_at IS NOT NULL
        AND first_send_at >= NOW() - ($2::int * INTERVAL '1 day')
        AND status <> 'draft'
        AND ($3::text IS NULL OR id <> $3)
      ORDER BY first_send_at DESC
      LIMIT 50`,
    [pattern, config.recentBrandSendDays, excludeCampaignId],
  );
  // Rows arrive newest first: keep the newest matches only (the rule is
  // « the ≤ N most recent sends », not every send of the window).
  return recentRows.filter((row) => campaignMatchesBrand(row.name, brand)).slice(0, SMART_SEGMENT_MAX_RECENT_SEND_EXCLUSIONS);
}

/**
 * Copy of a persisted dossier for a new analysis with the same evidence
 * identity: the recent brand sends are looked up again (a send started since
 * the original dossier must still be excluded); everything else — cohorts,
 * reservoirs, floor, baselines — is kept as measured then.
 */
export async function reuseSmartSegmentEvidence(
  source: SmartSegmentEvidence,
  from: { analysisId: string },
  input: Pick<EvidenceInput, "brand" | "campaignName" | "excludeCampaignId">,
  options: { config?: SmartSegmentConfig; query?: RecentSendQuery } = {},
): Promise<SmartSegmentEvidence> {
  const config = options.config ?? getSmartSegmentConfig();
  const query: RecentSendQuery = options.query ?? (async (text, params) => (await pool.query(text, params)).rows as never);
  const brand = brandForHistory(input);
  const campaignNames = { ...source.campaignNames };
  let recentBrandCampaignIds = source.recentBrandCampaignIds;
  const notes = [...source.notes];
  if (brand) {
    const recentMatches = await queryRecentBrandSends(query, brand, input.excludeCampaignId, config);
    recentBrandCampaignIds = recentMatches.map((row) => row.id);
    for (const row of recentMatches) campaignNames[row.id] = row.name;
    const changed = recentBrandCampaignIds.length !== source.recentBrandCampaignIds.length || recentBrandCampaignIds.some((id, index) => source.recentBrandCampaignIds[index] !== id);
    if (changed) notes.push("Envois récents de la marque mis à jour depuis le dossier réutilisé : les exclusions obligatoires portent sur la liste actuelle (les réservoirs affichés datent du dossier d'origine).");
  }
  const generatedAt = new Date(source.generatedAt);
  notes.push(`Dossier de preuves réutilisé de l'analyse du ${Number.isNaN(generatedAt.getTime()) ? source.generatedAt : generatedAt.toLocaleString("fr-FR", { timeZone: "Europe/Paris" })} (mêmes marque, famille, MTA et refs similaires) : cohortes et réservoirs non remesurés, seules la cible et le plafond changent.`);
  return {
    ...source,
    recentBrandCampaignIds,
    campaignNames,
    mandatoryExclusions: mandatoryExclusions(source.brand, source.family, recentBrandCampaignIds).map((entry) => entry.label),
    budget: { elapsedMs: 0, queries: 0, sampledCampaigns: source.budget.sampledCampaigns },
    notes,
    reusedFrom: { analysisId: from.analysisId, generatedAt: source.generatedAt },
  };
}

function exclusionRules(nodes: Array<{ node: SegmentGroup | SegmentGroup["children"][number] }>): SegmentRulesV2 {
  return { version: 2, root: group("AND", nodes.map((entry) => entry.node)) };
}

/**
 * Calibration sends among the eligible ones (finished, large enough), newest
 * first as given: sends whose MTA captures complaints (or is not established)
 * come first, the campaign's own MTA before the others; sends on blind MTAs
 * are used only when no other send exists — the floor then replaces their
 * (unmeasured) complaint rate.
 */
export function rankCalibrationSends(
  eligible: SmartSegmentBrandSend[],
  mtaId: string | null | undefined,
  max = MAX_CALIBRATION_SENDS,
): { sends: SmartSegmentBrandSend[]; skippedBlind: number; allBlind: boolean } {
  const nonBlind = eligible.filter((send) => send.mtaComplaintCapture !== "blind");
  const blind = eligible.filter((send) => send.mtaComplaintCapture === "blind");
  const preferred = mtaId ? [...nonBlind.filter((send) => send.mtaId === mtaId), ...nonBlind.filter((send) => send.mtaId !== mtaId)] : nonBlind;
  if (preferred.length) {
    return { sends: preferred.slice(0, max), skippedBlind: blind.length, allBlind: false };
  }
  return { sends: blind.slice(0, max), skippedBlind: 0, allBlind: blind.length > 0 };
}

type FloorCandidateRow = { id: string; name: string; mta_id: string | null; sent_count: string; complaints_count: string };

/**
 * Orders calibration candidates BEFORE the heavy stats query caps them: sends
 * on complaint-capturing (or unclassified) MTAs within the complaint horizon
 * come first, newest first; blind-MTA sends and sends older than the horizon
 * keep their recency order after them. Without this, a brand whose newest
 * sends all went through a blind MTA would be floored even though a slightly
 * older capturing send exists.
 */
export function preferCapturingCandidates<T extends { id: string; mtaId: string | null; firstSendAt?: Date | string | null }>(
  rows: T[],
  captures: MtaCaptureMap,
  max: number,
  now = Date.now(),
): T[] {
  const horizon = now - COMPLAINT_FLOOR_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const withinHorizon = (row: T) => {
    if (row.firstSendAt === undefined || row.firstSendAt === null) return true;
    const time = new Date(row.firstSendAt).getTime();
    return Number.isNaN(time) ? true : time >= horizon;
  };
  const preferred = rows.filter((row) => mtaCaptureOf(captures, row.mtaId) !== "blind" && withinHorizon(row));
  const rest = rows.filter((row) => !preferred.includes(row));
  return [...preferred, ...rest].slice(0, max);
}

/** Baseline floor from cached campaign counters (rule of three applied to the pooled sends). */
export function complaintFloorFrom(rows: FloorCandidateRow[], level: CalibrationLevel, label: string): SmartSegmentComplaintFloor | null {
  const picked = rows.slice(0, COMPLAINT_FLOOR_MAX_SENDS);
  if (!picked.length) return null;
  const delivered = picked.reduce((sum, row) => sum + (Number(row.sent_count) || 0), 0);
  const complaints = picked.reduce((sum, row) => sum + (Number(row.complaints_count) || 0), 0);
  if (delivered <= 0) return null;
  return { rate: ruleOfThreeRate(complaints / delivered, delivered), level, campaignIds: picked.map((row) => row.id), delivered, complaints, label };
}

/** Brand baselines (unsubscribes, Orange/Wanadoo share and complaint rate) read from the aggregated cohorts. */
export function baselinesFromCohorts(cohortRates: SmartSegmentEvidence["cohortRates"], level: CalibrationLevel): SmartSegmentBaselines {
  let delivered = 0, unsubscribes = 0, unsubscribesMeasured = false;
  for (const rate of cohortRates) {
    if (rate.axis !== "clicker_tier") continue;
    delivered += rate.delivered;
    if (rate.unsubscribes !== undefined) {
      unsubscribes += rate.unsubscribes;
      unsubscribesMeasured = true;
    }
  }
  const domainRows = cohortRates.filter((rate) => rate.axis === "domain_group");
  const domainDelivered = domainRows.reduce((sum, rate) => sum + rate.delivered, 0);
  const ow = domainRows.find((rate) => rate.cohort === ORANGE_WANADOO_COHORT);
  return {
    level,
    unsubscribeRate: unsubscribesMeasured && delivered > 0 ? unsubscribes / delivered : null,
    orangeWanadooShare: domainDelivered > 0 ? (ow?.delivered ?? 0) / domainDelivered : null,
    orangeWanadooComplaintRate: ow && ow.delivered >= MIN_RELIABLE_COHORT_DELIVERED ? ow.complaintRate : null,
  };
}

export async function buildSmartSegmentEvidence(
  input: EvidenceInput,
  onProgress: ProgressFn,
  options: { config?: SmartSegmentConfig; runner?: EvidenceQueryRunner } = {},
): Promise<SmartSegmentEvidence> {
  const config = options.config ?? getSmartSegmentConfig();
  const transaction = options.runner ? null : createTransactionRunner(config);
  const runner = options.runner ?? transaction!.runner;
  const notes: string[] = [];
  const campaignNames: Record<string, string> = {};
  const sampledCampaigns: Array<{ campaignId: string; divisor: number }> = [];
  if (transaction) await transaction.open();
  try {
    // ── Stage 1: brand history ────────────────────────────────────────────
    await onProgress("brand_history", 5);
    const brand = brandForHistory(input);
    // Complaint capture of every MTA (cached counters, all brands): decides
    // which sends may calibrate complaints and whether a floor is needed.
    const captures: MtaCaptureMap = new Map();
    const captureRows = await runner.query<{ mta_id: string; mta_name: string | null; delivered: string; complaints: string }>(
      "capture des plaintes par MTA",
      MTA_CAPTURE_SQL,
      [MTA_CAPTURE_WINDOW_DAYS, MIN_CALIBRATION_DELIVERED],
    );
    for (const row of captureRows) {
      const delivered = Number(row.delivered) || 0;
      const complaints = Number(row.complaints) || 0;
      captures.set(row.mta_id, { name: row.mta_name ?? null, capture: classifyMtaComplaintCapture(delivered, complaints), delivered, complaints });
    }
    const targetMtaId = input.mtaId?.trim() || null;
    const targetCapture = targetMtaId ? captures.get(targetMtaId) : undefined;
    const segmentNamesByCampaign = new Map<string, string[]>();
    let brandCampaignIds: string[] = [];
    if (brand) {
      // Deliberately outside the evidence transaction: this is the same
      // bounded, indexed `campaigns` lookup the segment-performance panel
      // runs on the main pool (no campaign_sends scan), so it does not need
      // the statement_timeout / snapshot of the heavy queries below.
      const candidates = await getSegmentPerformanceHistoryCandidates(historicalBrandKeys(brand), input.excludeCampaignId);
      const firstSendAtByCampaign = new Map<string, Date | string | null>();
      for (const candidate of candidates) {
        const names = segmentNamesByCampaign.get(candidate.campaignId) ?? [];
        if (!names.includes(candidate.segmentName)) names.push(candidate.segmentName);
        segmentNamesByCampaign.set(candidate.campaignId, names);
        if (!firstSendAtByCampaign.has(candidate.campaignId)) firstSendAtByCampaign.set(candidate.campaignId, candidate.firstSentAt ?? null);
      }
      // Newest first (repository order). When more sends exist than the
      // history keeps, a cheap PK lookup of their MTA lets capturing sends
      // rank before blind ones instead of being cut off by the recency cap.
      const window = [...segmentNamesByCampaign.keys()].slice(0, BRAND_CANDIDATE_LOOKAHEAD);
      const mtaByCampaign = new Map<string, string | null>();
      if (window.length > MAX_BRAND_SENDS) {
        const mtaRows = await runner.query<{ id: string; mta_id: string | null }>(
          "MTA des envois de la marque",
          `SELECT id, mta_id FROM campaigns WHERE id = ANY($1::text[])`,
          [window],
        );
        for (const row of mtaRows) mtaByCampaign.set(row.id, row.mta_id);
      }
      brandCampaignIds = preferCapturingCandidates(
        window.map((id) => ({ id, mtaId: mtaByCampaign.get(id) ?? null, firstSendAt: firstSendAtByCampaign.get(id) ?? null })),
        captures,
        MAX_BRAND_SENDS,
      ).map((row) => row.id);
    }
    const brandRows = brandCampaignIds.length
      ? await runner.query<CampaignStatsRow>("historique de la marque", CAMPAIGN_STATS_SQL, [brandCampaignIds])
      : [];
    const brandSends = brandRows.map((row) => toBrandSend(row, segmentNamesByCampaign.get(row.id) ?? [], captures));

    // Recent sends of the brand (any live status) whose recipients must be
    // excluded — includes campaigns still sending, which the completed-only
    // history query above cannot see.
    let recentBrandCampaignIds: string[] = [];
    if (brand) {
      const recentMatches = await queryRecentBrandSends((text, params) => runner.query("envois récents de la marque", text, params), brand, input.excludeCampaignId, config);
      recentBrandCampaignIds = recentMatches.map((row) => row.id);
      for (const row of recentMatches) campaignNames[row.id] = row.name;
    }
    await onProgress("brand_history", 15);

    // ── Calibration level ────────────────────────────────────────────────
    // Sends whose MTA captures complaints rank first (the campaign's own MTA
    // before the others); blind-MTA sends calibrate only when nothing else
    // exists, and a baseline floor then replaces their complaint rate.
    let calibrationLevel: CalibrationLevel = "brand";
    const eligibleBrandSends = brandSends.filter((send) => send.finished && send.delivered >= MIN_CALIBRATION_DELIVERED);
    let ranking = rankCalibrationSends(eligibleBrandSends, targetMtaId);
    let calibrationSends = ranking.sends;
    let verticalKeysCache: Set<string> | null = null;
    const loadVerticalKeys = async (): Promise<Set<string>> => {
      if (verticalKeysCache) return verticalKeysCache;
      verticalKeysCache = new Set<string>();
      if (input.brand.vertical) {
        const verticalBrands = await runner.query<{ name: string }>(
          "marques de la verticale",
          `SELECT DISTINCT name FROM brands WHERE lower(ref) LIKE $1 LIMIT 300`,
          [`${input.brand.vertical}%`],
        );
        verticalKeysCache = new Set(verticalBrands.map((row) => extractCampaignBrand(row.name)?.key).filter((key): key is string => !!key));
      }
      return verticalKeysCache;
    };
    const inVertical = (name: string, verticalKeys: Set<string>) => {
      const key = extractCampaignBrand(name)?.key;
      return key ? verticalKeys.has(key) : false;
    };
    if (!calibrationSends.length) {
      const fallbackRows = await runner.query<{ id: string; name: string; mta_id: string | null; first_send_at: string | null }>(
        "candidats de repli",
        `SELECT id, name, mta_id, first_send_at FROM campaigns
          WHERE status IN ('completed', 'sent')
            AND first_send_at IS NOT NULL
            AND sent_count >= $1
            AND ($2::text IS NULL OR id <> $2)
          ORDER BY first_send_at DESC
          LIMIT 150`,
        [MIN_CALIBRATION_DELIVERED, input.excludeCampaignId],
      );
      const verticalKeys = await loadVerticalKeys();
      const verticalCandidates = fallbackRows.filter((row) => inVertical(row.name, verticalKeys));
      const pick = async (rows: Array<{ id: string; mta_id: string | null; first_send_at: string | null }>, level: CalibrationLevel) => {
        // Capturing MTAs first, so the eight sends whose stats are computed
        // are not the eight newest blind ones while a capturing one exists.
        const ids = preferCapturingCandidates(rows.map((row) => ({ id: row.id, mtaId: row.mta_id, firstSendAt: row.first_send_at })), captures, 8).map((row) => row.id);
        if (!ids.length) return { sends: [] as SmartSegmentBrandSend[], skippedBlind: 0, allBlind: false };
        const statRows = await runner.query<CampaignStatsRow>(`statistiques de repli (${level})`, CAMPAIGN_STATS_SQL, [ids]);
        const eligible = statRows.map((row) => toBrandSend(row, [], captures)).filter((send) => send.finished && send.delivered >= MIN_CALIBRATION_DELIVERED);
        return rankCalibrationSends(eligible, targetMtaId);
      };
      if (verticalCandidates.length) {
        ranking = await pick(verticalCandidates, "vertical");
        calibrationSends = ranking.sends;
        if (calibrationSends.length) calibrationLevel = "vertical";
      }
      if (!calibrationSends.length) {
        ranking = await pick(fallbackRows, "global");
        calibrationSends = ranking.sends;
        calibrationLevel = "global";
      }
      if (!calibrationSends.length) {
        throw new SmartSegmentError("NO_CALIBRATION", "Aucun envoi terminé exploitable (≥ 5 000 livraisons, compteur rejoint) pour calibrer les projections.", 422);
      }
      notes.push(calibrationLevel === "vertical"
        ? `Aucun envoi terminé de la marque : calibrage sur ${calibrationSends.length} envoi(s) de la verticale ${input.brand.verticalLabel ?? ""}.`.trim()
        : `Aucun envoi terminé de la marque ni de sa verticale : calibrage sur ${calibrationSends.length} envoi(s) récents toutes marques.`);
    } else if (calibrationSends.length === 1) {
      notes.push("Un seul envoi terminé de la marque disponible : projections calibrées sur cet envoi uniquement.");
    }
    if (ranking.skippedBlind > 0) {
      notes.push(`${ranking.skippedBlind} envoi(s) terminé(s) écarté(s) du calibrage : leur MTA ne remonte pas les plaintes (taux < 0,01 % sur 90 j toutes marques), leurs 0 plainte ne mesurent rien.`);
    }
    for (const send of brandSends) {
      send.usedForCalibration = calibrationSends.some((c) => c.campaignId === send.campaignId);
    }
    for (const send of calibrationSends) send.usedForCalibration = true;
    const brandSendIds = new Set(brandSends.map((send) => send.campaignId));
    const extraSends = calibrationSends.filter((send) => !brandSendIds.has(send.campaignId));
    for (const send of [...brandSends, ...extraSends]) campaignNames[send.campaignId] = send.name;

    // ── Complaint floor (calibration blind to complaints) ────────────────
    // When every calibration send went through a blind MTA, their measured
    // complaint rate is meaningless: a baseline measured on capturing MTAs
    // (brand, else vertical, else all brands, cached counters, 180 d) floors
    // every projected cell.
    let complaintFloor: SmartSegmentComplaintFloor | null = null;
    if (ranking.allBlind) {
      const capturingMtaIds = [...captures.entries()].filter(([, entry]) => entry.capture === "capturing").map(([id]) => id);
      const blindMtaNames = [...new Set(calibrationSends.map((send) => send.mtaName ?? send.mtaId ?? "MTA inconnu"))].join(", ");
      if (capturingMtaIds.length) {
        const floorRows = await runner.query<FloorCandidateRow>(
          "envois via MTA remontant les plaintes (plancher)",
          COMPLAINT_FLOOR_CANDIDATES_SQL,
          [COMPLAINT_FLOOR_WINDOW_DAYS, MIN_CALIBRATION_DELIVERED, input.excludeCampaignId, capturingMtaIds],
        );
        const brandRows = brand ? floorRows.filter((row) => campaignMatchesBrand(row.name, brand)) : [];
        complaintFloor = complaintFloorFrom(brandRows, "brand", "envois de la marque via des MTA remontant les plaintes");
        if (!complaintFloor) {
          const verticalKeys = await loadVerticalKeys();
          complaintFloor = complaintFloorFrom(floorRows.filter((row) => inVertical(row.name, verticalKeys)), "vertical", `envois de la verticale ${input.brand.verticalLabel ?? ""} via des MTA remontant les plaintes`.replace(/\s+/g, " ").trim());
        }
        if (!complaintFloor) {
          complaintFloor = complaintFloorFrom(floorRows, "global", "envois récents toutes marques via des MTA remontant les plaintes");
        }
        for (const row of floorRows) if (complaintFloor?.campaignIds.includes(row.id)) campaignNames[row.id] = row.name;
      }
      if (complaintFloor) {
        notes.push(`Les ${calibrationSends.length} envoi(s) de calibrage passent par un MTA qui ne remonte pas les plaintes (${blindMtaNames}) : plancher de plaintes ${(complaintFloor.rate * 100).toFixed(3).replace(".", ",")} % appliqué à toutes les projections, mesuré sur ${complaintFloor.campaignIds.length} ${complaintFloor.label} (${complaintFloor.complaints.toLocaleString("fr-FR")} plaintes / ${complaintFloor.delivered.toLocaleString("fr-FR")} livrés, 180 j).`);
      } else {
        notes.push(`Les ${calibrationSends.length} envoi(s) de calibrage passent par un MTA qui ne remonte pas les plaintes (${blindMtaNames}) et aucun envoi via un MTA remontant les plaintes n'est disponible sur 180 j : les taux de plaintes projetés sont NON MESURÉS (seule la règle de trois s'applique).`);
      }
    }
    const mtaEvidence: SmartSegmentMtaEvidence | null = targetMtaId
      ? {
          id: targetMtaId,
          name: targetCapture?.name ?? calibrationSends.find((send) => send.mtaId === targetMtaId)?.mtaName ?? null,
          capture: targetCapture?.capture ?? "unknown",
          observedDelivered: targetCapture?.delivered ?? 0,
          observedComplaintRate: targetCapture && targetCapture.delivered > 0 ? targetCapture.complaints / targetCapture.delivered : null,
          calibrationSendsOnMta: calibrationSends.filter((send) => send.mtaId === targetMtaId).length,
        }
      : null;
    if (mtaEvidence && mtaEvidence.capture === "blind") {
      notes.push(`Le MTA de la campagne (${mtaEvidence.name ?? mtaEvidence.id}) ${SMART_SEGMENT_MTA_CAPTURE_LABELS.blind} : les plaintes réelles de cet envoi ne seront pas visibles dans les compteurs, la projection ne pourra pas être vérifiée a posteriori sur cette campagne.`);
    }

    // ── Stage 2: cohorts ─────────────────────────────────────────────────
    await onProgress("cohorts", 25);
    const familyDomains = [...DOMAIN_FAMILIES[input.family].domains];
    const similarRefs = input.brand.similarRefs ?? [];
    const rawRows: RawCohortRow[] = [];
    for (const [index, send] of calibrationSends.entries()) {
      const divisor = sampleDivisorFor(send.delivered, config.cohortSampleTarget);
      if (divisor > 1) sampledCampaigns.push({ campaignId: send.campaignId, divisor });
      const rows = await runner.query<{ axis: string; cohort: string; delivered: string; human_clickers: string; bot_clickers: string; complaints: string; unsubscribes?: string }>(
        `cohortes « ${send.name} »`,
        COHORT_SQL,
        [send.campaignId, send.firstSendAt, input.brand.coreRefs, input.brand.extensionRefs, familyDomains, divisor, similarRefs, input.brand.verticalRefs, ORANGE_WANADOO_DOMAINS],
      );
      for (const row of rows) {
        rawRows.push({
          axis: row.axis as RawCohortRow["axis"],
          cohort: row.cohort,
          delivered: Number(row.delivered) * divisor,
          humanClickers: Number(row.human_clickers) * divisor,
          botClickers: Number(row.bot_clickers) * divisor,
          complaints: Number(row.complaints) * divisor,
          unsubscribes: Number(row.unsubscribes ?? 0) * divisor,
          // Rule of three is judged on recipients actually observed.
          observed: Number(row.delivered),
        });
      }
      await onProgress("cohorts", 25 + Math.round(((index + 1) / calibrationSends.length) * 15));
    }

    // ── Stage 2b: recency cohorts ────────────────────────────────────────
    // Non-active bands (lapsed / dormant) are calibrated on the brand's own
    // sends only when those reached enough non-active recipients; otherwise
    // on a pool of recent sends of every brand, projected with the global
    // markups. Without any reliable band, the non-active blocks are omitted.
    const recencyQuery = async (campaignId: string, firstSendAt: string, delivered: number, target: number, label: string): Promise<RawCohortRow[]> => {
      const divisor = sampleDivisorFor(delivered, target);
      const rows = await runner.query<{ axis: string; cohort: string; delivered: string; human_clickers: string; bot_clickers: string; complaints: string; unsubscribes?: string }>(
        `récence « ${label} »`,
        RECENCY_COHORT_SQL,
        [campaignId, firstSendAt, input.brand.coreRefs, input.brand.extensionRefs, divisor, similarRefs, input.brand.verticalRefs],
      );
      return rows.map((row) => ({
        axis: row.axis as RawCohortRow["axis"],
        cohort: row.cohort,
        delivered: Number(row.delivered) * divisor,
        humanClickers: Number(row.human_clickers) * divisor,
        botClickers: Number(row.bot_clickers) * divisor,
        complaints: Number(row.complaints) * divisor,
        unsubscribes: Number(row.unsubscribes ?? 0) * divisor,
        // Reliability of a recency band is judged on recipients actually observed.
        observed: Number(row.delivered),
      }));
    };
    const bandsReliable = (rows: RawCohortRow[]): RecencyBand[] => {
      const rates = aggregateCohortRates(rows);
      return NON_ACTIVE_RECENCY_BANDS.filter((band) => recencyRateFor(rates, band) !== null);
    };
    const brandRecencyRows: RawCohortRow[] = [];
    for (const [index, send] of calibrationSends.entries()) {
      brandRecencyRows.push(...await recencyQuery(send.campaignId, send.firstSendAt, send.delivered, config.recencySampleTarget, send.name));
      await onProgress("cohorts", 40 + Math.round(((index + 1) / calibrationSends.length) * 5));
    }
    let recencyRows = brandRecencyRows;
    let recencyCalibration: SmartSegmentEvidence["recencyCalibration"] = {
      level: calibrationLevel,
      campaignIds: calibrationSends.map((send) => send.campaignId),
    };
    // The pool is a best-effort refinement: when the budget left would not
    // also cover block sizing and the recount, the non-active blocks are
    // omitted (fail closed) instead of failing the whole analysis.
    const RECENCY_POOL_BUDGET_RESERVE_MS = 90_000;
    const poolBudgetLeft = config.evidenceBudgetMs - runner.elapsedMs() > RECENCY_POOL_BUDGET_RESERVE_MS;
    if (bandsReliable(brandRecencyRows).length < NON_ACTIVE_RECENCY_BANDS.length && !poolBudgetLeft) {
      recencyRows = bandsReliable(brandRecencyRows).length ? brandRecencyRows : [];
      recencyCalibration = recencyRows.length ? recencyCalibration : null;
      notes.push("Budget d'analyse insuffisant pour calibrer la récence sur les envois récents toutes marques : les blocs sans activité 60 j non calibrés ne sont pas proposés.");
    } else if (bandsReliable(brandRecencyRows).length < NON_ACTIVE_RECENCY_BANDS.length) {
      const poolCandidates = await runner.query<{ id: string; name: string; status: string; first_send_at: Date | string; sent_count: string; delivered_rows: string }>(
        "envois récents toutes marques (récence)",
        RECENCY_POOL_CAMPAIGNS_SQL,
        [config.recencyPoolDays, MIN_CALIBRATION_DELIVERED, input.excludeCampaignId, calibrationSends.map((send) => send.campaignId), config.recencyPoolMaxCampaigns],
      );
      // Same finished criterion as the brand calibration: a send whose counter
      // has not rejoined its rows still has immature clicks and complaints.
      const poolRows = poolCandidates
        .filter((row) => isFinishedSend(row.status, Number(row.sent_count), Number(row.delivered_rows)) && Number(row.delivered_rows) >= MIN_CALIBRATION_DELIVERED)
        .slice(0, config.recencyPoolMaxCampaigns);
      const poolTarget = Math.max(2_000, Math.ceil(config.recencyPoolSampleTarget / Math.max(1, poolRows.length)));
      const pooled: RawCohortRow[] = [];
      for (const [index, row] of poolRows.entries()) {
        const firstSendAt = row.first_send_at instanceof Date ? row.first_send_at.toISOString() : String(row.first_send_at);
        pooled.push(...await recencyQuery(row.id, firstSendAt, Number(row.sent_count), poolTarget, row.name));
        campaignNames[row.id] = row.name;
        await onProgress("cohorts", 45 + Math.round(((index + 1) / poolRows.length) * 5));
      }
      const poolBands = bandsReliable(pooled);
      if (poolBands.length) {
        recencyRows = pooled;
        recencyCalibration = { level: "global", campaignIds: poolRows.map((row) => row.id) };
        notes.push(`Cohortes de récence (${poolBands.map((band) => RECENCY_BAND_LABELS[band]).join(", ")}) calibrées sur ${poolRows.length} envois récents toutes marques (repli global : CTR ×0,65, plaintes ×1,5) : les envois de la marque ne touchent pas assez de contacts sans activité 60 j.`);
      } else {
        recencyRows = bandsReliable(brandRecencyRows).length ? brandRecencyRows : [];
        recencyCalibration = recencyRows.length ? recencyCalibration : null;
        notes.push("Aucun envoi récent ne touche assez de contacts sans activité 60 j : les blocs « ouverts 61–180 j » et « dormants » ne sont pas proposés.");
      }
    }
    rawRows.push(...recencyRows);
    const cohortRates = aggregateCohortRates(rawRows);
    const recencyLevel: CalibrationLevel = recencyCalibration?.level ?? calibrationLevel;
    if (sampledCampaigns.length) {
      notes.push(`Envois volumineux mesurés sur un échantillon déterministe (1/${sampledCampaigns.map((s) => s.divisor).join(", 1/")}) ; les effectifs sont remis à l'échelle, les taux sont exacts sur l'échantillon.`);
    }

    // ── Stage 3: reservoirs ──────────────────────────────────────────────
    await onProgress("reservoirs", 55);
    const exclusions = mandatoryExclusions(input.brand, input.family, recentBrandCampaignIds);
    const exclusionOnly = exclusionRules(exclusions);
    // The compiled exclusion fragment is the only parameterised part of the
    // tier-mix statement, so its $1..$n placeholders can be embedded as-is.
    const tierWhere = dialect.sqlToQuery(compileSegmentRules(exclusionOnly));
    const tierRows = await runner.query<{ tier: string; count: string }>(
      "répartition des cliqueurs disponibles",
      tierMixSql(tierWhere.sql),
      tierWhere.params,
    );
    const tierCounts: TierCounts = {};
    for (const row of tierRows) tierCounts[row.tier as ClickerTier] = Number(row.count);

    // Fail closed: a non-active block without a reliable recency cohort is
    // omitted rather than projected at the actives' rates.
    const { projectable: definitions, omitted: omittedBlocks } = splitProjectableBlocks(buildBlockLibrary(input.brand), cohortRates);
    const blocks: SmartSegmentBlock[] = [];
    for (const [index, definition] of definitions.entries()) {
      const rules: SegmentRulesV2 = { version: 2, root: group("AND", [definition.rules, ...exclusions.map((entry) => entry.node)]) };
      const available = await runner.queryCount(`réservoir « ${definition.label} »`, compileCountQuery(rules));
      blocks.push(projectBlock(definition, available, cohortRates, calibrationLevel, tierCounts, recencyLevel, complaintFloor?.rate ?? 0));
      await onProgress("reservoirs", 55 + Math.round(((index + 1) / definitions.length) * 20));
    }
    const baselines = baselinesFromCohorts(cohortRates, calibrationLevel);
    if (baselines.orangeWanadooShare !== null) {
      notes.push(`Part Orange/Wanadoo des envois de calibrage : ${(baselines.orangeWanadooShare * 100).toFixed(1).replace(".", ",")} %${baselines.orangeWanadooComplaintRate !== null ? ` (plaintes mesurées ${(baselines.orangeWanadooComplaintRate * 100).toFixed(3).replace(".", ",")} % sur ces destinataires)` : ""}${baselines.unsubscribeRate !== null ? ` ; désabonnements ${(baselines.unsubscribeRate * 100).toFixed(3).replace(".", ",")} %` : ""}.`);
    }

    if (!recentBrandCampaignIds.length) {
      notes.push("Aucun envoi de la marque dans les 30 derniers jours : pas d'exclusion de destinataires récents à appliquer.");
    }
    if (!input.brand.detected) {
      notes.push("Marque sans ref connue : les réservoirs fondés sur les refs de la marque sont indisponibles.");
    }
    if (omittedBlocks.length) {
      notes.push(`Blocs non proposés faute de calibrage fiable : ${omittedBlocks.map((block) => block.id).join(", ")}.`);
    }
    let similarBrands: NonNullable<SmartSegmentEvidence["similarBrands"]> = [];
    if (similarRefs.length) {
      const nameRows = await runner.query<{ ref: string; name: string }>(
        "noms des marques similaires",
        `SELECT DISTINCT ON (upper(ref)) upper(ref) AS ref, name FROM brands WHERE upper(ref) = ANY($1::text[]) ORDER BY upper(ref), name`,
        [similarRefs],
      );
      const names = new Map(nameRows.map((row) => [row.ref, row.name]));
      similarBrands = similarRefs.map((ref) => ({ ref, brandName: names.get(ref) ?? null }));
    }

    return {
      version: 1,
      generatedAt: new Date().toISOString(),
      brand: input.brand,
      family: input.family,
      brandSends: [...brandSends, ...extraSends],
      recentBrandCampaignIds,
      campaignNames,
      calibrationLevel,
      calibrationCampaignIds: calibrationSends.map((send) => send.campaignId),
      cohortRates,
      recencyCalibration,
      similarBrands,
      omittedBlocks,
      blocks,
      mandatoryExclusions: exclusions.map((entry) => entry.label),
      budget: { elapsedMs: runner.elapsedMs(), queries: runner.queries(), sampledCampaigns },
      notes,
      mta: mtaEvidence,
      complaintFloor,
      baselines,
    };
  } catch (error) {
    if (error instanceof SmartSegmentError) throw error;
    logger.error("[SMART_SEGMENT] evidence engine failed", { error: (error as Error)?.message });
    throw new SmartSegmentError("EVIDENCE_FAILED", `Moteur de preuves en échec : ${(error as Error)?.message ?? String(error)}`);
  } finally {
    if (transaction) await transaction.close();
  }
}
