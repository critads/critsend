/**
 * Typed error hierarchy for object-storage backends.
 *
 * The whole motivation of the Hetzner S3 backend was to fix the original
 * import bug where `fileExistsWithRetry` returned `false` for ANY error
 * (real ENOENT vs EACCES vs EMFILE vs ENOSPC — all became "csv missing").
 *
 * To not reintroduce the same opacity at the S3 layer, all four backend
 * methods MUST distinguish between:
 *
 *   - `ObjectStorageNotFound`     — true 404, the object is genuinely gone.
 *                                   `objectExists()` returns `false` (does
 *                                   NOT throw this — boolean is the contract
 *                                   for that method). `getObjectStream()` and
 *                                   `deleteStorageObject()` throw this.
 *
 *   - `ObjectStorageAccessError`  — 403, signature mismatch, bad creds.
 *                                   ALWAYS thrown. Operator must fix env vars
 *                                   or bucket policy — retrying is futile.
 *
 *   - `ObjectStorageTransientError` — 5xx, throttle, network timeout, DNS
 *                                   blip. ALWAYS thrown. Caller (worker job
 *                                   loop) should requeue with exponential
 *                                   backoff per the architectural rule
 *                                   "transient errors are re-thrown to the
 *                                   job-level handler" (see replit.md).
 *
 *   - `ObjectStorageInvalidPath`  — caller passed a malformed path that
 *                                   doesn't start with `/objects/imports/`.
 *                                   Programming error, not a runtime failure.
 *
 * Callers should branch on `instanceof`. The error message and `cause` carry
 * enough context for both Prometheus labels and post-mortem debugging.
 */

export class ObjectStorageError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "ObjectStorageError";
  }
}

export class ObjectStorageNotFound extends ObjectStorageError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = "ObjectStorageNotFound";
  }
}

export class ObjectStorageAccessError extends ObjectStorageError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = "ObjectStorageAccessError";
  }
}

export class ObjectStorageTransientError extends ObjectStorageError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = "ObjectStorageTransientError";
  }
}

export class ObjectStorageInvalidPath extends ObjectStorageError {
  constructor(message: string) {
    super(message);
    this.name = "ObjectStorageInvalidPath";
  }
}

/**
 * Classify a raw AWS SDK error into our typed hierarchy.
 * Used by the Hetzner backend to convert SDK errors at the boundary.
 */
export function classifyS3Error(err: any, op: string, key: string): ObjectStorageError {
  const code = err?.$metadata?.httpStatusCode;
  const name = err?.name || err?.code;
  const msg = `[${op}] ${key} failed (http ${code ?? "?"}, ${name ?? "unknown"}): ${err?.message ?? String(err)}`;

  if (code === 404 || name === "NotFound" || name === "NoSuchKey") {
    return new ObjectStorageNotFound(msg, err);
  }
  // Transient 4xx: 408 RequestTimeout and 429 TooManyRequests are
  // RETRIABLE per RFC 7231/6585 and S3 will throttle clients with 429
  // (or "SlowDown"). Must be checked BEFORE the generic 4xx → Access
  // branch below, otherwise a Hetzner throttle event would be wrongly
  // surfaced to the user as `storage_misconfigured` (500) instead of
  // `storage_unavailable` (503) and the worker would permafail jobs
  // that should be retried with exponential backoff.
  if (code === 408 || code === 429 ||
      name === "RequestTimeout" || name === "RequestTimeoutException" ||
      name === "SlowDown" || name === "Throttling" ||
      name === "ThrottlingException" || name === "TooManyRequestsException" ||
      name === "ProvisionedThroughputExceededException") {
    return new ObjectStorageTransientError(msg, err);
  }
  // Other 4xx = client error: bad request, auth, precondition, missing
  // required header. Retrying is futile — surface as AccessError so
  // the worker fails fast instead of looping forever on a programming bug
  // or a permanently-misconfigured bucket policy. The classic offenders
  // (403/401/InvalidAccessKey/SignatureDoesNotMatch) are explicitly named
  // for clearer log messages.
  if (code === 403 || code === 401 ||
      name === "AccessDenied" || name === "Forbidden" ||
      name === "InvalidAccessKeyId" || name === "SignatureDoesNotMatch") {
    return new ObjectStorageAccessError(msg, err);
  }
  if (typeof code === "number" && code >= 400 && code < 500) {
    return new ObjectStorageAccessError(msg, err);
  }
  // 5xx, network errors (ECONNRESET, ETIMEDOUT, EPIPE), DNS, unknown code
  // (TCP reset before HTTP response) — all treated as transient and
  // re-thrown to the worker job loop for backoff-retry.
  return new ObjectStorageTransientError(msg, err);
}
