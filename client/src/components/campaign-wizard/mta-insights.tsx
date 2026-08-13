import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CalendarClock } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

// Shape of GET /api/mtas/schedule-insights — per-MTA scheduling context shown
// in the campaign wizard's Basic Info step.
export type MtaCampaignRef = {
  id: string;
  name: string;
  scheduledAt: string | null;
  openRate?: number;
};
export type MtaInsight = {
  scheduled: MtaCampaignRef[];
  lowOpen: MtaCampaignRef[];
};
export type MtaScheduleInsights = Record<string, MtaInsight>;

export function useMtaScheduleInsights() {
  return useQuery<MtaScheduleInsights>({
    queryKey: ["/api/mtas/schedule-insights"],
    // Always fresh: the operator must see the current scheduled list the
    // moment a server is selected, without reloading the page. The endpoint
    // is a single cheap indexed-ish query on the small campaigns table.
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
  });
}

export function formatParisDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleString("fr-FR", {
    timeZone: "Europe/Paris",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Amber warning icon + hover tooltip listing campaigns from the last 24h on
 *  this MTA with a unique open rate below 10%. Renders nothing when clean. */
export function MtaLowOpenWarning({ campaigns, mtaId }: { campaigns: MtaCampaignRef[]; mtaId: string }) {
  if (!campaigns.length) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="inline-flex shrink-0 cursor-help"
          onClick={(e) => e.stopPropagation()}
          data-testid={`mta-low-open-warning-${mtaId}`}
        >
          <AlertTriangle className="h-5 w-5 text-amber-500" />
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-sm">
        <p className="font-medium mb-1">Low open rates on this server (last 24h, &lt;10%)</p>
        <ul className="space-y-0.5 text-xs">
          {campaigns.map((c) => (
            <li key={c.id} className="flex justify-between gap-3">
              <span className="truncate">{c.name}</span>
              <span className="font-mono shrink-0">
                {formatParisDateTime(c.scheduledAt)}
                {typeof c.openRate === "number" ? ` · ${c.openRate.toFixed(1)}%` : ""}
              </span>
            </li>
          ))}
        </ul>
      </TooltipContent>
    </Tooltip>
  );
}

/** Compact list of the other campaigns already scheduled on this MTA (name +
 *  scheduled time, Paris timezone). Renders nothing when there are none. */
export function MtaScheduledCampaigns({
  campaigns,
  excludeCampaignId,
  mtaId,
}: {
  campaigns: MtaCampaignRef[];
  excludeCampaignId?: string | null;
  mtaId: string;
}) {
  const list = campaigns.filter((c) => c.id !== excludeCampaignId);
  if (!list.length) return null;
  return (
    <div
      className="mt-3 pt-3 border-t border-border/60 text-xs text-muted-foreground space-y-1"
      data-testid={`mta-scheduled-list-${mtaId}`}
    >
      <p className="font-medium flex items-center gap-1">
        <CalendarClock className="h-3.5 w-3.5" />
        Already scheduled on this server:
      </p>
      <ul className="space-y-0.5">
        {list.map((c) => (
          <li key={c.id} className="flex justify-between gap-3">
            <span className="truncate">{c.name}</span>
            <span className="font-mono shrink-0">{formatParisDateTime(c.scheduledAt)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
