import { describe, expect, it } from "vitest";
import { shouldRetrySegmentSuggestions } from "../client/src/lib/segment-suggestion-retry";

describe("campaign segment suggestion recovery", () => {
  it.each([429, 500, 503])("retries transient HTTP %s responses", (status) => {
    expect(shouldRetrySegmentSuggestions(0, new Error(`${status}: unavailable`))).toBe(true);
  });

  it("retries network failures", () => {
    expect(shouldRetrySegmentSuggestions(0, new TypeError("Failed to fetch"))).toBe(true);
  });

  it("does not retry ordinary client errors or exceed the retry budget", () => {
    expect(shouldRetrySegmentSuggestions(0, new Error("400: invalid name"))).toBe(false);
    expect(shouldRetrySegmentSuggestions(2, new Error("503: unavailable"))).toBe(false);
  });
});