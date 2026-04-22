/**
 * Classification helpers for Postgres / driver errors.
 *
 * These let request handlers and bootstrap code distinguish *transient*
 * infrastructure failures (disk full, connection lost, statement timeout)
 * from genuine application bugs, so we can degrade gracefully instead of
 * surfacing a raw Postgres message to the browser or crash-looping the
 * web boot.
 */

export type DbErrorKind =
  | "disk_full"
  | "connection"
  | "timeout"
  | "admin_shutdown"
  | "unknown";

export interface ClassifiedDbError {
  kind: DbErrorKind;
  transient: boolean;
  code?: string;
  message: string;
}

// Postgres SQLSTATE codes we treat as transient infrastructure failures.
// Disk-full family:
//   53100 disk_full
//   53400 configuration_limit_exceeded (e.g. temp_file_limit)
// Connection family:
//   08000 / 08001 / 08003 / 08004 / 08006 / 08007 / 08P01
//   57P01 admin_shutdown / 57P02 crash_shutdown / 57P03 cannot_connect_now
// Statement-timeout / cancellation:
//   57014 query_canceled
// 53200 (out_of_memory) is intentionally NOT classified as disk_full because
// it is a memory-pressure condition with different operator remediation.
const PG_DISK_FULL_CODES = new Set(["53100", "53400"]);
const PG_CONNECTION_CODES = new Set([
  "08000", "08003", "08006", "08001", "08004", "08007", "08P01",
  "57P01", "57P02", "57P03",
]);
const PG_TIMEOUT_CODES = new Set(["57014"]);

const DISK_FULL_PATTERNS = [
  /disk\s*quota\s*exceeded/i,
  /no space left on device/i,
  /could not write to file/i,
  /could not extend file/i,
  /could not write block/i,
  /out of disk space/i,
  /enospc/i,
];

const CONNECTION_PATTERNS = [
  /econnrefused/i,
  /econnreset/i,
  /connection terminated/i,
  /connection reset/i,
  /server closed the connection/i,
  /terminating connection/i,
  /client has encountered a connection error/i,
];

const TIMEOUT_PATTERNS = [
  /statement timeout/i,
  /canceling statement due to/i,
];

export function classifyDbError(err: unknown): ClassifiedDbError {
  const message = (err as any)?.message ? String((err as any).message) : String(err);
  const code = typeof (err as any)?.code === "string" ? (err as any).code : undefined;

  if (code && PG_DISK_FULL_CODES.has(code)) {
    return { kind: "disk_full", transient: true, code, message };
  }
  if (code && PG_CONNECTION_CODES.has(code)) {
    const kind: DbErrorKind = code.startsWith("57P") ? "admin_shutdown" : "connection";
    return { kind, transient: true, code, message };
  }
  if (code && PG_TIMEOUT_CODES.has(code)) {
    return { kind: "timeout", transient: true, code, message };
  }

  if (DISK_FULL_PATTERNS.some((re) => re.test(message))) {
    return { kind: "disk_full", transient: true, code, message };
  }
  if (CONNECTION_PATTERNS.some((re) => re.test(message))) {
    return { kind: "connection", transient: true, code, message };
  }
  if (TIMEOUT_PATTERNS.some((re) => re.test(message))) {
    return { kind: "timeout", transient: true, code, message };
  }

  return { kind: "unknown", transient: false, code, message };
}

export function isDiskFullError(err: unknown): boolean {
  return classifyDbError(err).kind === "disk_full";
}

export function isTransientDbError(err: unknown): boolean {
  return classifyDbError(err).transient;
}

/**
 * Stable, user-safe message corresponding to a transient DB failure.
 * Never includes the raw Postgres text so we don't leak "Disk quota exceeded"
 * or internal file paths to the browser.
 */
export function userFacingMessageFor(kind: DbErrorKind): string {
  switch (kind) {
    case "disk_full":
    case "admin_shutdown":
    case "connection":
    case "timeout":
      return "The service is temporarily unavailable. Please retry in a moment.";
    default:
      return "An unexpected error occurred.";
  }
}
