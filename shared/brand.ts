/**
 * Brand extraction shared by the client (wizard guard) and the server
 * (brand-unsubscribe count). Both sides MUST agree on what "the brand" is,
 * so this is the single source of truth.
 *
 * Convention: the brand is the text inside the FIRST `[...]` in a subject
 * line, trimmed. Examples:
 *   "[Decathlon] Soldes d'été"  -> "Decathlon"
 *   "  [ Nike ] Promo"          -> "Nike"
 *   "Promo sans marque"         -> null
 *   "[] vide"                   -> null
 */
export function extractBrand(subject: string | null | undefined): string | null {
  if (!subject) return null;
  const match = subject.match(/\[([^\]]+)\]/);
  if (!match) return null;
  const brand = match[1].trim();
  return brand.length > 0 ? brand : null;
}
