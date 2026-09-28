// Client side of `GET /api/mtas/orange-test/summary` — control values for a
// list of MTAs plus the mailbox connection health. The route accepts at most
// ORANGE_TEST_SUMMARY_MAX_IDS ids per request and silently ignores the rest,
// so longer lists are split here; callers always get an entry for every id the
// server knows about.
import {
  ORANGE_TEST_SUMMARY_MAX_IDS,
  type OrangeMailboxHealthView,
  type OrangeTestControlValue,
  type OrangeTestSummaryResponse,
} from "@shared/orange-test";

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

interface OrangeTestSummaryPage {
  values?: OrangeTestSummaryValues;
  mailbox?: OrangeMailboxHealthView;
}

async function fetchSummaryPages(
  chunks: readonly (readonly string[])[],
  { signal, fetchImpl }: FetchOrangeTestSummaryOptions,
): Promise<OrangeTestSummaryPage[]> {
  const doFetch = fetchImpl ?? fetch;
  return Promise.all(
    chunks.map(async (chunk) => {
      const res = await doFetch(`/api/mtas/orange-test/summary?ids=${encodeURIComponent(chunk.join(","))}`, {
        credentials: "include",
        signal,
      });
      if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
      return (await res.json()) as OrangeTestSummaryPage;
    }),
  );
}

/** Control values for `ids`, merged across as many requests as the route requires. */
export async function fetchOrangeTestSummary(
  ids: readonly string[],
  { chunkSize = ORANGE_TEST_SUMMARY_MAX_IDS, ...options }: FetchOrangeTestSummaryOptions = {},
): Promise<OrangeTestSummaryValues> {
  const normalized = normalizeOrangeSummaryIds(ids);
  if (normalized.length === 0) return {};
  const pages = await fetchSummaryPages(chunkOrangeSummaryIds(normalized, chunkSize), options);
  return Object.assign({}, ...pages.map((p) => p.values ?? {})) as OrangeTestSummaryValues;
}

/**
 * Same as `fetchOrangeTestSummary` but keeps the mailbox connection health
 * the route returns alongside the values (the /mtas banner). Every page
 * carries the same mailbox state, so the first one is kept; an empty id list
 * still makes one request so the mailbox health is read.
 */
export async function fetchOrangeTestSummaryResponse(
  ids: readonly string[],
  { chunkSize = ORANGE_TEST_SUMMARY_MAX_IDS, ...options }: FetchOrangeTestSummaryOptions = {},
): Promise<OrangeTestSummaryResponse> {
  const normalized = normalizeOrangeSummaryIds(ids);
  const chunks = normalized.length === 0 ? [[]] : chunkOrangeSummaryIds(normalized, chunkSize);
  const pages = await fetchSummaryPages(chunks, options);
  const mailbox = pages.find((p) => p.mailbox)?.mailbox;
  if (!mailbox) throw new Error("Orange test summary response is missing the mailbox health");
  return { values: Object.assign({}, ...pages.map((p) => p.values ?? {})) as OrangeTestSummaryValues, mailbox };
}
