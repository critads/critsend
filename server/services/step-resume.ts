export type StepResumeOverrides = {
  stepSendLimit?: number | null;
  stepProcessedCount?: number;
  stepCursorId?: string | null;
};

export class InvalidStepResumeLimitError extends Error {
  constructor() {
    super("stepLimit must be a positive integer when stepAction is 'continue'");
    this.name = "InvalidStepResumeLimitError";
  }
}

export function shouldResetOrphanedFailedSends(isStepLimitPause: boolean): boolean {
  // Step resumes retain their audience cursor. Keep failed rows too, so the
  // sender's retry phase can revisit them even though audience enumeration
  // resumes after the completed step.
  return !isStepLimitPause;
}

/**
 * Build only the fields that must change for a step-limit resume.
 *
 * Omitting stepCursorId is intentional for every action: the cursor already
 * points at the last processed audience position and must survive resume.
 * "finish" also preserves the completed step counter for operator visibility;
 * disabling the limit is sufficient to let the sender run to completion.
 */
export function buildStepResumeOverrides(
  isStepLimitPause: boolean,
  body: unknown,
): StepResumeOverrides {
  if (!isStepLimitPause) return {};

  const input = (body && typeof body === "object") ? body as Record<string, unknown> : {};
  if (input.stepAction === "finish") {
    return { stepSendLimit: null };
  }

  if (input.stepAction === "continue") {
    const parsedLimit = typeof input.stepLimit === "number"
      ? input.stepLimit
      : Number(input.stepLimit);
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1) {
      throw new InvalidStepResumeLimitError();
    }
    return { stepSendLimit: parsedLimit, stepProcessedCount: 0 };
  }

  return { stepProcessedCount: 0 };
}