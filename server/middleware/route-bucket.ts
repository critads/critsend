/**
 * Stable, low-cardinality route bucket used by both `pool-safety.ts` (load-shed
 * metric labels) and `request-lease.ts` (lease holding metric labels).
 *
 * Lives in its own module to avoid a circular import between those two files.
 */
export function routeBucket(path: string): string {
  if (path.startsWith("/api/campaigns")) return "/api/campaigns";
  if (path.startsWith("/api/subscribers")) return "/api/subscribers";
  if (path.startsWith("/api/imports")) return "/api/imports";
  if (path.startsWith("/api/segments")) return "/api/segments";
  if (path.startsWith("/api/automations")) return "/api/automations";
  if (path.startsWith("/api/analytics")) return "/api/analytics";
  if (path.startsWith("/api/mtas")) return "/api/mtas";
  if (path.startsWith("/api/")) return "/api/other";
  return "non-api";
}
