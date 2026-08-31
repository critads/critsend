import type { CampaignSendStateTotals } from "@shared/schema";

export type CampaignAnalyticsNotice = "awaiting-finalization" | "zero-engagement" | null;

export function getCampaignAnalyticsNotice(
  sendState: CampaignSendStateTotals,
  uniqueOpens: number,
  uniqueClicks: number,
): CampaignAnalyticsNotice {
  if (sendState.finalized === 0) return "awaiting-finalization";
  if (uniqueOpens === 0 && uniqueClicks === 0) return "zero-engagement";
  return null;
}