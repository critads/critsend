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
  orangeWanadoo: {
    recipients: number;
    uniqueOpeners: number;
    openRate: number;
    complaints: number;
    complaintRate: number;
  };
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

  const combined = providerStats
    .filter((row) => row.provider.toLowerCase() === "orange.fr" || row.provider.toLowerCase() === "wanadoo.fr")
    .reduce(
      (acc, row) => ({
        recipients: acc.recipients + row.recipients,
        uniqueOpeners: acc.uniqueOpeners + row.uniqueOpeners,
        complaints: acc.complaints + row.complaints,
      }),
      { recipients: 0, uniqueOpeners: 0, complaints: 0 },
    );
  return {
    openers,
    complaints,
    orangeWanadoo: {
      ...combined,
      openRate: percentage(combined.uniqueOpeners, combined.recipients),
      complaintRate: percentage(combined.complaints, combined.recipients),
    },
  };
}