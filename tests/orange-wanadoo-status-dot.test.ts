import { describe, expect, it } from "vitest";
import { orangeWanadooStatusPresentation } from "../client/src/lib/orange-wanadoo-status";

describe("Orange/Wanadoo campaign status dot", () => {
  it.each([
    ["green", "bg-emerald-500", 0.0039, "0.39%"],
    ["orange", "bg-amber-500", 0.004, "0.40%"],
    ["red", "bg-destructive", 0.0061, "0.61%"],
  ] as const)("renders the %s state with an exact accessible rate", (status, cssClass, rate, label) => {
    const presentation = orangeWanadooStatusPresentation({
      id: `campaign-${status}`,
      name: "Campaign",
      orangeWanadooSentCount: 10_000,
      orangeWanadooComplaintsCount: Math.round(rate * 10_000),
      orangeWanadooComplaintRate: rate,
      orangeWanadooComplaintStatus: status,
    });

    expect(presentation.dotClassName).toBe(cssClass);
    expect(presentation.details).toContain(label);
    expect(presentation.testId).toBe(`orange-wanadoo-status-campaign-${status}`);
  });

  it("uses a neutral accessible state without a denominator", () => {
    const presentation = orangeWanadooStatusPresentation({
      id: "campaign-empty",
      name: "Campaign",
      orangeWanadooSentCount: 0,
      orangeWanadooComplaintsCount: 0,
      orangeWanadooComplaintRate: null,
      orangeWanadooComplaintStatus: "unknown",
    });

    expect(presentation.dotClassName).toBe("bg-muted-foreground/50");
    expect(presentation.details).toContain("no delivered denominator");
  });
});