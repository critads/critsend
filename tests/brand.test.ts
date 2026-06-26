import { describe, it, expect } from "vitest";
import { extractBrand } from "@shared/brand";

describe("extractBrand", () => {
  it("extracts the brand from the first [...] and trims it", () => {
    expect(extractBrand("[Decathlon] Soldes d'été")).toBe("Decathlon");
    expect(extractBrand("[ Nike ] Promo")).toBe("Nike");
    expect(extractBrand("[Decathlon]")).toBe("Decathlon");
  });

  it("uses only the FIRST bracketed group", () => {
    expect(extractBrand("[Decathlon] [Nike] combo")).toBe("Decathlon");
  });

  it("returns null when there is no bracketed brand", () => {
    expect(extractBrand("Promo sans marque")).toBeNull();
    expect(extractBrand("")).toBeNull();
    expect(extractBrand(null)).toBeNull();
    expect(extractBrand(undefined)).toBeNull();
  });

  it("returns null for an empty or whitespace-only bracket", () => {
    expect(extractBrand("[] vide")).toBeNull();
    expect(extractBrand("[   ] vide")).toBeNull();
  });

  it("handles a leading space before the bracket", () => {
    expect(extractBrand("  [Carrefour] Offre")).toBe("Carrefour");
  });

  it("preserves inner spacing of multi-word brands", () => {
    expect(extractBrand("[Le Bon Coin] Annonces")).toBe("Le Bon Coin");
  });
});
