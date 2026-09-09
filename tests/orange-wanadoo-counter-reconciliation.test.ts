import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Orange/Wanadoo campaign counter reconciliation", () => {
  it("counts both legacy open detections and complaint rows from the complaint IP", () => {
    const source = readFileSync(
      "server/workers/counter-reconciler.ts",
      "utf8",
    );

    expect(source).toContain("type IN ('open', 'complaint')");
    expect(source).toContain("ip_address='195.154.17.225'");
  });

  it("keeps historical reconstruction outside the campaign list request", () => {
    const listSource = readFileSync(
      "server/repositories/campaign-repository.ts",
      "utf8",
    );
    const scriptSource = readFileSync(
      "scripts/reconcile-orange-wanadoo-campaign-counters.ts",
      "utf8",
    );

    expect(listSource).not.toContain("orangeWanadooBackfillIds");
    expect(scriptSource).toContain("--campaign=<id>");
    expect(scriptSource).toContain("--confirm=orange-wanadoo-counter-reconcile");
  });
});