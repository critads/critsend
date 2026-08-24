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

const TAG_SUGGEST_STOPWORDS = new Set([
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

/**
 * Brand-prefix match after the SQL candidate query. Once a reliable historical
 * anchor identifies "Air France", this includes descriptive variants such as
 * "Air France 20-30/08" without mixing "Air Caraibes".
 */
export function campaignMatchesBrand(name: string, brand: CampaignBrand): boolean {
  const candidate = extractCampaignBrand(name);
  if (!candidate || candidate.tokens.length < brand.tokens.length) return false;
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
  firstSentAt: Date | string;
};

export type SegmentPerformanceSuggestion = {
  segmentId: string;
  segmentName: string;
  totalClicks: number;
  campaignCount: number;
};

/**
 * Ranks segments using cached total-click counters from the ten most recently
 * sent campaigns for one exact brand. Candidates may share a first token (for
 * example "Air France" and "Air Caraïbes"), so the existing strict brand
 * matcher remains the authority before the recent-history window is applied.
 */
export function suggestSegmentsFromRecentHistory(
  brand: CampaignBrand,
  candidates: SegmentPerformanceCandidate[],
  historyLimit = 10,
  suggestionLimit = 3,
): {
  campaignsConsidered: number;
  suggestions: SegmentPerformanceSuggestion[];
} {
  const matching = candidates
    .filter((row) => campaignMatchesBrand(row.name, brand))
    .sort((a, b) => {
      const byFirstSend = new Date(b.firstSentAt).getTime() - new Date(a.firstSentAt).getTime();
      return byFirstSend || a.campaignId.localeCompare(b.campaignId);
    })
    .slice(0, historyLimit);

  const totals = new Map<string, SegmentPerformanceSuggestion>();
  for (const row of matching) {
    const existing = totals.get(row.segmentId);
    if (existing) {
      existing.totalClicks += Number(row.totalClicks) || 0;
      existing.campaignCount += 1;
      continue;
    }
    totals.set(row.segmentId, {
      segmentId: row.segmentId,
      segmentName: row.segmentName,
      totalClicks: Number(row.totalClicks) || 0,
      campaignCount: 1,
    });
  }

  const suggestions = [...totals.values()]
    .sort((a, b) =>
      b.totalClicks - a.totalClicks ||
      b.campaignCount - a.campaignCount ||
      a.segmentName.localeCompare(b.segmentName) ||
      a.segmentId.localeCompare(b.segmentId))
    .slice(0, suggestionLimit);

  return { campaignsConsidered: matching.length, suggestions };
}
