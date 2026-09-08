import { describe, expect, it } from "vitest";
import {
  calculateRiskDecision,
  complaintStatus,
  deterministicProbationExposure,
  summarizeRisk,
} from "../server/services/orange-wanadoo-risk";

const asOf = new Date("2026-06-01T00:00:00Z");

describe("Orange/Wanadoo risk policy", () => {
  it("uses exact complaint status boundaries", () => {
    expect(complaintStatus(0, 0)).toBe("unknown");
    expect(complaintStatus(10_000, 39)).toBe("green");
    expect(complaintStatus(10_000, 40)).toBe("orange");
    expect(complaintStatus(10_000, 60)).toBe("orange");
    expect(complaintStatus(10_000, 61)).toBe("red");
  });

  it("cools temporarily and reintroduces clickers on probation without permanent exclusion", () => {
    const cooling = calculateRiskDecision({
      subscriberId: "s1",
      email: "a@orange.fr",
      lastDetectionAt: "2026-05-20T00:00:00Z",
      detections15d: 1,
      distinctClickedCampaigns30d: 4,
      asOf,
    }, "c1");
    expect(cooling.riskTier).toBe("cooling");
    expect(cooling.reasonCode).toBe("ACTIVE_15D_COOLING");

    const probation = calculateRiskDecision({
      subscriberId: "s1",
      email: "a@orange.fr",
      lastDetectionAt: "2026-05-16T00:00:00Z",
      detections15d: 0,
      distinctClickedCampaigns30d: 4,
      asOf,
    }, "c1");
    expect(probation.riskTier).toBe("probation");

    const recovered = calculateRiskDecision({
      subscriberId: "s1",
      email: "a@orange.fr",
      lastDetectionAt: "2026-04-01T00:00:00Z",
      detections15d: 0,
      distinctClickedCampaigns30d: 4,
      asOf,
    }, "c1");
    expect(recovered.riskTier).toBe("safe");
    expect(recovered.eligible).toBe(true);
  });

  it("is deterministic and observe mode never changes eligibility", () => {
    expect(deterministicProbationExposure("s1", "c1")).toBe(
      deterministicProbationExposure("s1", "c1"),
    );
    const repeat = calculateRiskDecision({
      subscriberId: "s2",
      email: "b@wanadoo.fr",
      lastDetectionAt: "2026-05-31T00:00:00Z",
      detections15d: 2,
      asOf,
    }, "c1");
    expect(repeat.riskTier).toBe("blocked");
    expect(repeat.eligible).toBe(true);
  });

  it("returns the complete preflight contract", () => {
    const summary = summarizeRisk([
      calculateRiskDecision({ subscriberId: "a", email: "a@orange.fr", asOf }, "c"),
      calculateRiskDecision({ subscriberId: "b", email: "b@example.com", asOf }, "c"),
    ]);
    expect(summary).toMatchObject({
      mode: "observe",
      thresholds: { targetRate: 0.0045, hardThreshold: 0.006 },
      countsByTier: { safe: 1, cooling: 0, probation: 0, blocked: 0 },
    });
    expect(summary.projectedRate).toBeTypeOf("number");
    expect(summary.upperRate).toBeTypeOf("number");
    expect(summary.allowedProbation).toBeTypeOf("number");
    expect(summary.warnings).toBeInstanceOf(Array);
  });

  it("uses actual deterministic probation selections in batch summaries", () => {
    // Batch classification has individual decisions, so its projected
    // recipient count must not round an expected fraction separately for each
    // batch (which would drift with small batches).
    const summary = summarizeRisk([
      {
        targetProvider: true,
        riskTier: "probation" as const,
        valueTier: "engaged" as const,
        reasonCode: "POST_COOLING_CLICKER_PROBATION" as const,
        probationSelected: true,
        eligible: true,
      },
      {
        targetProvider: true,
        riskTier: "probation" as const,
        valueTier: "engaged" as const,
        reasonCode: "POST_COOLING_CLICKER_PROBATION" as const,
        probationSelected: false,
        eligible: true,
      },
    ]);
    expect(summary.countsByTier.probation).toBe(2);
    expect(summary.allowedProbation).toBe(1);
    expect(summary.projectedRecipients).toBe(1);
  });
});
