import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ShieldCheck, ShieldAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { apiRequest } from "@/lib/queryClient";

export type OrangeWanadooPreflight = {
  mode: string;
  thresholds?: {
    targetRate?: number | null;
    hardThreshold?: number | null;
  } | null;
  targetRate?: number | null;
  targetComplaintRate?: number | null;
  targetLimit?: number | null;
  hardLimit?: number | null;
  hardLimitRate?: number | null;
  hardLimitComplaintRate?: number | null;
  countsByTier?: Record<string, number> | null;
  tierCounts?: Record<string, number> | null;
  projectedRate?: number | null;
  projectedComplaintRate?: number | null;
  projectedComplaintRatePercent?: number | null;
  upperRate?: number | null;
  upperComplaintRate?: number | null;
  upperComplaintRatePercent?: number | null;
  allowedProbation?: number | null;
  allowedProbationCount?: number | null;
  total?: number | null;
  projectedRecipients?: number | null;
  wouldBlockCount?: number | null;
  warnings?: string[] | null;
};

const percent = (value: number | null | undefined) =>
  value === null || value === undefined ? "—" : `${(value <= 1 ? value * 100 : value).toFixed(2)}%`;

function riskTone(rate: number | null | undefined) {
  if (rate === null || rate === undefined) return "secondary" as const;
  if (rate > 0.006) return "destructive" as const;
  if (rate >= 0.004) return "outline" as const;
  return "secondary" as const;
}

/**
 * Read-only server preflight panel. It intentionally never derives risk from
 * local recipient data: the preflight endpoint remains the source of truth.
 */
export function OrangeWanadooRiskSummary({
  campaignId,
  preflight,
}: {
  campaignId?: string | null;
  preflight?: OrangeWanadooPreflight | null;
}) {
  const { data, isLoading, isError } = useQuery<OrangeWanadooPreflight>({
    queryKey: ["/api/campaigns", campaignId, "orange-wanadoo-preflight"],
    queryFn: async () => {
      const response = await apiRequest("GET", `/api/campaigns/${campaignId}/orange-wanadoo-preflight`);
      return response.json();
    },
    enabled: Boolean(campaignId) && !preflight,
    staleTime: 30_000,
  });
  const report = preflight ?? data;

  if (!campaignId && !preflight) return null;
  if (isLoading && !report) {
    return (
      <Card data-testid="card-orange-wanadoo-risk-loading">
        <CardContent className="space-y-3 p-5">
          <Skeleton className="h-4 w-44" />
          <Skeleton className="h-12 w-full" />
        </CardContent>
      </Card>
    );
  }
  // No panel is better than an invented "safe" result when this optional
  // capability is unavailable to a deployment or an older campaign.
  if (!report || isError) return null;

  const target = report.thresholds?.targetRate ?? report.targetRate ?? report.targetComplaintRate ?? report.targetLimit;
  const hardLimit = report.thresholds?.hardThreshold ?? report.hardLimit ?? report.hardLimitRate ?? report.hardLimitComplaintRate;
  const projected = report.projectedRate ?? report.projectedComplaintRate ?? report.projectedComplaintRatePercent;
  const upper = report.upperRate ?? report.upperComplaintRate ?? report.upperComplaintRatePercent;
  const probation = report.allowedProbation ?? report.allowedProbationCount;
  const tiers = Object.entries(report.countsByTier ?? report.tierCounts ?? {}).filter(([, count]) => typeof count === "number");
  const normalizedHardLimit = hardLimit !== null && hardLimit !== undefined && hardLimit > 1 ? hardLimit / 100 : hardLimit;
  const normalizedRisk = (upper ?? projected ?? 0) > 1 ? (upper ?? projected ?? 0) / 100 : (upper ?? projected ?? 0);
  const isBlocked = report.mode.toLowerCase().includes("block") || (normalizedHardLimit !== null && normalizedHardLimit !== undefined && normalizedRisk > normalizedHardLimit);

  return (
    <Card
      className={isBlocked ? "border-destructive/50" : "border-amber-500/35"}
      data-testid="card-orange-wanadoo-risk-summary"
    >
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            {isBlocked ? <ShieldAlert className="h-5 w-5 text-destructive" /> : <ShieldCheck className="h-5 w-5 text-amber-600" />}
            <CardTitle className="text-base">Orange / Wanadoo complaint guard</CardTitle>
          </div>
          <Badge variant={isBlocked ? "destructive" : "outline"} className="capitalize">
            {report.mode.replace(/[_-]/g, " ")}
          </Badge>
        </div>
        <CardDescription>Server preflight for the current campaign audience. Rates are not estimated in the browser.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-5">
          <Metric label="Target" value={percent(target)} />
          <Metric label="Hard limit" value={percent(hardLimit)} />
          <Metric label="Projected" value={percent(projected)} tone={riskTone(projected)} />
          <Metric label="Upper bound" value={percent(upper)} tone={riskTone(upper)} />
          <Metric label="Probation allowed" value={probation === null || probation === undefined ? "—" : probation.toLocaleString()} />
        </dl>
        {(report.total !== null && report.total !== undefined) && (
          <p className="text-xs text-muted-foreground">
            {report.projectedRecipients?.toLocaleString() ?? "—"} of {report.total.toLocaleString()} Orange / Wanadoo recipients
            would be selected by the active policy
            {report.wouldBlockCount !== null && report.wouldBlockCount !== undefined
              ? `; ${report.wouldBlockCount.toLocaleString()} would be held back`
              : ""}.
          </p>
        )}
        {tiers.length > 0 && (
          <div className="border-t pt-3">
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Audience by risk tier</p>
            <div className="flex flex-wrap gap-2">
              {tiers.map(([tier, count]) => <Badge key={tier} variant="secondary">{tier.replace(/[_-]/g, " ")}: {count.toLocaleString()}</Badge>)}
            </div>
          </div>
        )}
        {report.warnings && report.warnings.length > 0 && (
          <div className="space-y-2 border-t pt-3" role="status">
            {report.warnings.map((warning, index) => (
              <p key={`${warning}-${index}`} className="flex items-start gap-2 text-sm text-amber-800 dark:text-amber-300">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                {warning === "PROJECTED_UPPER_RATE_ABOVE_TARGET"
                  ? "The conservative complaint estimate is above the 0.45% operating target."
                  : warning === "PROJECTED_RATE_ABOVE_HARD_THRESHOLD"
                    ? "The projected complaint rate is above the 0.60% hard threshold."
                    : warning === "CAMPAIGN_TARGET_REACHED"
                      ? "This campaign has reached the 0.45% operating target, so probation recipients are held back."
                    : warning}
              </p>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: "secondary" | "outline" | "destructive" }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 flex items-center gap-1 font-mono text-sm font-semibold tabular-nums">
        {tone ? <Badge variant={tone} className="px-1.5 py-0 font-mono text-xs">{value}</Badge> : value}
      </dd>
    </div>
  );
}