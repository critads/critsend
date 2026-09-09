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

  it("walks history in bounded resumable batches and includes zero truths", () => {
    const source = readFileSync(
      "server/workers/counter-reconciler.ts",
      "utf8",
    );

    expect(source).toContain("orange_wanadoo_counter_reconcile_state");
    expect(source).toContain("pg_try_advisory_xact_lock");
    expect(source).toContain("cursor_created_at");
    expect(source).toContain("Math.min(10_000");
    expect(source).toContain("WITH send_chunk AS MATERIALIZED");
    expect(source).toContain("send_cursor_subscriber_id");
    expect(source).toContain("accumulated_complaints");
    expect(source).toContain("'failed', 'completed', 'sent', 'cancelled'");
    expect(source).toContain("total_retention_preserved");
    expect(source).toContain("accumulated_total_sent");
    expect(source).toContain("phase = 'stats'");
    expect(source).toContain("GREATEST(c.orange_wanadoo_sent_count, $1)");
  });
});