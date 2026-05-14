import { QueryClient, QueryFunction } from "@tanstack/react-query";

let csrfToken: string | null = null;

export async function fetchCsrfToken(): Promise<string> {
  if (csrfToken) return csrfToken;
  const res = await fetch('/api/csrf-token', { credentials: 'include' });
  const data = await res.json();
  csrfToken = data.csrfToken;
  return csrfToken!;
}

/**
 * Custom error type carrying the parsed HTTP status + JSON body so callers
 * (e.g. the campaigns list page) can branch on `error.status === 503` and
 * `error.body?.error === "service_busy"` without parsing message strings.
 */
export class ApiError extends Error {
  public readonly status: number;
  public readonly body: any;
  public readonly retryAfterSeconds?: number;
  constructor(status: number, body: any, message: string, retryAfterSeconds?: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    const text = (await res.text()) || res.statusText;
    let body: any = null;
    try { body = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    const retryAfter = res.headers.get("Retry-After");
    const retryAfterSeconds = retryAfter ? Number(retryAfter) : undefined;
    throw new ApiError(res.status, body, `${res.status}: ${text}`, retryAfterSeconds);
  }
}

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined,
  signal?: AbortSignal,
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (data) {
    headers["Content-Type"] = "application/json";
  }
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())) {
    headers["x-csrf-token"] = await fetchCsrfToken();
  }

  const res = await fetch(url, {
    method,
    headers,
    body: data ? JSON.stringify(data) : undefined,
    credentials: "include",
    signal,
  });

  if (res.status === 403) {
    const text = await res.text();
    if (text.includes('CSRF') || text.includes('csrf')) {
      csrfToken = null;
      headers["x-csrf-token"] = await fetchCsrfToken();
      const retryRes = await fetch(url, {
        method,
        headers,
        body: data ? JSON.stringify(data) : undefined,
        credentials: "include",
        signal,
      });
      await throwIfResNotOk(retryRes);
      return retryRes;
    }
    throw new Error(`${res.status}: ${text}`);
  }

  await throwIfResNotOk(res);
  return res;
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    // Build the URL from the queryKey: first segment is the path, optional
    // second segment is an object of query params (so callers can use
    // ["/api/campaigns", { page, search }] without inflating the cache key
    // into a flat string). Falls back to the legacy join-with-/ behaviour
    // for plain string-only keys.
    const [first, second] = queryKey as [unknown, unknown?];
    let url: string;
    if (typeof first === "string" && second && typeof second === "object" && !Array.isArray(second)) {
      const sp = new URLSearchParams();
      for (const [k, v] of Object.entries(second as Record<string, unknown>)) {
        if (v === undefined || v === null || v === "" || v === false) continue;
        sp.set(k, String(v));
      }
      const q = sp.toString();
      url = q ? `${first}?${q}` : first;
    } else {
      url = (queryKey as unknown[]).join("/");
    }
    const res = await fetch(url, { credentials: "include" });

    if (unauthorizedBehavior === "returnNull" && res.status === 401) {
      return null;
    }

    // throwIfResNotOk now throws ApiError carrying status + parsed body,
    // so callers can branch on err.status === 503 / err.body.error
    // (Task #148: distinguish "service_busy" from real failures).
    await throwIfResNotOk(res);
    return await res.json();
  };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: false,
      staleTime: Infinity,
      retry: false,
    },
    mutations: {
      retry: false,
    },
  },
});
