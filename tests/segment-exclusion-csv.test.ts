import { describe, expect, it } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import {
  MAX_SEGMENT_EXCLUSION_HASHES,
  parseSegmentExclusionCsv,
  parseSegmentExclusionCsvFile,
} from "../server/services/segment-exclusion-csv";

const A = "A".repeat(64);
const B = "0123456789abcdef".repeat(4);

describe("segment exclusion CSV", () => {
  it("tolerates a BOM, header and blank lines, lowercases and deduplicates", () => {
    expect(parseSegmentExclusionCsv(`\uFEFFsha256\r\n\r\n${A}\n"${B}"\n${A.toLowerCase()}\n`))
      .toEqual([A.toLowerCase(), B]);
  });

  it.each([
    ["an email", "person@example.com"],
    ["a short hash", "abc123"],
    ["non-hex text", "g".repeat(64)],
    ["a second column", `${B},extra`],
  ])("rejects %s", (_label, value) => {
    expect(() => parseSegmentExclusionCsv(value)).toThrow(/64-character hexadecimal/);
  });

  it("allows an empty or header-only file", () => {
    expect(parseSegmentExclusionCsv("\nemail_hash\n\n")).toEqual([]);
  });

  it("streams and normalizes an uploaded file", async () => {
    const filePath = path.join(os.tmpdir(), `segment-exclusions-${process.pid}-${Date.now()}.csv`);
    await fs.writeFile(filePath, `sha256\n${A}\n${B}\n`);
    try {
      await expect(parseSegmentExclusionCsvFile(filePath)).resolves.toEqual([
        A.toLowerCase(),
        B,
      ]);
      await expect(fs.stat(filePath)).resolves.toBeDefined();
    } finally {
      await fs.unlink(filePath).catch(() => {});
    }
  });

  it("keeps streaming time and memory bounded for a large upload", async () => {
    const hashCount = Math.min(MAX_SEGMENT_EXCLUSION_HASHES - 10_000, 240_000);
    const filePath = path.join(os.tmpdir(), `segment-exclusions-large-${process.pid}-${Date.now()}.csv`);
    const handle = await fs.open(filePath, "w");
    try {
      await handle.write("sha256\n");
      for (let start = 0; start < hashCount; start += 5_000) {
        const end = Math.min(start + 5_000, hashCount);
        const chunk = Array.from(
          { length: end - start },
          (_, offset) => (start + offset).toString(16).padStart(64, "0"),
        ).join("\n");
        await handle.write(`${chunk}\n`);
      }
      await handle.close();

      const rssBefore = process.memoryUsage().rss;
      const startedAt = performance.now();
      const hashes = await parseSegmentExclusionCsvFile(filePath);
      const elapsedMs = performance.now() - startedAt;
      const rssGrowth = process.memoryUsage().rss - rssBefore;

      expect(hashes).toHaveLength(hashCount);
      expect(hashes[0]).toBe("0".repeat(64));
      expect(hashes.at(-1)).toBe((hashCount - 1).toString(16).padStart(64, "0"));
      expect(elapsedMs).toBeLessThan(30_000);
      expect(rssGrowth).toBeLessThan(192 * 1024 * 1024);
    } finally {
      await handle.close().catch(() => {});
      await fs.unlink(filePath).catch(() => {});
    }
  }, 45_000);
});