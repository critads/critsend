export type OrangeWanadooMode = "observe" | "enforce";
export type OrangeWanadooRiskTier = "safe" | "cooling" | "probation" | "blocked";
export type OrangeWanadooValueTier = "none" | "engaged" | "high";
export type OrangeWanadooReasonCode =
  | "NON_TARGET_PROVIDER"
  | "NO_RECENT_DETECTION"
  | "ACTIVE_15D_COOLING"
  | "POST_COOLING_CLICKER_PROBATION"
  | "RECENT_REPEAT_DETECTION";

function ratioEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 && value < 1 ? value : fallback;
}

const configuredMode = String(process.env.ORANGE_WANADOO_RISK_MODE || "observe").toLowerCase();

/** Central, auditable policy. Rates are fractions (0.0045 = 0.45%). */
export const ORANGE_WANADOO_RISK_POLICY = Object.freeze({
  mode: (configuredMode === "enforce" ? "enforce" : "observe") as OrangeWanadooMode,
  targetRate: ratioEnv("ORANGE_WANADOO_TARGET_RATE", 0.0045),
  hardThreshold: ratioEnv("ORANGE_WANADOO_HARD_THRESHOLD", 0.006),
  coolingDays: 15,
  probationDays: 30,
  probationExposure: ratioEnv("ORANGE_WANADOO_PROBATION_EXPOSURE", 0.1),
  domains: ["orange.fr", "wanadoo.fr"] as const,
  projectedRates: {
    safe: 0.001,
    cooling: 0.012,
    probation: 0.0045,
    blocked: 0.018,
  } satisfies Record<OrangeWanadooRiskTier, number>,
});
