// Client side of `GET /api/mtas/orange-test/summary` — control values for a
// list of MTAs. The route accepts at most ORANGE_TEST_SUMMARY_MAX_IDS ids per
// request and silently ignores the rest, so longer lists are split here;
// callers always get an entry for every id the server knows about.
import { ORANGE_TEST_SUMMARY_MAX_IDS, type OrangeTestControlValue } from "@shared/orange-test";

export type OrangeTestSummaryValues = Record<string, OrangeTestControlValue>;

/** Sorted, de-duplicated ids: stable cache keys and stable request URLs. */
export function normalizeOrangeSummaryIds(ids: readonly string[]): string[] {
  return Array.from(new Set(ids.filter((id) => typeof id === "string" && id.length > 0))).sort();
}

export function chunkOrangeSummaryIds(ids: readonly string[], size = ORANGE_TEST_SUMMARY_MAX_IDS): string[][] {
  const chunkSize = Math.max(1, Math.floor(size));
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += chunkSize) chunks.push(ids.slice(i, i + chunkSize));
  return chunks;
}

export interface FetchOrangeTestSummaryOptions {
  signal?: AbortSignal;
  /** Injected in tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  chunkSize?: number;
}

/** Control values for `ids`, merged across as many requests as the route requires. */
export async function fetchOrangeTestSummary(
  ids: readonly string[],
  { signal, fetchImpl, chunkSize = ORANGE_TEST_SUMMARY_MAX_IDS }: FetchOrangeTestSummaryOptions = {},
): Promise<OrangeTestSummaryValues> {
  const normalized = normalizeOrangeSummaryIds(ids);
  if (normalized.length === 0) return {};
  const doFetch = fetchImpl ?? fetch;
  const pages = await Promise.all(
    chunkOrangeSummaryIds(normalized, chunkSize).map(async (chunk) => {
      const res = await doFetch(`/api/mtas/orange-test/summary?ids=${encodeURIComponent(chunk.join(","))}`, {
        credentials: "include",
        signal,
      });
      if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
      const body = (await res.json()) as { values?: OrangeTestSummaryValues };
      return body.values ?? {};
    }),
  );
  return Object.assign({}, ...pages) as OrangeTestSummaryValues;
}
