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

/**
 * Returns the current date + `days` in RFC 2822 format.
 * Example: "Wed, 8 Apr 2026 05:28:25 +0000"
 */
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
  personalized = personalized.replace(/\{\{subscriber_id\}\}/gi, subscriber.id);
  if (subscriber.tags && subscriber.tags.length > 0) {
    personalized = personalized.replace(/\{\{tags\}\}/gi, subscriber.tags.join(", "));
  }
  return personalized;
}

// Rewrite local image URLs to use the image hosting domain
export function rewriteImageUrls(html: string, imageHostingDomain: string | null | undefined): string {
  if (!imageHostingDomain) {
    return html;
  }
  
  // Normalize: remove trailing slash, ensure https:// scheme
  const raw = imageHostingDomain.replace(/\/$/, "");
  const domain = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  
  // Match src="/images/..." patterns and replace with full absolute URL
  // Also handles src='/images/...' (single quotes)
  return html.replace(
    /src=(["'])\/images\//g,
    `src=$1${domain}/images/`
  );
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

  let htmlContent = personalizeContent(campaign.htmlContent, subscriber);
  
  // Rewrite local image URLs to use the MTA's image hosting domain
  htmlContent = rewriteImageUrls(htmlContent, (mta as any).imageHostingDomain);
  
  // Resolve unsubscribe URL and replace placeholder in HTML body
  const baseUrl = normalizeBaseUrl(trackingOptions.trackingDomain);
  // Prefer short /u/{token} when a batch token is available for this subscriber
  const unsubToken = trackingOptions.batchUnsubTokens?.get(subscriber.id);
  const unsubscribeUrl = unsubToken && baseUrl
    ? `${baseUrl}/u/${unsubToken}`
    : (baseUrl ? generateSignedUnsubscribeUrl(baseUrl, campaign.id, subscriber.id) : "");
  if (unsubscribeUrl && htmlContent.includes("{{unsubscribe_url}}")) {
    htmlContent = htmlContent.replace(/\{\{unsubscribe_url\}\}/gi, unsubscribeUrl);
  }

  htmlContent = addTrackingToHtml(htmlContent, {
    campaignId: campaign.id,
    subscriberId: subscriber.id,
    trackOpens: trackingOptions.trackOpens,
    trackClicks: trackingOptions.trackClicks,
    trackingDomain: trackingOptions.trackingDomain,
    openTrackingDomain: trackingOptions.openTrackingDomain,
    openTag: trackingOptions.openTag,
    clickTag: trackingOptions.clickTag,
    linkMap: trackingOptions.linkMap,
    batchClickTokens: trackingOptions.batchClickTokens,
    batchUnsubTokens: trackingOptions.batchUnsubTokens,
  });

  // Append footer (unsubscribe link + company address) after tracking
  htmlContent = appendFooterToHtml(
    htmlContent,
    buildEmailFooter({
      unsubscribeText: campaign.unsubscribeText,
      companyAddress: campaign.companyAddress,
      unsubscribeUrl: unsubscribeUrl || undefined,
    })
  );

  const subject = personalizeContent(campaign.subject, subscriber);

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

  if (campaign.openTag) {
    mailOptions.headers["X-Open-Tag"] = campaign.openTag;
  }
  if (campaign.clickTag) {
    mailOptions.headers["X-Click-Tag"] = campaign.clickTag;
  }
  
  // Apply custom headers with placeholder replacement
  if (customHeaders) {
    const date7 = rfc2822DatePlusDays(7);
    
    for (const [headerName, headerValue] of Object.entries(customHeaders)) {
      const resolvedValue = headerValue
        .replace(/\{UNSUBSCRIBE\}/gi, unsubscribeUrl)
        .replace(/\{DATE\+7\}/gi, date7);
      mailOptions.headers[headerName] = resolvedValue;
    }
  }

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const info = await transporter.sendMail(mailOptions);
      
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

  // Build the email content similar to normal sending
  let htmlContent = personalizeContent(campaign.htmlContent, subscriber);
  
  // Rewrite local image URLs to use the MTA's image hosting domain
  htmlContent = rewriteImageUrls(htmlContent, (mta as any).imageHostingDomain);
  const baseUrl = normalizeBaseUrl(trackingOptions.trackingDomain);
  // Prefer short /u/{token} when a batch token is available for this subscriber
  const unsubTokenNullsink = trackingOptions.batchUnsubTokens?.get(subscriber.id);
  const unsubscribeUrl = unsubTokenNullsink && baseUrl
    ? `${baseUrl}/u/${unsubTokenNullsink}`
    : (baseUrl ? generateSignedUnsubscribeUrl(baseUrl, campaign.id, subscriber.id) : "");
  if (unsubscribeUrl && htmlContent.includes("{{unsubscribe_url}}")) {
    htmlContent = htmlContent.replace(/\{\{unsubscribe_url\}\}/gi, unsubscribeUrl);
  }

  htmlContent = addTrackingToHtml(htmlContent, {
    campaignId: campaign.id,
    subscriberId: subscriber.id,
    trackOpens: trackingOptions.trackOpens,
    trackClicks: trackingOptions.trackClicks,
    trackingDomain: trackingOptions.trackingDomain,
    openTrackingDomain: trackingOptions.openTrackingDomain,
    openTag: trackingOptions.openTag,
    clickTag: trackingOptions.clickTag,
    linkMap: trackingOptions.linkMap,
    batchClickTokens: trackingOptions.batchClickTokens,
    batchUnsubTokens: trackingOptions.batchUnsubTokens,
  });

  // Append footer after tracking
  htmlContent = appendFooterToHtml(
    htmlContent,
    buildEmailFooter({
      unsubscribeText: campaign.unsubscribeText,
      companyAddress: campaign.companyAddress,
      unsubscribeUrl: unsubscribeUrl || undefined,
    })
  );

  const subject = personalizeContent(campaign.subject, subscriber);

  const nullsinkTransporter = getNullsinkTransporter();

  const headers: Record<string, string> = {};
  
  // Apply custom headers with placeholder replacement
  if (customHeaders) {
    const date7 = rfc2822DatePlusDays(7);
    
    for (const [headerName, headerValue] of Object.entries(customHeaders)) {
      const resolvedValue = headerValue
        .replace(/\{UNSUBSCRIBE\}/gi, unsubscribeUrl)
        .replace(/\{DATE\+7\}/gi, date7);
      headers[headerName] = resolvedValue;
    }
  }
  
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

export async function sendTestEmailViaSMTP(
  mta: Mta,
  options: TestEmailOptions
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
  
  // Process HTML content - add preheader if provided
  let htmlContent = options.htmlContent;
  if (options.preheader) {
    const preheaderHtml = `<div style="display:none;font-size:1px;color:#ffffff;line-height:1px;max-height:0px;max-width:0px;opacity:0;overflow:hidden;">${options.preheader}</div>`;
    htmlContent = htmlContent.replace(/(<body[^>]*>)/i, `$1${preheaderHtml}`);
  }
  
  // Rewrite local image URLs if image hosting domain is configured
  const imageHostingDomain = (mta as any).imageHostingDomain;
  if (imageHostingDomain) {
    htmlContent = rewriteImageUrls(htmlContent, imageHostingDomain);
  }

  // Append footer preview (uses a placeholder URL since this is a test send)
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

  // Build mail options
  const mailOptions: nodemailer.SendMailOptions = {
    from: `${options.fromName} <${options.fromEmail}>`,
    to: options.to,
    subject: options.subject,
    html: htmlContent,
    headers: options.headers || {},
  };
  
  // Attempt to send with retries
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      logger.info('Sending via SMTP', { hostname: mta.hostname, port: mta.port, to: options.to, attempt });
      const info = await transporter.sendMail(mailOptions);
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
  baseHtml = rewriteImageUrls(baseHtml, (mta as any).imageHostingDomain);
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
  const baseUrl = normalizeBaseUrl(trackingOptions.trackingDomain);

  const baseHtml = precomputedBaseHtml ?? precomputeBaseHtml(campaign, mta);

  const results: BatchNullsinkResult[] = [];
  let htmlBodyStored = false;

  for (const sub of subscribers) {
    try {
      const subscriber: Subscriber = {
        id: sub.id,
        email: sub.email,
        tags: sub.tags || [],
        ipAddress: null,
        importDate: new Date(),
      };

      let htmlContent = personalizeContent(baseHtml, subscriber);

      // Prefer short /u/{token} when a batch token is available
      const unsubTokenBatch = trackingOptions.batchUnsubTokens?.get(subscriber.id);
      const unsubscribeUrl = unsubTokenBatch && baseUrl
        ? `${baseUrl}/u/${unsubTokenBatch}`
        : (baseUrl ? generateSignedUnsubscribeUrl(baseUrl, campaign.id, subscriber.id) : "");
      if (unsubscribeUrl && htmlContent.includes("{{unsubscribe_url}}")) {
        htmlContent = htmlContent.replace(/\{\{unsubscribe_url\}\}/gi, unsubscribeUrl);
      }

      htmlContent = addTrackingToHtml(htmlContent, {
        campaignId: campaign.id,
        subscriberId: subscriber.id,
        trackOpens: trackingOptions.trackOpens,
        trackClicks: trackingOptions.trackClicks,
        trackingDomain: trackingOptions.trackingDomain,
        openTrackingDomain: trackingOptions.openTrackingDomain,
        openTag: trackingOptions.openTag,
        clickTag: trackingOptions.clickTag,
        linkMap: trackingOptions.linkMap,
        batchClickTokens: trackingOptions.batchClickTokens,
        batchUnsubTokens: trackingOptions.batchUnsubTokens,
      });

      // Append footer (unsubscribe link + company address) after tracking
      htmlContent = appendFooterToHtml(
        htmlContent,
        buildEmailFooter({
          unsubscribeText: campaign.unsubscribeText,
          companyAddress: campaign.companyAddress,
          unsubscribeUrl: unsubscribeUrl || undefined,
        })
      );

      const subject = personalizeContent(campaign.subject, subscriber);
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
