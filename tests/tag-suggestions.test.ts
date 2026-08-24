import { describe, it, expect } from "vitest";
import {
  campaignMatchesBrand,
  extractCampaignBrand,
  tagSuggestTokens,
  likePattern,
  modeOfTags,
  resolveHistoricalBrand,
  suggestSegmentsFromRecentHistory,
  suggestTagsFromHistory,
} from "../server/services/tag-suggestions";

describe("tagSuggestTokens", () => {
  it("folds accents and lowercases", () => {
    expect(tagSuggestTokens("Éclat Rentrée")).toEqual(["eclat"]); // "rentree" is a stopword
  });

  it("drops stopwords, short tokens and pure numbers", () => {
    expect(tagSuggestTokens("Kammaspeed Promo Aout 2026 x")).toEqual(["kammaspeed"]);
  });

  it("dedupes and caps the brand section at 8 tokens", () => {
    const name = "aaa aaa bbb ccc ddd eee fff ggg hhh iii - code - mta";
    const tokens = tagSuggestTokens(name);
    expect(tokens).toHaveLength(8);
    expect(new Set(tokens).size).toBe(8);
  });

  it("returns empty for names with no usable token", () => {
    expect(tagSuggestTokens("12 - 34 !!")).toEqual([]);
    expect(tagSuggestTokens("")).toEqual([]);
  });
});

describe("extractCampaignBrand", () => {
  it("keeps only the brand section and removes the numeric campaign ref", () => {
    expect(extractCampaignBrand("#3130 Comme j'aime - 5cn4YY - kamma")).toEqual({
      label: "Comme j'aime",
      tokens: ["comme", "aime"],
      key: "comme\u001faime",
    });
  });

  it("does not treat a MTA or campaign code suffix as the brand", () => {
    expect(tagSuggestTokens("#3103 Air France - 4beTPA - Kamma")).toEqual(["air", "france"]);
    expect(tagSuggestTokens("#3091 Picard - 5au5NM - mayesale")).toEqual(["picard"]);
  });

  it("does not treat dates or Critads as part of the Kiabi brand", () => {
    expect(tagSuggestTokens("#3555 Kiabi 20-30/08 Critads - server2.mayasoldes")).toEqual(["kiabi"]);
  });

  it("returns null when the brand section has no reliable token", () => {
    expect(extractCampaignBrand("#123 Promo Aout - LIST - kamma")).toBeNull();
  });
});

describe("likePattern", () => {
  it("escapes LIKE metacharacters", () => {
    expect(likePattern("a%b_c\\d")).toBe("%a\\%b\\_c\\\\d%");
  });

  it("wraps plain tokens", () => {
    expect(likePattern("kamma")).toBe("%kamma%");
  });
});

describe("campaignMatchesBrand", () => {
  it("requires the complete brand prefix, not one common word", () => {
    const brand = extractCampaignBrand("#3103 Air France - 4beTPA - Kamma")!;
    expect(campaignMatchesBrand("#3086 Air France - 4beTPA - rndaserver", brand)).toBe(true);
    expect(campaignMatchesBrand("#4000 Air France 20-30/08 - mayesale", brand)).toBe(true);
    expect(campaignMatchesBrand("#3081 Air Caraibes - 4axS9H - rndaserver", brand)).toBe(false);
  });
});

describe("resolveHistoricalBrand", () => {
  it("resolves Kiabi from the first words after the campaign number", () => {
    const requested = extractCampaignBrand("#3555 Kiabi 20-30/08 Critads - server2.mayasoldes")!;
    const resolved = resolveHistoricalBrand(requested, [
      { name: "#3500 Kiabi - mahlesoldes" },
      { name: "#3500 Kiabi - mahlesoldes (Copy)" },
      { name: "#3499 Ricaud - server2.mayasoldes" },
    ]);
    expect(resolved?.label).toBe("Kiabi");
    expect(resolved?.tokens).toEqual(["kiabi"]);
  });

  it("keeps the longest anchored prefix for multi-word brands", () => {
    const requested = extractCampaignBrand("#4000 Air France Holiday Push - kamma")!;
    const resolved = resolveHistoricalBrand(requested, [
      { name: "#3103 Air France - 4beTPA - Kamma" },
      { name: "#3081 Air Caraibes - 4axS9H - rndaserver" },
      { name: "#3107 Air Corsica - 4av6PG - rndamailing" },
    ]);
    expect(resolved?.label).toBe("Air France");
    expect(resolved?.tokens).toEqual(["air", "france"]);
  });

  it("refuses to fall back to a shared first word without an exact anchor", () => {
    const requested = extractCampaignBrand("#4000 Air Unknown Push - kamma")!;
    expect(resolveHistoricalBrand(requested, [
      { name: "#3103 Air France - 4beTPA - Kamma" },
      { name: "#3081 Air Caraibes - 4axS9H - rndaserver" },
    ])).toBeNull();
  });
});

describe("modeOfTags", () => {
  it("returns the most frequent non-empty value", () => {
    expect(modeOfTags(["A", "B", "A", null, "", "  "])).toBe("A");
  });

  it("returns null when all values empty", () => {
    expect(modeOfTags([null, undefined, "", "  "])).toBeNull();
  });
});

describe("suggestTagsFromHistory", () => {
  it("aggregates the exact brand across all MTA suffixes without mixing advertisers", () => {
    const brand = extractCampaignBrand("#4000 Picard - new-code - mayesale")!;
    const result = suggestTagsFromHistory(brand, [
      {
        name: "#3091 Picard - 5au5NM - kamma",
        open_tag: "O5AU",
        click_tag: "C5AU",
        unsubscribe_tag: "U5AU",
      },
      {
        name: "#3040 Picard - 5auXYZ - rndaserver",
        open_tag: "O5AU",
        click_tag: "C5AU",
        unsubscribe_tag: "U5AU",
      },
      {
        // Descriptive text after an anchored brand still belongs to Picard.
        name: "#3041 Picard 20-30/08 - verysent",
        open_tag: "O5AU",
        click_tag: "C5AU",
        unsubscribe_tag: "U5AU",
      },
      {
        // Same MTA suffix as the request, but a different brand: must be ignored.
        name: "#3999 Ricaud - 3ceABC - mayesale",
        open_tag: "WRONG",
        click_tag: "WRONG",
        unsubscribe_tag: "WRONG",
      },
    ]);
    expect(result).toEqual({
      matches: 3,
      suggestions: {
        openTag: "O5AU",
        clickTag: "C5AU",
        unsubscribeTag: "U5AU",
      },
    });
  });

  it("uses the complete history rather than a 100-row recent window", () => {
    const brand = extractCampaignBrand("#9999 Ricaud - fresh - kamma")!;
    const rows = Array.from({ length: 150 }, (_, i) => ({
      name: `#${i} Ricaud - code${i} - ${i % 2 ? "kamma" : "rndaserver"}`,
      open_tag: i < 60 ? "RECENT_WRONG" : "HISTORICAL_MODE",
      click_tag: i < 60 ? "RECENT_WRONG" : "HISTORICAL_MODE",
      unsubscribe_tag: i < 60 ? "RECENT_WRONG" : "HISTORICAL_MODE",
    }));
    expect(suggestTagsFromHistory(brand, rows)).toEqual({
      matches: 150,
      suggestions: {
        openTag: "HISTORICAL_MODE",
        clickTag: "HISTORICAL_MODE",
        unsubscribeTag: "HISTORICAL_MODE",
      },
    });
  });

  it("returns no suggestion instead of falling back to another brand", () => {
    const brand = extractCampaignBrand("#9999 Unknown Brand - fresh - kamma")!;
    expect(suggestTagsFromHistory(brand, [{
      name: "#3091 Picard - 5au5NM - kamma",
      open_tag: "O5AU",
      click_tag: "C5AU",
      unsubscribe_tag: "U5AU",
    }])).toEqual({ matches: 0, suggestions: null });
  });
});

describe("suggestSegmentsFromRecentHistory", () => {
  const brand = extractCampaignBrand("#5000 Air France - fresh-code - kamma")!;
  const row = (
    campaignId: string,
    name: string,
    segmentId: string,
    segmentName: string,
    totalClicks: number,
    firstSentAt: string,
  ) => ({ campaignId, name, segmentId, segmentName, totalClicks, firstSentAt });

  it("isolates exact brands, takes the latest ten, and sums total clicks by segment", () => {
    const recentAirFrance = Array.from({ length: 11 }, (_, index) =>
      row(
        `fr-${index}`,
        `#${4900 - index} Air France - code${index} - mta`,
        index < 2 ? "vip" : "general",
        index < 2 ? "VIP" : "General",
        index === 0 ? 80 : 10,
        `2026-08-${String(20 - index).padStart(2, "0")}T10:00:00.000Z`,
      ));
    const result = suggestSegmentsFromRecentHistory(brand, [
      ...recentAirFrance,
      row("caribes", "#4880 Air Caraibes - code - mta", "wrong", "Wrong", 9_999, "2026-08-24T10:00:00.000Z"),
    ]);

    expect(result.campaignsConsidered).toBe(10);
    expect(result.suggestions).toEqual([
      { segmentId: "vip", segmentName: "VIP", totalClicks: 90, campaignCount: 2 },
      { segmentId: "general", segmentName: "General", totalClicks: 80, campaignCount: 8 },
    ]);
  });

  it("keeps zero-click campaigns and uses deterministic ties", () => {
    const result = suggestSegmentsFromRecentHistory(brand, [
      row("a", "#4900 Air France - code - mta", "z", "Zulu", 0, "2026-08-23T10:00:00.000Z"),
      row("b", "#4899 Air France - code - mta", "a", "Alpha", 0, "2026-08-22T10:00:00.000Z"),
      row("c", "#4898 Air France - code - mta", "m", "Middle", 1, "2026-08-21T10:00:00.000Z"),
    ]);
    expect(result.suggestions).toEqual([
      { segmentId: "m", segmentName: "Middle", totalClicks: 1, campaignCount: 1 },
      { segmentId: "a", segmentName: "Alpha", totalClicks: 0, campaignCount: 1 },
      { segmentId: "z", segmentName: "Zulu", totalClicks: 0, campaignCount: 1 },
    ]);
  });
});
