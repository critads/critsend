import crypto from "crypto";
import {
  ORANGE_WANADOO_RISK_POLICY as policy,
  type OrangeWanadooReasonCode,
  type OrangeWanadooRiskTier,
  type OrangeWanadooValueTier,
} from "../config/orange-wanadoo-risk";
import { logger } from "../logger";

export interface RiskProfileInput {
  subscriberId: string;
  email: string;
  lastDetectionAt?: Date | string | null;
  detections15d?: number | null;
  detections30d?: number | null;
  distinctClickedCampaigns30d?: number | null;
  asOf?: Date;
}

export interface RiskDecision {
  targetProvider: boolean;
  riskTier: OrangeWanadooRiskTier;
  valueTier: OrangeWanadooValueTier;
  reasonCode: OrangeWanadooReasonCode;
  probationSelected: boolean;
  eligible: boolean;
}

export type RiskCountsByTier = Record<OrangeWanadooRiskTier, number>;

function emptyRiskCounts(): RiskCountsByTier {
  return { safe: 0, cooling: 0, probation: 0, blocked: 0 };
}

export function isOrangeWanadooEmail(email: string): boolean {
  const domain = email.trim().toLowerCase().split("@").pop() || "";
  return (policy.domains as readonly string[]).includes(domain);
}

export function deterministicProbationExposure(subscriberId: string, campaignId: string, fraction = policy.probationExposure): boolean {
  if (fraction <= 0) return false;
  if (fraction >= 1) return true;
  const digest = crypto.createHash("sha256").update(`${campaignId}\0${subscriberId}`).digest();
  return digest.readUInt32BE(0) / 0x1_0000_0000 < fraction;
}

export function calculateRiskDecision(input: RiskProfileInput, campaignId = ""): RiskDecision {
  if (!isOrangeWanadooEmail(input.email)) {
    return { targetProvider: false, riskTier: "safe", valueTier: "none", reasonCode: "NON_TARGET_PROVIDER", probationSelected: true, eligible: true };
  }
  const clicks = Math.max(0, Number(input.distinctClickedCampaigns30d) || 0);
  const valueTier: OrangeWanadooValueTier = clicks >= 3 ? "high" : clicks >= 1 ? "engaged" : "none";
  const asOf = input.asOf ?? new Date();
  const last = input.lastDetectionAt ? new Date(input.lastDetectionAt) : null;
  const ageDays = last && Number.isFinite(last.getTime()) ? (asOf.getTime() - last.getTime()) / 86_400_000 : Infinity;
  let riskTier: OrangeWanadooRiskTier;
  let reasonCode: OrangeWanadooReasonCode;
  if (ageDays < policy.coolingDays) {
    riskTier = (Number(input.detections15d) || 0) >= 2 ? "blocked" : "cooling";
    reasonCode = riskTier === "blocked" ? "RECENT_REPEAT_DETECTION" : "ACTIVE_15D_COOLING";
  } else if (ageDays < policy.probationDays && clicks > 0) {
    riskTier = "probation";
    reasonCode = "POST_COOLING_CLICKER_PROBATION";
  } else {
    riskTier = "safe";
    reasonCode = "NO_RECENT_DETECTION";
  }
  const probationSelected = riskTier !== "probation" || deterministicProbationExposure(input.subscriberId, campaignId);
  const wouldBlock = riskTier === "blocked" || riskTier === "cooling" || !probationSelected;
  return {
    targetProvider: true,
    riskTier,
    valueTier,
    reasonCode,
    probationSelected,
    eligible: policy.mode === "observe" || !wouldBlock,
  };
}

export function complaintStatus(sent: number, complaints: number): "green" | "orange" | "red" | "unknown" {
  if (sent <= 0) return "unknown";
  const rate = complaints / sent;
  if (rate < 0.004) return "green";
  if (rate <= 0.006) return "orange";
  return "red";
}

export function summarizeRiskCounts(countsByTier: RiskCountsByTier, selectedProbation?: number) {
  const total = Object.values(countsByTier).reduce((a, b) => a + b, 0);
  const allowedProbation = Math.min(
    countsByTier.probation,
    Math.max(0, selectedProbation ?? Math.floor(countsByTier.probation * policy.probationExposure)),
  );
  const projectedRecipients = countsByTier.safe + allowedProbation;
  const projectedComplaints =
    countsByTier.safe * policy.projectedRates.safe
    + allowedProbation * policy.projectedRates.probation;
  const projectedRate = projectedRecipients ? projectedComplaints / projectedRecipients : 0;
  const upperRate = projectedRecipients
    ? Math.min(1, projectedRate + 1.96 * Math.sqrt(projectedRate * (1 - projectedRate) / projectedRecipients))
    : 0;
  const wouldBlockCount = countsByTier.cooling
    + countsByTier.blocked
    + Math.max(0, countsByTier.probation - allowedProbation);
  const warnings: string[] = [];
  if (upperRate > policy.targetRate) warnings.push("PROJECTED_UPPER_RATE_ABOVE_TARGET");
  if (projectedRate > policy.hardThreshold) warnings.push("PROJECTED_RATE_ABOVE_HARD_THRESHOLD");
  return {
    mode: policy.mode,
    thresholds: { targetRate: policy.targetRate, hardThreshold: policy.hardThreshold },
    countsByTier,
    total,
    projectedRecipients,
    wouldBlockCount,
    projectedRate,
    upperRate,
    allowedProbation,
    warnings,
  };
}

export function summarizeRisk(decisions: RiskDecision[]) {
  const countsByTier = emptyRiskCounts();
  let selectedProbation = 0;
  for (const decision of decisions) {
    if (decision.targetProvider) {
      countsByTier[decision.riskTier]++;
      if (decision.riskTier === "probation" && decision.probationSelected) selectedProbation++;
    }
  }
  // The audience path has the actual deterministic selection decisions.
  // Use them rather than rounding an expected exposure fraction per batch.
  return summarizeRiskCounts(countsByTier, selectedProbation);
}

export async function campaignRiskPreflight(input: {
  campaignId?: string;
  segmentIds?: string[];
  excludeSegmentId?: string;
}) {
  const [{ storage }, { pool }] = await Promise.all([import("../storage"), import("../db")]);
  let campaignId = input.campaignId || "segment-preflight";
  let segmentIds = input.segmentIds || [];
  let excludeSegmentId = input.excludeSegmentId;
  let parentCampaignId: string | undefined;
  if (input.campaignId) {
    const campaign = await storage.getCampaign(input.campaignId);
    if (!campaign) return null;
    segmentIds = (campaign as any).segmentIds ?? (campaign.segmentId ? [campaign.segmentId] : []);
    excludeSegmentId = campaign.excludeSegmentId ?? undefined;
    parentCampaignId = campaign.parentCampaignId ?? undefined;
  }
  const countsByTier = emptyRiskCounts();
  let cursor: string | undefined;
  for (;;) {
    const batch = parentCampaignId
      ? await storage.getOpenersForParentCampaignCursor(parentCampaignId, 10_000, cursor, true)
      : await storage.getSubscribersForSegmentsCursor(segmentIds, 10_000, cursor, excludeSegmentId, true);
    if (batch.length === 0) break;
    const ids = batch.map((subscriber) => subscriber.id);
    const profiles = await pool.query(
      `SELECT subscriber_id, last_detection_at, detections_15d,
              detections_30d, distinct_clicked_campaigns_30d
         FROM subscriber_risk_profiles WHERE subscriber_id = ANY($1::varchar[])`,
      [ids],
    );
    const byId = new Map(profiles.rows.map((row: any) => [row.subscriber_id, row]));
    for (const subscriber of batch) {
      const profile: any = byId.get(subscriber.id);
      const decision = calculateRiskDecision({
        subscriberId: subscriber.id,
        email: subscriber.email,
        lastDetectionAt: profile?.last_detection_at,
        detections15d: profile?.detections_15d,
        detections30d: profile?.detections_30d,
        distinctClickedCampaigns30d: profile?.distinct_clicked_campaigns_30d,
      }, campaignId);
      if (decision.targetProvider) countsByTier[decision.riskTier]++;
    }
    cursor = batch[batch.length - 1].id;
    if (batch.length < 10_000) break;
  }
  return summarizeRiskCounts(countsByTier);
}

export async function classifyAudienceBatch<T extends { id: string; email: string }>(
  campaignId: string,
  batchCursor: string,
  subscribers: T[],
  options: { decrementPendingForBlocked?: boolean } = {},
): Promise<{ subscribers: T[]; summary: ReturnType<typeof summarizeRisk>; newlyAudited: boolean }> {
  if (subscribers.length === 0) {
    return { subscribers, summary: summarizeRisk([]), newlyAudited: false };
  }
  const { pool } = await import("../db");
  const ids = subscribers.map((subscriber) => subscriber.id);
  let profiles: { rows: any[] };
  try {
    profiles = await pool.query(
      `SELECT subscriber_id, last_detection_at, detections_15d,
              detections_30d, distinct_clicked_campaigns_30d
         FROM subscriber_risk_profiles WHERE subscriber_id = ANY($1::varchar[])`,
      [ids],
    );
  } catch (error) {
    logger.error("[ORANGE_WANADOO] profile lookup failed", {
      campaignId,
      error: error instanceof Error ? error.message : String(error),
    });
    if (policy.mode === "enforce") throw error;
    return { subscribers, summary: summarizeRisk([]), newlyAudited: false };
  }
  const byId = new Map(profiles.rows.map((row: any) => [row.subscriber_id, row]));
  const decisions = subscribers.map((subscriber) => {
    const profile: any = byId.get(subscriber.id);
    return calculateRiskDecision({
      subscriberId: subscriber.id,
      email: subscriber.email,
      lastDetectionAt: profile?.last_detection_at,
      detections15d: profile?.detections_15d,
      detections30d: profile?.detections_30d,
      distinctClickedCampaigns30d: profile?.distinct_clicked_campaigns_30d,
    }, campaignId);
  });
  const summary = summarizeRisk(decisions);
  let wouldBlockCount = decisions.filter((decision) => decision.targetProvider && !(
    decision.riskTier === "safe" || (decision.riskTier === "probation" && decision.probationSelected)
  )).length;
  let complaintTargetReached = false;
  if (policy.mode === "enforce" && decisions.some((decision) => decision.riskTier === "probation")) {
    try {
      const rate = await pool.query(
        `SELECT orange_wanadoo_sent_count AS sent,
                orange_wanadoo_complaints_count AS complaints
         FROM campaigns
         WHERE id = $1`,
        [campaignId],
      );
      const row: any = rate.rows[0] ?? {};
      const sent = Number(row.sent ?? 0);
      const complaints = Number(row.complaints ?? 0);
      complaintTargetReached = sent > 0 && complaints / sent >= policy.targetRate;
      if (complaintTargetReached) {
        const additionallyBlocked = decisions.filter(
          (decision) => decision.riskTier === "probation" && decision.probationSelected,
        ).length;
        wouldBlockCount += additionallyBlocked;
        summary.wouldBlockCount += additionallyBlocked;
        summary.projectedRecipients = summary.countsByTier.safe;
        summary.allowedProbation = 0;
        summary.projectedRate = summary.projectedRecipients > 0 ? policy.projectedRates.safe : 0;
        summary.upperRate = summary.projectedRecipients > 0
          ? Math.min(
              1,
              summary.projectedRate
                + 1.96 * Math.sqrt(
                  summary.projectedRate * (1 - summary.projectedRate) / summary.projectedRecipients,
                ),
            )
          : 0;
        summary.warnings.push("CAMPAIGN_TARGET_REACHED");
        logger.warn("[ORANGE_WANADOO] campaign complaint target reached; probation admissions stopped", {
          campaignId, sent, complaints, targetRate: policy.targetRate,
        });
      }
    } catch (error) {
      logger.error("[ORANGE_WANADOO] complaint-rate lookup failed", {
        campaignId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
  const classifiedSubscribers = policy.mode === "observe"
    ? subscribers
    : subscribers.filter((_subscriber, index) =>
      decisions[index].eligible && !(complaintTargetReached && decisions[index].riskTier === "probation"),
    );
  const skippedCount = subscribers.length - classifiedSubscribers.length;
  let newlyAudited = false;
  try {
    const inserted = await pool.query(
      `WITH inserted AS (
         INSERT INTO orange_wanadoo_risk_audit
           (campaign_id, batch_cursor, mode, counts_by_tier, would_block_count)
         VALUES ($1,$2,$3,$4::jsonb,$5)
         ON CONFLICT (campaign_id,batch_cursor) DO NOTHING
         RETURNING 1
       ), adjusted AS (
         UPDATE campaigns
         SET pending_count=GREATEST(pending_count-$6,0)
         WHERE id=$1
           AND $7::boolean
           AND $6 > 0
           AND EXISTS (SELECT 1 FROM inserted)
         RETURNING 1
       )
       SELECT EXISTS (SELECT 1 FROM inserted) AS inserted,
              EXISTS (SELECT 1 FROM adjusted) AS adjusted`,
      [
        campaignId,
        batchCursor,
        policy.mode,
        JSON.stringify(summary.countsByTier),
        wouldBlockCount,
        skippedCount,
        options.decrementPendingForBlocked === true && policy.mode === "enforce",
      ],
    );
    newlyAudited = inserted.rows[0]?.inserted === true;
  } catch (error) {
    logger.error("[ORANGE_WANADOO] audit write failed", {
      campaignId,
      error: error instanceof Error ? error.message : String(error),
    });
    if (policy.mode === "enforce") throw error;
    return { subscribers, summary, newlyAudited: false };
  }
  return {
    subscribers: classifiedSubscribers,
    summary,
    newlyAudited,
  };
}
