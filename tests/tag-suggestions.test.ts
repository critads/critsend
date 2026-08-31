import { describe, it, expect } from "vitest";
import {
  campaignMatchesBrand,
  extractCampaignBrand,
  historicalBrandKeys,
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

describe("historicalBrandKeys", () => {
  it("tries descriptive names from the longest key down to a strict brand anchor", () => {
    const requested = extractCampaignBrand("#4000 Air France Holiday Push - kamma")!;
    expect(historicalBrandKeys(requested)).toEqual([
      "air\u001ffrance\u001fholiday\u001fpush",
      "air\u001ffrance\u001fholiday",
      "air\u001ffrance",
      "air",
    ]);
  });

  it("deduplicates repeated significant words like the SQL brand key", () => {
    const requested = extractCampaignBrand("#4000 Foo Foo Bar - kamma")!;
    expect(requested.key).toBe("foo\u001fbar");
    expect(historicalBrandKeys(requested)).toEqual(["foo\u001fbar", "foo"]);
  });
});

describe("campaignMatchesBrand", () => {
  it("requires the complete brand prefix, not one common word", () => {
    const brand = extractCampaignBrand("#3103 Air France - 4beTPA - Kamma")!;
    expect(campaignMatchesBrand("#3086 Air France - 4beTPA - rndaserver", brand)).toBe(true);
    expect(campaignMatchesBrand("#4000 Air France 20-30/08 - mayesale", brand)).toBe(true);
    expect(campaignMatchesBrand("#3081 Air Caraibes - 4axS9H - rndaserver", brand)).toBe(false);
  });

  it("does not expand a generic one-token anchor into unrelated multiword brands", () => {
    const brand = extractCampaignBrand("#3100 Air - code - kamma")!;
    expect(campaignMatchesBrand("#3099 Air - another - mta", brand)).toBe(true);
    expect(campaignMatchesBrand("#3098 Air France - code - mta", brand)).toBe(false);
    expect(campaignMatchesBrand("#3097 Air Caraibes - code - mta", brand)).toBe(false);
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
    deliveredCount: number,
    firstSentAt: string,
  ) => ({ campaignId, name, segmentId, segmentName, totalClicks, deliveredCount, firstSentAt });

  it("isolates exact brands and includes every segment from multi-segment campaigns", () => {
    const result = suggestSegmentsFromRecentHistory(brand, [
      row("fr-1", "#4900 Air France - code - mta", "vip", "VIP", 200, 10_000, "2026-08-20T10:00:00.000Z"),
      row("fr-1", "#4900 Air France - code - mta", "general", "General", 200, 10_000, "2026-08-20T10:00:00.000Z"),
      row("fr-2", "#4899 Air France - code - mta", "vip", "VIP", 150, 10_000, "2026-08-19T10:00:00.000Z"),
      row("caribes", "#4880 Air Caraibes - code - mta", "wrong", "Wrong", 9_999, 10_000, "2026-08-24T10:00:00.000Z"),
    ]);

    expect(result.campaignsConsidered).toBe(2);
    expect(result.strategy).toBe("performance");
    expect(result.suggestions.map((item) => item.segmentId)).toEqual(["vip", "general"]);
    expect(result.suggestions[0]).toMatchObject({
      segmentId: "vip",
      campaignCount: 2,
      deliveredCount: 20_000,
      totalClicks: 350,
      evidence: "performance",
      metricScope: "campaigns_using_segment",
    });
  });

  it("prefers repeatable click rate over one campaign's large absolute click count", () => {
    const result = suggestSegmentsFromRecentHistory(brand, [
      row("large", "#4900 Air France - code - mta", "large", "One huge send", 10_000, 1_000_000, "2026-08-23T10:00:00.000Z"),
      row("repeat-1", "#4899 Air France - code - mta", "repeat", "Repeat winner", 300, 10_000, "2026-08-22T10:00:00.000Z"),
      row("repeat-2", "#4898 Air France - code - mta", "repeat", "Repeat winner", 300, 10_000, "2026-08-21T10:00:00.000Z"),
    ]);

    expect(result.suggestions.map((item) => item.segmentId)).toEqual(["repeat", "large"]);
  });

  it("uses an explicit recent-use fallback for sparse zero-click history", () => {
    const result = suggestSegmentsFromRecentHistory(brand, [
      row("a", "#4900 Air France - code - mta", "older", "Older", 0, 5_000, "2026-08-22T10:00:00.000Z"),
      row("b", "#4899 Air France - code - mta", "recent", "Recent", 0, 500, "2026-08-23T10:00:00.000Z"),
    ]);

    expect(result.strategy).toBe("recent_use");
    expect(result.suggestions.map((item) => item.segmentId)).toEqual(["recent", "older"]);
    expect(result.suggestions.every((item) => item.evidence === "recent_use")).toBe(true);
  });

  it("uses stable segment IDs to break otherwise identical ties", () => {
    const result = suggestSegmentsFromRecentHistory(brand, [
      row("a", "#4900 Air France - code - mta", "z", "Same", 10, 1_000, "2026-08-23T10:00:00.000Z"),
      row("b", "#4899 Air France - code - mta", "a", "Same", 10, 1_000, "2026-08-23T10:00:00.000Z"),
    ]);

    expect(result.suggestions.map((item) => item.segmentId)).toEqual(["a", "z"]);
  });

  it("bounds ranking work to the 250 most recent matching campaigns", () => {
    const candidates = Array.from({ length: 251 }, (_, index) =>
      row(
        `campaign-${index}`,
        `#${5000 - index} Air France - code - mta`,
        `segment-${index}`,
        `Segment ${index}`,
        10,
        1_000,
        new Date(Date.UTC(2026, 7, 31 - index)).toISOString(),
      ));

    const result = suggestSegmentsFromRecentHistory(brand, candidates);

    expect(result.campaignsConsidered).toBe(250);
    expect(result.suggestions).toHaveLength(3);
  });

  it("applies the history limit after strict brand filtering", () => {
    const unrelated = Array.from({ length: 251 }, (_, index) =>
      row(
        `caraibes-${index}`,
        `#${6000 - index} Air Caraibes - code - mta`,
        "wrong",
        "Wrong",
        100,
        1_000,
        new Date(Date.UTC(2026, 7, 31 - index)).toISOString(),
      ));
    const result = suggestSegmentsFromRecentHistory(brand, [
      ...unrelated,
      row("fr-1", "#4900 Air France - code - mta", "right", "Right", 20, 1_000, "2025-01-02T00:00:00.000Z"),
      row("fr-2", "#4899 Air France - code - mta", "right", "Right", 20, 1_000, "2025-01-01T00:00:00.000Z"),
    ]);

    expect(result.campaignsConsidered).toBe(2);
    expect(result.suggestions.map((item) => item.segmentId)).toEqual(["right"]);
  });

  it("keeps a generic one-token brand isolated from longer brands", () => {
    const genericBrand = extractCampaignBrand("#5000 Air - code - mta")!;
    const result = suggestSegmentsFromRecentHistory(genericBrand, [
      row("air", "#4999 Air - code - mta", "exact", "Exact", 20, 1_000, "2026-08-03T00:00:00.000Z"),
      row("fr", "#4998 Air France - code - mta", "fr", "France", 2_000, 10_000, "2026-08-02T00:00:00.000Z"),
      row("car", "#4997 Air Caraibes - code - mta", "car", "Caraibes", 2_000, 10_000, "2026-08-01T00:00:00.000Z"),
    ]);

    expect(result.campaignsConsidered).toBe(1);
    expect(result.suggestions.map((item) => item.segmentId)).toEqual(["exact"]);
  });
});
