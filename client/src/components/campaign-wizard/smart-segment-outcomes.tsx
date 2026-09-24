import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronUp } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { apiRequest } from "@/lib/queryClient";
import { complaintRateColor, formatSmartSegmentPercent, parseSmartSegmentApiError } from "@/lib/smart-segment-ui";
import {
  SMART_SEGMENT_PROPOSAL_KIND_LABELS,
  type SmartSegmentOutcome,
  type SmartSegmentOutcomeCampaign,
  type SmartSegmentOutcomesResponse,
} from "@shared/smart-segment";

type Props = {
  /** Debounced campaign name (the brand is resolved from it server-side). */
  campaignName: string;
  brandOverride: { name: string; ref: string } | null;
  enabled: boolean;
};

const integer = new Intl.NumberFormat("fr-FR");
const date = (value: string | null) => (value ? new Intl.DateTimeFormat("fr-FR").format(new Date(value)) : "—");
const rate = (numerator: number, denominator: number) => (denominator > 0 ? numerator / denominator : null);
const percentOrDash = (value: number | null, digits = 2) => (value === null ? "—" : `${formatSmartSegmentPercent(value, digits)} %`);

/** Actual figures of one campaign, formatted as the operator reads them in the campaign list. */
export function describeOutcomeCampaign(campaign: SmartSegmentOutcomeCampaign): {
  complaintRate: number | null;
  unsubscribeRate: number | null;
  clickRate: number | null;
  orangeWanadooShare: number | null;
  orangeWanadooComplaintRate: number | null;
} {
  return {
    complaintRate: rate(campaign.complaintsCount, campaign.sentCount),
    unsubscribeRate: rate(campaign.unsubscribesCount, campaign.sentCount),
    clickRate: rate(campaign.uniqueClicks, campaign.sentCount),
    orangeWanadooShare: rate(campaign.orangeWanadooSentCount, campaign.sentCount),
    orangeWanadooComplaintRate: rate(campaign.orangeWanadooComplaintsCount, campaign.orangeWanadooSentCount),
  };
}

/**
 * « Projeté vs réel » — what the brand's recent analyses projected next to
 * the cached counters of the campaigns that used their segments. Unique
 * clicks include robots (campaign counter), projected clicks are human: the
 * columns say so rather than pretending to be comparable.
 */
export function SmartSegmentOutcomesPanel({ campaignName, brandOverride, enabled }: Props) {
  const [open, setOpen] = useState(false);
  const query = useQuery({
    queryKey: ["/api/smart-segments/outcomes", campaignName, brandOverride],
    enabled: enabled && campaignName.length > 0,
    staleTime: 60_000,
    queryFn: async () => {
      const params = new URLSearchParams({ campaignName });
      if (brandOverride) params.set("brandOverride", JSON.stringify(brandOverride));
      const response = await apiRequest("GET", `/api/smart-segments/outcomes?${params.toString()}`);
      return response.json() as Promise<SmartSegmentOutcomesResponse>;
    },
  });
  const outcomes = query.data?.outcomes ?? [];
  if (!enabled || !campaignName || (!query.isError && outcomes.length === 0)) return null;
  const withCampaigns = outcomes.filter((outcome) => outcome.campaigns.length > 0).length;
  return (
    <div className="rounded-lg border bg-background" data-testid="smart-segment-outcomes">
      <Button type="button" variant="ghost" className="w-full justify-between" onClick={() => setOpen((value) => !value)} data-testid="button-smart-segment-outcomes-toggle">
        <span>Projeté vs réel — {query.data?.brandName ?? campaignName} ({integer.format(withCampaigns)} segment{withCampaigns > 1 ? "s" : ""} envoyé{withCampaigns > 1 ? "s" : ""} sur {integer.format(outcomes.length)} créé{outcomes.length > 1 ? "s" : ""})</span>
        {open ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
      </Button>
      {open && <div className="space-y-4 overflow-x-auto p-4 text-sm">
        {query.isError && <p className="text-destructive">{parseSmartSegmentApiError(query.error).message}</p>}
        {outcomes.map((outcome) => <OutcomeBlock key={`${outcome.analysisId}-${outcome.index}`} outcome={outcome} />)}
        <p className="text-xs text-muted-foreground">Clics réels = clics uniques de la campagne, robots inclus (compteur de la liste des campagnes) ; les clics projetés sont humains. Une campagne à plusieurs segments affiche les chiffres de la campagne entière.</p>
      </div>}
    </div>
  );
}

function OutcomeBlock({ outcome }: { outcome: SmartSegmentOutcome }) {
  const kindLabel = outcome.kind ? SMART_SEGMENT_PROPOSAL_KIND_LABELS[outcome.kind] : null;
  return (
    <div className="space-y-2" data-testid={`smart-segment-outcome-${outcome.analysisId}-${outcome.index}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{outcome.segmentName}</span>
        {kindLabel && <Badge variant="secondary">{kindLabel}</Badge>}
        <span className="text-xs text-muted-foreground">analyse du {date(outcome.analysedAt)}{outcome.mtaName ? ` · MTA ${outcome.mtaName}` : ""}</span>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead></TableHead>
            <TableHead>Effectif / envoyés</TableHead>
            <TableHead>Clics</TableHead>
            <TableHead>Plaintes</TableHead>
            <TableHead>Désabonnements</TableHead>
            <TableHead>Orange/Wanadoo</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell className="font-medium">Projeté</TableCell>
            <TableCell>{integer.format(outcome.projected.audienceCount)}</TableCell>
            <TableCell>{integer.format(outcome.projected.clicks.low)} – {integer.format(outcome.projected.clicks.high)} humains</TableCell>
            <TableCell className={complaintRateColor(outcome.projected.complaintRate)}>{formatSmartSegmentPercent(outcome.projected.complaintRate, 3)} % ({integer.format(outcome.projected.complaints)})</TableCell>
            <TableCell>{percentOrDash(outcome.projected.unsubscribeRate)}</TableCell>
            <TableCell>{outcome.projected.orangeWanadooShare === null ? "—" : `${formatSmartSegmentPercent(outcome.projected.orangeWanadooShare, 0)} % de l'audience`}{outcome.projected.orangeWanadooComplaintRate !== null && <>, plaintes {formatSmartSegmentPercent(outcome.projected.orangeWanadooComplaintRate, 3)} %</>}</TableCell>
          </TableRow>
          {outcome.campaigns.length === 0 && <TableRow><TableCell className="text-muted-foreground" colSpan={6}>Aucune campagne envoyée avec ce segment.</TableCell></TableRow>}
          {outcome.campaigns.map((campaign) => {
            const actual = describeOutcomeCampaign(campaign);
            return <TableRow key={campaign.campaignId} data-testid={`smart-segment-outcome-campaign-${campaign.campaignId}`}>
              <TableCell>
                <span className="font-medium">Réel</span> — {campaign.name}
                <br />
                <span className="text-xs text-muted-foreground">{date(campaign.firstSendAt)}{campaign.mtaName ? ` · ${campaign.mtaName}` : ""}{campaign.finished ? "" : ` · ${campaign.status} (en cours)`}{campaign.segmentCount > 1 ? ` · ${campaign.segmentCount} segments` : ""}</span>
              </TableCell>
              <TableCell>{integer.format(campaign.sentCount)}</TableCell>
              <TableCell>{integer.format(campaign.uniqueClicks)} uniques{actual.clickRate !== null && <> ({formatSmartSegmentPercent(actual.clickRate)} %)</>}</TableCell>
              <TableCell className={actual.complaintRate === null ? "" : complaintRateColor(actual.complaintRate)}>{percentOrDash(actual.complaintRate, 3)} ({integer.format(campaign.complaintsCount)})</TableCell>
              <TableCell>{percentOrDash(actual.unsubscribeRate)} ({integer.format(campaign.unsubscribesCount)})</TableCell>
              <TableCell>{actual.orangeWanadooShare === null ? "—" : `${formatSmartSegmentPercent(actual.orangeWanadooShare, 0)} % des envois`}{actual.orangeWanadooComplaintRate !== null && <>, plaintes <span className={complaintRateColor(actual.orangeWanadooComplaintRate)}>{formatSmartSegmentPercent(actual.orangeWanadooComplaintRate, 3)} %</span></>}</TableCell>
            </TableRow>;
          })}
        </TableBody>
      </Table>
    </div>
  );
}
