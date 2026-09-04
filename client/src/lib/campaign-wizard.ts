import { Mail, Users, FileText, Settings, Clock } from "lucide-react";
import type { InsertCampaign, Mta } from "@shared/schema";

/** Inject a <base href> into preview HTML so relative image URLs (/campaigns/...)
 *  resolve against the current server instead of about:srcdoc. */
export function withBaseHref(html: string): string {
  const base = `<base href="${window.location.origin}/">`;
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, (m) => `${m}${base}`);
  }
  return `${base}${html}`;
}

/** Normalize a domain (with or without scheme/path) to a bare lowercase hostname. */
export function normalizeHost(domain: string | null | undefined): string | null {
  if (!domain) return null;
  let d = domain.trim().replace(/\/+$/, "");
  if (!d) return null;
  if (!/^https?:\/\//i.test(d)) d = `https://${d}`;
  try {
    return new URL(d).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Hostname of an image src, or null for relative / data: / cid: URLs — those
 *  are hosted locally (or inline) and rewritten at send time, so never count
 *  as "external". */
export function imageSrcHost(rawSrc: string): string | null {
  const raw = rawSrc.trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (lower.startsWith("data:") || lower.startsWith("cid:")) return null;
  if (/^https?:\/\//i.test(raw)) {
    try { return new URL(raw).hostname.toLowerCase(); } catch { return null; }
  }
  if (raw.startsWith("//")) {
    try { return new URL(`https:${raw}`).hostname.toLowerCase(); } catch { return null; }
  }
  return null; // relative path (/images/..., /campaigns/...) — rehosted on send
}

/** Every external <img> src in `html` whose host is NOT one of `ourHosts`.
 *  Parses with DOMParser so only real image elements are inspected (never
 *  <script>/<iframe> src) and unquoted attributes are handled. DOMParser does
 *  not fetch resources or run scripts, so this is safe for untrusted HTML. */
export function findExternalImageSrcs(html: string, ourHosts: Set<string>): string[] {
  if (!html) return [];
  const urls: string[] = [];
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    doc.querySelectorAll("img[src], source[src]").forEach((el) => {
      const src = el.getAttribute("src") ?? "";
      const host = imageSrcHost(src);
      if (host && !ourHosts.has(host)) urls.push(src.trim());
    });
  } catch {
    // ignore parse failures — alert simply won't show
  }
  return urls;
}

/**
 * Remove only <img src> and <source src> elements whose absolute URL is not
 * hosted on one of the selected MTA's domains. The original HTML is otherwise
 * kept byte-for-byte so deleting failed images does not reserialize or rewrite
 * the email template.
 */
export function removeExternalImageElements(
  html: string,
  ourHosts: Set<string>,
): { html: string; removed: number } {
  if (!html) return { html, removed: 0 };

  let removed = 0;
  const imageElementPattern = /<(?:img|source)\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
  const cleanedHtml = html.replace(imageElementPattern, (element) => {
    const srcMatch = element.match(
      /(?:^|\s)src\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i,
    );
    const src = srcMatch?.[1] ?? srcMatch?.[2] ?? srcMatch?.[3] ?? "";
    const host = imageSrcHost(src);
    if (!host || ourHosts.has(host)) return element;

    removed += 1;
    return "";
  });

  return { html: cleanedHtml, removed };
}

type MtaNameSource = Pick<Mta, "name" | "hostname">;

function normalizedMtaName(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

/**
 * Returns the likely labels an operator may have used for an MTA in a campaign
 * name. In addition to the configured display name, this recognizes the first
 * hostname portion, so "mayesale" matches the configured "Mayesale.com".
 */
function mtaNameAliases(mta: MtaNameSource): string[] {
  const rawNames = [mta.name, mta.hostname].filter(
    (value): value is string => Boolean(value?.trim()),
  );
  return [...new Set(rawNames.flatMap((value) => {
    const trimmed = value.trim();
    return [trimmed, trimmed.split(".")[0]];
  }).map(normalizedMtaName).filter((value) => value.length >= 4))];
}

function isKnownMtaSuffix(value: string, mtas: MtaNameSource[]): boolean {
  const normalized = normalizedMtaName(value);
  if (normalized.length < 4) return false;

  return mtas.some((mta) => mtaNameAliases(mta).some((alias) => (
    alias === normalized
    || alias.startsWith(normalized)
    || normalized.startsWith(alias)
  )));
}

/**
 * Keeps the MTA suffix in a campaign name in sync with the selected MTA.
 *
 * Campaigns are conventionally named "#123 Brand - campaign code - MTA".
 * We only replace a final section when it looks like one of the configured
 * MTAs, which preserves ordinary campaign codes such as "#123 Brand - ABC42".
 * If no MTA suffix exists yet, the selected MTA is appended.
 */
export function updateCampaignNameMtaSuffix(
  campaignName: string,
  selectedMta: MtaNameSource | undefined,
  mtas: MtaNameSource[],
  options: { appendIfMissing?: boolean } = {},
): string {
  const nextMtaName = selectedMta?.name.trim();
  if (!campaignName.trim() || !nextMtaName) return campaignName;

  const trailingSection = /^(.*)(\s+(?:-|–|—|\|)\s+)([^–—|]+?)\s*$/.exec(campaignName);
  if (trailingSection && isKnownMtaSuffix(trailingSection[3], mtas)) {
    return `${trailingSection[1]}${trailingSection[2]}${nextMtaName}`;
  }

  if (options.appendIfMissing === false) return campaignName;
  return `${campaignName.trimEnd()} - ${nextMtaName}`;
}

/**
 * Updates an editor-managed MTA suffix without ever creating a new suffix.
 * Once the operator has touched the name field, ownership is theirs and MTA
 * changes must leave the value byte-for-byte unchanged.
 */
export function updateManagedCampaignNameMtaSuffix(
  campaignName: string,
  selectedMta: MtaNameSource | undefined,
  mtas: MtaNameSource[],
  nameWasManuallyEdited: boolean,
): string {
  if (nameWasManuallyEdited) return campaignName;
  return updateCampaignNameMtaSuffix(campaignName, selectedMta, mtas, {
    appendIfMissing: false,
  });
}

export const steps = [
  { id: 1, title: "Basic Info", icon: Mail },
  { id: 2, title: "Audience", icon: Users },
  { id: 3, title: "Content", icon: FileText },
  { id: 4, title: "Tracking", icon: Settings },
  { id: 5, title: "Schedule", icon: Clock },
];

export function normalizeForApi(data: Partial<InsertCampaign>) {
  return {
    ...data,
    replyEmail: data.replyEmail || null,
    mtaId: data.mtaId || null,
    segmentId: data.segmentId || null,
    excludeSegmentId: data.excludeSegmentId || null,
    openTag: data.openTag || null,
    clickTag: data.clickTag || null,
    unsubscribeTag: data.unsubscribeTag || null,
    companyAddress: data.companyAddress || null,
    status: "draft",
  };
}

// Shape returned by GET /api/campaigns/brand-unsub-check.
export type BrandUnsubResult = {
  brand: string | null;
  brandKey: string | null;
  count: number;
  warnThreshold: number;
  limit: number;
  windowDays: number;
  status: "ok" | "warn" | "blocked";
};

// French operator-facing message for the brand-unsubscribe safeguard. Counts
// are formatted with French digit grouping (e.g. "2 134").
export function buildBrandMessage(data: BrandUnsubResult): string {
  const fmt = (n: number) => (n ?? 0).toLocaleString("fr-FR");
  if (data.status === "blocked") {
    return `La marque ${data.brand} a déjà généré ${fmt(data.count)} désabonnés sur les ${data.windowDays} derniers jours (limite : ${fmt(data.limit)}). Impossible de continuer.`;
  }
  return `La marque ${data.brand} approche de sa limite : ${fmt(data.count)} désabonnés sur les ${data.windowDays} derniers jours (limite : ${fmt(data.limit)}).`;
}

export function campaignActionErrorMessage(error: unknown, fallback: string): string {
  const body = (error as { body?: any } | null)?.body;
  if (body?.code === "BRAND_UNSUB_LIMIT_EXCEEDED" && body.brandGuard) {
    return buildBrandMessage(body.brandGuard as BrandUnsubResult);
  }
  if (typeof body?.error === "string" && body.error) return body.error;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}
