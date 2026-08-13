import { db, pool } from "./server/db";
import { sql } from "drizzle-orm";
import { compileCountQuery, compilePreviewQuery } from "./server/services/segment-compiler";
import type { SegmentRulesV2 } from "./shared/schema";

const rules = (operator: string): SegmentRulesV2 => ({
  version: 2,
  root: { type: "group", combinator: "AND", children: [
    { type: "condition", field: "engagement", operator, value: null, value2: null } as any,
  ]},
});

async function main() {
  await db.execute(sql`BEGIN`);
  try {
    // Seed: 5 subscribers with unique test emails
    const subs: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r: any = await db.execute(sql`INSERT INTO subscribers (email) VALUES (${`clicker-e2e-${i}@test.local`}) RETURNING id`);
      subs.push(r.rows[0].id);
    }
    // 7 campaigns
    const camps: string[] = [];
    for (let i = 0; i < 7; i++) {
      const r: any = await db.execute(sql`INSERT INTO campaigns (name, from_name, from_email, subject, html_content, status) VALUES (${`clicker-e2e-c${i}`}, 'f', 'f@test.local', 's', 'c', 'draft') RETURNING id`);
      camps.push(r.rows[0].id);
    }
    const click = (sub: string, camp: string, daysAgo: number) =>
      db.execute(sql`INSERT INTO campaign_stats (campaign_id, subscriber_id, type, timestamp) VALUES (${camp}, ${sub}, 'click', NOW() - INTERVAL '1 day' * ${daysAgo})`);

    // sub0: 3 distinct campaigns -> neither
    for (let c = 0; c < 3; c++) await click(subs[0], camps[c], 5);
    // sub1: 4 distinct, with duplicate clicks in one campaign -> Top only
    for (let c = 0; c < 4; c++) await click(subs[1], camps[c], 10);
    await click(subs[1], camps[0], 11); // dup same campaign
    // sub2: 6 distinct -> Top + Ultra
    for (let c = 0; c < 6; c++) await click(subs[2], camps[c], 20);
    // sub3: 6 distinct but all >60 days ago -> neither
    for (let c = 0; c < 6; c++) await click(subs[3], camps[c], 70);
    // sub4: 6 distinct but suppressed -> excluded
    for (let c = 0; c < 6; c++) await click(subs[4], camps[c], 5);
    await db.execute(sql`UPDATE subscribers SET suppressed_until = NOW() + INTERVAL '7 days' WHERE id = ${subs[4]}`);

    const count = async (op: string) => {
      const r: any = await db.execute(compileCountQuery(rules(op)));
      return Number(r.rows[0].count);
    };
    // Restrict to our test emails by intersecting via preview list
    const preview = async (op: string) => {
      const r: any = await db.execute(compilePreviewQuery(rules(op), 100));
      return r.rows.filter((row: any) => String(row.email).includes("clicker-e2e")).map((row: any) => row.email).sort();
    };
    console.log("TOP matches:", await preview("top_active_clicker"));
    console.log("ULTRA matches:", await preview("ultra_active_clicker"));
    console.log("(global counts: top =", await count("top_active_clicker"), ", ultra =", await count("ultra_active_clicker"), ")");
  } finally {
    await db.execute(sql`ROLLBACK`);
    await pool.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
