export interface CampaignProviderStat {
  provider: string;
  recipients: number;
  uniqueOpeners: number;
  complaints: number;
}

export interface CampaignProviderQuickViews {
  openers: Array<{
    provider: string;
    recipients: number;
    uniqueOpeners: number;
    openRate: number;
  }>;
  complaints: Array<{
    provider: string;
    recipients: number;
    complaints: number;
    complaintRate: number;
  }>;
}

function compareProviders(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function percentage(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.round((numerator / denominator) * 10000) / 100;
}

export function buildCampaignProviderQuickViews(
  providerStats: CampaignProviderStat[],
): CampaignProviderQuickViews {
  const openers = [...providerStats]
    .sort((left, right) =>
      right.recipients - left.recipients
      || compareProviders(left.provider, right.provider),
    )
    .slice(0, 5)
    .map(({ provider, recipients, uniqueOpeners }) => ({
      provider,
      recipients,
      uniqueOpeners,
      openRate: percentage(uniqueOpeners, recipients),
    }));

  const complaints = providerStats
    .filter((row) => row.complaints > 0)
    .sort((left, right) =>
      right.complaints - left.complaints
      || right.recipients - left.recipients
      || compareProviders(left.provider, right.provider),
    )
    .slice(0, 3)
    .map(({ provider, recipients, complaints: complaintCount }) => ({
      provider,
      recipients,
      complaints: complaintCount,
      complaintRate: percentage(complaintCount, recipients),
    }));

  return { openers, complaints };
}