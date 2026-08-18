import { describe, it, expect } from "vitest";
import { tagSuggestTokens, likePattern, pickBrandIndex, modeOfTags } from "../server/services/tag-suggestions";

describe("tagSuggestTokens", () => {
  it("folds accents and lowercases", () => {
    expect(tagSuggestTokens("Éclat Rentrée")).toEqual(["eclat"]); // "rentree" is a stopword
  });

  it("drops stopwords, short tokens and pure numbers", () => {
    expect(tagSuggestTokens("Kammaspeed Promo Aout 2026 x")).toEqual(["kammaspeed"]);
  });

  it("dedupes and caps at 8 tokens", () => {
    const name = "aaa aaa bbb ccc ddd eee fff ggg hhh iii";
    const tokens = tagSuggestTokens(name);
    expect(tokens).toHaveLength(8);
    expect(new Set(tokens).size).toBe(8);
  });

  it("returns empty for names with no usable token", () => {
    expect(tagSuggestTokens("12 - 34 !!")).toEqual([]);
    expect(tagSuggestTokens("")).toEqual([]);
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

describe("pickBrandIndex", () => {
  it("picks the token with the most matches", () => {
    expect(pickBrandIndex(["aaa", "bbbb"], [2, 5])).toBe(1);
  });

  it("breaks ties by longest token", () => {
    expect(pickBrandIndex(["aaa", "bbbb"], [3, 3])).toBe(1);
    expect(pickBrandIndex(["aaaaa", "bbbb"], [3, 3])).toBe(0);
  });

  it("returns -1 when nothing matched", () => {
    expect(pickBrandIndex(["aaa", "bbb"], [0, 0])).toBe(-1);
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
