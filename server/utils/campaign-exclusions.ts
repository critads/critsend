/**
 * Request-body normalization for campaign exclusion segments.
 *
 * Clients may send the canonical `excludeSegmentIds: string[]` or the legacy
 * single `excludeSegmentId` (string | null | ""). The canonical key wins when
 * both are present. `provided` tells PATCH-style callers whether the request
 * touched the exclusion at all (an absent key must keep the stored value).
 */
export type ExclusionSegmentRequest =
  | { ok: true; provided: boolean; ids: string[] }
  | { ok: false; error: string };

export function readExclusionSegmentIds(body: unknown): ExclusionSegmentRequest {
  const record = (body && typeof body === "object") ? (body as Record<string, unknown>) : {};
  if (Object.prototype.hasOwnProperty.call(record, "excludeSegmentIds")) {
    const raw = record.excludeSegmentIds;
    if (raw === null || raw === undefined) return { ok: true, provided: true, ids: [] };
    if (
      !Array.isArray(raw)
      || raw.some((id) => typeof id !== "string" || !id.trim())
      || new Set(raw).size !== raw.length
    ) {
      return { ok: false, error: "excludeSegmentIds must be a unique list of segment IDs" };
    }
    return { ok: true, provided: true, ids: [...(raw as string[])] };
  }
  if (Object.prototype.hasOwnProperty.call(record, "excludeSegmentId")) {
    const raw = record.excludeSegmentId;
    if (raw === null || raw === undefined || raw === "") return { ok: true, provided: true, ids: [] };
    if (typeof raw !== "string") return { ok: false, error: "excludeSegmentId must be a segment ID" };
    return { ok: true, provided: true, ids: [raw] };
  }
  return { ok: true, provided: false, ids: [] };
}

/** Order-insensitive equality: exclusion order has no audience meaning. */
export function sameIdSets(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id));
}

/** Ids present on both sides — such an audience is always empty. */
export function exclusionAudienceOverlap(segmentIds: string[], excludeSegmentIds: string[]): string[] {
  return excludeSegmentIds.filter((id) => segmentIds.includes(id));
}
