/**
 * Stable, low-cardinality route bucket used by both `pool-safety.ts` (load-shed
 * metric labels) and `request-lease.ts` (lease holding metric labels).
 *
 * Lives in its own module to avoid a circular import between those two files.
 *
 * Bucket discipline: the union of all prefixes here should cover ≥99% of
 * mounted /api routes so the `/api/other` bucket stays near-empty. When
 * /api/other shows non-trivial traffic, a saturation incident becomes
 * un-diagnosable (we can't tell which endpoint actually filled the pool).
 * If you add a new top-level /api/<prefix> route, also add it here.
 */
export function routeBucket(path: string): string {
  // Most-trafficked first for fastest match in the common case.
  if (path.startsWith("/api/campaigns")) return "/api/campaigns";
  if (path.startsWith("/api/campaign-assets")) return "/api/campaigns";
  if (path.startsWith("/api/subscribers")) return "/api/subscribers";
  if (path.startsWith("/api/imports")) return "/api/imports";
  if (path.startsWith("/api/import-jobs")) return "/api/imports";
  if (path.startsWith("/api/import")) return "/api/imports";
  if (path.startsWith("/api/segments")) return "/api/segments";
  if (path.startsWith("/api/automations")) return "/api/automations";
  if (path.startsWith("/api/automation")) return "/api/automations";
  if (path.startsWith("/api/analytics")) return "/api/analytics";
  if (path.startsWith("/api/mtas")) return "/api/mtas";
  // Lower-traffic but distinct prefixes — break out so /api/other stays
  // near-empty and any future saturation can be attributed to one of these.
  if (path.startsWith("/api/dashboard")) return "/api/dashboard";
  if (path.startsWith("/api/system-metrics")) return "/api/system-metrics";
  if (path.startsWith("/api/database-health")) return "/api/database-health";
  if (path.startsWith("/api/jobs")) return "/api/jobs";
  if (path.startsWith("/api/tag-queue")) return "/api/jobs";
  if (path.startsWith("/api/error-logs")) return "/api/error-logs";
  if (path.startsWith("/api/export")) return "/api/export";
  if (path.startsWith("/api/admin")) return "/api/admin";
  if (path.startsWith("/api/bug-reports")) return "/api/bug-reports";
  if (path.startsWith("/api/warmup")) return "/api/warmup";
  if (path.startsWith("/api/nullsink")) return "/api/nullsink";
  if (path.startsWith("/api/debug")) return "/api/debug";
  if (path.startsWith("/api/headers")) return "/api/headers";
  if (path.startsWith("/api/auth")) return "/api/auth";
  if (path.startsWith("/api/csrf-token")) return "/api/auth";
  if (path.startsWith("/api/webhooks")) return "/api/webhooks";
  if (path.startsWith("/api/unsubscribe")) return "/api/unsubscribe";
  if (path.startsWith("/api/track")) return "/api/track";
  if (path.startsWith("/api/health")) return "/api/health";
  if (path.startsWith("/api/metrics")) return "/api/metrics";
  if (path.startsWith("/api/")) return "/api/other";
  return "non-api";
}
