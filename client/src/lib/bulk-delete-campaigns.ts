import { apiRequest } from "./queryClient";

const DEFAULT_CONCURRENCY = 3;
const DEFAULT_REQUEST_TIMEOUT_MS = 45_000;

type ApiRequest = typeof apiRequest;

export interface BulkDeleteProgress {
  completed: number;
  total: number;
}

export interface BulkDeleteFailure {
  id: string;
  error: Error;
}

export interface BulkDeleteResult {
  deletedIds: string[];
  failures: BulkDeleteFailure[];
}

interface BulkDeleteOptions {
  concurrency?: number;
  requestTimeoutMs?: number;
  onProgress?: (progress: BulkDeleteProgress) => void;
  request?: ApiRequest;
}

export class CampaignDeleteTimeoutError extends Error {
  constructor(public readonly campaignId: string, timeoutMs: number) {
    super(`Campaign deletion did not finish within ${Math.ceil(timeoutMs / 1000)} seconds`);
    this.name = "CampaignDeleteTimeoutError";
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

async function deleteWithTimeout(
  id: string,
  request: ApiRequest,
  timeoutMs: number,
): Promise<void> {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new CampaignDeleteTimeoutError(id, timeoutMs));
    }, timeoutMs);
  });

  try {
    await Promise.race([
      request("DELETE", `/api/campaigns/${id}`, undefined, controller.signal),
      timeout,
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

/**
 * Delete selected campaigns through individually bounded requests. A single
 * large cascade can no longer hold the entire bulk action open forever, and
 * limited concurrency avoids overwhelming the database with heavy cascades.
 */
export async function deleteCampaignsWithProgress(
  ids: string[],
  options: BulkDeleteOptions = {},
): Promise<BulkDeleteResult> {
  const request = options.request ?? apiRequest;
  const timeoutMs = Math.max(1, options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
  const concurrency = Math.max(
    1,
    Math.min(options.concurrency ?? DEFAULT_CONCURRENCY, Math.max(1, ids.length)),
  );
  const deletedIds: string[] = [];
  const failures: BulkDeleteFailure[] = [];
  let nextIndex = 0;
  let completed = 0;

  options.onProgress?.({ completed: 0, total: ids.length });

  async function worker() {
    while (nextIndex < ids.length) {
      const id = ids[nextIndex++];
      try {
        await deleteWithTimeout(id, request, timeoutMs);
        deletedIds.push(id);
      } catch (error) {
        failures.push({ id, error: asError(error) });
      } finally {
        completed += 1;
        options.onProgress?.({ completed, total: ids.length });
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return { deletedIds, failures };
}