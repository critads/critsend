import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

// Source-level guards for two startup-recovery invariants that are inline SQL in
// server/workers.ts (so they cannot be unit-tested without a live DB). These
// protect against silently reintroducing the two regressions behind the
// "imports complete but write nothing" + "import_staging bloat" incident.
const workersSrc = readFileSync(resolve(__dirname, "../server/workers.ts"), "utf8");

describe("startup import recovery invariants (source guards)", () => {
  it("orphanResult fails a 'processing' import_job ONLY when no queue row is pending OR processing", () => {
    // Locate the orphan-fail UPDATE by its unique error_message.
    const marker = "Server restarted while import was processing";
    const idx = workersSrc.indexOf(marker);
    expect(idx).toBeGreaterThan(-1);
    const stmt = workersSrc.slice(idx, workersSrc.indexOf("RETURNING id", idx));

    // MUST treat 'pending' as active too. resumeInterruptedCampaigns() (un-awaited)
    // resets a crashed queue row 'processing'->'pending' for retry; if this subquery
    // only matched 'processing', such a job would be falsely failed and then closed.
    expect(stmt).toMatch(/status\s+IN\s*\(\s*'pending'\s*,\s*'processing'\s*\)/);
  });

  it("never auto-completes an import_job from processed_rows >= total_rows (no counter-based completion)", () => {
    // Parsed/staged rows are NOT committed subscribers — completing on that proxy
    // is what made imports finish having written nothing.
    const counterCompletion =
      /SET\s+status\s*=\s*'completed'[\s\S]{0,400}processed_rows[\s\S]{0,40}>=[\s\S]{0,40}total_rows/;
    expect(workersSrc).not.toMatch(counterCompletion);
  });
});
