import type { CampaignJob } from "@shared/schema";
import { storage } from "../storage";
import { logger } from "../logger";

export function prioritizeFinalizationDurabilityError(
  primaryError: unknown,
  emergencyFlushError: unknown,
): unknown {
  return (emergencyFlushError as any)?.senderFinalizationIncomplete
    ? emergencyFlushError
    : primaryError;
}

export async function stopAutomaticReplayForFinalizationFailure(
  job: CampaignJob,
  error: unknown,
): Promise<boolean> {
  if (!(error as any)?.senderFinalizationIncomplete) return false;

  const message = error instanceof Error ? error.message : String(error);
  try {
    await storage.completeJob(
      job.id,
      "failed",
      `Terminal finalization durability failure: ${message}`,
    );
  } catch (completeError) {
    logger.error(
      `[JOB_POLL] Failed to close durability-failed job ${job.id}:`,
      completeError,
    );
  }

  // processCampaignInternal normally already changed sending -> failed. Keep a
  // guarded safety net for failures in that status write, but never override a
  // concurrent manual pause/end.
  try {
    await storage.updateCampaignStatusAtomic(job.campaignId, "failed", "sending");
  } catch (statusError) {
    logger.error(
      `[JOB_POLL] Failed to preserve terminal status for campaign ${job.campaignId}:`,
      statusError,
    );
  }

  return true;
}