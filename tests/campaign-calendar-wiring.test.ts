import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const navigationSource = readFileSync(
  new URL("../client/src/components/crextio-layout.tsx", import.meta.url),
  "utf8",
);
const routesSource = readFileSync(
  new URL("../server/routes/campaigns.ts", import.meta.url),
  "utf8",
);
const repositorySource = readFileSync(
  new URL("../server/repositories/campaign-repository.ts", import.meta.url),
  "utf8",
);

describe("campaign calendar wiring", () => {
  it("places Calendar once in primary navigation and Automation in overflow", () => {
    const primary = navigationSource.slice(
      navigationSource.indexOf("const PRIMARY_NAV"),
      navigationSource.indexOf("const OVERFLOW_NAV"),
    );
    const overflow = navigationSource.slice(
      navigationSource.indexOf("const OVERFLOW_NAV"),
      navigationSource.indexOf("function isActive"),
    );
    expect(primary.match(/url: "\/calendar"/g)).toHaveLength(1);
    expect(primary).not.toContain('url: "/automation"');
    expect(overflow).toContain('url: "/automation"');
  });

  it("registers the literal calendar endpoint before the campaign id endpoint", () => {
    const calendarRoute = routesSource.indexOf('app.get("/api/campaigns/calendar"');
    const campaignIdRoute = routesSource.indexOf('app.get("/api/campaigns/:id"');
    expect(calendarRoute).toBeGreaterThanOrEqual(0);
    expect(calendarRoute).toBeLessThan(campaignIdRoute);
    expect(routesSource.slice(calendarRoute, campaignIdRoute)).toContain(
      "parseCampaignCalendarRange(req.query.from, req.query.to)",
    );
  });

  it("uses cached campaign timestamps without scanning individual sends", () => {
    const start = repositorySource.indexOf("export async function getCampaignCalendar");
    const end = repositorySource.indexOf("\nexport async function", start + 1);
    const implementation = repositorySource.slice(
      start,
      end >= 0 ? end : repositorySource.length,
    );
    expect(implementation).toContain("firstSendAt");
    expect(implementation).toContain("lastSendAt");
    expect(implementation).not.toContain("campaignSends");
    expect(implementation).not.toContain("campaign_sends");
  });

  it("defines indexes matching finished and live calendar interval expressions", () => {
    expect(repositorySource).toContain("campaigns_calendar_actual_end_idx");
    expect(repositorySource).toContain(
      "COALESCE(last_send_at, completed_at, first_send_at, started_at, scheduled_at)",
    );
    expect(repositorySource).toContain("campaigns_calendar_sending_start_idx");
    expect(repositorySource).toContain(
      "COALESCE(first_send_at, started_at, scheduled_at)",
    );
  });
});