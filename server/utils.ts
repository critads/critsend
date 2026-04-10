import * as fs from "fs";
import * as path from "path";
import * as dns from "dns";
import crypto from "crypto";
import { promisify } from "util";
import { Readable } from "stream";
import sanitizeHtml from "sanitize-html";
import { logger } from "./logger";

const dnsLookup = promisify(dns.lookup);

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
  const blockedPatterns = [
    /^127\.\d+\.\d+\.\d+$/,
    /^10\.\d+\.\d+\.\d+$/,
    /^192\.168\.\d+\.\d+$/,
    /^172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+$/,
    /^169\.254\.\d+\.\d+$/,
    /^0\.0\.0\.0$/,
    /^::1$/,
    /^fe80:/i,
    /^fc00:/i,
    /^fd00:/i,
  ];
  return blockedPatterns.some(pattern => pattern.test(ip));
}

export function isBlockedHost(hostname: string): boolean {
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

export async function downloadImage(url: string, destPath: string, redirectCount = 0): Promise<boolean> {
  if (redirectCount > 3) {
    logger.info(`[Image download] Failed: ${url} - too many redirects`);
    return false;
  }

  try {
    const urlObj = new URL(url);

    if (urlObj.protocol !== "http:" && urlObj.protocol !== "https:") {
      logger.info(`[Image download] Failed: ${url} - invalid protocol`);
      return false;
    }

    if (isBlockedHost(urlObj.hostname)) {
      logger.info(`[Image download] Failed: ${url} - blocked host`);
      return false;
    }

    const result = await dnsLookup(urlObj.hostname);
    if (isBlockedIP(result.address)) {
      logger.info(`[Image download] Failed: ${url} - blocked IP ${result.address}`);
      return false;
    }
  } catch (error) {
    logger.info(`[Image download] Failed: ${url} - DNS/URL error: ${error}`);
    return false;
  }

  const maxSize = 10 * 1024 * 1024;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
    logger.info(`[Image download] Failed: ${url} - timeout`);
  }, 15000);

  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      redirect: "manual",
      headers: { "User-Agent": "Mozilla/5.0 (compatible; CritsendBot/1.0)" },
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) return false;
      try {
        const redirectObj = new URL(location, url);
        if (redirectObj.protocol !== "http:" && redirectObj.protocol !== "https:") return false;
        if (isBlockedHost(redirectObj.hostname)) return false;
        return downloadImage(redirectObj.href, destPath, redirectCount + 1);
      } catch {
        return false;
      }
    }

    if (response.status !== 200) {
      logger.info(`[Image download] Failed: ${url} - HTTP ${response.status}`);
      return false;
    }

    const contentLength = parseInt(response.headers.get("content-length") || "0", 10);
    if (contentLength > maxSize) {
      logger.info(`[Image download] Failed: ${url} - content-length exceeds 10MB`);
      return false;
    }

    if (!response.body) return false;

    const nodeStream = Readable.fromWeb(response.body as any);
    const fileStream = fs.createWriteStream(destPath, { mode: 0o644 });
    let downloadedSize = 0;

    return new Promise((resolve) => {
      nodeStream.on("data", (chunk: Buffer) => {
        downloadedSize += chunk.length;
        if (downloadedSize > maxSize) {
          nodeStream.destroy();
          fileStream.destroy();
          fs.unlink(destPath, () => {});
          resolve(false);
        }
      });

      nodeStream.pipe(fileStream);

      fileStream.on("finish", () => resolve(true));

      fileStream.on("error", (err) => {
        logger.info(`[Image download] Failed: ${url} - write error: ${err.message}`);
        fs.unlink(destPath, () => {});
        resolve(false);
      });

      nodeStream.on("error", (err) => {
        logger.info(`[Image download] Failed: ${url} - stream error: ${err.message}`);
        fileStream.destroy();
        fs.unlink(destPath, () => {});
        resolve(false);
      });
    });
  } catch (error: any) {
    if (error?.name === "AbortError") {
      logger.info(`[Image download] Failed: ${url} - request timed out`);
    } else {
      logger.info(`[Image download] Failed: ${url} - fetch error: ${error?.message}`);
    }
    fs.unlink(destPath, () => {});
    return false;
  } finally {
    clearTimeout(timer);
  }
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
  await Promise.all(workers);
  return results;
}
