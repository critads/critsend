import { describe, it, expect } from "vitest";
import {
  campaignMatchesBrand,
  extractCampaignBrand,
  tagSuggestTokens,
  likePattern,
  modeOfTags,
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
  it("requires the complete brand signature, not one common word", () => {
    const brand = extractCampaignBrand("#3103 Air France - 4beTPA - Kamma")!;
    expect(campaignMatchesBrand("#3086 Air France - 4beTPA - rndaserver", brand)).toBe(true);
    expect(campaignMatchesBrand("#3081 Air Caraibes - 4axS9H - rndaserver", brand)).toBe(false);
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
        // Same MTA suffix as the request, but a different brand: must be ignored.
        name: "#3999 Ricaud - 3ceABC - mayesale",
        open_tag: "WRONG",
        click_tag: "WRONG",
        unsubscribe_tag: "WRONG",
      },
    ]);
    expect(result).toEqual({
      matches: 2,
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
