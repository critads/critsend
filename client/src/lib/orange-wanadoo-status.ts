export type OrangeWanadooComplaintStatus = "unknown" | "green" | "orange" | "red";

export type OrangeWanadooStatusCampaign = {
  id: string;
  name: string;
  orangeWanadooSentCount?: number;
  orangeWanadooComplaintsCount?: number;
  orangeWanadooComplaintRate?: number | null;
  orangeWanadooComplaintStatus?: OrangeWanadooComplaintStatus;
};

export function orangeWanadooStatusPresentation(campaign: OrangeWanadooStatusCampaign) {
  const status = campaign.orangeWanadooComplaintStatus ?? "unknown";
  const rate = campaign.orangeWanadooComplaintRate;
  const sent = campaign.orangeWanadooSentCount ?? 0;
  const complaints = campaign.orangeWanadooComplaintsCount ?? 0;
  const labels = {
    green: "within target",
    orange: "watch threshold",
    red: "above threshold",
    unknown: "no delivered Orange / Wanadoo audience yet",
  };
  const dotColor = {
    green: "bg-emerald-500",
    orange: "bg-amber-500",
    red: "bg-destructive",
    unknown: "bg-muted-foreground/50",
  };
  const details = rate === null || rate === undefined || sent === 0
    ? `Orange / Wanadoo complaints: ${complaints.toLocaleString()} complaints, no delivered denominator. Status: ${labels[status]}.`
    : `Orange / Wanadoo complaints: ${complaints.toLocaleString()} of ${sent.toLocaleString()} delivered (${(rate * 100).toFixed(2)}%). Status: ${labels[status]}.`;

  return {
    status,
    details,
    dotClassName: dotColor[status],
    testId: `orange-wanadoo-status-${campaign.id}`,
  };
}