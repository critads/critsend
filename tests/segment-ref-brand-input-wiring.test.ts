import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const inputSource = readFileSync(
  new URL("../client/src/components/ref-brand-input.tsx", import.meta.url),
  "utf8",
);
const builderSource = readFileSync(
  new URL("../client/src/components/segment-builder.tsx", import.meta.url),
  "utf8",
);

describe("segment REF brand selector wiring", () => {
  it("queries the first 25 brands using a separate picker search", () => {
    expect(inputSource).toContain('params.set("page", "1")');
    expect(inputSource).toContain('params.set("limit", String(REF_BRAND_PAGE_SIZE))');
    expect(inputSource).toContain('params.set("search", search.trim())');
    expect(inputSource).toContain('apiRequest("GET", refBrandSearchUrl(search)');
    expect(inputSource).toContain("value={search}");
    expect(inputSource).toContain("onValueChange={setSearch}");
  });

  it("writes only an exact brand REF while showing the brand and REF together", () => {
    expect(inputSource).toContain("onChange(brand.ref)");
    expect(inputSource).toContain("`${selected.name} · REF: ${selected.ref}`");
    expect(inputSource).toContain("aria-label={`${brand.name} · REF: ${brand.ref}`}");
    expect(inputSource).toContain("More than {REF_BRAND_PAGE_SIZE} brands match");
    expect(inputSource).toContain("No matching brands");
    expect(inputSource).toContain("Unable to load brands.");
    expect(inputSource).toContain("Loading brands");
  });

  it("keeps direct REF entry case-sensitive and exposes the reusable input", () => {
    expect(inputSource).toContain("export function RefBrandInput");
    expect(inputSource).toContain("onChange(event.target.value)");
    expect(inputSource).not.toContain("event.target.value.toUpperCase()");
    expect(builderSource).toContain('import { RefBrandInput } from "@/components/ref-brand-input";');
    expect(builderSource).toContain("<RefBrandInput");
    expect(builderSource).toContain("onChange={(value) => onChange({ ...condition, value })}");
  });

  it("uses the selector for each textual REF operator but not unary operators", () => {
    expect(builderSource).toContain(
      'const isRefText = condition.operator === "has_ref" || condition.operator === "not_has_ref" || condition.operator === "ref_contains";',
    );
    expect(builderSource).toContain("{!isUnary && (");
    expect(builderSource).not.toContain('condition.operator === "has_any_ref" ||');
  });
});