import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

/**
 * campaign_exclusion_segments bootstrap: the segment FK must RESTRICT
 * deletion (a running sender keeps exclusion ids in memory and skips segments
 * it can no longer compile, so a cascaded delete would let later batches
 * reach explicitly excluded subscribers). Tables created by an earlier build
 * with ON DELETE CASCADE are rewritten in place, idempotently.
 */

const queries: string[] = [];
let fkRows: Array<{ conname: string; confdeltype: string }> = [];
const release = vi.fn();

vi.mock("../server/db", () => ({
  pool: {
    connect: async () => ({
      query: async (text: string) => {
        queries.push(text.replace(/\s+/g, " ").trim());
        if (text.includes("FROM pg_constraint")) return { rows: fkRows };
        return { rows: [] };
      },
      release,
    }),
  },
}));
vi.mock("../server/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

beforeEach(() => {
  queries.length = 0;
  release.mockReset();
  vi.resetModules();
});

async function runBootstrap() {
  const mod = await import("../server/campaign-segments-bootstrap");
  await mod.ensureCampaignSegmentsSchema();
}

describe("campaign_exclusion_segments bootstrap", () => {
  it("creates the table with a RESTRICT segment FK and backfills only campaigns without rows", async () => {
    fkRows = [{ conname: "campaign_exclusion_segments_segment_id_fkey", confdeltype: "r" }];
    await runBootstrap();
    const create = queries.find((q) => q.includes("CREATE TABLE IF NOT EXISTS campaign_exclusion_segments"));
    expect(create).toMatch(/segment_id varchar NOT NULL CONSTRAINT campaign_exclusion_segments_segment_id_fkey REFERENCES segments\(id\) ON DELETE RESTRICT/);
    expect(create).toMatch(/campaign_id varchar NOT NULL REFERENCES campaigns\(id\) ON DELETE CASCADE/);
    const backfill = queries.find((q) => q.includes("INSERT INTO campaign_exclusion_segments"));
    expect(backfill).toContain("WHERE c.exclude_segment_id IS NOT NULL AND NOT EXISTS");
    expect(backfill).toContain("ON CONFLICT DO NOTHING");
    // Already RESTRICT: nothing to rewrite.
    expect(queries.some((q) => q.startsWith("ALTER TABLE campaign_exclusion_segments"))).toBe(false);
    expect(queries.at(-1)).toBe("COMMIT");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("rewrites a CASCADE segment FK left by an earlier build to RESTRICT, inside the same transaction", async () => {
    fkRows = [{ conname: "campaign_exclusion_segments_segment_id_fkey", confdeltype: "c" }];
    await runBootstrap();
    const alters = queries.filter((q) => q.startsWith("ALTER TABLE campaign_exclusion_segments"));
    expect(alters).toEqual([
      'ALTER TABLE campaign_exclusion_segments DROP CONSTRAINT "campaign_exclusion_segments_segment_id_fkey"',
      "ALTER TABLE campaign_exclusion_segments ADD CONSTRAINT campaign_exclusion_segments_segment_id_fkey FOREIGN KEY (segment_id) REFERENCES segments(id) ON DELETE RESTRICT",
    ]);
    const begin = queries.indexOf("BEGIN");
    const commit = queries.indexOf("COMMIT");
    for (const alter of alters) {
      const idx = queries.indexOf(alter);
      expect(idx).toBeGreaterThan(begin);
      expect(idx).toBeLessThan(commit);
    }
  });

  it("rolls back and releases the client when the bootstrap fails", async () => {
    fkRows = [];
    vi.doMock("../server/db", () => ({
      pool: {
        connect: async () => ({
          query: async (text: string) => {
            queries.push(text.replace(/\s+/g, " ").trim());
            if (text.includes("CREATE TABLE IF NOT EXISTS campaign_exclusion_segments")) {
              throw new Error("boom");
            }
            return { rows: [] };
          },
          release,
        }),
      },
    }));
    const mod = await import("../server/campaign-segments-bootstrap");
    await expect(mod.ensureCampaignSegmentsSchema()).rejects.toThrow("boom");
    expect(queries.at(-1)).toBe("ROLLBACK");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("keeps the drizzle declaration, the SQL mirror and the delete route consistent with RESTRICT", () => {
    const schema = readFileSync("shared/schema.ts", "utf8");
    expect(schema).toMatch(/campaignExclusionSegments = pgTable[\s\S]*?segmentId: varchar\("segment_id"\)\.notNull\(\)\.references\(\(\) => segments\.id, \{ onDelete: "restrict" \}\)/);
    const migration = readFileSync("migrations/0008_campaign_exclusion_segments.sql", "utf8");
    expect(migration).toMatch(/"segment_id" varchar NOT NULL CONSTRAINT "campaign_exclusion_segments_segment_id_fkey"\s+REFERENCES "segments"\("id"\) ON DELETE RESTRICT/);
    // The delete route turns the FK violation into a 409 instead of a 500.
    const segmentsRoute = readFileSync("server/routes/segments.ts", "utf8");
    expect(segmentsRoute).toContain('if (pgCode === "23503") {');
    expect(segmentsRoute).toContain("res.status(409)");
  });
});
