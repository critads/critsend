export function getCampaignListSegmentIds(campaign: {
  segmentIds?: string[] | null;
  segmentId?: string | null;
}): string[] {
  const canonicalIds = Array.isArray(campaign.segmentIds)
    ? campaign.segmentIds.filter((id): id is string => typeof id === "string" && id.length > 0)
    : [];
  const ids = canonicalIds.length > 0
    ? canonicalIds
    : campaign.segmentId
      ? [campaign.segmentId]
      : [];

  return [...new Set(ids)];
}