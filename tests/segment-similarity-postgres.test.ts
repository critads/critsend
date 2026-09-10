import pg from "pg";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { compileSegmentRules } from "../server/services/segment-compiler";
import type { SegmentRulesV2, SegmentSimilarity } from "../shared/schema";

// Deliberately never falls back to application/shared database variables.
// Run with TEST_DATABASE_URL pointing at an isolated disposable PostgreSQL DB.
const integrationDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;

integrationDescribe("similar segment compiler (isolated PostgreSQL)", () => {
  const schema = `similarity_${process.pid}_${Date.now()}`;
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
  const rule: SegmentSimilarity = {
    type: "similarity",
    ruleId: "08345316-2af7-44a9-8b00-58dfc8f38eb0",
    sourceRef: "Source",
    analysisId: "8ee55e4b-26f9-43b4-986e-a8e8ab6d9b8c",
    resolvedRefs: ["Affinity-A", "affinity-a"],
    analyzedAt: "2026-09-10T10:00:00.000Z",
    candidates: [
      { ref: "Affinity-A", commonCount: 30, additionalCount: 10, sourceFrequency: 0.3, referenceFrequency: 0.1, lift: 3, score: 0.3296 },
      { ref: "affinity-a", commonCount: 25, additionalCount: 10, sourceFrequency: 0.25, referenceFrequency: 0.1, lift: 2.5, score: 0.2291 },
    ],
    calibration: "production-v1",
  };

  beforeAll(async () => {
    await pool.query(`CREATE SCHEMA ${schema}`);
    await pool.query(`CREATE TABLE ${schema}.subscribers (
      id varchar PRIMARY KEY,
      email text NOT NULL,
      tags text[] NOT NULL,
      refs text[] NOT NULL DEFAULT ARRAY[]::text[],
      ip_address text,
      import_date timestamp NOT NULL DEFAULT now(),
      suppressed_until timestamp,
      last_engaged_at timestamp,
      last_sent_at timestamp
    )`);
    await pool.query(
      `INSERT INTO ${schema}.subscribers (id,email,tags,refs) VALUES
       ('source','source@test',ARRAY[]::text[],ARRAY['Source','Affinity-A']),
       ('upper','upper@test',ARRAY[]::text[],ARRAY['Affinity-A','DEL']),
       ('lower','lower@test',ARRAY[]::text[],ARRAY['affinity-a']),
       ('none','none@test',ARRAY[]::text[],ARRAY['Other'])`,
    );
  });

  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool.end();
  });

  it("deduplicates any-ref matches, respects case, permits DEL companions, and excludes source holders", async () => {
    const rules: SegmentRulesV2 = {
      version: 2,
      root: { type: "group", combinator: "AND", children: [rule] },
    };
    const compiled = new PgDialect().sqlToQuery(compileSegmentRules(rules));
    const client = await pool.connect();
    try {
      await client.query(`SET search_path TO ${schema}`);
      const result = await client.query(
        `SELECT id FROM subscribers WHERE ${compiled.sql} ORDER BY id`,
        compiled.params,
      );
      expect(result.rows.map((row) => row.id)).toEqual(["lower", "upper"]);
    } finally {
      client.release();
    }
  });

  it("uses the immutable frozen resolution after the live rule changes", async () => {
    const changed = { ...rule, resolvedRefs: ["Other"], candidates: [
      { ref: "Other", commonCount: 40, additionalCount: 10, sourceFrequency: 0.4, referenceFrequency: 0.1, lift: 4, score: 0.5545 },
    ] };
    const rules: SegmentRulesV2 = {
      version: 2,
      root: { type: "group", combinator: "AND", children: [changed] },
    };
    const compiled = new PgDialect().sqlToQuery(compileSegmentRules(rules, [rule]));
    const client = await pool.connect();
    try {
      await client.query(`SET search_path TO ${schema}`);
      const result = await client.query(
        `SELECT id FROM subscribers WHERE ${compiled.sql} ORDER BY id`,
        compiled.params,
      );
      expect(result.rows.map((row) => row.id)).toEqual(["lower", "upper"]);
    } finally {
      client.release();
    }
  });

  it("backfills launched campaigns but leaves unlaunched drafts rebuildable", async () => {
    const migrationSchema = `${schema}_migration`;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`CREATE SCHEMA ${migrationSchema}`);
      await client.query(`SET LOCAL search_path TO ${migrationSchema}`);
      await client.query(`CREATE TABLE campaigns (
        id varchar PRIMARY KEY,
        status text NOT NULL,
        started_at timestamp
      )`);
      await client.query(`INSERT INTO campaigns (id, status, started_at) VALUES
        ('paused', 'paused', now()),
        ('scheduled', 'scheduled', null),
        ('draft', 'draft', null)`);
      await client.query(readFileSync("migrations/0003_segment_ref_similarity.sql", "utf8"));
      const rows = await client.query(
        `SELECT id, similarity_snapshot FROM campaigns ORDER BY id`,
      );
      expect(rows.rows).toEqual([
        { id: "draft", similarity_snapshot: null },
        { id: "paused", similarity_snapshot: {} },
        { id: "scheduled", similarity_snapshot: {} },
      ]);
      const defaultValue = await client.query<{ column_default: string }>(
        `SELECT column_default
           FROM information_schema.columns
          WHERE table_schema = $1
            AND table_name = 'campaigns'
            AND column_name = 'similarity_snapshot'`,
        [migrationSchema],
      );
      expect(defaultValue.rows[0]?.column_default).toContain("'{}'::jsonb");
      await client.query("ROLLBACK");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  });
});