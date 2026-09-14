import { describe, expect, it } from "vitest";
import {
  BrandCsvError,
  MAX_BRAND_CSV_ROWS,
  parseBrandCsv,
} from "../server/services/brand-csv";

describe("Brands directory CSV parser", () => {
  it("accepts BOM, quoted comma values, and trims fields", () => {
    const rows = parseBrandCsv(
      Buffer.from("\uFEFFNaMe;ReF\r\n\"Acme, Inc.\";  Ref-A  \r\n"),
    );
    expect(rows).toEqual([{ name: "Acme, Inc.", ref: "Ref-A" }]);
  });

  it("accepts comma-delimited name/ref headers case-insensitively", () => {
    expect(parseBrandCsv("BRAND,REF\nAcme,R-1\n")).toEqual([
      { name: "Acme", ref: "R-1" },
    ]);
    expect(parseBrandCsv("name,ref\nAcme,R-2\n")).toEqual([
      { name: "Acme", ref: "R-2" },
    ]);
  });

  it("preserves REF case and supports escaped quotes", () => {
    expect(parseBrandCsv('brand,ref\n"Acme ""Prime""","rEf-Mixed"\n')).toEqual([
      { name: 'Acme "Prime"', ref: "rEf-Mixed" },
    ]);
  });

  it("reports the malformed row line before any import can start", () => {
    expect(() => parseBrandCsv("brand,ref\nAcme,R-1\nMissingRef,\n")).toThrow(
      "CSV error on line 3",
    );
    expect(() => parseBrandCsv("brand,ref\nAcme,R-1\nMissingRef,\n")).toThrow(
      BrandCsvError,
    );
  });

  it("rejects more than the allowed number of data rows", () => {
    const csv = `brand,ref\n${Array.from(
      { length: MAX_BRAND_CSV_ROWS + 1 },
      (_, index) => `Acme-${index},R-${index}`,
    ).join("\n")}`;
    expect(() => parseBrandCsv(csv)).toThrow(
      `maximum ${MAX_BRAND_CSV_ROWS} data rows exceeded`,
    );
  });

  it("discards many blank records while scanning instead of retaining them", () => {
    const csv = `brand,ref\n${"\n".repeat(100_000)}Acme,R-1\n`;
    expect(parseBrandCsv(csv)).toEqual([{ name: "Acme", ref: "R-1" }]);
  });
});