import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  insertCampaignDraftSchema,
  updateCampaignDraftSchema,
} from "../shared/schema";
import { calculateWarmStartCap } from "../server/services/campaign-warm-start";

describe("campaign active-clicker warm start", () => {
  it("applies clicker, 30 percent, and absolute caps", () => {
    expect(calculateWarmStartCap(100, 90)).toBe(30);
    expect(calculateWarmStartCap(100, 12)).toBe(12);
    expect(calculateWarmStartCap(1_000_000, 400_000)).toBe(50_000);
    expect(calculateWarmStartCap(3, 3)).toBe(0);
  });

  it("validates the toggle on draft create and patch", () => {
    const created = insertCampaignDraftSchema.parse({
      name: "Warm draft",
      prioritizeActiveClickers: true,
    });
    expect(created.prioritizeActiveClickers).toBe(true);
    expect(updateCampaignDraftSchema.safeParse({ prioritizeActiveClickers: "true" }).success).toBe(false);
    expect(updateCampaignDraftSchema.parse({ prioritizeActiveClickers: false }).prioritizeActiveClickers).toBe(false);
  });

  it("uses an inclusive lower and exclusive upper fixed 30-day window", () => {
    const source = readFileSync("server/repositories/subscriber-repository.ts", "utf8");
    expect(source).toContain("timestamp >= ${cutoff}::timestamp - INTERVAL '30 days'");
    expect(source).toContain("timestamp < ${cutoff}");
  });

  it("persists warm cursor after finalization and phase before normal pass", () => {
    const source = readFileSync("server/services/campaign-sender.ts", "utf8");
    const finalFlush = source.indexOf("await flushBuffer();", source.indexOf("while (!shouldStop)"));
    const warmCheckpoint = source.indexOf("warmCursorId ?? null,", finalFlush);
    expect(warmCheckpoint).toBeGreaterThan(finalFlush);
    expect(source).toContain("cursorId ?? null, \"normal\", stepExecutionVersion");
    expect(source).toContain("cursorId = (campaign as any).stepCursorId ?? undefined");
  });

  it("keeps both phases on the shared risk, reservation and campaign-send dedupe path", () => {
    const source = readFileSync("server/services/campaign-sender.ts", "utf8");
    expect(source.match(/classifyAudienceBatch\(/g)?.length).toBeGreaterThanOrEqual(2);
    expect(source).toContain("pressureGuardReserveSendSlots(campaignId, subscriberIds)");
    const repo = readFileSync("server/repositories/campaign-repository.ts", "utf8");
    expect(repo).toContain("ON CONFLICT (campaign_id, subscriber_id) DO NOTHING");
  });

  it("does not plan or alter iteration when the toggle is off", () => {
    const source = readFileSync("server/services/campaign-sender.ts", "utf8");
    expect(source).toContain("} else if (campaign.prioritizeActiveClickers) {");
    expect(source).toContain("let audiencePhase: \"warm\" | \"normal\" = \"normal\"");
  });

  it("guards launch mutations under row locks in PATCH and send", () => {
    const routes = readFileSync("server/routes/campaigns.ts", "utf8");
    expect(routes.match(/\.for\("update"\)/g)?.length).toBeGreaterThanOrEqual(2);
    expect(routes).toContain("WARM_EXECUTION_STATUSES.has(locked.status)");
    expect(routes).toContain("throw new WarmCampaignImmutableError");
    expect(routes).toContain("\"warmEngagementCutoff\", \"warmEligibleCount\"");
  });

  it("uses monotonic status-and-phase guarded warm checkpoints", () => {
    const repo = readFileSync("server/repositories/subscriber-repository.ts", "utf8");
    expect(repo).toContain("status='sending' AND warm_phase='warm'");
    expect(repo).toContain("warm_cursor_id IS NULL OR warm_cursor_id <= ${cursorId}");
    expect(repo).toContain("warm_cursor_id IS NOT DISTINCT FROM ${cursorId}");
    expect(repo).toContain("UPDATE campaigns SET warm_phase='normal'");
    expect(repo).toContain("step_execution_version=${expectedStepExecutionVersion}");
    expect(repo).toContain("Number(prior.step_execution_version) !== expectedStepExecutionVersion");
  });

  it("persists only durable step count and cleans snapshots transactionally", () => {
    const sender = readFileSync("server/services/campaign-sender.ts", "utf8");
    expect(sender).toContain("SET step_processed_count = ${durableStepProcessedCount}");
    expect(sender).toContain("durableStepProcessedCount = stepProcessedCount");
    expect(sender).toContain("warmCursorId ?? null,");
    expect(sender).toContain("durableStepProcessedCount,");
    const repo = readFileSync("server/repositories/campaign-repository.ts", "utf8");
    expect(repo).toContain("const changed = await db.transaction(async (tx)");
    expect(repo).toContain("await tx.execute(sql`DELETE FROM campaign_warm_recipients");
  });

  it("durably checkpoints batches with no pressure-sendable recipients", () => {
    const sender = readFileSync("server/services/campaign-sender.ts", "utf8");
    const empty = sender.indexOf("if (subscribersToSend.length === 0)");
    const nextContinue = sender.indexOf("continue;", empty);
    const branch = sender.slice(empty, nextContinue);
    expect(branch).toContain("durableStepProcessedCount = stepProcessedCount");
    expect(branch).toContain("checkpointCampaignWarmStart");
    expect(branch).toContain("persistStepCount");
  });

  it("gates automatic completion on durable normal-audience exhaustion", () => {
    const schema = readFileSync("shared/schema.ts", "utf8");
    const bootstrap = readFileSync("server/campaign-warm-start-bootstrap.ts", "utf8");
    const repo = readFileSync("server/repositories/campaign-repository.ts", "utf8");
    const sender = readFileSync("server/services/campaign-sender.ts", "utf8");
    expect(schema).toContain("warmAudienceExhaustedAt");
    expect(bootstrap).toContain("warm_audience_exhausted_at timestamp");
    expect(repo.match(/NOT prioritize_active_clickers OR warm_audience_exhausted_at IS NOT NULL/g)?.length)
      .toBeGreaterThanOrEqual(2);
    expect(sender).toContain("markCampaignWarmAudienceExhausted");
    expect(sender).toContain("skipping enumeration");
  });

  it("fences checkpoints and deliberate reopen transitions by generation", () => {
    const sender = readFileSync("server/services/campaign-sender.ts", "utf8");
    const routes = readFileSync("server/routes/campaigns.ts", "utf8");
    const workers = readFileSync("server/workers.ts", "utf8");
    expect(sender).toContain("step_execution_version = ${stepExecutionVersion}");
    expect(sender).toContain("await checkStatusAndHeartbeat(true)");
    expect(routes.split("stepExecutionVersion: sql`${campaigns.stepExecutionVersion} + 1`").length - 1)
      .toBeGreaterThanOrEqual(4);
    expect(workers).toContain("step_execution_version = step_execution_version + 1");
    expect(workers).toContain("Fenced and re-enqueued campaign");
    expect(workers).toContain("await fenceCampaignForReplacement(campaignId)");
    expect(workers.match(/fenceCampaignForReplacement\(c\.id/g)?.length).toBeGreaterThanOrEqual(3);
    expect(workers).toContain("SELECT id, 'pending', 0 FROM fence_stuck");
    const resumeStart = routes.indexOf('app.post("/api/campaigns/:id/resume"');
    const resumeRoute = routes.slice(resumeStart, routes.indexOf("\n  app.", resumeStart + 1));
    expect(resumeRoute).not.toContain("DELETE FROM campaign_sends");
  });

  it("freezes toggle changes after any launch and validates send options", () => {
    const routes = readFileSync("server/routes/campaigns.ts", "utf8");
    expect(routes).toContain("(executionBegun && toggleChanged)");
    expect(routes).toContain("const sendOptionsSchema = z.object");
    expect(routes).toContain("prioritizeActiveClickers: z.boolean().optional()");
    expect(routes).toContain("Step send limit must be at least 1");
  });
});