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

  it("protects calendar rescheduling against auth, status, past-time and start races", () => {
    const route = routesSource.slice(
      routesSource.indexOf('app.patch("/api/campaigns/:id/schedule"'),
      routesSource.indexOf('app.get("/api/campaigns/:id"'),
    );
    expect(route).toContain("Authentication required");
    expect(route).toContain("scheduledAt.getTime() <= Date.now()");
    expect(route).toContain('row.status !== "scheduled"');
    expect(route).toContain("AND status = 'scheduled'");
    expect(route).toContain("AND scheduled_at = ${expectedScheduledAt}");
    expect(route).toContain("publishCampaignsListInvalidation()");
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
    expect(implementation).toContain(".innerJoin(segments");
    expect(implementation).toContain("campaignSegments.position");
    expect(implementation).toContain("legacySegmentId");
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

  it("drags only scheduled cards and exposes each campaign audience", () => {
    expect(calendarPageSource).toContain(
      'const canDrag = campaign.status === "scheduled" && !rescheduling',
    );
    expect(calendarPageSource).toContain("calendarDropInstant(day, snappedMinute)");
    expect(calendarPageSource).toContain("Math.round(rawMinute / 15) * 15");
    expect(calendarPageSource).toContain(
      'apiRequest("PATCH", `/api/campaigns/${campaignId}/schedule`',
    );
    expect(calendarPageSource).toContain("expectedScheduledAt: campaign.scheduledAt");
    expect(calendarPageSource).toContain("queryClient.setQueryData");
    expect(calendarPageSource).toContain("Segments programmés");
    expect(calendarPageSource).toContain("campaign.segments ?? []");
    expect(calendarPageSource).toContain(
      "event.stopPropagation()",
    );
  });
});