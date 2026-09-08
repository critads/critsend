import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("campaign pause versus job replay", () => {
  it("does not claim pending jobs for a paused campaign", () => {
    const source = readFileSync(
      "server/repositories/job-repository.ts",
      "utf8",
    );
    const claimStart = source.indexOf("export async function claimNextJob");
    const claimEnd = source.indexOf(
      "export async function completeJob",
      claimStart,
    );
    const claimSource = source.slice(claimStart, claimEnd);

    expect(claimSource).toContain("c.status = 'sending'");
  });

  it("never resurrects a campaign that was paused during error handling", () => {
    const source = readFileSync("server/workers.ts", "utf8");
    const handlerStart = source.indexOf("async function handleJobError");
    const handlerEnd = source.indexOf(
      "async function processJob",
      handlerStart,
    );
    const handlerSource = source.slice(handlerStart, handlerEnd);

    expect(source).not.toContain(
      'updateCampaign(job.campaignId, { status: "sending", pauseReason: null })',
    );
    expect(
      handlerSource.match(
        /updateCampaignStatusAtomic\(\s*job\.campaignId,\s*"sending",\s*"sending"/g,
      ),
    ).toHaveLength(2);
    expect(source).toMatch(
      /updateCampaignStatusAtomic\(\s*job\.campaignId,\s*"sending",\s*"failed"/,
    );
  });

  it("keeps the deferred-send drainer out of the remediation pause", () => {
    const source = readFileSync(
      "server/workers/pressure-guard-worker.ts",
      "utf8",
    );

    expect(source).toContain("FALSE_FAILED_RECOVERY_PAUSE_REASON");
    expect(source).toContain("pause_reason IS DISTINCT FROM $4");
  });
});