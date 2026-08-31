/**
 * Tag suggestions (Tasks #237 / #245) — pure logic, extracted for unit testing.
 *
 * Campaign names follow the operator convention:
 *   #<id> <brand> - <campaign code> - <optional MTA alias>
 *
 * Only the first section identifies the brand. Parsing that section prevents
 * an MTA alias (kamma, mayesale, rndaserver...) or a list/category suffix from
 * becoming the match key and mixing unrelated advertisers.
 */

export const TAG_SUGGEST_STOPWORDS = new Set([
  // FR + EN months and generic campaign vocabulary that would otherwise
  // match across brands.
  "janvier", "fevrier", "mars", "avril", "mai", "juin", "juillet", "aout",
  "septembre", "octobre", "novembre", "decembre",
  "january", "february", "march", "april", "may", "june", "july", "august",
  "september", "october", "november", "december",
  "jan", "feb", "fev", "avr", "jun", "jul", "sep", "sept", "oct", "nov", "dec",
  "promo", "promotion", "soldes", "solde", "vente", "ventes", "offre", "offres",
  "campagne", "campaign", "relance", "resend", "test", "newsletter", "nl",
  "flash", "black", "friday", "noel", "rentree", "ete", "hiver", "printemps",
  "automne", "semaine", "week", "jour", "day", "top", "new", "copy", "copie",
  // Internal campaign descriptor, not an advertiser/brand.
  "critads",
]);

export interface CampaignBrand {
  /** Human-readable brand section, without the leading numeric campaign ref. */
  label: string;
  /** Normalized significant tokens used for indexed candidate lookup. */
  tokens: string[];
  /** Exact normalized signature used to reject false-positive candidates. */
  key: string;
}

export interface TagSuggestionHistoryRow {
  name: string;
  open_tag: string | null;
  click_tag: string | null;
  unsubscribe_tag: string | null;
}

function normalizedTokens(value: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of value.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").split(/[^a-z0-9]+/)) {
    if (raw.length < 3) continue;               // too short to be a brand
    if (/^\d+$/.test(raw)) continue;            // pure number (dates, ids)
    if (TAG_SUGGEST_STOPWORDS.has(raw)) continue;
    if (!seen.has(raw)) { seen.add(raw); out.push(raw); }
  }
  return out.slice(0, 8);
}

/**
 * Extracts the brand section from an operator campaign name.
 *
 * A separator must have surrounding whitespace so hyphenated brand names stay
 * intact. We support the separators used by copied/imported campaign names.
 */
export function extractCampaignBrand(name: string): CampaignBrand | null {
  const firstSection = name.split(/\s+(?:-|–|—|\|)\s+/, 1)[0] ?? "";
  const label = firstSection.replace(/^\s*#\s*\d+\s*/, "").trim();
  const tokens = normalizedTokens(label);
  if (!label || tokens.length === 0) return null;
  return {
    label,
    tokens,
    key: tokens.join("\u001f"),
  };
}

/**
 * Backwards-compatible token helper used by existing callers/tests.
 * Tokens now come only from the brand section, never campaign/MTA suffixes.
 */
export function tagSuggestTokens(name: string): string[] {
  return extractCampaignBrand(name)?.tokens ?? [];
}

/** Escapes LIKE metacharacters and wraps in %...% for a contains match. */
export function likePattern(token: string): string {
  return `%${token.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** Longest-to-shortest exact keys used to resolve descriptive name variants. */
export function historicalBrandKeys(brand: CampaignBrand): string[] {
  return Array.from(
    { length: brand.tokens.length },
    (_, index) => brand.tokens.slice(0, brand.tokens.length - index).join("\u001f"),
  );
}

/**
 * Brand-prefix match after the SQL candidate query. Once a reliable historical
 * anchor identifies "Air France", this includes descriptive variants such as
 * "Air France 20-30/08" without mixing "Air Caraibes".
 */
export function campaignMatchesBrand(name: string, brand: CampaignBrand): boolean {
  const candidate = extractCampaignBrand(name);
  if (!candidate || candidate.tokens.length < brand.tokens.length) return false;
  // A one-token anchor is too generic for prefix expansion: accepting "Air *"
  // for the exact historical brand "Air" would mix distinct advertisers.
  if (brand.tokens.length === 1) return candidate.key === brand.key;
  return brand.tokens.every((token, index) => candidate.tokens[index] === token);
}

/**
 * Resolves the actual brand from the leading tokens after `#<number>`.
 *
 * Operators sometimes append dates/descriptors before the first dash:
 *   #3555 Kiabi 20-30/08 Critads - server2.mayasoldes
 *
 * We try leading prefixes from most-specific to least-specific and require an
 * exact historical brand anchor before accepting one. This lets "Kiabi" match
 * while preserving multi-word brands such as "Air France" and "Center Parcs".
 * It also refuses an unsafe fallback to the generic first word "Air" unless an
 * actual historical campaign brand is exactly "Air".
 */
export function resolveHistoricalBrand(
  requested: CampaignBrand,
  candidates: Array<Pick<TagSuggestionHistoryRow, "name">>,
): CampaignBrand | null {
  const historical = candidates
    .map((row) => extractCampaignBrand(row.name))
    .filter((brand): brand is CampaignBrand => brand !== null);

  for (let length = requested.tokens.length; length >= 1; length--) {
    const key = requested.tokens.slice(0, length).join("\u001f");
    const anchor = historical.find((brand) => brand.key === key);
    if (anchor) return anchor;
  }
  return null;
}

/** Most frequent non-empty trimmed value, or null. */
export function modeOfTags(values: Array<string | null | undefined>): string | null {
  const counts = new Map<string, number>();
  for (const raw of values) {
    const v = (raw || "").trim();
    if (!v) continue;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestN = 0;
  for (const [v, n] of counts) {
    if (n > bestN) { best = v; bestN = n; }
  }
  return best;
}

/**
 * Filters SQL candidates to one exact brand and computes suggestions over the
 * ENTIRE matching history. Rows should be ordered newest-first so equal-
 * frequency tags resolve consistently to the most recently used value.
 */
export function suggestTagsFromHistory(
  brand: CampaignBrand,
  candidates: TagSuggestionHistoryRow[],
): {
  matches: number;
  suggestions: {
    openTag: string | null;
    clickTag: string | null;
    unsubscribeTag: string | null;
  } | null;
} {
  const matching = candidates.filter((row) => campaignMatchesBrand(row.name, brand));
  if (matching.length === 0) {
    return { matches: 0, suggestions: null };
  }
  return {
    matches: matching.length,
    suggestions: {
      openTag: modeOfTags(matching.map((row) => row.open_tag)),
      clickTag: modeOfTags(matching.map((row) => row.click_tag)),
      unsubscribeTag: modeOfTags(matching.map((row) => row.unsubscribe_tag)),
    },
  };
}

export type SegmentPerformanceCandidate = {
  campaignId: string;
  name: string;
  segmentId: string;
  segmentName: string;
  totalClicks: number;
  deliveredCount: number;
  firstSentAt: Date | string;
};

export type SegmentPerformanceSuggestion = {
  segmentId: string;
  segmentName: string;
  totalClicks: number;
  campaignCount: number;
  deliveredCount: number;
  clickRate: number;
  smoothedClickRate: number;
  lastUsedAt: string;
  evidence: "performance" | "recent_use";
  metricScope: "campaigns_using_segment";
};

/**
 * Ranks every segment used by matching campaigns. Campaign-level click rate is
 * smoothed toward the brand baseline; repeat use, delivered volume, and recency
 * then provide bounded confidence boosts. Sparse/zero-click histories still
 * return deterministic recent-use suggestions instead of disappearing.
 */
export function suggestSegmentsFromRecentHistory(
  brand: CampaignBrand,
  candidates: SegmentPerformanceCandidate[],
  historyLimit = 250,
  suggestionLimit = 3,
): {
  campaignsConsidered: number;
  strategy: "performance" | "recent_use";
  suggestions: SegmentPerformanceSuggestion[];
} {
  const matching = candidates
    .filter((row) => campaignMatchesBrand(row.name, brand))
    .sort((a, b) => {
      const byFirstSend = new Date(b.firstSentAt).getTime() - new Date(a.firstSentAt).getTime();
      return byFirstSend || a.campaignId.localeCompare(b.campaignId);
    })
    .filter((row) => Number(row.deliveredCount) > 0);

  const campaignDates = new Map<string, number>();
  for (const row of matching) {
    campaignDates.set(row.campaignId, new Date(row.firstSentAt).getTime());
  }
  const includedCampaignIds = [...campaignDates.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, historyLimit)
    .map(([id]) => id);
  const includedIds = new Set(includedCampaignIds);
  const included = matching.filter((row) => includedIds.has(row.campaignId));

  type Aggregate = SegmentPerformanceSuggestion & { campaignIds: Set<string>; lastUsedMs: number; score: number };
  const totals = new Map<string, Aggregate>();
  for (const row of included) {
    const existing = totals.get(row.segmentId);
    if (existing) {
      if (existing.campaignIds.has(row.campaignId)) continue;
      existing.campaignIds.add(row.campaignId);
      existing.totalClicks += Number(row.totalClicks) || 0;
      existing.deliveredCount += Number(row.deliveredCount) || 0;
      existing.campaignCount += 1;
      existing.lastUsedMs = Math.max(existing.lastUsedMs, new Date(row.firstSentAt).getTime());
      continue;
    }
    const lastUsedMs = new Date(row.firstSentAt).getTime();
    totals.set(row.segmentId, {
      segmentId: row.segmentId,
      segmentName: row.segmentName,
      totalClicks: Number(row.totalClicks) || 0,
      deliveredCount: Number(row.deliveredCount) || 0,
      campaignCount: 1,
      clickRate: 0,
      smoothedClickRate: 0,
      lastUsedAt: new Date(lastUsedMs).toISOString(),
      evidence: "performance",
      metricScope: "campaigns_using_segment",
      campaignIds: new Set([row.campaignId]),
      lastUsedMs,
      score: 0,
    });
  }

  const uniqueCampaigns = new Map<string, { clicks: number; delivered: number }>();
  for (const row of included) {
    if (!uniqueCampaigns.has(row.campaignId)) {
      uniqueCampaigns.set(row.campaignId, {
        clicks: Number(row.totalClicks) || 0,
        delivered: Number(row.deliveredCount) || 0,
      });
    }
  }
  const brandClicks = [...uniqueCampaigns.values()].reduce((sum, row) => sum + row.clicks, 0);
  const brandDelivered = [...uniqueCampaigns.values()].reduce((sum, row) => sum + row.delivered, 0);
  const baselineRate = brandDelivered > 0 ? brandClicks / brandDelivered : 0;
  const strategy = uniqueCampaigns.size < 2 || brandClicks === 0 ? "recent_use" : "performance";
  const newestMs = Math.max(0, ...campaignDates.values());
  const priorDelivered = 2_000;

  for (const item of totals.values()) {
    const clickRate = item.deliveredCount > 0 ? item.totalClicks / item.deliveredCount : 0;
    const smoothedRate = (item.totalClicks + baselineRate * priorDelivered)
      / (item.deliveredCount + priorDelivered);
    const ageDays = Math.max(0, newestMs - item.lastUsedMs) / 86_400_000;
    const repeatability = Math.min(1, item.campaignCount / 3);
    const volumeConfidence = Math.min(1, Math.log10(item.deliveredCount + 1) / 5);
    const recency = Math.exp(-ageDays / 90);
    item.clickRate = clickRate * 100;
    item.smoothedClickRate = smoothedRate * 100;
    item.lastUsedAt = new Date(item.lastUsedMs).toISOString();
    item.evidence = strategy;
    item.score = smoothedRate * 100 * 0.45
      + repeatability * 0.40
      + volumeConfidence * 0.10
      + recency * 0.05;
  }

  const suggestions = [...totals.values()]
    .sort((a, b) => strategy === "recent_use"
      ? b.lastUsedMs - a.lastUsedMs ||
        b.campaignCount - a.campaignCount ||
        b.deliveredCount - a.deliveredCount ||
        a.segmentId.localeCompare(b.segmentId)
      : b.score - a.score ||
        b.campaignCount - a.campaignCount ||
        b.lastUsedMs - a.lastUsedMs ||
        a.segmentId.localeCompare(b.segmentId))
    .slice(0, suggestionLimit);

  return {
    campaignsConsidered: uniqueCampaigns.size,
    strategy,
    suggestions: suggestions.map(({ campaignIds: _, lastUsedMs: __, score: ___, ...item }) => item),
  };
}
