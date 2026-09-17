import * as cheerio from "cheerio";
import * as fs from "fs/promises";
import * as path from "path";
import { randomUUID } from "crypto";
import {
  IMAGES_DIR,
  downloadImage,
  getExtensionFromUrl,
  sanitizeImageFilename,
  mapWithConcurrency,
} from "../utils";

export class TransferImageError extends Error {
  readonly code = "IMAGES_UNSUPPORTED";
  constructor(message: string, public readonly unsupported: string[] = []) {
    super(message);
    this.name = "TransferImageError";
  }
}

export type TransferImageInspection = {
  externalCount: number;
  managedCount: number;
  unsupported: string[];
};

export type PreparedTransferImages = TransferImageInspection & {
  html: string;
  preparedFiles: string[];
  cleanup: () => Promise<void>;
};

/**
 * Cleanup is deliberately allow-listed: callers pass only paths created by
 * this preparation attempt. In particular, never derive a directory from the
 * campaign id and recursively remove it, because a successful/older send may
 * still reference files there.
 */
export async function cleanupPreparedTransferFiles(preparedFiles: string[], stagingDir?: string): Promise<void> {
  await Promise.all(preparedFiles.map(async (file) => {
    try { await fs.unlink(file); } catch { /* already removed */ }
  }));
  if (stagingDir) {
    try { await fs.rm(stagingDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function isExternal(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function isManaged(value: string, trustedSourceOrigin?: string | null): boolean {
  if (/^\/(?:campaigns|i)\//.test(value)) return true;
  if (!trustedSourceOrigin || !/^https?:\/\//i.test(value)) return false;
  try {
    const parsed = new URL(value);
    return `${parsed.protocol}//${parsed.host}`.toLowerCase() === trustedSourceOrigin.toLowerCase()
      && /^\/(?:campaigns|i)\//.test(parsed.pathname);
  } catch {
    return false;
  }
}

function validateHostedOrigin(value: string | null | undefined): string | null {
  if (!value) return null;
  const candidate = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  try {
    const parsed = new URL(candidate);
    if (!parsed.hostname || parsed.username || parsed.password || parsed.pathname !== "/" && parsed.pathname !== "") {
      return null;
    }
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return null;
  }
}

function inspectHtml(html: string, trustedSourceOrigin?: string | null): { $: cheerio.CheerioAPI; inspection: TransferImageInspection; urls: Array<{ el: any; src: string; index: number }> } {
  const $ = cheerio.load(html);
  const unsupported: string[] = [];
  let externalCount = 0;
  let managedCount = 0;
  const urls: Array<{ el: any; src: string; index: number }> = [];

  $("img").each((index, el) => {
    const src = $(el).attr("src")?.trim();
    const srcset = $(el).attr("srcset");
    if (srcset?.trim()) unsupported.push("img[srcset]");
    if (!src) {
      unsupported.push("img without src");
      return;
    }
    if (isManaged(src, trustedSourceOrigin)) {
      managedCount++;
    } else if (isExternal(src)) {
      externalCount++;
      urls.push({ el, src, index });
    } else if (/^(data:image\/|\/|\.{0,2}\/)/i.test(src)) {
      // Embedded and relative assets are deliberately left byte-for-byte
      // intact.  The existing image serving path is still valid.
    } else if (!/^data:image\//i.test(src)) {
      unsupported.push(`img src scheme: ${src.slice(0, 80)}`);
    }
  });
  $("[srcset]").each((_, el) => {
    if ($(el).is("img")) return;
    if ($(el).attr("srcset")?.trim()) unsupported.push("srcset");
  });

  $("[style]").each((_, el) => {
    if (/\burl\s*\(/i.test($(el).attr("style") ?? "")) unsupported.push("CSS background-image");
  });
  $("[background]").each((_, el) => {
    if ($(el).attr("background")?.trim()) unsupported.push("HTML background image");
  });
  $("style").each((_, el) => {
    if (/\burl\s*\(/i.test($(el).text())) unsupported.push("CSS url()");
  });

  return {
    $,
    inspection: { externalCount, managedCount, unsupported: [...new Set(unsupported)] },
    urls,
  };
}

export function inspectCampaignMtaTransferImages(html: string, trustedSourceImageHostingDomain?: string | null): TransferImageInspection {
  return inspectHtml(html, validateHostedOrigin(trustedSourceImageHostingDomain)).inspection;
}

function looksLikeImage(file: Buffer, extension: string): boolean {
  if (file.length >= 8 && file.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return true;
  if (file.length >= 3 && file[0] === 0xff && file[1] === 0xd8 && file[2] === 0xff) return true;
  if (file.length >= 6 && (file.subarray(0, 6).toString() === "GIF87a" || file.subarray(0, 6).toString() === "GIF89a")) return true;
  if (file.length >= 12 && file.subarray(0, 4).toString() === "RIFF" && file.subarray(8, 12).toString() === "WEBP") return true;
  if (file.length >= 2 && file[0] === 0x42 && file[1] === 0x4d) return true;
  // SVG is text, and may have an XML declaration before the root element.
  if (extension === "svg" && /^\s*(?:<\?xml[\s\S]*?\?>\s*)?<svg[\s>]/i.test(file.toString("utf8", 0, 2048))) return true;
  return false;
}

/**
 * Prepare external images without touching source campaign files.  All
 * downloads land in a transfer-specific staging directory and are renamed
 * into unique campaign paths only after their bytes pass a basic image
 * signature validation.  The returned cleanup is safe to call after a CAS
 * conflict because it only knows about files created by this preparation.
 */
export async function prepareCampaignMtaTransferImages(opts: {
  html: string;
  campaignId: string;
  createdAt: Date | string;
  imageHostingDomain: string;
  sourceImageHostingDomain?: string | null;
}): Promise<PreparedTransferImages> {
  const origin = validateHostedOrigin(opts.imageHostingDomain);
  if (!origin) throw new TransferImageError("Target image hosting domain is invalid", ["imageHostingDomain"]);

  const parsed = inspectHtml(opts.html, validateHostedOrigin(opts.sourceImageHostingDomain));
  if (parsed.inspection.unsupported.length) {
    throw new TransferImageError("This campaign contains unsupported image markup", parsed.inspection.unsupported);
  }

  const token = randomUUID().replace(/-/g, "");
  const targetDir = path.join(IMAGES_DIR, opts.campaignId);
  const stagingDir = path.join(targetDir, `.mta-transfer-${token}`);
  await fs.mkdir(stagingDir, { recursive: true, mode: 0o755 });
  const preparedFiles: string[] = [];
  const date = new Date(opts.createdAt);
  const year = String(date.getUTCFullYear());
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const used = new Set<string>();

  const cleanup = async () => {
    await cleanupPreparedTransferFiles(preparedFiles, stagingDir);
  };

  try {
    await mapWithConcurrency(parsed.urls, 3, async ({ el, src, index }) => {
      const extension = getExtensionFromUrl(src);
      let filename = `mta-transfer-${token}-${sanitizeImageFilename(src, index, extension)}`;
      let n = 2;
      while (used.has(filename)) filename = `mta-transfer-${token}-${n++}.${extension}`;
      used.add(filename);
      const staged = path.join(stagingDir, filename);
      if (!await downloadImage(src, staged)) {
        throw new TransferImageError(`Unable to download image: ${src}`, [src]);
      }
      const bytes = await fs.readFile(staged);
      if (!looksLikeImage(bytes, extension)) {
        throw new TransferImageError(`Downloaded content is not a supported image: ${src}`, [src]);
      }
      const finalPath = path.join(targetDir, filename);
      // rename() is atomic and the generated transfer name cannot collide with
      // source files.  Never overwrite an existing path.
      await fs.rename(staged, finalPath);
      preparedFiles.push(finalPath);
      const local = `/campaigns/${year}/${month}/${opts.campaignId}/${filename}`;
      parsed.$(el).attr("src", `${origin}${local}`);
    });

    // Existing managed URLs need only switch origin.  Do not re-download or
    // mutate their source files.
    parsed.$("img").each((_, el) => {
      const src = parsed.$(el).attr("src");
       if (!src || !isManaged(src, validateHostedOrigin(opts.sourceImageHostingDomain))) return;
      const parsedUrl = /^https?:\/\//i.test(src) ? new URL(src) : null;
      const pathname = parsedUrl?.pathname ?? src;
      parsed.$(el).attr("src", `${origin}${pathname}`);
    });

    await fs.rm(stagingDir, { recursive: true, force: true });
    return {
      ...parsed.inspection,
      html: parsed.$.html(),
      preparedFiles,
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}