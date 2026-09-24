// « Projeté vs réel » — the actual figures of the campaigns that used a
// segment created by a Smart segment analysis of the same brand, next to what
// the analysis projected. Read-only, built from the cached campaign counters
// (the same ones the campaign list shows), so it costs one small query per
// panel and never touches campaign_sends.
import { pool } from "../db";
import type {
  SmartSegmentBrandResolution,
  SmartSegmentCreatedSegment,
  SmartSegmentOutcome,
  SmartSegmentOutcomeCampaign,
  SmartSegmentOutcomesResponse,
  SmartSegmentProposal,
} from "@shared/smart-segment";
import { resolveSmartSegmentBrand } from "./smart-segment-brand";

/** Analyses older than this are not compared any more (the base and the MTAs drift). */
export const OUTCOMES_WINDOW_DAYS = 180;
/** Most recent analyses of the brand shown in the panel. */
export const OUTCOMES_MAX_ANALYSES = 10;
/** Campaign statuses whose counters are final. */
const FINISHED_STATUSES = new Set(["completed", "sent"]);

type OutcomeQuery = <T extends Record<string, unknown>>(text: string, params: unknown[]) => Promise<{ rows: T[] }>;

type AnalysisOutcomeRow = {
  id: string;
  created_at: Date | string;
  params: { campaignName: string; family: SmartSegmentOutcome["family"] };
  evidence: { brand?: { brandName?: string | null }; mta?: { name?: string | null } | null } | null;
  proposal: SmartSegmentProposal;
  created_segments: SmartSegmentCreatedSegment[];
};

type CampaignOutcomeRow = {
  segment_id: string;
  campaign_id: string;
  name: string;
  status: string;
  mta_name: string | null;
  first_send_at: Date | string | null;
  segment_count: string;
  sent_count: string;
  unique_clicks_count: string;
  complaints_count: string;
  unsubscribes_count: string;
  orange_wanadoo_sent_count: string;
  orange_wanadoo_complaints_count: string;
};

/**
 * Analyses of the brand: same resolved brand name (case-insensitive) or a
 * shared core ref — so a renamed brand or a manual override still finds the
 * dossiers built for the same subscribers. Only analyses that created at
 * least one segment can have outcomes.
 */
export const OUTCOME_ANALYSES_SQL = `
  SELECT id, created_at, params, evidence, proposal, created_segments
    FROM smart_segment_analyses
   WHERE status = 'succeeded'
     AND proposal IS NOT NULL
     AND jsonb_typeof(created_segments) = 'array'
     AND jsonb_array_length(created_segments) > 0
     AND created_at >= NOW() - ($1::int * INTERVAL '1 day')
     AND (
       ($2::text IS NOT NULL AND lower(evidence->'brand'->>'brandName') = lower($2::text))
       OR (cardinality($3::text[]) > 0 AND (evidence->'brand'->'coreRefs') ?| $3::text[])
     )
   ORDER BY created_at DESC
   LIMIT $4::int`;

/**
 * Campaigns that used one of the given segments: through campaign_segments,
 * or through the legacy single-segment column for campaigns that predate the
 * relation. Drafts are skipped (nothing to compare yet).
 */
export const OUTCOME_CAMPAIGNS_SQL = `
  WITH usage AS (
    SELECT cs.segment_id, cs.campaign_id
      FROM campaign_segments cs
     WHERE cs.segment_id = ANY($1::varchar[])
    UNION
    SELECT c.segment_id, c.id AS campaign_id
      FROM campaigns c
     WHERE c.segment_id = ANY($1::varchar[])
       AND NOT EXISTS (SELECT 1 FROM campaign_segments cs WHERE cs.campaign_id = c.id)
  )
  SELECT u.segment_id, c.id AS campaign_id, c.name, c.status, m.name AS mta_name, c.first_send_at,
         (SELECT COUNT(*) FROM campaign_segments cs WHERE cs.campaign_id = c.id)::text AS segment_count,
         c.sent_count::text AS sent_count,
         c.unique_clicks_count::text AS unique_clicks_count,
         c.complaints_count::text AS complaints_count,
         c.unsubscribes_count::text AS unsubscribes_count,
         c.orange_wanadoo_sent_count::text AS orange_wanadoo_sent_count,
         c.orange_wanadoo_complaints_count::text AS orange_wanadoo_complaints_count
    FROM usage u
    INNER JOIN campaigns c ON c.id = u.campaign_id
    LEFT JOIN mtas m ON m.id = c.mta_id
   WHERE c.status <> 'draft'
   ORDER BY c.first_send_at DESC NULLS LAST, c.id ASC`;

function toIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toCampaign(row: CampaignOutcomeRow): SmartSegmentOutcomeCampaign {
  return {
    campaignId: row.campaign_id,
    name: row.name,
    status: row.status,
    mtaName: row.mta_name ?? null,
    firstSendAt: toIso(row.first_send_at),
    segmentCount: Math.max(1, Number(row.segment_count) || 0),
    sentCount: Number(row.sent_count) || 0,
    uniqueClicks: Number(row.unique_clicks_count) || 0,
    complaintsCount: Number(row.complaints_count) || 0,
    unsubscribesCount: Number(row.unsubscribes_count) || 0,
    orangeWanadooSentCount: Number(row.orange_wanadoo_sent_count) || 0,
    orangeWanadooComplaintsCount: Number(row.orange_wanadoo_complaints_count) || 0,
    finished: FINISHED_STATUSES.has(row.status),
  };
}

/** Pure assembly of the panel rows from the analyses and the campaigns that used their segments. */
export function assembleOutcomes(analyses: AnalysisOutcomeRow[], campaigns: CampaignOutcomeRow[]): SmartSegmentOutcome[] {
  const bySegment = new Map<string, SmartSegmentOutcomeCampaign[]>();
  for (const row of campaigns) {
    const list = bySegment.get(row.segment_id) ?? [];
    list.push(toCampaign(row));
    bySegment.set(row.segment_id, list);
  }
  const outcomes: SmartSegmentOutcome[] = [];
  for (const analysis of analyses) {
    const created = Array.isArray(analysis.created_segments) ? analysis.created_segments : [];
    for (const entry of [...created].sort((a, b) => a.index - b.index)) {
      const projected = analysis.proposal?.segments?.[entry.index];
      if (!projected) continue;
      outcomes.push({
        analysisId: analysis.id,
        analysedAt: toIso(analysis.created_at) ?? new Date(0).toISOString(),
        campaignName: analysis.params?.campaignName ?? "",
        family: analysis.params?.family,
        mtaName: analysis.evidence?.mta?.name ?? null,
        index: entry.index,
        segmentId: entry.id,
        segmentName: entry.name,
        kind: projected.kind ?? null,
        projected: {
          audienceCount: projected.audienceCount,
          clicks: projected.projectedClicks,
          complaintRate: projected.projectedComplaintRate,
          complaints: projected.projectedComplaints,
          unsubscribeRate: projected.projectedUnsubscribeRate ?? null,
          orangeWanadooShare: projected.orangeWanadoo?.share ?? null,
          orangeWanadooComplaintRate: projected.orangeWanadoo?.projectedComplaintRate ?? null,
        },
        campaigns: bySegment.get(entry.id) ?? [],
      });
    }
  }
  return outcomes;
}

export async function listSmartSegmentOutcomes(
  input: { campaignName: string; brandOverride?: { name: string; ref: string } | null },
  deps: { query?: OutcomeQuery; resolveBrand?: (input: { campaignName: string; brandOverride?: { name: string; ref: string } | null }) => Promise<SmartSegmentBrandResolution> } = {},
): Promise<SmartSegmentOutcomesResponse> {
  const query: OutcomeQuery = deps.query ?? ((text, params) => pool.query(text, params));
  const resolveBrand = deps.resolveBrand ?? resolveSmartSegmentBrand;
  const brand = await resolveBrand({ campaignName: input.campaignName, brandOverride: input.brandOverride ?? null });
  const brandName = brand.brandName?.trim() || null;
  const coreRefs = brand.coreRefs ?? [];
  if (!brandName && !coreRefs.length) return { brandName: null, outcomes: [] };
  const analyses = await query<AnalysisOutcomeRow>(OUTCOME_ANALYSES_SQL, [OUTCOMES_WINDOW_DAYS, brandName, coreRefs, OUTCOMES_MAX_ANALYSES]);
  const segmentIds = [...new Set(analyses.rows.flatMap((row) => (Array.isArray(row.created_segments) ? row.created_segments : []).map((entry) => entry.id)))];
  const campaigns = segmentIds.length ? (await query<CampaignOutcomeRow>(OUTCOME_CAMPAIGNS_SQL, [segmentIds])).rows : [];
  return { brandName, outcomes: assembleOutcomes(analyses.rows, campaigns) };
}
