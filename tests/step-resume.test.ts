import { describe, expect, it } from "vitest";
import {
  buildStepResumeOverrides,
  InvalidStepResumeLimitError,
  shouldResetOrphanedFailedSends,
} from "../server/services/step-resume";

describe("step-limit resume transitions", () => {
  it("continues with a fresh step counter without touching the cursor", () => {
    expect(buildStepResumeOverrides(true, { stepAction: "continue", stepLimit: "250" })).toEqual({
      stepSendLimit: 250,
      stepProcessedCount: 0,
    });
  });

  it("finishes without clearing the completed counter or cursor", () => {
    expect(buildStepResumeOverrides(true, { stepAction: "finish" })).toEqual({
      stepSendLimit: null,
    });
  });

  it("plain resume resets only the current step counter", () => {
    expect(buildStepResumeOverrides(true, {})).toEqual({ stepProcessedCount: 0 });
  });

  it("does not apply step fields to other pause reasons", () => {
    expect(buildStepResumeOverrides(false, { stepAction: "finish" })).toEqual({});
  });

  it("rejects invalid continue limits", () => {
    expect(() => buildStepResumeOverrides(true, {
      stepAction: "continue",
      stepLimit: "1abc",
    })).toThrow(InvalidStepResumeLimitError);
  });

  it("keeps failed rows for step resumes so finish can retry them after the cursor", () => {
    expect(shouldResetOrphanedFailedSends(true)).toBe(false);
  });

  it("preserves legacy orphan cleanup for non-step resumes", () => {
    expect(shouldResetOrphanedFailedSends(false)).toBe(true);
  });
});