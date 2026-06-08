import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import type { Mta, Campaign, Subscriber, InsertNullsinkCapture } from "@shared/schema";
import {
  generateSignedOpenTrackingUrl,
  generateSignedClickTrackingUrl,
  generateSignedClickTrackingUrlByLinkId,
  generateSignedUnsubscribeUrl,
} from "./tracking";
import { getNullsinkServer } from "./nullsink-smtp";
import { logger } from "./logger";
import { getDefaultHeaders } from "./repositories/mta-repository";

// ── Default email headers cache ────────────────────────────────────────
// Operator-configured "Default" headers (e.g. List-Unsubscribe-Post,
// X-Mailer, X-List-Unsubscribe, Expires) must be attached to EVERY outgoing
// email — bulk campaign sends, pressure-guard drain sends, and automation
// sends. Rather than relying on each call site to fetch + pass them (which
// silently regressed: the pressure-guard drain and automation paths were
// sending with NO default headers), we inject them centrally inside
// `sendEmail` — the single real-wire function all three paths funnel through.
// The DB read is cached for 60s with single-flight dedup so high-volume
// sending never hammers the table; the header CRUD routes call
// `invalidateDefaultHeadersCache()` so operator edits take effect at once.
type CachedHeader = { name: string; value: string };
let _defaultHeadersCache: { value: CachedHeader[]; fetchedAt: number } | null = null;
let _defaultHeadersInflight: Promise<CachedHeader[]> | null = null;
const DEFAULT_HEADERS_CACHE_TTL = 60000;

export function invalidateDefaultHeadersCache(): void {
  _defaultHeadersCache = null;
}

async function getDefaultHeadersCached(): Promise<CachedHeader[]> {
  const cached = _defaultHeadersCache;
  if (cached && Date.now() - cached.fetchedAt < DEFAULT_HEADERS_CACHE_TTL) {
    return cached.value;
  }
  if (_defaultHeadersInflight) return _defaultHeadersInflight;
  _defaultHeadersInflight = (async () => {
    // When we already have a last-good cache (TTL just expired) a single
    // attempt is enough — on failure we serve stale. When we have NO cache
    // yet (process cold-start) we retry a few times so a transient DB blip at
    // startup can't let the very first batch go out without the mandatory
    // default headers (List-Unsubscribe-Post, etc.).
    const maxAttempts = cached ? 1 : 4;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const rows = await getDefaultHeaders();
        const value = rows.map((h) => ({ name: h.name, value: h.value }));
        _defaultHeadersCache = { value, fetchedAt: Date.now() };
        return value;
      } catch (err) {
        lastErr = err;
        if (attempt < maxAttempts) {
          await sleep(250 * attempt);
        }
      }
    }
    // All attempts failed. Prefer the last-good cache (backed off for another
    // TTL window so we don't hammer the DB during an outage). With no cache at
    // all, log at ERROR — this is the only window where a send can go out
    // without default headers, and operators must see it.
    if (cached) {
      logger.warn(
        `[DEFAULT_HEADERS] refresh failed, serving stale cache: ${(lastErr as Error)?.message || lastErr}`,
      );
      cached.fetchedAt = Date.now();
      return cached.value;
    }
    logger.error(
      `[DEFAULT_HEADERS] cold-start fetch failed after ${maxAttempts} attempts — sends in this window will omit default headers: ${(lastErr as Error)?.message || lastErr}`,
    );
    return [];
  })().finally(() => {
    _defaultHeadersInflight = null;
  });
  return _defaultHeadersInflight;
}

/**
 * Merge operator-configured DEFAULT headers (cached) with any caller-supplied
 * custom headers, then resolve `{UNSUBSCRIBE}` / `{DATE+7}` placeholders for
 * this recipient. Defaults are applied to EVERY send so no call site can omit
 * them; caller-supplied headers win on a key conflict. The returned map is
 * always passed through `sanitizeOutboundHeaders` by the caller.
 */
async function buildOutboundHeaders(
  unsubscribeUrl: string,
  customHeaders?: Record<string, string>,
): Promise<Record<string, string>> {
  const defaults = await getDefaultHeadersCached();
  const merged: Record<string, string> = {};
  for (const h of defaults) merged[h.name] = h.value;
  if (customHeaders) {
    for (const [k, v] of Object.entries(customHeaders)) merged[k] = v;
  }
  const date7 = rfc2822DatePlusDays(7);
  const resolved: Record<string, string> = {};
  for (const [name, value] of Object.entries(merged)) {
    resolved[name] = value
      .replace(/\{UNSUBSCRIBE\}/gi, unsubscribeUrl)
      .replace(/\{DATE\+7\}/gi, date7);
  }
  return resolved;
}

/**
 * Returns the current date + `days` in RFC 2822 format.
 * Example: "Wed, 8 Apr 2026 05:28:25 +0000"
 */
/**
 * Strip X-Open-Tag / X-Click-Tag from a headers map (case-insensitive).
 * These header names must never appear in outgoing email — they leaked
 * internal tag identifiers with no operational benefit. Call this on any
 * operator-supplied or test-supplied headers right before handing them to
 * the transport (nodemailer or Resend). The tracking pipeline reads these
 * tags from the campaigns table at event time and does NOT depend on the
 * wire header.
 */
export function sanitizeOutboundHeaders<T extends Record<string, string> | undefined>(headers: T): T {
  if (!headers) return headers;
  for (const key of Object.keys(headers)) {
    if (/^x-(open|click)-tag$/i.test(key)) {
      delete headers[key];
    }
  }
  return headers;
}

function rfc2822DatePlusDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  // toUTCString() → "Wed, 08 Apr 2026 05:28:25 GMT"
  // Normalise: strip leading zero from day, replace "GMT" with "+0000"
  return d.toUTCString().replace(/ 0(\d) /, " $1 ").replace("GMT", "+0000");
}

const transporterPool: Map<string, Transporter> = new Map();

let nullsinkPooledTransporter: Transporter | null = null;
const NULLSINK_MAX_CONNECTIONS = 200;

export function getNullsinkTransporter(): Transporter {
  if (nullsinkPooledTransporter) {
    return nullsinkPooledTransporter;
  }
  nullsinkPooledTransporter = nodemailer.createTransport({
    host: "localhost",
    port: 2525,
    secure: false,
    pool: true,
    maxConnections: NULLSINK_MAX_CONNECTIONS,
    maxMessages: Infinity,
    connectionTimeout: 5000,
    greetingTimeout: 5000,
    socketTimeout: 10000,
    tls: {
      rejectUnauthorized: false,
    },
  });
  return nullsinkPooledTransporter;
}

export function closeNullsinkTransporter(): void {
  if (nullsinkPooledTransporter) {
    nullsinkPooledTransporter.close();
    nullsinkPooledTransporter = null;
  }
}

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

/**
 * Hard upper bound (ms) on a single `transporter.sendMail` call (Task #199).
 * Nodemailer's `socketTimeout` only bounds an ALREADY-ASSIGNED socket; when a
 * pooled transporter has no free connection (all sockets stuck), `sendMail`
 * queues and can wait indefinitely. That never-settling await was the root of
 * the campaign hung-tick wedge. Bounding the call converts an indefinite hang
 * into a retryable `ETIMEDOUT`, so the send loop keeps heartbeating and the
 * job never silently freezes. Default 60s = 2× the pooled socketTimeout (30s)
 * so a normal slow send is not preempted. Env: `SMTP_SEND_TIMEOUT_MS`.
 */
const SMTP_SEND_TIMEOUT_MS = Math.max(
  10_000,
  parseInt(process.env.SMTP_SEND_TIMEOUT_MS || '60000', 10) || 60000,
);

/**
 * Races `transporter.sendMail` against a timeout. On timeout, rejects with an
 * error tagged `code='ETIMEDOUT'` so `isTransientError` classifies it as
 * retryable. Always clears the timer to avoid a dangling handle.
 */
export async function sendMailBounded(
  transporter: Pick<nodemailer.Transporter, 'sendMail'>,
  mailOptions: nodemailer.SendMailOptions,
): Promise<any> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      transporter.sendMail(mailOptions),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
          const err: any = new Error(
            `SMTP sendMail timed out after ${SMTP_SEND_TIMEOUT_MS}ms (no free pooled connection or unresponsive server)`,
          );
          err.code = 'ETIMEDOUT';
          reject(err);
        }, SMTP_SEND_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Maps a user-facing protocol label to Nodemailer transport security options.
 *   SSL     → implicit TLS from the start  (secure: true,  port 465)
 *   TLS     → same as SSL (alternate label used by some providers)
 *   STARTTLS → opportunistic upgrade after greeting (secure: false, port 587)
 *   NONE    → no encryption at all  (secure: false, ignoreTLS: true, port 25)
 */
export function resolveSmtpSecurity(protocol: string): { secure: boolean; ignoreTLS: boolean } {
  switch ((protocol || "STARTTLS").toUpperCase()) {
    case "SSL":
    case "TLS":
      return { secure: true,  ignoreTLS: false };
    case "NONE":
      return { secure: false, ignoreTLS: true };
    case "STARTTLS":
    default:
      return { secure: false, ignoreTLS: false };
  }
}

export function createTransporter(mta: Mta): Transporter {
  const existingTransporter = transporterPool.get(mta.id);
  if (existingTransporter) {
    return existingTransporter;
  }

  const port = mta.port || 587;
  const protocol = (mta as any).protocol || "STARTTLS";
  const { secure, ignoreTLS } = resolveSmtpSecurity(protocol);
  const transporter = nodemailer.createTransport({
    host: mta.hostname || "localhost",
    port: port,
    secure,
    ignoreTLS,
    auth: mta.username && mta.password ? {
      user: mta.username,
      pass: mta.password,
    } : undefined,
    pool: true,
    maxConnections: (mta as any).maxSmtpConnections || 10,
    maxMessages: Infinity,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 30000,
    tls: {
      rejectUnauthorized: process.env.SMTP_SKIP_TLS_VERIFY !== "true",
    },
  });

  transporterPool.set(mta.id, transporter);
  return transporter;
}

export function closeTransporter(mtaId: string): void {
  const transporter = transporterPool.get(mtaId);
  if (transporter) {
    transporter.close();
    transporterPool.delete(mtaId);
  }
}

export function closeAllTransporters(): void {
  transporterPool.forEach((transporter, mtaId) => {
    transporter.close();
  });
  transporterPool.clear();
}

export interface TrackingOptions {
  campaignId: string;
  subscriberId: string;
  trackOpens: boolean;
  trackClicks: boolean;
  trackingDomain?: string | null;
  openTrackingDomain?: string | null;
  openTag?: string | null;
  clickTag?: string | null;
  /** Opaque link-ID map from preregisterCampaignLinks: Map<destinationUrl, linkId>. When set, click URLs use ?lid= instead of ?url=. */
  linkMap?: Map<string, string>;
  /**
   * Batch click tokens pre-generated for a send batch.
   * Map<subscriberId, Map<linkId, shortToken>> — looked up per subscriber in addTrackingToHtml.
   * When present, click links emit /c/{token} instead of the HMAC-signed legacy URL.
   */
  batchClickTokens?: Map<string, Map<string, string>>;
  /**
   * Batch unsubscribe tokens pre-generated for a send batch.
   * Map<subscriberId, shortToken> — looked up per subscriber in sendEmail/sendEmailBatchNullsink.
   * When present, unsubscribe links emit /u/{token} instead of the HMAC-signed legacy URL.
   */
  batchUnsubTokens?: Map<string, string>;
}

export function addTrackingToHtml(
  htmlContent: string,
  options: TrackingOptions
): string {
  let processedHtml = htmlContent;
  
  // Get the base URL for tracking — normalize scheme and trailing slash
  const rawDomain = (options.trackingDomain || "").replace(/\/$/, "");
  const baseUrl = rawDomain && !/^https?:\/\//i.test(rawDomain) ? `https://${rawDomain}` : rawDomain;

  // Rewrite all links with signed click tracking URLs
  if (options.trackClicks && baseUrl) {
    processedHtml = processedHtml.replace(
      /href="(https?:\/\/[^"]+)"/gi,
      (match, url) => {
        // Prefer short branded /c/{token} when batchClickTokens contains a token for this subscriber+link
        if (options.linkMap && options.linkMap.has(url)) {
          const linkId = options.linkMap.get(url)!;
          if (options.batchClickTokens) {
            const tokenMap = options.batchClickTokens.get(options.subscriberId);
            const token = tokenMap?.get(linkId);
            if (token) {
              return `href="${baseUrl}/c/${token}"`;
            }
          }
          // Fall back to HMAC-signed ?lid= URL
          const trackingUrl = generateSignedClickTrackingUrlByLinkId(
            baseUrl,
            options.campaignId,
            options.subscriberId,
            linkId
          );
          return `href="${trackingUrl}"`;
        }
        // Legacy fallback: expose destination URL in query param
        const trackingUrl = generateSignedClickTrackingUrl(
          baseUrl,
          options.campaignId,
          options.subscriberId,
          url
        );
        return `href="${trackingUrl}"`;
      }
    );
  }

  // Insert open tracking pixel before </body>
  if (options.trackOpens) {
    const rawOpenDomain = (options.openTrackingDomain || "").replace(/\/$/, "");
    const openTrackingBase = rawOpenDomain
      ? (!/^https?:\/\//i.test(rawOpenDomain) ? `https://${rawOpenDomain}` : rawOpenDomain)
      : baseUrl;
    
    if (openTrackingBase) {
      // Generate signed open tracking URL
      const pixelUrl = generateSignedOpenTrackingUrl(
        openTrackingBase,
        options.campaignId,
        options.subscriberId
      );
      
      const trackingPixel = `<img src="${pixelUrl}" width="1" height="1" alt="" style="display:none;width:1px;height:1px;border:0;" />`;
      
      if (processedHtml.includes("</body>")) {
        processedHtml = processedHtml.replace("</body>", `${trackingPixel}</body>`);
      } else {
        processedHtml += trackingPixel;
      }
    }
  }

  return processedHtml;
}

/**
 * Extracts all https?:// hrefs from the campaign HTML and pre-creates opaque link registry entries.
 * Returns a Map<destinationUrl, linkId> ready to pass as `linkMap` in TrackingOptions.
 * Call once per campaign before the subscriber send loop.
 */
export async function preregisterCampaignLinks(
  html: string,
  campaignId: string,
  batchGetOrCreate: (campaignId: string, urls: string[]) => Promise<Map<string, string>>
): Promise<Map<string, string>> {
  const urls: string[] = [];
  const re = /href="(https?:\/\/[^"]+)"/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    urls.push(m[1]);
  }
  if (urls.length === 0) return new Map();
  const uniqueUrls = [...new Set(urls)];
  return batchGetOrCreate(campaignId, uniqueUrls);
}

export function personalizeContent(
  content: string,
  subscriber: Subscriber
): string {
  let personalized = content;
  personalized = personalized.replace(/\{\{email\}\}/gi, subscriber.email);
  personalized = personalized.replace(/\[EMAIL\]/g, subscriber.email);
  personalized = personalized.replace(/\{\{subscriber_id\}\}/gi, subscriber.id);
  if (subscriber.tags && subscriber.tags.length > 0) {
    personalized = personalized.replace(/\{\{tags\}\}/gi, subscriber.tags.join(", "));
  }
  return personalized;
}

/**
 * Minimal Campaign shape required by `prepareTrackedHtml`. Accepts both real
 * `Campaign` rows and synthetic objects used by the automation engine /
 * Resend fallback / test-send paths.
 */
export interface TrackedHtmlCampaign {
  id: string;
  htmlContent: string;
  subject: string;
  preheader?: string | null;
  unsubscribeText?: string | null;
  companyAddress?: string | null;
  createdAt?: Date | string | null;
  fromName?: string;
  fromEmail?: string;
  replyEmail?: string | null;
  openTag?: string | null;
  clickTag?: string | null;
}

/** Minimal Subscriber shape required by `prepareTrackedHtml`. */
export interface TrackedHtmlSubscriber {
  id: string;
  email: string;
  tags?: string[] | null;
}

/** Minimal MTA shape required by `prepareTrackedHtml`. */
export interface TrackedHtmlMta {
  imageHostingDomain?: string | null;
}

export interface PreparedEmail {
  /** Final HTML body, fully tracked and footered. */
  html: string;
  /** Personalized subject line. */
  subject: string;
  /** Resolved unsubscribe URL (short /u/{token} when batchUnsubTokens has one, else HMAC). */
  unsubscribeUrl: string;
}

export interface PrepareTrackedHtmlOptions {
  /** Wrap subject through personalizeContent (default: true). */
  personalizeSubject?: boolean;
  /** Inject the footer block (unsubscribe + company address) after tracking. Default: true. */
  appendFooter?: boolean;
  /** Inject preheader span at the top of the HTML body. Default: false — most
   *  callers prefer to prepend it AFTER tracking/footer (e.g. `sendEmail`). */
  injectPreheader?: boolean;
}

/**
 * Single canonical pipeline that takes raw campaign HTML + subscriber + MTA
 * + tracking decisions and produces the fully prepared HTML for transport.
 *
 * Steps (in order):
 *   1. personalizeContent  (htmlContent — {{email}} / {{subscriber_id}} / {{tags}})
 *   2. rewriteImageUrls    (using mta.imageHostingDomain + campaign date context)
 *   3. resolve unsubscribe URL (short /u/{token} from tracking.batchUnsubTokens, else HMAC)
 *   4. replace {{unsubscribe_url}} placeholder
 *   5. addTrackingToHtml   (open pixel + click rewriting via tracking options)
 *   6. appendFooter        (optional)
 *
 * This is the chokepoint every outbound email path funnels through:
 * bulk campaign sender, pressure-guard drain worker, automation engine,
 * Resend fallback, and (opt-in) test sends. Adding a new send path? Use
 * this helper or your emails will silently lose tracking.
 */
export function prepareTrackedHtml(
  campaign: TrackedHtmlCampaign,
  subscriber: TrackedHtmlSubscriber,
  mta: TrackedHtmlMta,
  tracking: TrackingOptions,
  opts: PrepareTrackedHtmlOptions = {}
): PreparedEmail {
  // `personalizeContent` only reads { email, id, tags } — cast a minimal
  // shape so callers don't have to materialize the full Subscriber row.
  const subscriberObj = {
    id: subscriber.id,
    email: subscriber.email,
    tags: subscriber.tags || [],
  } as unknown as Subscriber;

  // 1. personalize body
  let html = personalizeContent(campaign.htmlContent, subscriberObj);

  // 2. image URL rewriting (uses MTA's image hosting domain + campaign date)
  const createdAt = campaign.createdAt
    ? (campaign.createdAt instanceof Date ? campaign.createdAt : new Date(campaign.createdAt))
    : new Date();
  html = rewriteImageUrls(html, mta.imageHostingDomain, {
    campaignId: String(campaign.id),
    year: createdAt.getUTCFullYear().toString(),
    month: String(createdAt.getUTCMonth() + 1).padStart(2, "0"),
  });

  // 3. resolve unsubscribe URL: prefer branded /u/{token}, else HMAC-signed.
  const baseUrl = normalizeBaseUrl(tracking.trackingDomain);
  const unsubToken = tracking.batchUnsubTokens?.get(subscriber.id);
  const unsubscribeUrl = unsubToken && baseUrl
    ? `${baseUrl}/u/${unsubToken}`
    : (baseUrl ? generateSignedUnsubscribeUrl(baseUrl, campaign.id, subscriber.id) : "");

  // 4. replace {{unsubscribe_url}} placeholder in the body
  if (unsubscribeUrl && html.includes("{{unsubscribe_url}}")) {
    html = html.replace(/\{\{unsubscribe_url\}\}/gi, unsubscribeUrl);
  }

  // 5. tracking pixel + click rewriting
  html = addTrackingToHtml(html, {
    ...tracking,
    campaignId: campaign.id,
    subscriberId: subscriber.id,
  });

  // Optional preheader injection at the top of the body
  if (opts.injectPreheader && campaign.preheader) {
    html =
      `<span style="display:none;font-size:1px;color:#ffffff;line-height:1px;max-height:0px;max-width:0px;opacity:0;overflow:hidden;">${campaign.preheader}</span>` +
      html;
  }

  // 6. footer (unsubscribe link + company address)
  if (opts.appendFooter !== false) {
    html = appendFooterToHtml(
      html,
      buildEmailFooter({
        unsubscribeText: campaign.unsubscribeText,
        companyAddress: campaign.companyAddress,
        unsubscribeUrl: unsubscribeUrl || undefined,
      })
    );
  }

  const subject = opts.personalizeSubject === false
    ? campaign.subject
    : personalizeContent(campaign.subject, subscriberObj);

  return { html, subject, unsubscribeUrl };
}

/** Optional campaign context for upgrading legacy /images/ paths to /campaigns/ format. */
export interface ImageRewriteContext {
  campaignId: string;
  year: string;
  month: string;
}

/** Build an ImageRewriteContext from a Campaign object. */
function campaignContext(campaign: Campaign): ImageRewriteContext {
  const d = campaign.createdAt ? new Date(campaign.createdAt) : new Date();
  return {
    campaignId: String(campaign.id),
    year: d.getUTCFullYear().toString(),
    month: String(d.getUTCMonth() + 1).padStart(2, '0'),
  };
}

/**
 * Rewrite local image URLs to absolute URLs using the image hosting domain.
 *
 * When `context` is provided the function also upgrades any legacy
 * `/images/{campaignId}/` relative paths to the new
 * `/campaigns/{year}/{month}/{campaignId}/` format before making them
 * absolute, so emails sent after the migration consistently use branded URLs.
 * Paths belonging to other campaigns are left with the legacy `/images/` prefix.
 */
export function rewriteImageUrls(
  html: string,
  imageHostingDomain: string | null | undefined,
  context?: ImageRewriteContext
): string {
  // Fall back to PUBLIC_URL env var so campaigns with relative image paths
  // still get absolute URLs in sent emails even when no MTA domain is configured.
  const effectiveDomain = imageHostingDomain || process.env.PUBLIC_URL || null;
  if (!effectiveDomain) {
    return html;
  }
  
  // Normalize: remove trailing slash, ensure https:// scheme
  const raw = effectiveDomain.replace(/\/$/, "");
  const domain = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  
  let result = html;

  // Upgrade legacy /images/{campaignId}/ paths to new branded /campaigns/ format
  if (context) {
    const { campaignId, year, month } = context;
    // Escape campaignId for use in regex (UUIDs and integers are safe, but guard anyway)
    const escapedId = campaignId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    result = result.replace(
      new RegExp(`src=(["'])/images/${escapedId}/`, 'g'),
      `src=$1${domain}/campaigns/${year}/${month}/${campaignId}/`
    );
  }

  // Rewrite any remaining relative /images/ paths (other campaigns / no context)
  result = result.replace(/src=(["'])\/images\//g, `src=$1${domain}/images/`);
  // Rewrite new-style /campaigns/ paths (both absolute domain and remaining relatives)
  result = result.replace(/src=(["'])\/campaigns\//g, `src=$1${domain}/campaigns/`);

  return result;
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Ensures a tracking domain always has an https:// scheme.
 * Accepts "example.com", "https://example.com/", or empty/null.
 */
function normalizeBaseUrl(domain: string | null | undefined): string {
  const url = (domain || "").replace(/\/$/, "");
  if (!url) return "";
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

/**
 * Builds the HTML footer block containing the unsubscribe link and company address.
 * Returns an empty string when no content is available.
 */
function buildEmailFooter(options: {
  unsubscribeText?: string | null;
  companyAddress?: string | null;
  unsubscribeUrl?: string;
}): string {
  const parts: string[] = [];
  if (options.unsubscribeUrl && options.unsubscribeText) {
    parts.push(
      `<a href="${options.unsubscribeUrl}" style="color:#666;text-decoration:underline;">${options.unsubscribeText}</a>`
    );
  }
  if (options.companyAddress) {
    parts.push(`<span style="color:#888;">${options.companyAddress}</span>`);
  }
  if (parts.length === 0) return "";
  return (
    `\n<div style="margin-top:30px;padding-top:20px;border-top:1px solid #eee;` +
    `text-align:center;font-size:12px;color:#666;">` +
    parts.map(p => `<div style="margin-top:4px;">${p}</div>`).join("") +
    `</div>`
  );
}

/** Appends a footer block just before </body>, or at the end if no </body> tag. */
function appendFooterToHtml(html: string, footer: string): string {
  if (!footer) return html;
  if (html.includes("</body>")) {
    return html.replace("</body>", footer + "</body>");
  }
  return html + footer;
}

export interface SendEmailResult {
  success: boolean;
  messageId?: string;
  error?: string;
  retryable?: boolean;
}

export async function sendEmail(
  mta: Mta,
  subscriber: Subscriber,
  campaign: Campaign,
  trackingOptions: Omit<TrackingOptions, "campaignId" | "subscriberId">,
  customHeaders?: Record<string, string>
): Promise<SendEmailResult> {
  const transporter = createTransporter(mta);

  // All HTML transforms — personalize → image rewrite → unsubscribe →
  // tracking → footer — funnel through `prepareTrackedHtml` so the SMTP
  // path stays byte-identical with the nullsink + automation + Resend
  // paths. Any drift here would silently regress one path's tracking.
  const prepared = prepareTrackedHtml(
    campaign,
    subscriber,
    mta as TrackedHtmlMta,
    {
      ...trackingOptions,
      campaignId: campaign.id,
      subscriberId: subscriber.id,
    },
  );
  let htmlContent = prepared.html;
  const unsubscribeUrl = prepared.unsubscribeUrl;
  const subject = prepared.subject;

  const mailOptions = {
    from: `"${campaign.fromName}" <${campaign.fromEmail}>`,
    replyTo: campaign.replyEmail || campaign.fromEmail,
    to: subscriber.email,
    subject: subject,
    html: htmlContent,
    headers: {} as Record<string, string>,
  };

  if (campaign.preheader) {
    mailOptions.html = `<span style="display:none;font-size:1px;color:#ffffff;line-height:1px;max-height:0px;max-width:0px;opacity:0;overflow:hidden;">${campaign.preheader}</span>` + mailOptions.html;
  }

  // X-Open-Tag / X-Click-Tag headers were intentionally removed: they leaked
  // internal tag identifiers (e.g. O4CM, C4CM) into every outgoing message
  // header with no operational benefit. The tracking pipeline still consults
  // campaigns.open_tag / click_tag at event time via getCampaignTagsCached()
  // in server/routes/tracking.ts — subscriber tagging on open/click is
  // unaffected.

  // Inject operator-configured DEFAULT headers + any caller-supplied custom
  // headers. This is the single chokepoint for outbound headers — every real
  // SMTP send (bulk sender, pressure-guard drain, automation) funnels through
  // here, so default headers can never be silently dropped by a call site.
  mailOptions.headers = await buildOutboundHeaders(unsubscribeUrl, customHeaders);

  // Defensive guard: never let X-Open-Tag / X-Click-Tag reach the wire,
  // even if an operator configured them via customHeaders.
  sanitizeOutboundHeaders(mailOptions.headers);

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const info = await sendMailBounded(transporter, mailOptions);
      
      return {
        success: true,
        messageId: info.messageId,
      };
    } catch (error: any) {
      lastError = error;
      
      const isRetryable = isTransientError(error);
      
      if (!isRetryable || attempt === MAX_RETRIES) {
        logger.error('Email send failed', { email: subscriber.email, attempt, maxRetries: MAX_RETRIES, errorMessage: error.message });
        return {
          success: false,
          error: error.message || "Unknown error",
          retryable: isRetryable,
        };
      }

      logger.warn('Retrying email send', { email: subscriber.email, attempt, maxRetries: MAX_RETRIES, errorMessage: error.message });
      await sleep(RETRY_DELAY_MS * attempt);
    }
  }

  return {
    success: false,
    error: lastError?.message || "Max retries exceeded",
    retryable: false,
  };
}

function isTransientError(error: any): boolean {
  if (!error) return false;
  
  const transientCodes = [
    "ECONNRESET",
    "ECONNREFUSED", 
    "ETIMEDOUT",
    "ESOCKET",
    "ENOTFOUND",
    "EAI_AGAIN",
  ];
  
  if (error.code && transientCodes.includes(error.code)) {
    return true;
  }
  
  if (error.responseCode) {
    const code = error.responseCode;
    if (code >= 400 && code < 500) {
      return code === 421 || code === 450 || code === 451 || code === 452;
    }
    if (code >= 500) {
      return false;
    }
  }
  
  const message = (error.message || "").toLowerCase();
  if (
    message.includes("timeout") ||
    message.includes("connection") ||
    message.includes("temporarily")
  ) {
    return true;
  }

  return false;
}

export async function verifyTransporter(mta: Mta): Promise<{ success: boolean; error?: string }> {
  try {
    // For nullsink mode, verify the nullsink server is running instead of real SMTP
    if ((mta as any).mode === "nullsink") {
      const nullsinkServer = getNullsinkServer();
      if (!nullsinkServer.isRunning()) {
        // Try to start the nullsink server
        await nullsinkServer.start();
      }
      // Nullsink server is ready
      return { success: true };
    }
    
    // For real mode, verify actual SMTP connection
    const transporter = createTransporter(mta);
    await transporter.verify();
    return { success: true };
  } catch (error: any) {
    return {
      success: false,
      error: error.message || "Failed to verify SMTP connection",
    };
  }
}

// Nullsink email sending - simulates SMTP but doesn't actually send
export interface NullsinkSendResult extends SendEmailResult {
  capture?: InsertNullsinkCapture;
}

export async function sendEmailWithNullsink(
  mta: Mta,
  subscriber: Subscriber,
  campaign: Campaign,
  trackingOptions: Omit<TrackingOptions, "campaignId" | "subscriberId">,
  customHeaders?: Record<string, string>
): Promise<NullsinkSendResult> {
  if ((mta as any).mode !== "nullsink") {
    return sendEmail(mta, subscriber, campaign, trackingOptions, customHeaders);
  }

  // Nullsink mode - simulate sending
  const startTime = Date.now();
  const nullsinkServer = getNullsinkServer();
  
  // Ensure nullsink server is running
  if (!nullsinkServer.isRunning()) {
    await nullsinkServer.start();
  }

  // Get MTA-specific settings (don't modify global server config to avoid race conditions)
  const simulatedLatencyMs = (mta as any).simulatedLatencyMs || 0;
  const failureRate = (mta as any).failureRate || 0;

  // Funnel through the shared `prepareTrackedHtml` chokepoint so the
  // nullsink path stays byte-identical with the SMTP / automation / Resend
  // paths.
  const prepared = prepareTrackedHtml(
    campaign,
    subscriber,
    mta as TrackedHtmlMta,
    {
      ...trackingOptions,
      campaignId: campaign.id,
      subscriberId: subscriber.id,
    },
  );
  const htmlContent = prepared.html;
  const unsubscribeUrl = prepared.unsubscribeUrl;
  const subject = prepared.subject;

  const nullsinkTransporter = getNullsinkTransporter();

  // Inject operator-configured DEFAULT headers + any caller-supplied custom
  // headers (parity with the real-SMTP `sendEmail` path so nullsink captures
  // reflect exactly what would go on the wire).
  const headers: Record<string, string> = await buildOutboundHeaders(unsubscribeUrl, customHeaders);

  // Defensive guard: strip X-Open-Tag / X-Click-Tag from operator-supplied
  // headers — these must never appear on the wire.
  sanitizeOutboundHeaders(headers);

  const mailOptions = {
    from: `"${campaign.fromName}" <${campaign.fromEmail}>`,
    replyTo: campaign.replyEmail || campaign.fromEmail,
    to: subscriber.email,
    subject: subject,
    html: htmlContent,
    headers,
  };

  const handshakeTime = Date.now() - startTime;

  try {
    await nullsinkTransporter.sendMail(mailOptions);
    
    // Apply simulated latency locally (per-send, not global server config)
    if (simulatedLatencyMs > 0) {
      await sleep(simulatedLatencyMs);
    }
    
    // Check if we should simulate a failure locally (per-send, not global server config)
    const shouldFail = Math.random() * 100 < failureRate;
    
    const totalTime = Date.now() - startTime;
    
    const capture: InsertNullsinkCapture = {
      campaignId: campaign.id,
      subscriberId: subscriber.id,
      mtaId: mta.id,
      fromEmail: campaign.fromEmail,
      toEmail: subscriber.email,
      subject: subject,
      messageSize: Buffer.byteLength(htmlContent, 'utf8'),
      htmlBody: htmlContent,
      status: shouldFail ? "simulated_failure" : "captured",
      handshakeTimeMs: handshakeTime,
      totalTimeMs: totalTime,
    };

    if (shouldFail) {
      return {
        success: false,
        error: "Simulated SMTP failure",
        capture,
      };
    }

    return {
      success: true,
      messageId: `nullsink-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      capture,
    };
  } catch (error: any) {
    const totalTime = Date.now() - startTime;
    
    // Real error (e.g., nullsink server not running) - still record capture for visibility
    const capture: InsertNullsinkCapture = {
      campaignId: campaign.id,
      subscriberId: subscriber.id,
      mtaId: mta.id,
      fromEmail: campaign.fromEmail,
      toEmail: subscriber.email,
      subject: subject,
      messageSize: Buffer.byteLength(htmlContent, 'utf8'),
      htmlBody: null,
      status: "simulated_failure",
      handshakeTimeMs: handshakeTime,
      totalTimeMs: totalTime,
    };

    return {
      success: false,
      error: error.message || "Nullsink send failed",
      capture,
    };
  }
}

/**
 * Send a test email via SMTP using the provided MTA configuration
 * This is a simpler version of sendEmail that doesn't require a subscriber or campaign object
 */
export interface TestEmailOptions {
  to: string;
  fromName: string;
  fromEmail: string;
  subject: string;
  htmlContent: string;
  preheader?: string | null;
  companyAddress?: string | null;
  unsubscribeText?: string | null;
  trackingDomain?: string | null;
  headers?: Record<string, string>;
}

/**
 * Single-shot transactional send (no per-campaign tracking, but uses the same
 * MTA transport, retries, image rewriting and footer infrastructure as the
 * campaign sender). Used by the automation engine for send_email steps.
 *
 * This is an alias of sendTestEmailViaSMTP — kept distinct so callers express
 * intent and we can specialize it later (e.g. opt-in tracking).
 */
export async function sendAutomationEmail(
  mta: Mta,
  options: TestEmailOptions
): Promise<SendEmailResult> {
  return sendTestEmailViaSMTP(mta, options);
}

/**
 * Optional tracking context for test sends. When provided, the test path
 * funnels through `prepareTrackedHtml` exactly like a real campaign send
 * so the previewed HTML reflects what a recipient would actually receive
 * (open pixel + click rewriting + footer). Default behavior (when this
 * is undefined) remains "preview only — no tracking" to avoid polluting
 * analytics from developer test sends.
 */
export interface TestEmailTrackingContext {
  campaign: TrackedHtmlCampaign;
  subscriber: TrackedHtmlSubscriber;
  tracking: Omit<TrackingOptions, "campaignId" | "subscriberId">;
}

export async function sendTestEmailViaSMTP(
  mta: Mta,
  options: TestEmailOptions,
  trackingContext?: TestEmailTrackingContext,
): Promise<SendEmailResult> {
  // If MTA is in nullsink mode, just simulate success
  if ((mta as any).mode === "nullsink") {
    logger.info('Nullsink mode - simulating successful send', { to: options.to });
    return {
      success: true,
      messageId: `nullsink-test-${Date.now()}@local`,
    };
  }

  // Create transporter for this MTA
  const transporter = createTransporter(mta);

  let htmlContent: string;

  if (trackingContext) {
    // Tracked test send: route through the shared chokepoint so the
    // preview is byte-identical with a real bulk send.
    const prepared = prepareTrackedHtml(
      trackingContext.campaign,
      trackingContext.subscriber,
      mta as TrackedHtmlMta,
      {
        ...trackingContext.tracking,
        campaignId: trackingContext.campaign.id,
        subscriberId: trackingContext.subscriber.id,
      },
      { injectPreheader: !!trackingContext.campaign.preheader },
    );
    htmlContent = prepared.html;
  } else {
    // Untracked test send (default): minimal pipeline, no tracking pixels
    // or rewritten click URLs.
    htmlContent = options.htmlContent;
    if (options.preheader) {
      const preheaderHtml = `<div style="display:none;font-size:1px;color:#ffffff;line-height:1px;max-height:0px;max-width:0px;opacity:0;overflow:hidden;">${options.preheader}</div>`;
      htmlContent = htmlContent.replace(/(<body[^>]*>)/i, `$1${preheaderHtml}`);
    }
    const imageHostingDomain = (mta as any).imageHostingDomain;
    if (imageHostingDomain) {
      htmlContent = rewriteImageUrls(htmlContent, imageHostingDomain);
    }
    const testBaseUrl = normalizeBaseUrl(options.trackingDomain);
    const testUnsubscribeUrl = testBaseUrl
      ? `${testBaseUrl}/api/unsubscribe/test/test`
      : "";
    htmlContent = appendFooterToHtml(
      htmlContent,
      buildEmailFooter({
        unsubscribeText: options.unsubscribeText,
        companyAddress: options.companyAddress,
        unsubscribeUrl: testUnsubscribeUrl || undefined,
      })
    );
  }

  // Build mail options
  const mailOptions: nodemailer.SendMailOptions = {
    from: `${options.fromName} <${options.fromEmail}>`,
    to: options.to,
    subject: options.subject,
    html: htmlContent,
    headers: sanitizeOutboundHeaders({ ...(options.headers || {}) }),
  };
  
  // Attempt to send with retries
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      logger.info('Sending via SMTP', { hostname: mta.hostname, port: mta.port, to: options.to, attempt });
      const info = await sendMailBounded(transporter, mailOptions);
      logger.info('Sent successfully', { messageId: info.messageId });
      return {
        success: true,
        messageId: info.messageId,
      };
    } catch (error: any) {
      logger.error('SMTP error', { attempt, errorMessage: error.message });
      
      // Check for transient errors that are worth retrying
      const isTransient = 
        error.code === "ECONNRESET" ||
        error.code === "ETIMEDOUT" ||
        error.code === "ECONNREFUSED" ||
        error.responseCode === 421 ||
        error.responseCode === 450 ||
        error.responseCode === 451;
      
      if (isTransient && attempt < MAX_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * attempt));
        continue;
      }
      
      return {
        success: false,
        error: error.message || "SMTP send failed",
      };
    }
  }
  
  return {
    success: false,
    error: "Max retries exceeded",
  };
}

export function precomputeBaseHtml(campaign: Campaign, mta: Mta): string {
  let baseHtml = campaign.htmlContent;
  baseHtml = rewriteImageUrls(baseHtml, (mta as any).imageHostingDomain, campaignContext(campaign));
  if (campaign.preheader) {
    baseHtml = `<span style="display:none;font-size:1px;color:#ffffff;line-height:1px;max-height:0px;max-width:0px;opacity:0;overflow:hidden;">${campaign.preheader}</span>` + baseHtml;
  }
  return baseHtml;
}

export interface BatchNullsinkResult {
  subscriberId: string;
  email: string;
  success: boolean;
  error?: string;
  capture: InsertNullsinkCapture;
}

export function sendEmailBatchNullsink(
  mta: Mta,
  subscribers: Array<{ id: string; email: string; tags?: string[] }>,
  campaign: Campaign,
  trackingOptions: Omit<TrackingOptions, "campaignId" | "subscriberId">,
  customHeaders?: Record<string, string>,
  precomputedBaseHtml?: string
): BatchNullsinkResult[] {
  const failureRate = (mta as any).failureRate || 0;

  const baseHtml = precomputedBaseHtml ?? precomputeBaseHtml(campaign, mta);

  const results: BatchNullsinkResult[] = [];
  let htmlBodyStored = false;

  // Build a wrapper campaign carrying the precomputed `baseHtml` (already
   // image-rewritten + preheader-prepended) as its htmlContent so the shared
   // `prepareTrackedHtml` chokepoint applies personalize → tracking → footer
   // without redoing the per-batch precompute work. preheader cleared so
   // we don't re-inject it.
  const wrappedCampaign: TrackedHtmlCampaign = {
    ...campaign,
    htmlContent: baseHtml,
    preheader: null,
  };

  for (const sub of subscribers) {
    try {
      const subscriber: TrackedHtmlSubscriber = {
        id: sub.id,
        email: sub.email,
        tags: sub.tags || [],
      };

      const prepared = prepareTrackedHtml(
        wrappedCampaign,
        subscriber,
        mta as TrackedHtmlMta,
        {
          ...trackingOptions,
          campaignId: campaign.id,
          subscriberId: subscriber.id,
        },
      );
      const htmlContent = prepared.html;
      const subject = prepared.subject;
      const messageSize = Buffer.byteLength(htmlContent, 'utf8');

      const shouldFail = failureRate > 0 && Math.random() * 100 < failureRate;

      const capture: InsertNullsinkCapture = {
        campaignId: campaign.id,
        subscriberId: subscriber.id,
        mtaId: mta.id,
        fromEmail: campaign.fromEmail,
        toEmail: subscriber.email,
        subject: subject,
        messageSize: messageSize,
        htmlBody: !htmlBodyStored ? htmlContent : null,
        status: shouldFail ? "simulated_failure" : "captured",
        handshakeTimeMs: 0,
        totalTimeMs: 0,
      };
      if (!htmlBodyStored) htmlBodyStored = true;

      results.push({
        subscriberId: subscriber.id,
        email: subscriber.email,
        success: !shouldFail,
        error: shouldFail ? "Simulated batch failure" : undefined,
        capture,
      });
    } catch (error: any) {
      const capture: InsertNullsinkCapture = {
        campaignId: campaign.id,
        subscriberId: sub.id,
        mtaId: mta.id,
        fromEmail: campaign.fromEmail,
        toEmail: sub.email,
        subject: campaign.subject,
        messageSize: 0,
        htmlBody: null,
        status: "simulated_failure",
        handshakeTimeMs: 0,
        totalTimeMs: 0,
      };

      results.push({
        subscriberId: sub.id,
        email: sub.email,
        success: false,
        error: error.message || "Batch processing error",
        capture,
      });
    }
  }

  return results;
}
