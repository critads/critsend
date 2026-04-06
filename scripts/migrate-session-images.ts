#!/usr/bin/env tsx
/**
 * One-time migration: consolidate session-folder image references in campaign HTML
 * into proper campaign-specific folders.
 *
 * Fixes URLs like:
 *   /images/temp_1775205062594_ki5hu/img_0.jpg
 *   /images/draft-aBcD1234EFgh/hero-banner.jpg
 *   https://domain.com/images/temp_.../img_0.jpg
 *
 * Into:
 *   /campaigns/{year}/{month}/{campaignId}/{filename}
 *
 * Usage:
 *   tsx scripts/migrate-session-images.ts            # live run (modifies DB + disk)
 *   tsx scripts/migrate-session-images.ts --dry-run  # preview only, no writes
 */

import pg from "pg";
import * as cheerio from "cheerio";
import * as fs from "fs";
import * as path from "path";

const { Pool } = pg;
const DRY_RUN = process.argv.includes("--dry-run");
const IMAGES_DIR = path.join(process.cwd(), "images");

// Matches /images/{folderId}/{filename}
const LEGACY_PATH = /^\/images\/([^/]+)\/([^/?#]+)$/;
// Matches /campaigns/{year}/{month}/{folderId}/{filename}
const NEW_PATH = /^\/campaigns\/[^/]+\/[^/]+\/([^/]+)\/([^/?#]+)$/;

/** Strip an absolute domain prefix from a URL to get a relative path. */
function toRelative(src: string): string {
  return src.replace(/^https?:\/\/[^/]+/, "");
}

/** Return true if the folder ID looks like a session folder.
 * Session folders are explicitly prefixed: temp_ (legacy) or draft- (current).
 * Campaign folders are UUIDs (e.g. 01b88541-88bc-447e-a39e-766b70c3f8b2) and are never touched.
 */
function isSessionFolder(folderId: string): boolean {
  return /^(temp_|draft-)/.test(folderId);
}

interface ParsedSrc {
  sessionFolderId: string;
  filename: string;
}

function parseSrc(src: string): ParsedSrc | null {
  const rel = toRelative(src);

  let m = rel.match(LEGACY_PATH);
  if (m && isSessionFolder(m[1])) return { sessionFolderId: m[1], filename: m[2] };

  m = rel.match(NEW_PATH);
  if (m && isSessionFolder(m[1])) return { sessionFolderId: m[1], filename: m[2] };

  return null;
}

async function main() {
  const connectionString =
    process.env.NEON_DATABASE_URL || process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("ERROR: NEON_DATABASE_URL or DATABASE_URL must be set.");
    process.exit(1);
  }

  const pool = new Pool({
    connectionString,
    ssl: connectionString.includes("neon.tech")
      ? { rejectUnauthorized: false }
      : undefined,
    max: 2,
  });

  console.log(
    `[migrate-session-images] ${DRY_RUN ? "DRY RUN — no changes will be written" : "LIVE RUN — files will be copied and DB updated"}`
  );
  console.log(`[migrate-session-images] IMAGES_DIR = ${IMAGES_DIR}`);

  // Find campaigns whose HTML references session-folder image paths
  const { rows } = await pool.query<{
    id: number;
    html_content: string;
    created_at: Date;
    mta_id: string | null;
  }>(`
    SELECT id, html_content, created_at, mta_id
    FROM campaigns
    WHERE html_content IS NOT NULL
      AND html_content != ''
      AND (
        html_content LIKE '%/images/temp\_%'
        OR html_content LIKE '%/images/draft-%'
        OR html_content LIKE '%/campaigns/%/temp\_%'
        OR html_content LIKE '%/campaigns/%/draft-%'
      )
    ORDER BY id
  `);

  console.log(
    `[migrate-session-images] ${rows.length} campaign(s) matched.\n`
  );

  let updated = 0;
  let skipped = 0;
  let errors = 0;

  for (const row of rows) {
    const campaignId = String(row.id);
    const html = row.html_content;
    const createdAt = row.created_at ? new Date(row.created_at) : new Date();
    const year = createdAt.getUTCFullYear().toString();
    const month = String(createdAt.getUTCMonth() + 1).padStart(2, "0");
    const campaignImagesDir = path.join(IMAGES_DIR, campaignId);

    console.log(
      `--- Campaign ${campaignId}  (created ${createdAt.toISOString().slice(0, 10)})`
    );

    try {
      const $ = cheerio.load(html);
      let changed = false;

      const usedFilenames = new Set<string>();
      if (fs.existsSync(campaignImagesDir)) {
        for (const f of fs.readdirSync(campaignImagesDir)) {
          usedFilenames.add(f);
        }
      }

      $("img").each((_, el) => {
        const src = $(el).attr("src");
        if (!src) return;

        const parsed = parseSrc(src);
        if (!parsed) return;

        const { sessionFolderId, filename } = parsed;
        if (sessionFolderId === campaignId) return;

        const srcPath = path.join(IMAGES_DIR, sessionFolderId, filename);
        if (!fs.existsSync(srcPath)) {
          console.log(
            `  [skip]   images/${sessionFolderId}/${filename} — file not found on disk`
          );
          return;
        }

        // Resolve destination filename with numeric-suffix conflict handling
        let destFilename = filename;
        if (usedFilenames.has(destFilename)) {
          const ext = path.extname(destFilename);
          const base = destFilename.slice(0, destFilename.length - ext.length);
          let counter = 2;
          while (usedFilenames.has(`${base}-${counter}${ext}`)) counter++;
          destFilename = `${base}-${counter}${ext}`;
        }
        usedFilenames.add(destFilename);

        const newUrl = `/campaigns/${year}/${month}/${campaignId}/${destFilename}`;
        console.log(`  [copy]   ${src}`);
        console.log(`        →  ${newUrl}`);

        if (!DRY_RUN) {
          if (!fs.existsSync(campaignImagesDir)) {
            fs.mkdirSync(campaignImagesDir, { recursive: true, mode: 0o755 });
          }
          fs.copyFileSync(srcPath, path.join(campaignImagesDir, destFilename));
          $(el).attr("src", newUrl);
        }
        changed = true;
      });

      if (!changed) {
        console.log("  [skip]   No session-folder images found in HTML.\n");
        skipped++;
        continue;
      }

      if (DRY_RUN) {
        console.log("  [dry-run] Would update HTML in database.\n");
        updated++;
      } else {
        const newHtml = $.html();
        await pool.query(
          "UPDATE campaigns SET html_content = $1 WHERE id = $2",
          [newHtml, row.id]
        );
        console.log("  [done]   HTML updated in database.\n");
        updated++;
      }
    } catch (err) {
      console.error(`  [error]  Campaign ${campaignId}:`, err);
      errors++;
    }
  }

  console.log(
    `\n[migrate-session-images] Complete. updated=${updated} skipped=${skipped} errors=${errors}`
  );

  if (!DRY_RUN && updated > 0) {
    console.log(
      "\nNote: Session folder directories under images/ can be removed once you\n" +
        "have verified all campaigns render correctly:\n" +
        "  rm -rf images/temp_* images/draft-*"
    );
  }

  await pool.end();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
