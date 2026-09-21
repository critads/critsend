import { describe, expect, it, vi } from "vitest";

vi.mock("../server/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../server/db", () => ({ pool: {}, db: {} }));
vi.mock("../server/storage", () => ({ storage: {} }));

import {
  classifyDomainFamily,
  deriveExtensionRefs,
  deriveUnsubscribeTags,
  inferDomainFamilyFromMta,
  matchDirectoryBrands,
  resolveSmartSegmentBrand,
  resolveSmartSegmentContext,
  suggestFamilyFromShares,
  verticalOf,
  type BrandLookupDeps,
} from "../server/services/smart-segment-brand";
import { extractCampaignBrand } from "../server/services/tag-suggestions";

function deps(overrides: Partial<BrandLookupDeps> = {}): BrandLookupDeps {
  return {
    findBrandsByToken: async () => [],
    findCampaignBrandAnchor: async () => null,
    listVerticalRefs: async () => [],
    ...overrides,
  };
}

describe("smart segment brand resolution", () => {
  it("derives US/E extension refs, U-tags and the vertical from the core ref", () => {
    expect(deriveExtensionRefs(["4AF"])).toEqual(["US4AF", "E4AF"]);
    expect(deriveUnsubscribeTags(["4AF"])).toEqual(["U4AF", "UUS4AF"]);
    expect(verticalOf("4AF")).toBe("4");
    expect(verticalOf("AF")).toBeNull();
    expect(verticalOf(null)).toBeNull();
  });

  it("matches directory brands on the longest campaign-name prefix without accepting a different advertiser", () => {
    const requested = extractCampaignBrand("Air France 20-30/08 - Promo")!;
    const rows = [
      { name: "Air France", ref: "4af" },
      { name: "Air France", ref: "4AF2" },
      { name: "Air Caraïbes", ref: "4AC" },
      { name: "Air France", ref: "del" },
    ];
    const match = matchDirectoryBrands(requested, rows);
    expect(match).toEqual({ brandName: "Air France", refs: ["4AF", "4AF2"], matchedKey: "air\u001ffrance" });
    expect(matchDirectoryBrands(extractCampaignBrand("Air 20/08")!, rows)).toBeNull();
  });

  it("resolves from the directory, filters DEL and the brand's own refs out of the vertical list", async () => {
    const resolution = await resolveSmartSegmentBrand({ campaignName: "Air France 21/09" }, deps({
      findBrandsByToken: async (token) => {
        expect(token).toBe("air");
        return [{ name: "Air France", ref: "4AF" }];
      },
      listVerticalRefs: async (prefix) => {
        expect(prefix).toBe("4");
        return ["4AF", "4TUI", "DEL", "4CLUB"];
      },
    }));
    expect(resolution).toMatchObject({
      detected: true,
      source: "directory",
      brandName: "Air France",
      coreRefs: ["4AF"],
      extensionRefs: ["US4AF", "E4AF"],
      unsubscribeTags: ["U4AF", "UUS4AF"],
      vertical: "4",
      verticalRefs: ["4TUI", "4CLUB"],
    });
    expect(resolution.verticalLabel).toBeTruthy();
  });

  it("falls back to the historical anchor (no refs) and then to 'none'", async () => {
    const history = await resolveSmartSegmentBrand({ campaignName: "Vieille Marque 21/09" }, deps({
      findCampaignBrandAnchor: async () => "Vieille Marque 01/01",
    }));
    expect(history.detected).toBe(false);
    expect(history.source).toBe("history");
    expect(history.brandName).toBe("Vieille Marque");
    expect(history.coreRefs).toEqual([]);

    const partial = await resolveSmartSegmentBrand({ campaignName: "Vieille Marque Été 21/09" }, deps({
      findCampaignBrandAnchor: async () => "Vieille Marque 01/01",
    }));
    expect(partial.brandName).toBe("Vieille Marque");
    expect(partial.matchedKeys).toEqual(["vieille\u001fmarque"]);

    const none = await resolveSmartSegmentBrand({ campaignName: "Inconnue 21/09" }, deps());
    expect(none.source).toBe("none");
    expect(none.detected).toBe(false);
    expect(none.brandName).toBe("Inconnue 21/09");
  });

  it("honours a manual override with an exact-case uppercase ref", async () => {
    const manual = await resolveSmartSegmentBrand(
      { campaignName: "Whatever", brandOverride: { name: " Ma Marque ", ref: "7mm" } },
      deps({ listVerticalRefs: async () => ["7OTHER"] }),
    );
    expect(manual).toMatchObject({ source: "manual", brandName: "Ma Marque", coreRefs: ["7MM"], vertical: "7", verticalRefs: ["7OTHER"] });
  });
});

describe("domain family inference", () => {
  it("classifies domains into the two families, never mixing them", () => {
    expect(classifyDomainFamily("orange.fr")).toBe("fai_fr");
    expect(classifyDomainFamily("HOTMAIL.FR")).toBe("microsoft_yahoo");
    expect(classifyDomainFamily("gmail.com")).toBeNull();
    expect(suggestFamilyFromShares({ fai_fr: 0.7, microsoft_yahoo: 0.1 }, 1_000)).toBe("fai_fr");
    expect(suggestFamilyFromShares({ fai_fr: 0.2, microsoft_yahoo: 0.2 }, 1_000)).toBeNull();
    // Too small a sample never suggests anything.
    expect(suggestFamilyFromShares({ fai_fr: 0.9, microsoft_yahoo: 0 }, 20)).toBeNull();
  });

  it("suggests a family from the MTA's recent recipients and returns the evidence", async () => {
    const result = await inferDomainFamilyFromMta("mta-1", {
      recentMtaCampaignIds: async () => ["c1"],
      sampleRecipientDomains: async () => [
        { domain: "hotmail.fr", count: 800 },
        { domain: "outlook.com", count: 150 },
        { domain: "orange.fr", count: 50 },
      ],
    });
    expect(result.suggestedFamily).toBe("microsoft_yahoo");
    expect(result.familyEvidence?.sampled).toBe(1_000);
    expect(result.familyEvidence?.inFamilyShare.microsoft_yahoo).toBeCloseTo(0.95);
    const empty = await inferDomainFamilyFromMta(null, { recentMtaCampaignIds: async () => [], sampleRecipientDomains: async () => [] });
    expect(empty).toEqual({ suggestedFamily: null, familyEvidence: null });
  });

  it("combines brand and family resolution for the wizard", async () => {
    const context = await resolveSmartSegmentContext(
      { campaignName: "Air France 21/09", mtaId: "mta-1", brandOverride: null },
      {
        brand: deps({ findBrandsByToken: async () => [{ name: "Air France", ref: "4AF" }] }),
        family: { recentMtaCampaignIds: async () => ["c1"], sampleRecipientDomains: async () => [{ domain: "orange.fr", count: 100 }] },
      },
    );
    expect(context.brand.coreRefs).toEqual(["4AF"]);
    expect(context.suggestedFamily).toBe("fai_fr");
  });
});
