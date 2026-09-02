import { createHash } from "node:crypto";
import pg, { type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAX_SEGMENT_EXCLUSION_HASHES } from "../server/services/segment-exclusion-csv";

const HAS_DB = !!(process.env.NEON_DATABASE_URL || process.env.DATABASE_URL);
const integrationDescribe = HAS_DB ? describe : describe.skip;
const LARGE_HASH_COUNT = Math.min(MAX_SEGMENT_EXCLUSION_HASHES - 10_000, 240_000);

function emailHash(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase(), "utf8").digest("hex");
}

integrationDescribe("large segment exclusions (real PostgreSQL)", () => {
  const suffix = `${process.pid}_${Date.now()}`;
  const schema = `excl_large_${suffix}`;
  const tagA = `excl-large-a-${suffix}`;
  const tagB = `excl-large-b-${suffix}`;
  const segmentAId = `segment-a-${suffix}`;
  const segmentBId = `segment-b-${suffix}`;
  const rollbackSegmentId = `rollback-${suffix}`;
  const audienceSize = 20_000;
  const excludedFromA = "subscriber-1@example.test";
  const excludedFromB = "subscriber-2@example.test";
  const overlapAllowedViaB = "subscriber-3@example.test";
  let pool: pg.Pool;
  let largeHashes: string[];

  async function publishSegment(
    client: PoolClient,
    segmentId: string,
    tag: string,
    hashes: string[],
  ): Promise<{ matchedCount: number; finalCount: number }> {
    await client.query("BEGIN");
    try {
      await client.query(
        `INSERT INTO ${schema}.segments (id, tag) VALUES ($1, $2)`,
        [segmentId, tag],
      );
      for (let start = 0; start < hashes.length; start += 5_000) {
        await client.query(
          `INSERT INTO ${schema}.segment_exclusion_hashes (segment_id, email_hash)
           SELECT $1, unnest($2::text[])
           ON CONFLICT DO NOTHING`,
          [segmentId, hashes.slice(start, start + 5_000)],
        );
      }
      const counts = await client.query(
        `SELECT
           count(*) FILTER (
             WHERE EXISTS (
               SELECT 1 FROM ${schema}.segment_exclusion_hashes seh
               WHERE seh.segment_id = $1
                 AND seh.email_hash = encode(
                   digest(convert_to(lower(btrim(s.email)), 'UTF8'), 'sha256'), 'hex'
                 )
             )
           )::int AS matched_count,
           count(*) FILTER (
             WHERE NOT EXISTS (
               SELECT 1 FROM ${schema}.segment_exclusion_hashes seh
               WHERE seh.segment_id = $1
                 AND seh.email_hash = encode(
                   digest(convert_to(lower(btrim(s.email)), 'UTF8'), 'sha256'), 'hex'
                 )
             )
           )::int AS final_count
         FROM ${schema}.subscribers s
         WHERE $2 = ANY(s.tags)`,
        [segmentId, tag],
      );
      await client.query(
        `UPDATE ${schema}.segments SET cached_count = $2 WHERE id = $1`,
        [segmentId, counts.rows[0].final_count],
      );
      await client.query("COMMIT");
      return {
        matchedCount: Number(counts.rows[0].matched_count),
        finalCount: Number(counts.rows[0].final_count),
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    }
  }

  beforeAll(async () => {
    pool = new pg.Pool({
      connectionString: process.env.NEON_DATABASE_URL || process.env.DATABASE_URL,
      max: 2,
    });
    await pool.query("CREATE EXTENSION IF NOT EXISTS pgcrypto");
    await pool.query(`CREATE SCHEMA ${schema}`);
    await pool.query(`
      CREATE TABLE ${schema}.subscribers (
        id varchar PRIMARY KEY,
        email text NOT NULL UNIQUE,
        tags text[] NOT NULL DEFAULT ARRAY[]::text[]
      );
      CREATE TABLE ${schema}.segments (
        id varchar PRIMARY KEY,
        tag text NOT NULL,
        cached_count integer
      );
      CREATE TABLE ${schema}.segment_exclusion_hashes (
        segment_id varchar NOT NULL
          REFERENCES ${schema}.segments(id) ON DELETE CASCADE,
        email_hash varchar(64) NOT NULL
          CHECK (email_hash ~ '^[0-9a-f]{64}$'),
        PRIMARY KEY (segment_id, email_hash)
      );
      CREATE INDEX segment_exclusion_hashes_hash_idx
        ON ${schema}.segment_exclusion_hashes (email_hash);
    `);
    await pool.query(
      `INSERT INTO ${schema}.subscribers (id, email, tags)
       SELECT 'subscriber-' || n,
              'subscriber-' || n || '@example.test',
              CASE
                WHEN n = 3 THEN ARRAY[$1, $2]::text[]
                WHEN n % 2 = 0 THEN ARRAY[$2]::text[]
                ELSE ARRAY[$1]::text[]
              END
       FROM generate_series(1, $3::int) AS n`,
      [tagA, tagB, audienceSize],
    );
    largeHashes = Array.from({ length: LARGE_HASH_COUNT }, (_, i) =>
      createHash("sha256").update(`non-matching-${suffix}-${i}`).digest("hex"),
    );
    largeHashes[0] = emailHash(excludedFromA);
    largeHashes[1] = emailHash(overlapAllowedViaB);
  }, 60_000);

  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await pool.end();
  }, 60_000);

  it("previews and publishes a near-limit exclusion list with bounded resources", async () => {
    const rssBefore = process.memoryUsage().rss;
    const startedAt = performance.now();
    const preview = await pool.query(
      `SELECT count(*)::int AS count
       FROM ${schema}.subscribers s
       WHERE $1 = ANY(s.tags)
         AND NOT (
           encode(
             digest(convert_to(lower(btrim(s.email)), 'UTF8'), 'sha256'), 'hex'
           ) = ANY($2::text[])
         )`,
      [tagA, largeHashes],
    );
    const client = await pool.connect();
    let published: { matchedCount: number; finalCount: number };
    try {
      published = await publishSegment(client, segmentAId, tagA, largeHashes);
    } finally {
      client.release();
    }
    const elapsedMs = performance.now() - startedAt;
    const rssGrowth = process.memoryUsage().rss - rssBefore;

    expect(Number(preview.rows[0].count)).toBe(audienceSize / 2 - 2);
    expect(published.matchedCount).toBe(2);
    expect(published.finalCount).toBe(audienceSize / 2 - 2);
    expect(elapsedMs).toBeLessThan(120_000);
    expect(rssGrowth).toBeLessThan(384 * 1024 * 1024);
  }, 150_000);

  it("applies each branch's exclusions to counts and paged sending cursors", async () => {
    const client = await pool.connect();
    try {
      await publishSegment(client, segmentBId, tagB, [emailHash(excludedFromB)]);
    } finally {
      client.release();
    }

    const branchSql = `
      (
        $1 = ANY(s.tags)
        AND NOT EXISTS (
          SELECT 1 FROM ${schema}.segment_exclusion_hashes seh
          WHERE seh.segment_id = $3
            AND seh.email_hash = encode(
              digest(convert_to(lower(btrim(s.email)), 'UTF8'), 'sha256'), 'hex'
            )
        )
      )
      OR
      (
        $2 = ANY(s.tags)
        AND NOT EXISTS (
          SELECT 1 FROM ${schema}.segment_exclusion_hashes seh
          WHERE seh.segment_id = $4
            AND seh.email_hash = encode(
              digest(convert_to(lower(btrim(s.email)), 'UTF8'), 'sha256'), 'hex'
            )
        )
      )
    `;
    const params = [tagA, tagB, segmentAId, segmentBId];
    const count = await pool.query(
      `SELECT count(*)::int AS count
       FROM ${schema}.subscribers s
       WHERE ${branchSql}`,
      params,
    );

    const seenEmails: string[] = [];
    let afterId = "";
    do {
      const page = await pool.query(
        `SELECT s.id, s.email
         FROM ${schema}.subscribers s
         WHERE (${branchSql}) AND s.id > $5
         ORDER BY s.id
         LIMIT 777`,
        [...params, afterId],
      );
      seenEmails.push(...page.rows.map((row) => String(row.email)));
      afterId = page.rows.at(-1)?.id ?? afterId;
      if (page.rowCount! < 777) break;
    } while (true);

    expect(Number(count.rows[0].count)).toBe(audienceSize - 2);
    expect(seenEmails).toHaveLength(audienceSize - 2);
    expect(seenEmails).not.toContain(excludedFromA);
    expect(seenEmails).not.toContain(excludedFromB);
    expect(seenEmails).toContain(overlapAllowedViaB);
  }, 60_000);

  it("rolls back the segment and all hashes when a later import batch fails", async () => {
    const validHashes = Array.from({ length: 5_000 }, (_, i) =>
      createHash("sha256").update(`rollback-${suffix}-${i}`).digest("hex"),
    );
    const client = await pool.connect();
    try {
      await expect(
        publishSegment(client, rollbackSegmentId, tagA, [...validHashes, "not-a-sha256"]),
      ).rejects.toThrow();
    } finally {
      client.release();
    }

    const result = await pool.query(
      `SELECT
         EXISTS (
           SELECT 1 FROM ${schema}.segments WHERE id = $1
         ) AS segment_exists,
         (
           SELECT count(*)::int
           FROM ${schema}.segment_exclusion_hashes
           WHERE segment_id = $1
         ) AS hash_count`,
      [rollbackSegmentId],
    );
    expect(result.rows[0]).toEqual({ segment_exists: false, hash_count: 0 });
  }, 30_000);
});

integrationDescribe("large replacement through the real repository", () => {
  const suffix = `${process.pid}_${Date.now()}`;
  const segmentId = `excl-replace-${suffix}`;
  const tag = `excl-replace-tag-${suffix}`;
  let controlPool: pg.Pool;
  let appPool: pg.Pool;
  let repo: typeof import("../server/repositories/subscriber-repository");

  beforeAll(async () => {
    controlPool = new pg.Pool({
      connectionString: process.env.NEON_DATABASE_URL || process.env.DATABASE_URL,
      max: 1,
    });
    await controlPool.query(
      `INSERT INTO public.segments (id, name, rules)
       VALUES ($1::varchar, ($1::varchar)::text, $2::jsonb)`,
      [segmentId, JSON.stringify({
        version: 2,
        root: {
          type: "group",
          combinator: "AND",
          children: [{
            type: "condition",
            field: "tags",
            operator: "has_tag",
            value: tag,
            value2: null,
          }],
        },
      })],
    );
    ({ pool: appPool } = await import("../server/db"));
    repo = await import("../server/repositories/subscriber-repository");
  }, 30_000);

  afterAll(async () => {
    await appPool?.end().catch(() => {});
    await controlPool?.query(
      "DELETE FROM public.segment_exclusion_hashes WHERE segment_id = $1",
      [segmentId],
    ).catch(() => {});
    await controlPool?.query(
      "DELETE FROM public.segments WHERE id = $1 AND name = id",
      [segmentId],
    ).catch(() => {});
    await controlPool?.end().catch(() => {});
  }, 120_000);

  it("replaces near-limit hashes atomically without expanding the query AST", async () => {
    const hashes = Array.from({ length: LARGE_HASH_COUNT }, (_, i) =>
      createHash("sha256").update(`repository-replacement-${suffix}-${i}`).digest("hex"),
    );
    const startedAt = performance.now();
    const result = await repo.replaceSegmentExclusions(segmentId, hashes);
    const elapsedMs = performance.now() - startedAt;

    expect(result?.exclusionHashCount).toBe(LARGE_HASH_COUNT);
    expect(result?.matchedExclusionCount).toBe(0);
    expect(result?.finalSegmentCount).toBe(0);
    expect(elapsedMs).toBeLessThan(120_000);

    const stored = await controlPool.query(
      `SELECT count(*)::int AS count
       FROM public.segment_exclusion_hashes
       WHERE segment_id = $1`,
      [segmentId],
    );
    expect(stored.rows[0].count).toBe(LARGE_HASH_COUNT);

    const replacementFirstBatch = Array.from({ length: 5_000 }, (_, i) =>
      createHash("sha256").update(`failed-replacement-${suffix}-${i}`).digest("hex"),
    );
    await expect(repo.replaceSegmentExclusions(
      segmentId,
      [...replacementFirstBatch, "not-a-sha256"],
    )).rejects.toThrow();

    const afterFailure = await controlPool.query(
      `SELECT
         count(*)::int AS count,
         bool_or(email_hash = $2) AS kept_original
       FROM public.segment_exclusion_hashes
       WHERE segment_id = $1`,
      [segmentId, hashes[0]],
    );
    expect(afterFailure.rows[0]).toEqual({
      count: LARGE_HASH_COUNT,
      kept_original: true,
    });
  }, 180_000);
});