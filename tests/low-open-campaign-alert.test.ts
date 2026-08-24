import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { isLowOpenCampaignAlertVisible } from "../client/src/lib/low-open-campaign-alert";

const HAS_DB = !!process.env.DATABASE_URL;
const d = HAS_DB ? describe : describe.skip;

d("recent low-open campaign alerts", () => {
  let db: any;
  let getRecentLowOpenCampaignAlerts: () => Promise<Array<{
    id: string;
    mtaName: string;
    openRate: number;
  }>>;

  const suffix = Date.now();
  const mtaId = `low-open-mta-${suffix}`;
  const ids = {
    alert: `low-open-alert-${suffix}`,
    threshold: `low-open-threshold-${suffix}`,
    tooRecent: `low-open-recent-${suffix}`,
    tooOld: `low-open-old-${suffix}`,
    noSends: `low-open-no-sends-${suffix}`,
  };

  beforeAll(async () => {
    ({ db } = await import("../server/db"));
    ({ getRecentLowOpenCampaignAlerts } = await import("../server/repositories/campaign-repository"));

    await db.execute(sql`
      INSERT INTO mtas (id, name, hostname, port, mode, from_email, from_name)
      VALUES (${mtaId}, 'Low Open Test MTA', 'localhost', 25, 'nullsink', 'test@example.com', 'Test')
      ON CONFLICT (id) DO NOTHING
    `);

    const seed = async (
      id: string,
      startedAt: ReturnType<typeof sql>,
      sentCount: number,
      uniqueOpens: number,
    ) => {
      await db.execute(sql`
        INSERT INTO campaigns (
          id, name, mta_id, from_email, from_name, subject, html_content, status,
          started_at, first_send_at, sent_count, unique_opens_count
        ) VALUES (
          ${id}, ${id}, ${mtaId}, 'test@example.com', 'Test', 'Test subject', '<p>Test</p>', 'completed',
          NOW() - INTERVAL '1 hour', ${startedAt}, ${sentCount}, ${uniqueOpens}
        )
        ON CONFLICT (id) DO NOTHING
      `);
    };

    await seed(ids.alert, sql`NOW() - INTERVAL '13 hours'`, 100, 9);
    await seed(ids.threshold, sql`NOW() - INTERVAL '13 hours'`, 100, 10);
    await seed(ids.tooRecent, sql`NOW() - INTERVAL '11 hours'`, 100, 1);
    await seed(ids.tooOld, sql`NOW() - INTERVAL '49 hours'`, 100, 1);
    await seed(ids.noSends, sql`NOW() - INTERVAL '13 hours'`, 0, 0);
  });

  afterAll(async () => {
    if (!HAS_DB) return;
    await db.execute(sql`DELETE FROM campaigns WHERE id = ANY(${sql`ARRAY[${Object.values(ids).map((id) => sql`${id}`)}]`}::text[])`).catch(() => {});
    await db.execute(sql`DELETE FROM mtas WHERE id = ${mtaId}`).catch(() => {});
  });

  it("returns only campaigns in the 12–48h window with an open rate below 10%", async () => {
    const alerts = await getRecentLowOpenCampaignAlerts();

    const alert = alerts.find((campaign) => campaign.id === ids.alert);
    expect(alert).toMatchObject({
      id: ids.alert,
      mtaName: "Low Open Test MTA",
      openRate: 9,
    });
    expect(alerts.find((campaign) => campaign.id === ids.threshold)).toBeUndefined();
    expect(alerts.find((campaign) => campaign.id === ids.tooRecent)).toBeUndefined();
    expect(alerts.find((campaign) => campaign.id === ids.tooOld)).toBeUndefined();
    expect(alerts.find((campaign) => campaign.id === ids.noSends)).toBeUndefined();
  });
});

describe("low-open campaign alert visibility", () => {
  const alerts = [{
    id: "campaign-1",
    name: "Campaign one",
    mtaName: "MTA one",
    startedAt: "2026-08-24T00:00:00.000Z",
    sentCount: 100,
    uniqueOpens: 9,
    openRate: 9,
  }];

  it("shows matches until the operator closes the alert", () => {
    expect(isLowOpenCampaignAlertVisible(alerts, false)).toBe(true);
    expect(isLowOpenCampaignAlertVisible(alerts, true)).toBe(false);
    expect(isLowOpenCampaignAlertVisible([], false)).toBe(false);
  });
});