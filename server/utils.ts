import * as fs from "fs";
import * as path from "path";
import * as dns from "dns";
import * as http from "http";
import * as https from "https";
import crypto from "crypto";
import ipaddr from "ipaddr.js";
import sanitizeHtml from "sanitize-html";
import { logger } from "./logger";

export const IMAGES_DIR = path.join(process.cwd(), "images");
export const TEMP_SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** Generate a random base62 string of the given length. */
export function generateBase62(length: number): string {
  const bytes = crypto.randomBytes(length);
  return Array.from(bytes).map(b => BASE62[b % 62]).join('');
}

export function cleanupOrphanedTempSessions(): void {
  try {
    if (!fs.existsSync(IMAGES_DIR)) return;
    
    const entries = fs.readdirSync(IMAGES_DIR);
    const now = Date.now();
    
    for (const entry of entries) {
      // Support both legacy "temp_" prefix and new "draft-" prefix
      if (!entry.startsWith("temp_") && !entry.startsWith("draft-")) continue;
      
      const entryPath = path.join(IMAGES_DIR, entry);
      const stat = fs.statSync(entryPath);
      
      if (!stat.isDirectory()) continue;

      // Never delete a session folder that contains any files — those files are
      // hosted at permanent URLs and must not be removed. Only clean up truly
      // empty directories (abandoned sessions where no images were ever uploaded).
      const files = fs.readdirSync(entryPath);
      if (files.length > 0) continue;
      
      const age = now - stat.mtimeMs;
      if (age > TEMP_SESSION_MAX_AGE_MS) {
        fs.rmdirSync(entryPath);
        logger.info(`Cleaned up empty orphaned draft session: ${entry}`);
      }
    }
  } catch (error) {
    logger.error("Error cleaning up temp sessions:", error);
  }
}

/**
 * Generic/non-descriptive single-segment names that should fall back to
 * indexed naming rather than being used as-is.
 */
const GENERIC_IMAGE_NAMES = new Set([
  'img', 'image', 'images', 'photo', 'photos', 'pic', 'pics',
  'picture', 'pictures', 'thumbnail', 'thumb', 'banner', 'asset',
  'file', 'upload', 'media', 'content', 'graphic', 'logo', 'icon',
]);

/**
 * Derives a clean, sanitized filename from a source image URL.
 * Extracts the pathname's last segment, strips the extension, sanitizes to
 * alphanumeric + hyphens + underscores, then re-appends the extension.
 * Falls back to `img-{fallbackIndex}.{ext}` when no meaningful name is found
 * (e.g. query-only URLs like /img?id=42, or generic names like /image.jpg).
 */
export function sanitizeImageFilename(sourceUrl: string, fallbackIndex: number, ext: string): string {
  try {
    const urlObj = new URL(sourceUrl);
    const rawName = urlObj.pathname.split('/').pop() || '';
    // Strip extension from raw name
    const withoutExt = rawName.replace(/\.[^.]+$/, '');
    // Sanitize: replace disallowed chars with hyphen, collapse & trim
    const sanitized = withoutExt
      .replace(/[^a-zA-Z0-9_-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '');
    // Must be non-empty, contain at least one letter/hyphen/underscore,
    // be longer than 1 char, and not be a generic/non-descriptive name
    if (
      sanitized.length > 1 &&
      /[a-zA-Z_-]/.test(sanitized) &&
      !GENERIC_IMAGE_NAMES.has(sanitized.toLowerCase())
    ) {
      return `${sanitized}.${ext}`;
    }
  } catch {}
  return `img-${fallbackIndex}.${ext}`;
}

export function isBlockedIP(ip: string): boolean {
  const normalized = ip.trim().replace(/^\[|\]$/g, "");
  try {
    let parsed: any = ipaddr.parse(normalized);
    // IPv4-mapped IPv6 is still an IPv4 socket destination.  Convert before
    // applying the IPv4 range policy; otherwise hexadecimal forms such as
    // ::ffff:7f00:1 and ::ffff:a00:1 bypass dotted-quad checks.
    if (parsed.kind() === "ipv6" && parsed.isIPv4MappedAddress()) {
      parsed = parsed.toIPv4Address();
    }
    if (parsed.kind() === "ipv4") {
      const octets = parsed.octets;
      const [a, b] = octets;
      // ipaddr's range table covers loopback, RFC1918, link-local, CGNAT,
      // multicast, unspecified and reserved/documentation ranges.  Keep the
      // benchmarking range explicit because it is classified as unicast.
      return parsed.range() !== "unicast" || (a === 198 && b >= 18 && b <= 19);
    }
    // Only globally routable IPv6 unicast is acceptable.  This excludes
    // fc/fd ULA, fe80/febf link-local, multicast, transition mechanisms
    // (Teredo/6to4), documentation and all other special-use ranges.
    const bytes = parsed.toByteArray();
    return (bytes[0] & 0xe0) !== 0x20 || parsed.range() !== "unicast";
  } catch {
    // Anything that is not a canonical IP literal is unsafe when supplied as
    // the result of a resolver.
    return true;
  }
}

export function isBlockedHost(hostname: string): boolean {
  const literal = hostname.trim().replace(/^\[|\]$/g, "");
  if (ipaddr.isValid(literal) && isBlockedIP(literal)) return true;
  const blockedPatterns = [
    /^localhost$/i,
    /^127\.\d+\.\d+\.\d+$/,
    /^10\.\d+\.\d+\.\d+$/,
    /^192\.168\.\d+\.\d+$/,
    /^172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+$/,
    /^169\.254\.\d+\.\d+$/,
    /^0\.0\.0\.0$/,
    /^\[?::1\]?$/,
    /^\[?fe80:/i,
    /^\[?fc00:/i,
    /^\[?fd00:/i,
  ];
  return blockedPatterns.some(pattern => pattern.test(hostname));
}

const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const IMAGE_REQUEST_TIMEOUT_MS = 15_000;
const IMAGE_MAX_REDIRECTS = 3;

type ResolvedImageAddress = { address: string; family: 4 | 6 };
type ImageAddressResolver = (hostname: string) => Promise<ResolvedImageAddress[]>;
type PinnedImageRequester = (url: URL, address: ResolvedImageAddress, deadlineAt?: number) => Promise<http.IncomingMessage>;

/**
 * Resolve every address before connecting.  Rejecting a hostname when ANY
 * answer is private is intentional: selecting the first answer would leave a
 * public/private DNS race to the OS resolver.  The selected address is then
 * pinned through http(s).request's lookup callback.
 */
export async function resolvePublicImageAddresses(hostname: string): Promise<ResolvedImageAddress[]> {
  const results = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  const addresses = results.map((result) => ({
    address: result.address,
    family: result.family === 6 ? 6 as const : 4 as const,
  }));
  if (!addresses.length || addresses.some(({ address }) => isBlockedIP(address))) {
    throw new Error(`DNS answer for ${hostname} contains a blocked address`);
  }
  return addresses;
}

function imageContentTypeAllowed(value: string | string[] | undefined): boolean {
  if (!value) return true;
  const contentType = Array.isArray(value) ? value[0] : value;
  if (!contentType) return true;
  return /^image\/(?:jpeg|png|gif|webp|svg\+xml|bmp|x-icon|vnd\.microsoft\.icon)(?:\s*;|$)/i.test(contentType.trim());
}

function requestPinnedImage(
  urlObj: URL,
  address: ResolvedImageAddress,
  deadlineAt = Date.now() + IMAGE_REQUEST_TIMEOUT_MS,
  connectOverride?: { address: string; port: number },
): Promise<http.IncomingMessage> {
  const transport = urlObj.protocol === "https:" ? https : http;
  // The socket destination: the validated public address (tests point it at
  // a local fixture, the logical URL/Host/SNI staying untouched).
  const pinned: ResolvedImageAddress = connectOverride
    ? { address: connectOverride.address, family: 4 }
    : address;
  return new Promise((resolve, reject) => {
    const remaining = Math.max(1, deadlineAt - Date.now());
    let deadlineTimer: ReturnType<typeof setTimeout>;
    let promiseSettled = false;
    const onError = (error: Error) => {
      clearTimeout(deadlineTimer);
      // The request promise is normally settled as soon as headers arrive,
      // but the ClientRequest can still emit an error when its socket is
      // destroyed while the response body is being handled. Keep this
      // listener for the request's entire lifetime so that late errors never
      // become process-level unhandled errors.
      if (!promiseSettled) {
        promiseSettled = true;
        reject(error);
      }
    };
    const request = transport.request({
      protocol: urlObj.protocol,
      // Keep the logical hostname for Host/SNI while lookup pins the socket
      // to the already validated address. TLS certificate verification remains
      // against the original hostname via `servername`.
      hostname: urlObj.hostname,
      port: connectOverride?.port ?? (urlObj.port || (urlObj.protocol === "https:" ? 443 : 80)),
      path: `${urlObj.pathname}${urlObj.search}`,
      method: "GET",
      headers: {
        Host: urlObj.host,
        "User-Agent": "Mozilla/5.0 (compatible; CritsendBot/1.0)",
      },
      // Never a second DNS query: the pinned address is the only answer. Node
      // ≥ 20 (autoSelectFamily) asks with `all: true` and expects an ARRAY of
      // {address, family}; answering a bare string there makes every real
      // connection fail with "Invalid IP address: undefined". Older Node (or
      // a forced family) asks without `all` and expects (address, family).
      lookup: (_hostname, options, callback) => {
        if (options && typeof options === "object" && (options as { all?: boolean }).all) {
          (callback as unknown as (err: null, addresses: Array<{ address: string; family: number }>) => void)(null, [{ address: pinned.address, family: pinned.family }]);
          return;
        }
        callback(null, pinned.address, pinned.family);
      },
      ...(urlObj.protocol === "https:" ? { servername: urlObj.hostname } : {}),
    }, (response) => {
      clearTimeout(deadlineTimer);
      promiseSettled = true;
      Object.defineProperty(response, "__imageRequest", { value: request, configurable: true });
      resolve(response);
    });
    // setTimeout is only an inactivity guard. The hard deadline is separate
    // and spans DNS, connection setup, redirects, and response streaming.
    request.setTimeout(Math.min(IMAGE_REQUEST_TIMEOUT_MS, remaining), () => request.destroy(new Error("image request inactivity timeout")));
    deadlineTimer = setTimeout(() => request.destroy(new Error("image download deadline exceeded")), remaining);
    request.on("error", onError);
    request.end();
  });
}

function destroyDiscardedImageResponse(response: http.IncomingMessage, error?: Error): void {
  const request = (response as any).__imageRequest as { destroy: (cause?: Error) => void } | undefined;
  // Destroy both sides. Calling resume() here would permit an attacker to
  // keep an unwanted redirect/error body alive indefinitely.
  request?.destroy(error);
  response.destroy(error);
}

function abortDiscardedImageResponse(
  response: http.IncomingMessage,
  deadlineTimer: ReturnType<typeof setTimeout>,
  error?: Error,
): void {
  clearTimeout(deadlineTimer);
  destroyDiscardedImageResponse(response, error);
}

async function downloadImageInternal(
  url: string,
  destPath: string,
  redirectCount: number,
  network: { resolve: ImageAddressResolver; request: PinnedImageRequester },
  deadlineAt: number,
): Promise<boolean> {
  if (Date.now() >= deadlineAt) {
    logger.info(`[Image download] Failed: ${url} - overall deadline exceeded`);
    return false;
  }
  if (redirectCount > IMAGE_MAX_REDIRECTS) {
    logger.info(`[Image download] Failed: ${url} - too many redirects`);
    return false;
  }

  let urlObj: URL;
  let addresses: ResolvedImageAddress[];
  try {
    urlObj = new URL(url);
    if (urlObj.protocol !== "http:" && urlObj.protocol !== "https:") {
      logger.info(`[Image download] Failed: ${url} - invalid protocol`);
      return false;
    }
    if (isBlockedHost(urlObj.hostname)) {
      logger.info(`[Image download] Failed: ${url} - blocked host`);
      return false;
    }
    const remaining = Math.max(1, deadlineAt - Date.now());
    addresses = await new Promise<ResolvedImageAddress[]>((resolve, reject) => {
      const dnsTimer = setTimeout(() => reject(new Error("DNS lookup timeout")), remaining);
      Promise.resolve()
        .then(() => network.resolve(urlObj.hostname))
        .then(resolve, reject)
        .finally(() => clearTimeout(dnsTimer));
    });
  } catch (error) {
    logger.info(`[Image download] Failed: ${url} - DNS/URL error: ${error}`);
    return false;
  }

  // One validated address is chosen and passed to the socket lookup callback;
  // the callback never performs a second DNS lookup.
  const address = addresses[0];
  let response: http.IncomingMessage | undefined;
  let responseDeadlineTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const currentResponse = await network.request(urlObj, address, deadlineAt);
    response = currentResponse;
    const responseRemaining = deadlineAt - Date.now();
    if (responseRemaining <= 0) {
      destroyDiscardedImageResponse(currentResponse, new Error("image download deadline exceeded"));
      return false;
    }
    responseDeadlineTimer = setTimeout(
      () => destroyDiscardedImageResponse(currentResponse, new Error("image download deadline exceeded")),
      responseRemaining,
    );
    if ((currentResponse.statusCode ?? 0) >= 300 && (currentResponse.statusCode ?? 0) < 400) {
      const location = currentResponse.headers.location;
      abortDiscardedImageResponse(currentResponse, responseDeadlineTimer);
      responseDeadlineTimer = undefined;
      if (!location) return false;
      try {
        const redirected = new URL(Array.isArray(location) ? location[0] : location, urlObj);
        return downloadImageInternal(redirected.href, destPath, redirectCount + 1, network, deadlineAt);
      } catch {
        return false;
      }
    }
    if (currentResponse.statusCode !== 200) {
      abortDiscardedImageResponse(currentResponse, responseDeadlineTimer);
      responseDeadlineTimer = undefined;
      logger.info(`[Image download] Failed: ${url} - HTTP ${currentResponse.statusCode}`);
      return false;
    }
    if (!imageContentTypeAllowed(currentResponse.headers["content-type"])) {
      abortDiscardedImageResponse(currentResponse, responseDeadlineTimer);
      responseDeadlineTimer = undefined;
      logger.info(`[Image download] Failed: ${url} - unsupported content type`);
      return false;
    }
    const contentLength = Number.parseInt(String(currentResponse.headers["content-length"] ?? "0"), 10);
    if (contentLength > IMAGE_MAX_BYTES) {
      abortDiscardedImageResponse(currentResponse, responseDeadlineTimer);
      responseDeadlineTimer = undefined;
      logger.info(`[Image download] Failed: ${url} - content-length exceeds 10MB`);
      return false;
    }

    const fileStream = fs.createWriteStream(destPath, { mode: 0o644 });
    let downloadedSize = 0;
    let settled = false;
    return await new Promise<boolean>((resolve) => {
      const fail = (message: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(responseDeadlineTimer);
        responseDeadlineTimer = undefined;
        destroyDiscardedImageResponse(currentResponse);
        fileStream.destroy();
        fs.unlink(destPath, () => {});
        logger.info(`[Image download] Failed: ${url} - ${message}`);
        resolve(false);
      };
      let responseEnded = false;
      currentResponse.once("end", () => { responseEnded = true; });
      currentResponse.on("data", (chunk: Buffer) => {
        downloadedSize += chunk.length;
        if (downloadedSize > IMAGE_MAX_BYTES) fail("response exceeds 10MB");
      });
      currentResponse.once("error", (error) => fail(`stream error: ${error.message}`));
      currentResponse.once("aborted", () => fail("response aborted"));
      currentResponse.once("close", () => {
        if (!settled && !responseEnded) fail("response closed before completion");
      });
      fileStream.once("error", (error) => fail(`write error: ${error.message}`));
      fileStream.once("finish", () => {
        if (!settled) {
          settled = true;
          clearTimeout(responseDeadlineTimer);
          responseDeadlineTimer = undefined;
          resolve(true);
        }
      });
      currentResponse.pipe(fileStream);
    });
  } catch (error: any) {
    if (responseDeadlineTimer) {
      clearTimeout(responseDeadlineTimer);
      responseDeadlineTimer = undefined;
    }
    if (response) destroyDiscardedImageResponse(response);
    logger.info(`[Image download] Failed: ${url} - request error: ${error?.message || error}`);
    fs.unlink(destPath, () => {});
    return false;
  }
}

export function downloadImage(url: string, destPath: string, redirectCount = 0): Promise<boolean> {
  return downloadImageInternal(url, destPath, redirectCount, {
    resolve: resolvePublicImageAddresses,
    request: requestPinnedImage,
  }, Date.now() + IMAGE_REQUEST_TIMEOUT_MS);
}

/** Dependency-injected entry point used by SSRF behavioral tests. */
export function downloadImageWithNetworkForTest(
  url: string,
  destPath: string,
  network: { resolve: ImageAddressResolver; request: PinnedImageRequester },
  timeoutMs = IMAGE_REQUEST_TIMEOUT_MS,
): Promise<boolean> {
  return downloadImageInternal(url, destPath, 0, network, Date.now() + timeoutMs);
}

/** Uses the production pinned ClientRequest while allowing tests to connect
 * to a local fixture server: the URL keeps its (unresolvable) hostname, so
 * the request goes through the same lookup callback as in production, and
 * the pinned answer is the fixture's address. Host/SNI remain unchanged. */
export function requestPinnedImageForTest(
  url: string,
  address: ResolvedImageAddress,
  connectTo: { address: string; port: number },
  timeoutMs = IMAGE_REQUEST_TIMEOUT_MS,
): Promise<http.IncomingMessage> {
  return requestPinnedImage(new URL(url), address, Date.now() + timeoutMs, connectTo);
}

export function getExtensionFromUrl(url: string): string {
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname;
    const match = pathname.match(/\.([a-zA-Z0-9]+)(?:\?|$)/);
    if (match) {
      const ext = match[1].toLowerCase();
      if (["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "ico"].includes(ext)) {
        return ext === "jpeg" ? "jpg" : ext;
      }
    }
  } catch {}
  return "jpg";
}

export function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_").substring(0, 50);
}

export function sanitizeCampaignHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat([
      'img', 'style', 'head', 'html', 'body', 'meta', 'title',
      'center', 'font', 'span', 'div', 'table', 'tr', 'td', 'th',
      'thead', 'tbody', 'tfoot', 'caption', 'colgroup', 'col',
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'br', 'p',
      'a', 'b', 'i', 'u', 'em', 'strong', 'sup', 'sub',
      'ul', 'ol', 'li', 'blockquote', 'pre', 'code',
    ]),
    allowedAttributes: {
      '*': ['style', 'class', 'id', 'dir', 'lang', 'align', 'valign', 'bgcolor', 'background', 'width', 'height', 'border', 'cellpadding', 'cellspacing'],
      'a': ['href', 'target', 'rel', 'title', 'name'],
      'img': ['src', 'alt', 'title', 'width', 'height'],
      'td': ['colspan', 'rowspan', 'width', 'height', 'align', 'valign', 'bgcolor', 'style'],
      'th': ['colspan', 'rowspan', 'width', 'height', 'align', 'valign', 'bgcolor', 'style'],
      'table': ['width', 'height', 'border', 'cellpadding', 'cellspacing', 'align', 'bgcolor', 'style'],
      'font': ['color', 'size', 'face'],
      'meta': ['charset', 'name', 'content', 'http-equiv'],
    },
    allowedSchemes: ['http', 'https', 'mailto', 'data'],
    allowedSchemesByTag: {
      img: ['http', 'https', 'data'],
    },
    allowVulnerableTags: false,
  });
}

export function sanitizeCsvValue(val: string): string {
  if (val && /^[=+\-@\t\r]/.test(val)) {
    return "'" + val;
  }
  return val;
}

export function parsePagination(query: any): { page: number; limit: number } {
  const page = Math.max(1, Math.min(10000, parseInt(query.page as string) || 1));
  const limit = Math.max(1, Math.min(100, parseInt(query.limit as string) || 20));
  return { page, limit };
}

export function validateId(id: string): boolean {
  return typeof id === 'string' && id.length > 0 && id.length <= 100 && /^[a-zA-Z0-9_-]+$/.test(id);
}

export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];
  const effectiveConcurrency = Math.max(1, Math.min(concurrency, items.length));
  const results: R[] = new Array(items.length);
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i]);
    }
  }

  const workers = Array.from({ length: effectiveConcurrency }, () => worker());
  // Do not reject as soon as one worker fails: sibling workers may already
  // have downloaded/renamed files.  The caller must receive the failure only
  // after every worker has settled so its cleanup cannot race those writes.
  const settled = await Promise.allSettled(workers);
  const failure = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failure) throw failure.reason;
  return results;
}
