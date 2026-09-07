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
const calendarPageSource = readFileSync(
  new URL("../client/src/pages/campaign-calendar.tsx", import.meta.url),
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

  it("queries only scheduled_at inside the requested day", () => {
    const start = repositorySource.indexOf("export async function getCampaignCalendar");
    const end = repositorySource.indexOf("\nexport async function", start + 1);
    const implementation = repositorySource.slice(
      start,
      end >= 0 ? end : repositorySource.length,
    );
    expect(implementation).toContain("gte(campaigns.scheduledAt, from)");
    expect(implementation).toContain("lt(campaigns.scheduledAt, to)");
    expect(implementation).toContain('ne(campaigns.status, "draft")');
    expect(implementation).toContain('ne(campaigns.status, "automation_internal")');
    expect(implementation).not.toContain("firstSendAt");
    expect(implementation).not.toContain("lastSendAt");
    expect(implementation).not.toContain("startedAt");
    expect(implementation).not.toContain("completedAt");
    expect(implementation).not.toContain("campaignSends");
    expect(implementation).not.toContain("campaign_sends");
  });

  it("renders one daily timeline with MTA and unidentified columns", () => {
    expect(calendarPageSource).not.toContain('type ViewMode = "week" | "day"');
    expect(calendarPageSource).not.toContain('"Semaine"');
    expect(calendarPageSource).toContain("setAnchor((day) => addDays(day, n))");
    expect(calendarPageSource).toContain("Sans MTA identifiable");
    expect(calendarPageSource).not.toContain("hasUnidentified");
    expect(calendarPageSource).toContain("Aucune campagne programmée pour cette journée.");
    expect(calendarPageSource).toContain('aria-label="Jour précédent"');
    expect(calendarPageSource).toContain('aria-label="Jour suivant"');
  });
});