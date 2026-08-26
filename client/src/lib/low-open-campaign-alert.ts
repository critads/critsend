export type LowOpenCampaignAlertSummary = {
  id: string;
  name: string;
  mtaName: string;
  startedAt: string;
  sentCount: number;
  uniqueOpens: number;
  openRate: number;
};

const DISMISSED_SESSION_KEY = "campaigns.low-open-alert-dismissed";

/** Keep a dismissal while the operator remains in the same browser tab. */
export function readLowOpenCampaignAlertDismissed(): boolean {
  try {
    return window.sessionStorage.getItem(DISMISSED_SESSION_KEY) === "true";
  } catch {
    return false;
  }
}

export function persistLowOpenCampaignAlertDismissed(): void {
  try {
    window.sessionStorage.setItem(DISMISSED_SESSION_KEY, "true");
  } catch {
    // Storage can be unavailable in privacy-restricted browsers. The in-memory
    // state still dismisses the alert until the component is recreated.
  }
}

export function isLowOpenCampaignAlertVisible(
  campaigns: LowOpenCampaignAlertSummary[],
  dismissed: boolean,
): boolean {
  return !dismissed && campaigns.length > 0;
}