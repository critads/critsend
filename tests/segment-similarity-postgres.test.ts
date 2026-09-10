import pg from "pg";
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
    sourceTag: "Source",
    analysisId: "8ee55e4b-26f9-43b4-986e-a8e8ab6d9b8c",
    resolvedTags: ["Affinity-A", "affinity-a"],
    analyzedAt: "2026-09-10T10:00:00.000Z",
    candidates: [
      { tag: "Affinity-A", commonCount: 30, sourceFrequency: 0.3, referenceFrequency: 0.1, lift: 3 },
      { tag: "affinity-a", commonCount: 25, sourceFrequency: 0.25, referenceFrequency: 0.1, lift: 2.5 },
    ],
    calibration: "provisional-v1",
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
      `INSERT INTO ${schema}.subscribers (id,email,tags) VALUES
       ('source','source@test',ARRAY['Source','Affinity-A']),
       ('upper','upper@test',ARRAY['Affinity-A']),
       ('lower','lower@test',ARRAY['affinity-a']),
       ('none','none@test',ARRAY['Other'])`,
    );
  });

  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool.end();
  });

  it("deduplicates any-tag matches, respects case, and cannot include source holders", async () => {
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
    const changed = { ...rule, resolvedTags: ["Other"], candidates: [
      { tag: "Other", commonCount: 40, sourceFrequency: 0.4, referenceFrequency: 0.1, lift: 4 },
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
});