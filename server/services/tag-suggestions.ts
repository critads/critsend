/**
 * Tag suggestions (Task #237) — pure logic, extracted for unit testing.
 *
 * Campaign names always contain the brand name. We tokenize the input name,
 * discard short/generic/date-like tokens, and pick as "brand" the token that
 * matches the most historical campaigns (ties: longest token). The suggested
 * tags are the modes of the non-empty tags among the most recent matches.
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

/** ASCII-folds, lowercases, splits, and filters a campaign name into candidate brand tokens. */
export function tagSuggestTokens(name: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").split(/[^a-z0-9]+/)) {
    if (raw.length < 3) continue;               // too short to be a brand
    if (/^\d+$/.test(raw)) continue;            // pure number (dates, ids)
    if (TAG_SUGGEST_STOPWORDS.has(raw)) continue;
    if (!seen.has(raw)) { seen.add(raw); out.push(raw); }
  }
  return out.slice(0, 8);
}

/** Escapes LIKE metacharacters and wraps in %...% for a contains match. */
export function likePattern(token: string): string {
  return `%${token.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * Brand token = the one matching the most campaigns (ties: longest token).
 * Returns -1 when no token matched anything.
 */
export function pickBrandIndex(tokens: string[], counts: number[]): number {
  let brandIdx = -1;
  let brandCount = 0;
  tokens.forEach((t, i) => {
    const c = counts[i] ?? 0;
    if (c > brandCount || (c === brandCount && c > 0 && brandIdx >= 0 && t.length > tokens[brandIdx].length)) {
      brandCount = c;
      brandIdx = i;
    }
  });
  return brandIdx;
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
