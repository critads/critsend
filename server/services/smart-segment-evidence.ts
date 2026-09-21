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
  type SmartSegmentBlock,
  type SmartSegmentBrandResolution,
  type SmartSegmentBrandSend,
  type SmartSegmentEvidence,
  type SmartSegmentStage,
} from "@shared/smart-segment";
import { compileCountQuery, compileSegmentRules, EXCLUDED_BOT_OPEN_IP } from "./segment-compiler";
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
  group,
  mandatoryExclusions,
  projectBlock,
  sampleDivisorFor,
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
};

function toBrandSend(row: CampaignStatsRow, segmentNames: string[]): SmartSegmentBrandSend {
  const delivered = Number(row.sent_count) || 0;
  const deliveredRows = Number(row.delivered_rows) || 0;
  const clickers = Number(row.clickers) || 0;
  const botClickers = Number(row.bot_clickers) || 0;
  const humanClickers = Math.max(0, clickers - botClickers);
  const complaints = Number(row.complaints_count) || 0;
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
  };
}

const CAMPAIGN_STATS_SQL = `
  SELECT c.id, c.name, c.status, c.first_send_at,
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
   WHERE c.id = ANY($1::text[])
   ORDER BY c.first_send_at DESC, c.id ASC`;

const COHORT_SQL = `
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
  enriched AS (
    SELECT r.clicked,
           CASE WHEN p.n IS NULL THEN '0' WHEN p.n = 1 THEN '1' WHEN p.n <= 3 THEN '2-3' WHEN p.n <= 5 THEN '4-5' ELSE '6+' END AS tier,
           CASE WHEN s.refs && $3::text[] THEN 'core' WHEN s.refs && $4::text[] THEN 'extension' ELSE 'none' END AS ref_relation,
           CASE WHEN lower(split_part(s.email, '@', 2)) = ANY($5::text[]) THEN 'in_family' ELSE 'other' END AS family,
           (d.subscriber_id IS NOT NULL) AS bot,
           (cd.subscriber_id IS NOT NULL) AS complained
      FROM recipients r
      JOIN subscribers s ON s.id = r.subscriber_id
      LEFT JOIN prior p ON p.subscriber_id = r.subscriber_id
      LEFT JOIN detected d ON d.subscriber_id = r.subscriber_id
      LEFT JOIN campaign_detected cd ON cd.subscriber_id = r.subscriber_id
  )
  SELECT axis, cohort,
         COUNT(*)::text AS delivered,
         COUNT(*) FILTER (WHERE clicked AND NOT bot)::text AS human_clickers,
         COUNT(*) FILTER (WHERE clicked AND bot)::text AS bot_clickers,
         COUNT(*) FILTER (WHERE complained)::text AS complaints
    FROM (
      SELECT 'clicker_tier' AS axis, tier AS cohort, clicked, bot, complained FROM enriched
      UNION ALL SELECT 'ref_relation', ref_relation, clicked, bot, complained FROM enriched
      UNION ALL SELECT 'family', family, clicked, bot, complained FROM enriched
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
  }
  return { total, tierCounts };
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

function brandForHistory(input: EvidenceInput): CampaignBrand | null {
  return extractCampaignBrand(input.brand.brandName ?? input.campaignName) ?? extractCampaignBrand(input.campaignName);
}

function exclusionRules(nodes: Array<{ node: SegmentGroup | SegmentGroup["children"][number] }>): SegmentRulesV2 {
  return { version: 2, root: group("AND", nodes.map((entry) => entry.node)) };
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
    const segmentNamesByCampaign = new Map<string, string[]>();
    let brandCampaignIds: string[] = [];
    if (brand) {
      // Deliberately outside the evidence transaction: this is the same
      // bounded, indexed `campaigns` lookup the segment-performance panel
      // runs on the main pool (no campaign_sends scan), so it does not need
      // the statement_timeout / snapshot of the heavy queries below.
      const candidates = await getSegmentPerformanceHistoryCandidates(historicalBrandKeys(brand), input.excludeCampaignId);
      for (const candidate of candidates) {
        const names = segmentNamesByCampaign.get(candidate.campaignId) ?? [];
        if (!names.includes(candidate.segmentName)) names.push(candidate.segmentName);
        segmentNamesByCampaign.set(candidate.campaignId, names);
      }
      brandCampaignIds = [...segmentNamesByCampaign.keys()].slice(0, MAX_BRAND_SENDS);
    }
    const brandRows = brandCampaignIds.length
      ? await runner.query<CampaignStatsRow>("historique de la marque", CAMPAIGN_STATS_SQL, [brandCampaignIds])
      : [];
    const brandSends = brandRows.map((row) => toBrandSend(row, segmentNamesByCampaign.get(row.id) ?? []));

    // Recent sends of the brand (any live status) whose recipients must be
    // excluded — includes campaigns still sending, which the completed-only
    // history query above cannot see.
    let recentBrandCampaignIds: string[] = [];
    if (brand) {
      // Raw first word of the label (not the normalised token) so accented
      // brand names still match ILIKE; campaignMatchesBrand does the exact
      // token comparison afterwards.
      const firstWord = (brand.label.split(/\s+/)[0] ?? brand.tokens[0]).replace(/[\\%_]/g, (c) => `\\${c}`);
      const pattern = `%${firstWord}%`;
      const recentRows = await runner.query<{ id: string; name: string }>(
        "envois récents de la marque",
        `SELECT id, name FROM campaigns
          WHERE name ILIKE $1
            AND first_send_at IS NOT NULL
            AND first_send_at >= NOW() - ($2::int * INTERVAL '1 day')
            AND status <> 'draft'
            AND ($3::text IS NULL OR id <> $3)
          ORDER BY first_send_at DESC
          LIMIT 50`,
        [pattern, config.recentBrandSendDays, input.excludeCampaignId],
      );
      const recentMatches = recentRows.filter((row) => campaignMatchesBrand(row.name, brand));
      recentBrandCampaignIds = recentMatches.map((row) => row.id);
      for (const row of recentMatches) campaignNames[row.id] = row.name;
    }
    await onProgress("brand_history", 15);

    // ── Calibration level ────────────────────────────────────────────────
    let calibrationLevel: CalibrationLevel = "brand";
    let calibrationSends = brandSends.filter((send) => send.finished && send.delivered >= MIN_CALIBRATION_DELIVERED).slice(0, MAX_CALIBRATION_SENDS);
    if (!calibrationSends.length) {
      const fallbackRows = await runner.query<{ id: string; name: string }>(
        "candidats de repli",
        `SELECT id, name FROM campaigns
          WHERE status IN ('completed', 'sent')
            AND first_send_at IS NOT NULL
            AND sent_count >= $1
            AND ($2::text IS NULL OR id <> $2)
          ORDER BY first_send_at DESC
          LIMIT 150`,
        [MIN_CALIBRATION_DELIVERED, input.excludeCampaignId],
      );
      let verticalKeys = new Set<string>();
      if (input.brand.vertical) {
        const verticalBrands = await runner.query<{ name: string }>(
          "marques de la verticale",
          `SELECT DISTINCT name FROM brands WHERE lower(ref) LIKE $1 LIMIT 300`,
          [`${input.brand.vertical}%`],
        );
        verticalKeys = new Set(verticalBrands.map((row) => extractCampaignBrand(row.name)?.key).filter((key): key is string => !!key));
      }
      const verticalCandidates = fallbackRows.filter((row) => {
        const key = extractCampaignBrand(row.name)?.key;
        return key ? verticalKeys.has(key) : false;
      });
      const pick = async (rows: Array<{ id: string }>, level: CalibrationLevel) => {
        const ids = rows.slice(0, 8).map((row) => row.id);
        if (!ids.length) return [] as SmartSegmentBrandSend[];
        const statRows = await runner.query<CampaignStatsRow>(`statistiques de repli (${level})`, CAMPAIGN_STATS_SQL, [ids]);
        return statRows.map((row) => toBrandSend(row, [])).filter((send) => send.finished && send.delivered >= MIN_CALIBRATION_DELIVERED).slice(0, MAX_CALIBRATION_SENDS);
      };
      if (verticalCandidates.length) {
        calibrationSends = await pick(verticalCandidates, "vertical");
        if (calibrationSends.length) calibrationLevel = "vertical";
      }
      if (!calibrationSends.length) {
        calibrationSends = await pick(fallbackRows, "global");
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
    for (const send of brandSends) {
      send.usedForCalibration = calibrationSends.some((c) => c.campaignId === send.campaignId);
    }
    for (const send of calibrationSends) send.usedForCalibration = true;
    const brandSendIds = new Set(brandSends.map((send) => send.campaignId));
    const extraSends = calibrationSends.filter((send) => !brandSendIds.has(send.campaignId));
    for (const send of [...brandSends, ...extraSends]) campaignNames[send.campaignId] = send.name;

    // ── Stage 2: cohorts ─────────────────────────────────────────────────
    await onProgress("cohorts", 25);
    const familyDomains = [...DOMAIN_FAMILIES[input.family].domains];
    const rawRows: RawCohortRow[] = [];
    for (const [index, send] of calibrationSends.entries()) {
      const divisor = sampleDivisorFor(send.delivered, config.cohortSampleTarget);
      if (divisor > 1) sampledCampaigns.push({ campaignId: send.campaignId, divisor });
      const rows = await runner.query<{ axis: string; cohort: string; delivered: string; human_clickers: string; bot_clickers: string; complaints: string }>(
        `cohortes « ${send.name} »`,
        COHORT_SQL,
        [send.campaignId, send.firstSendAt, input.brand.coreRefs, input.brand.extensionRefs, familyDomains, divisor],
      );
      for (const row of rows) {
        rawRows.push({
          axis: row.axis as RawCohortRow["axis"],
          cohort: row.cohort,
          delivered: Number(row.delivered) * divisor,
          humanClickers: Number(row.human_clickers) * divisor,
          botClickers: Number(row.bot_clickers) * divisor,
          complaints: Number(row.complaints) * divisor,
        });
      }
      await onProgress("cohorts", 25 + Math.round(((index + 1) / calibrationSends.length) * 25));
    }
    const cohortRates = aggregateCohortRates(rawRows);
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

    const definitions = buildBlockLibrary(input.brand);
    const blocks: SmartSegmentBlock[] = [];
    for (const [index, definition] of definitions.entries()) {
      const rules: SegmentRulesV2 = { version: 2, root: group("AND", [definition.rules, ...exclusions.map((entry) => entry.node)]) };
      const available = await runner.queryCount(`réservoir « ${definition.label} »`, compileCountQuery(rules));
      blocks.push(projectBlock(definition, available, cohortRates, calibrationLevel, tierCounts));
      await onProgress("reservoirs", 55 + Math.round(((index + 1) / definitions.length) * 20));
    }

    if (!recentBrandCampaignIds.length) {
      notes.push("Aucun envoi de la marque dans les 30 derniers jours : pas d'exclusion de destinataires récents à appliquer.");
    }
    if (!input.brand.detected) {
      notes.push("Marque sans ref connue : les réservoirs fondés sur les refs de la marque sont indisponibles.");
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
      blocks,
      mandatoryExclusions: exclusions.map((entry) => entry.label),
      budget: { elapsedMs: runner.elapsedMs(), queries: runner.queries(), sampledCampaigns },
      notes,
    };
  } catch (error) {
    if (error instanceof SmartSegmentError) throw error;
    logger.error("[SMART_SEGMENT] evidence engine failed", { error: (error as Error)?.message });
    throw new SmartSegmentError("EVIDENCE_FAILED", `Moteur de preuves en échec : ${(error as Error)?.message ?? String(error)}`);
  } finally {
    if (transaction) await transaction.close();
  }
}
