import { describe, expect, it } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import {
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
});