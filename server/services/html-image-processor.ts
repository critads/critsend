import * as cheerio from "cheerio";
import * as fs from "fs";
import * as path from "path";
import {
  IMAGES_DIR,
  downloadImage,
  getExtensionFromUrl,
  sanitizeImageFilename,
  mapWithConcurrency,
} from "../utils";

export interface ProcessHtmlImagesOptions {
  html: string;
  campaignId: string;
  /** Absolute origin (https://images.example.com) or null → relative paths. */
  imageHostingDomain: string | null;
  /** Campaign creation date, used for stable /campaigns/<year>/<month>/... URLs. */
  createdAt?: Date | string | null;
  /** Called after each image finishes (success or failure). */
  onProgress?: (processed: number, total: number) => void;
  /** Return true to stop scheduling further downloads (e.g. client disconnect). */
  isCancelled?: () => boolean;
}

export interface ProcessHtmlImagesResult {
  html: string;
  downloaded: number;
  failed: number;
  failedUrls: string[];
  total: number;
}

/**
 * Downloads external <img src> URLs into IMAGES_DIR/<campaignId> and rewrites
 * them to hosted URLs. Shared by the campaign wizard's process-html endpoint
 * and the external API. Behavior notes:
 * - Only http(s) srcs are downloaded; already-local /campaigns/... paths are
 *   preserved (never wipe the campaign image dir — see wizard route comment).
 * - Failed downloads keep their original src.
 * - Anti-SSRF protections live in downloadImage (server/utils.ts).
 */
export async function processHtmlImages(opts: ProcessHtmlImagesOptions): Promise<ProcessHtmlImagesResult> {
  const { html, campaignId, imageHostingDomain, onProgress, isCancelled } = opts;

  const campaignImagesDir = path.join(IMAGES_DIR, campaignId);
  // Ensure directories exist — never wipe existing images upfront. Wiping
  // would destroy already-downloaded images when a campaign is re-saved
  // (their relative /campaigns/... srcs would never be re-downloaded).
  fs.mkdirSync(campaignImagesDir, { recursive: true, mode: 0o755 });

  const campaignDate = opts.createdAt ? new Date(opts.createdAt) : new Date();
  const year = campaignDate.getUTCFullYear().toString();
  const month = String(campaignDate.getUTCMonth() + 1).padStart(2, "0");

  const $ = cheerio.load(html);
  const downloadedImages: { original: string; local: string }[] = [];
  const failedImages: string[] = [];
  let imageIndex = 0;

  const imageTasks: Array<{ el: any; src: string; currentIndex: number }> = [];
  $("img").each((_, el) => {
    const src = $(el).attr("src");
    // Only queue external URLs for download — images already stored locally
    // (/campaigns/... or relative paths) are preserved as-is on disk.
    if (src && (src.startsWith("http://") || src.startsWith("https://"))) {
      imageTasks.push({ el, src, currentIndex: imageIndex++ });
    }
  });

  // Track used filenames within this request to handle conflicts with a numeric suffix
  const usedFilenames = new Set<string>();
  let processed = 0;

  // Initial 0/N progress event so callers can render a bar before the first
  // download settles (preserves the wizard's historical SSE behavior).
  if (imageTasks.length > 0) onProgress?.(0, imageTasks.length);

  await mapWithConcurrency(imageTasks, 5, async (task) => {
    if (isCancelled?.()) return;
    const ext = getExtensionFromUrl(task.src);
    let baseFilename = sanitizeImageFilename(task.src, task.currentIndex, ext);
    if (usedFilenames.has(baseFilename)) {
      const base = baseFilename.replace(/\.[^.]+$/, "");
      let counter = 2;
      while (usedFilenames.has(`${base}-${counter}.${ext}`)) counter++;
      baseFilename = `${base}-${counter}.${ext}`;
    }
    usedFilenames.add(baseFilename);

    const destPath = path.join(campaignImagesDir, baseFilename);
    const relativePath = `/campaigns/${year}/${month}/${campaignId}/${baseFilename}`;
    const localUrl = imageHostingDomain ? `${imageHostingDomain}${relativePath}` : relativePath;
    const success = await downloadImage(task.src, destPath);
    if (success) {
      $(task.el).attr("src", localUrl);
      downloadedImages.push({ original: task.src, local: localUrl });
    } else {
      failedImages.push(task.src);
    }
    processed++;
    onProgress?.(processed, imageTasks.length);
  });

  // Normalize any scheme-less srcs that already point at the hosting domain.
  if (imageHostingDomain) {
    const rawDomain = imageHostingDomain.replace(/^https?:\/\//i, "").replace(/\/$/, "");
    $("img").each((_, el) => {
      const src = $(el).attr("src");
      if (src && src.startsWith(rawDomain + "/")) {
        $(el).attr("src", `https://${src}`);
      }
    });
  }

  return {
    html: $.html(),
    downloaded: downloadedImages.length,
    failed: failedImages.length,
    failedUrls: failedImages,
    total: imageTasks.length,
  };
}

/** Normalizes an MTA imageHostingDomain value to an absolute https origin. */
export function normalizeImageHostingDomain(domain: string | null | undefined): string | null {
  if (!domain) return null;
  const raw = domain.replace(/\/$/, "");
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}
