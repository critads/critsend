import * as fs from "fs";
import * as path from "path";
import * as https from "https";
import * as http from "http";
import * as dns from "dns";
import { promisify } from "util";
import sanitizeHtml from "sanitize-html";
import { logger } from "./logger";

const dnsLookup = promisify(dns.lookup);

export const IMAGES_DIR = path.join(process.cwd(), "images");
export const TEMP_SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function cleanupOrphanedTempSessions(): void {
  try {
    if (!fs.existsSync(IMAGES_DIR)) return;
    
    const entries = fs.readdirSync(IMAGES_DIR);
    const now = Date.now();
    
    for (const entry of entries) {
      if (!entry.startsWith("temp_")) continue;
      
      const entryPath = path.join(IMAGES_DIR, entry);
      const stat = fs.statSync(entryPath);
      
      if (!stat.isDirectory()) continue;
      
      const age = now - stat.mtimeMs;
      if (age > TEMP_SESSION_MAX_AGE_MS) {
        const files = fs.readdirSync(entryPath);
        for (const file of files) {
          fs.unlinkSync(path.join(entryPath, file));
        }
        fs.rmdirSync(entryPath);
        logger.info(`Cleaned up orphaned temp session: ${entry}`);
      }
    }
  } catch (error) {
    logger.error("Error cleaning up temp sessions:", error);
  }
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
  
  let urlObj: URL;
  let resolvedIP: string;
  
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
    
    const result = await dnsLookup(urlObj.hostname);
    resolvedIP = result.address;
    
    if (isBlockedIP(resolvedIP)) {
      logger.info(`[Image download] Failed: ${url} - blocked IP ${resolvedIP}`);
      return false;
    }
  } catch (error) {
    logger.info(`[Image download] Failed: ${url} - DNS/URL error: ${error}`);
    return false;
  }
  
  return new Promise((resolve) => {
    const protocol = url.startsWith("https") ? https : http;
    const timeout = 15000;
    const maxSize = 10 * 1024 * 1024;
    
    const safetyLookup = (hostname: string, options: any, callback: any) => {
      if (typeof options === 'function') {
        callback = options;
        options = {};
      }
      if (options && options.all) {
        callback(null, [{ address: resolvedIP, family: 4 }]);
      } else {
        callback(null, resolvedIP, 4);
      }
    };
    
    const requestOptions: https.RequestOptions = {
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === "https:" ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: "GET",
      timeout,
      lookup: safetyLookup as any,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; CritsendBot/1.0)",
      },
      ...(urlObj.protocol === "https:" ? { servername: urlObj.hostname } : {}),
    };
    
    const request = protocol.get(requestOptions, (response) => {
      const socket = response.socket as any;
      if (socket && socket.remoteAddress && isBlockedIP(socket.remoteAddress)) {
        request.destroy();
        resolve(false);
        return;
      }
      
      if (response.statusCode === 301 || response.statusCode === 302) {
        const redirectUrl = response.headers.location;
        if (redirectUrl) {
          try {
            const redirectObj = new URL(redirectUrl, url);
            if (redirectObj.protocol !== "http:" && redirectObj.protocol !== "https:") {
              resolve(false);
              return;
            }
            if (isBlockedHost(redirectObj.hostname)) {
              resolve(false);
              return;
            }
            downloadImage(redirectObj.href, destPath, redirectCount + 1).then(resolve);
            return;
          } catch {
            resolve(false);
            return;
          }
        }
      }
      
      if (response.statusCode !== 200) {
        logger.info(`[Image download] Failed: ${url} - HTTP ${response.statusCode}`);
        resolve(false);
        return;
      }
      
      const contentLength = parseInt(response.headers["content-length"] || "0", 10);
      if (contentLength > maxSize) {
        resolve(false);
        return;
      }
      
      let downloadedSize = 0;
      const fileStream = fs.createWriteStream(destPath);
      
      response.on("data", (chunk: Buffer) => {
        downloadedSize += chunk.length;
        if (downloadedSize > maxSize) {
          request.destroy();
          fileStream.close();
          fs.unlink(destPath, () => {});
          resolve(false);
        }
      });
      
      response.pipe(fileStream);
      
      fileStream.on("finish", () => {
        fileStream.close();
        resolve(true);
      });
      
      fileStream.on("error", () => {
        fs.unlink(destPath, () => {});
        resolve(false);
      });
    });
    
    request.on("error", (err) => {
      logger.info(`[Image download] Failed: ${url} - network error: ${err.message}`);
      resolve(false);
    });
    
    request.on("timeout", () => {
      logger.info(`[Image download] Failed: ${url} - timeout`);
      request.destroy();
      resolve(false);
    });
  });
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
