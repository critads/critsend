import fs from "fs";
import readline from "readline";

export const MAX_SEGMENT_EXCLUSION_CSV_BYTES = 100 * 1024 * 1024;
// A one-column CSV containing 64 hex characters plus a newline fits roughly
// 1.6 million hashes inside the 100 MiB upload ceiling.
export const MAX_SEGMENT_EXCLUSION_HASHES = 1_600_000;

const SHA256 = /^[0-9a-fA-F]{64}$/;
const HEADERS = new Set([
  "hash",
  "sha256",
  "sha-256",
  "email_hash",
  "email hash",
  "email_sha256",
  "email sha256",
]);

/** Parse a one-column hash CSV without ever accepting or hashing email data. */
export function parseSegmentExclusionCsv(input: Buffer | string): string[] {
  const text = Buffer.isBuffer(input) ? input.toString("utf8") : input;
  if (Buffer.byteLength(text, "utf8") > MAX_SEGMENT_EXCLUSION_CSV_BYTES) {
    throw new Error(`Exclusion CSV exceeds ${MAX_SEGMENT_EXCLUSION_CSV_BYTES} bytes`);
  }

  const hashes = new Set<string>();
  let sawValue = false;
  for (let raw of text.split(/\r?\n/)) {
    raw = raw.replace(/^\uFEFF/, "").trim();
    if (!raw) continue;
    if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
      raw = raw.slice(1, -1).trim();
    }
    const lowered = raw.toLowerCase();
    if (!sawValue && HEADERS.has(lowered)) {
      sawValue = true;
      continue;
    }
    sawValue = true;
    if (!SHA256.test(raw)) {
      throw new Error("Exclusion CSV must contain only 64-character hexadecimal SHA-256 hashes");
    }
    hashes.add(lowered);
    if (hashes.size > MAX_SEGMENT_EXCLUSION_HASHES) {
      throw new Error(`Exclusion CSV exceeds ${MAX_SEGMENT_EXCLUSION_HASHES} unique hashes`);
    }
  }
  return [...hashes];
}

/** Stream the upload from disk so a valid 100 MiB file is never duplicated in memory. */
export async function parseSegmentExclusionCsvFile(filePath: string): Promise<string[]> {
  const hashes = new Set<string>();
  let sawValue = false;
  const input = fs.createReadStream(filePath, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });

  try {
    for await (let raw of lines) {
      raw = raw.replace(/^\uFEFF/, "").trim();
      if (!raw) continue;
      if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
        raw = raw.slice(1, -1).trim();
      }
      const lowered = raw.toLowerCase();
      if (!sawValue && HEADERS.has(lowered)) {
        sawValue = true;
        continue;
      }
      sawValue = true;
      if (!SHA256.test(raw)) {
        throw new Error("Exclusion CSV must contain only 64-character hexadecimal SHA-256 hashes");
      }
      hashes.add(lowered);
      if (hashes.size > MAX_SEGMENT_EXCLUSION_HASHES) {
        throw new Error(`Exclusion CSV exceeds ${MAX_SEGMENT_EXCLUSION_HASHES} unique hashes`);
      }
    }
  } finally {
    lines.close();
    input.destroy();
  }

  return [...hashes];
}