export type LowOpenCampaignAlertSummary = {
  id: string;
  name: string;
  mtaName: string;
  startedAt: string;
  sentCount: number;
  uniqueOpens: number;
  openRate: number;
};

/** An operator dismissal is intentionally limited to the current page visit. */
export function isLowOpenCampaignAlertVisible(
  campaigns: LowOpenCampaignAlertSummary[],
  dismissed: boolean,
): boolean {
  return !dismissed && campaigns.length > 0;
}