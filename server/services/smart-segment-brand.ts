// Task #304 — step 1: brand → refs → vertical resolution, and default domain
// family inference from the selected MTA's recent sends.
//
// Data-provider conventions (observed on the live DB, not enforced by code):
// subscriber refs are UPPERCASE exact-case codes whose first character is the
// vertical (4 = travel/leisure…). `US<ref>` is the same brand from the
// Microsoft/Yahoo files, `E<ref>` the openers extension, and tag `U<ref>`
// marks a subscriber who unsubscribed from that brand. The brands directory
// stores refs lowercase, so everything is upper-cased on the way out.
import { pool } from "../db";
import {
  extractCampaignBrand,
  historicalBrandKeys,
  resolveHistoricalBrand,
  type CampaignBrand,
} from "./tag-suggestions";
import { storage } from "../storage";
import {
  DOMAIN_FAMILIES,
  DOMAIN_FAMILY_IDS,
  type DomainFamilyId,
  type SmartSegmentBrandResolution,
  type SmartSegmentResolveResponse,
} from "@shared/smart-segment";
import { BOT_OPENER_REF } from "../config/suppression";

export const VERTICAL_LABELS: Record<string, string> = {
  "1": "Mode",
  "2": "Maison",
  "3": "Beauté",
  "4": "Voyage / loisirs",
  "5": "Distribution / électronique",
  "6": "Bijoux / énergie",
};

const MAX_CORE_REFS = 5;
const MAX_VERTICAL_REFS = 60;

export type BrandLookupDeps = {
  /** Brand directory rows whose lower(name) contains the token. */
  findBrandsByToken(token: string): Promise<Array<{ name: string; ref: string }>>;
  /** Exact-key anchor among historical campaign names (see brand guard). */
  findCampaignBrandAnchor(keys: string[]): Promise<string | null>;
  /** Uppercase refs of the directory sharing a vertical prefix. */
  listVerticalRefs(prefix: string): Promise<string[]>;
};

export const defaultBrandLookupDeps: BrandLookupDeps = {
  async findBrandsByToken(token) {
    const result = await pool.query<{ name: string; ref: string }>(
      `SELECT name, ref FROM brands WHERE lower(name) LIKE $1 ORDER BY name ASC, ref ASC LIMIT 200`,
      [`%${token.replace(/[\\%_]/g, (c) => `\\${c}`)}%`],
    );
    return result.rows;
  },
  findCampaignBrandAnchor: (keys) => storage.findCampaignBrandAnchor(keys),
  async listVerticalRefs(prefix) {
    const result = await pool.query<{ ref: string }>(
      `SELECT DISTINCT upper(ref) AS ref FROM brands WHERE lower(ref) LIKE $1 ORDER BY 1 LIMIT $2`,
      [`${prefix.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`, MAX_VERTICAL_REFS],
    );
    return result.rows.map((row) => row.ref);
  },
};

export function normalizeRef(ref: string): string {
  return ref.trim().toUpperCase();
}

/** US<ref> and E<ref> variants for the given core refs (deduplicated, ordered). */
export function deriveExtensionRefs(coreRefs: string[]): string[] {
  const out: string[] = [];
  for (const ref of coreRefs) {
    for (const variant of [`US${ref}`, `E${ref}`]) {
      if (!out.includes(variant) && !coreRefs.includes(variant)) out.push(variant);
    }
  }
  return out;
}

/** U<ref> tags for the core refs and their US variants. */
export function deriveUnsubscribeTags(coreRefs: string[]): string[] {
  const out: string[] = [];
  for (const ref of coreRefs) {
    for (const tag of [`U${ref}`, `UUS${ref}`]) {
      if (!out.includes(tag)) out.push(tag);
    }
  }
  return out;
}

export function verticalOf(ref: string | null | undefined): string | null {
  if (!ref) return null;
  const first = ref.trim().charAt(0);
  return /^[0-9]$/.test(first) ? first : null;
}

function brandKeyOf(name: string): CampaignBrand | null {
  return extractCampaignBrand(name);
}

/**
 * Human-readable brand name for a matched key: the leading words of the
 * operator's own campaign label that produce that key (keeps casing/accents),
 * or the whole label when the words cannot be aligned with the tokens.
 */
export function displayNameForKey(requested: CampaignBrand, key: string): string {
  const words = requested.label.split(/\s+/).filter(Boolean);
  for (let count = 1; count <= words.length; count++) {
    const candidate = words.slice(0, count).join(" ");
    const candidateKey = extractCampaignBrand(candidate)?.key;
    if (candidateKey === key) return candidate;
  }
  return requested.label;
}

/**
 * Matches directory brands against the requested campaign brand using the same
 * longest-prefix keys as the historical resolver, so "Air France 20-30/08"
 * finds "Air France" without accepting "Air Caraïbes".
 */
export function matchDirectoryBrands(
  requested: CampaignBrand,
  rows: Array<{ name: string; ref: string }>,
): { brandName: string; refs: string[]; matchedKey: string } | null {
  const byKey = new Map<string, { brandName: string; refs: string[] }>();
  for (const row of rows) {
    const key = brandKeyOf(row.name)?.key;
    if (!key) continue;
    const entry = byKey.get(key) ?? { brandName: row.name.trim(), refs: [] };
    const ref = normalizeRef(row.ref);
    if (ref && ref !== BOT_OPENER_REF && !entry.refs.includes(ref)) entry.refs.push(ref);
    byKey.set(key, entry);
  }
  for (const key of historicalBrandKeys(requested)) {
    const entry = byKey.get(key);
    if (entry && entry.refs.length) {
      return { brandName: entry.brandName, refs: entry.refs.slice(0, MAX_CORE_REFS), matchedKey: key };
    }
  }
  return null;
}

async function buildResolution(
  brandName: string | null,
  coreRefs: string[],
  source: SmartSegmentBrandResolution["source"],
  matchedKeys: string[],
  deps: BrandLookupDeps,
): Promise<SmartSegmentBrandResolution> {
  const vertical = verticalOf(coreRefs[0]);
  const coreSet = new Set(coreRefs);
  const verticalRefs = vertical
    ? (await deps.listVerticalRefs(vertical)).filter((ref) => !coreSet.has(ref) && ref !== BOT_OPENER_REF)
    : [];
  return {
    detected: coreRefs.length > 0,
    source,
    brandName,
    coreRefs,
    extensionRefs: deriveExtensionRefs(coreRefs),
    unsubscribeTags: deriveUnsubscribeTags(coreRefs),
    vertical,
    verticalLabel: vertical ? (VERTICAL_LABELS[vertical] ?? `Verticale ${vertical}`) : null,
    verticalRefs,
    matchedKeys,
    similarRefs: [],
  };
}

export async function resolveSmartSegmentBrand(
  input: { campaignName: string; brandOverride?: { name: string; ref: string } | null },
  deps: BrandLookupDeps = defaultBrandLookupDeps,
): Promise<SmartSegmentBrandResolution> {
  if (input.brandOverride) {
    const ref = normalizeRef(input.brandOverride.ref);
    return buildResolution(input.brandOverride.name.trim(), [ref], "manual", [], deps);
  }
  const requested = extractCampaignBrand(input.campaignName);
  if (!requested) {
    return buildResolution(null, [], "none", [], deps);
  }
  // 1) Brand directory (authoritative ref mapping).
  const directoryRows = await deps.findBrandsByToken(requested.tokens[0]);
  const directoryMatch = matchDirectoryBrands(requested, directoryRows);
  if (directoryMatch) {
    return buildResolution(directoryMatch.brandName, directoryMatch.refs, "directory", [directoryMatch.matchedKey], deps);
  }
  // 2) Historical campaign anchor: the brand exists in campaign history but is
  // not in the directory — the operator must supply the ref manually.
  const anchorName = await deps.findCampaignBrandAnchor(historicalBrandKeys(requested));
  const resolved = anchorName ? resolveHistoricalBrand(requested, [{ name: anchorName }]) : null;
  return buildResolution(
    resolved ? displayNameForKey(requested, resolved.key) : requested.label,
    [],
    resolved ? "history" : "none",
    resolved ? [resolved.key] : [],
    deps,
  );
}

export function classifyDomainFamily(domain: string): DomainFamilyId | null {
  const lower = domain.toLowerCase();
  for (const id of DOMAIN_FAMILY_IDS) {
    if (DOMAIN_FAMILIES[id].domains.includes(lower)) return id;
  }
  return null;
}

export function suggestFamilyFromShares(
  shares: Record<DomainFamilyId, number>,
  sampled: number,
): DomainFamilyId | null {
  if (sampled < 50) return null;
  let best: DomainFamilyId | null = null;
  for (const id of DOMAIN_FAMILY_IDS) {
    if (best === null || shares[id] > shares[best]) best = id;
  }
  if (best === null || shares[best] < 0.3) return null;
  return best;
}

export type FamilyInferenceDeps = {
  recentMtaCampaignIds(mtaId: string): Promise<string[]>;
  sampleRecipientDomains(campaignIds: string[]): Promise<Array<{ domain: string; count: number }>>;
};

export const defaultFamilyInferenceDeps: FamilyInferenceDeps = {
  async recentMtaCampaignIds(mtaId) {
    const result = await pool.query<{ id: string }>(
      `SELECT id FROM campaigns
        WHERE mta_id = $1 AND status IN ('completed', 'sent') AND first_send_at IS NOT NULL AND sent_count > 0
        ORDER BY first_send_at DESC LIMIT 3`,
      [mtaId],
    );
    return result.rows.map((row) => row.id);
  },
  async sampleRecipientDomains(campaignIds) {
    // Bounded sample: the first 4 000 send rows of the MTA's latest campaigns
    // are enough to tell FR ISPs from Microsoft/Yahoo files apart.
    const result = await pool.query<{ domain: string; count: string }>(
      `SELECT lower(split_part(s.email, '@', 2)) AS domain, COUNT(*)::text AS count
         FROM (SELECT subscriber_id FROM campaign_sends WHERE campaign_id = ANY($1::text[]) LIMIT 4000) r
         JOIN subscribers s ON s.id = r.subscriber_id
        GROUP BY 1`,
      [campaignIds],
    );
    return result.rows.map((row) => ({ domain: row.domain, count: Number(row.count) }));
  },
};

export async function inferDomainFamilyFromMta(
  mtaId: string | null | undefined,
  deps: FamilyInferenceDeps = defaultFamilyInferenceDeps,
): Promise<Pick<SmartSegmentResolveResponse, "suggestedFamily" | "familyEvidence">> {
  if (!mtaId) return { suggestedFamily: null, familyEvidence: null };
  const campaignIds = await deps.recentMtaCampaignIds(mtaId);
  if (!campaignIds.length) return { suggestedFamily: null, familyEvidence: null };
  const rows = await deps.sampleRecipientDomains(campaignIds);
  const sampled = rows.reduce((sum, row) => sum + row.count, 0);
  const counts: Record<DomainFamilyId, number> = { fai_fr: 0, microsoft_yahoo: 0 };
  for (const row of rows) {
    const family = classifyDomainFamily(row.domain);
    if (family) counts[family] += row.count;
  }
  const shares: Record<DomainFamilyId, number> = {
    fai_fr: sampled ? counts.fai_fr / sampled : 0,
    microsoft_yahoo: sampled ? counts.microsoft_yahoo / sampled : 0,
  };
  return {
    suggestedFamily: suggestFamilyFromShares(shares, sampled),
    familyEvidence: { sampled, inFamilyShare: shares },
  };
}

export async function resolveSmartSegmentContext(
  input: { campaignName: string; mtaId?: string | null; brandOverride?: { name: string; ref: string } | null },
  deps: { brand?: BrandLookupDeps; family?: FamilyInferenceDeps } = {},
): Promise<SmartSegmentResolveResponse> {
  const [brand, family] = await Promise.all([
    resolveSmartSegmentBrand(input, deps.brand),
    inferDomainFamilyFromMta(input.mtaId, deps.family),
  ]);
  return { brand, ...family };
}
