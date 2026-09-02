import { describe, expect, it } from "vitest";
import fs from "node:fs";

const repositorySource = fs.readFileSync(
  new URL("../server/repositories/subscriber-repository.ts", import.meta.url),
  "utf8",
);
const routesSource = fs.readFileSync(
  new URL("../server/routes/segments.ts", import.meta.url),
  "utf8",
);

describe("segment exclusion replacement invariants", () => {
  it("replaces hashes and recalculates the published count in one transaction", () => {
    const start = repositorySource.indexOf("export async function replaceSegmentExclusions");
    const end = repositorySource.indexOf("export async function updateSegment", start);
    const implementation = repositorySource.slice(start, end);

    expect(implementation).toContain("db.transaction");
    expect(implementation).toContain(".for(\"update\")");
    expect(implementation).toContain("tx.delete(segmentExclusionHashes)");
    expect(implementation).toContain("tx.insert(segmentExclusionHashes)");
    expect(implementation).toContain("cachedCount: finalSegmentCount");
    expect(implementation).toContain("exclusionVersion");
    expect(implementation.indexOf("tx.delete(segmentExclusionHashes)"))
      .toBeLessThan(implementation.indexOf("tx.insert(segmentExclusionHashes)"));
    expect(implementation.indexOf("tx.insert(segmentExclusionHashes)"))
      .toBeLessThan(implementation.indexOf("cachedCount: finalSegmentCount"));
  });

  it("fences stale count writers with the exclusion generation", () => {
    const start = repositorySource.indexOf("export async function getSegmentSubscriberCountCached");
    const end = repositorySource.indexOf("// ═", start);
    const implementation = repositorySource.slice(start, end);
    expect(implementation).toContain("segments.exclusionVersion");
    expect(implementation).toContain("segmentCountCacheKey(segmentId, exclusionVersion)");
    expect(implementation).toContain("persistSegmentCachedCount(segmentId, exclusionVersion, count)");
    expect(implementation).toContain("eq(segments.exclusionVersion, exclusionVersion)");
  });

  it("validates uploaded hashes before starting replacement", () => {
    const start = routesSource.indexOf('app.put("/api/segments/:id/exclusions"');
    const end = routesSource.indexOf('app.delete("/api/segments/:id/exclusions"', start);
    const handler = routesSource.slice(start, end);

    expect(handler.indexOf("parseSegmentExclusionCsvFile"))
      .toBeLessThan(handler.indexOf("replaceSegmentExclusions"));
    expect(handler).toContain("cleanupExclusionFiles(files)");
    expect(handler.indexOf("cleanupExclusionFiles(files)"))
      .toBeGreaterThan(handler.indexOf("finally"));
  });

  it("uses the same atomic replacement path to remove all hashes", () => {
    const start = routesSource.indexOf('app.delete("/api/segments/:id/exclusions"');
    const handler = routesSource.slice(start, routesSource.indexOf('app.get("/api/segments/:id/subscribers"', start));
    expect(handler).toContain("limitExclusionOperations");
    expect(handler).toContain("replaceSegmentExclusions(req.params.id, [])");
    expect(handler).toContain("releaseExclusionOperationForRequest(req)");
  });
});