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
 * Exact brand match after the SQL candidate query. This second deterministic
 * check is essential because `%air%` is only an indexed pre-filter; it must not
 * mix "Air France" with "Air Caraibes" or an unrelated word containing "air".
 */
export function campaignMatchesBrand(name: string, brand: CampaignBrand): boolean {
  return extractCampaignBrand(name)?.key === brand.key;
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
