import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export interface CampaignProgressProps {
  sentCount: number;
  failedCount: number;
  pendingCount: number;
  /**
   * Live count of sends currently parked in the Marketing Pressure Guard
   * drain queue (i.e. `campaign_sends.status = 'pending'` AND
   * `eligible_at IS NOT NULL`).
   *
   * IMPORTANT: this MUST be the live snapshot count (e.g. the
   * `pressureHeldCount` field added to the campaigns list endpoint), NOT
   * `campaigns.deferred_count` — that column is a lifetime cumulative
   * counter and stays inflated forever after a campaign completes.
   */
  heldCount: number;
  status?: string;
  size?: "sm" | "lg";
  className?: string;
  testId?: string;
}

interface ProgressBreakdown {
  sent: number;
  failed: number;
  pending: number;
  held: number;
  finalized: number;
  total: number;
  percent: number;
  sentPct: number;
  failedPct: number;
  heldPct: number;
  pendingPct: number;
}

function computeBreakdown({
  sentCount,
  failedCount,
  pendingCount,
  heldCount,
  status,
}: CampaignProgressProps): ProgressBreakdown {
  const sent = Math.max(0, sentCount || 0);
  const held = Math.max(0, heldCount || 0);

  // Counter-drift defense (observed in prod on long-running sends: e.g.
  // campaign f19f77d2 ended up with failedCount=-897 and pendingCount=235797
  // while only 40 rows were truly in flight — bar showed 50% instead of
  // the real ~99.8%). Two impossible-state signals flag the drift:
  //   (a) failedCount < 0   — arithmetic underflow in a counter-update path
  //   (b) pendingCount < heldCount — see "held ⊂ pending" note below.
  // When either fires, the cached pending/failed counters on `campaigns`
  // are not trustworthy. Fall back to the live signals we DO have
  // (`sentCount` is close to reality, `heldCount` is a live subquery): set
  // the drifted counters to 0 so the bar reflects "sent + still in
  // pressure-guard queue" — the true remaining work for a campaign whose
  // claim phase has finished.
  const counterDrift =
    (failedCount || 0) < 0 || (pendingCount || 0) < held;
  const failed = counterDrift ? 0 : Math.max(0, failedCount || 0);
  const pendingRaw = counterDrift ? 0 : Math.max(0, pendingCount || 0);

  // `held` is a strict subset of `pending` in DB semantics: held rows ARE
  // pending rows with `eligible_at IS NOT NULL` (see pressure-guard.ts
  // around L516-522: deferred rows already live inside `pending_count`,
  // it is intentionally NOT re-incremented for the held slice). Therefore
  // we must NOT add `held + pending` into the same denominator — that
  // double-counts the deferred work. Split pending into its disjoint
  // pieces:
  //   pendingActive = pending - held  (still to be claimed / freshly inserted)
  //   held                            (parked in pressure-guard drain queue)
  const pendingActive = Math.max(0, pendingRaw - held);
  const finalized = sent + failed;
  const total = finalized + held + pendingActive;

  if (total === 0) {
    // Zero-work edge cases:
    //   - status='completed' with zero recipients → 100% (the campaign
    //     legitimately finished — "all 0 of 0 done" is a successful
    //     terminal state per product spec).
    //   - any other status → 0% neutral empty state (bar empty, no dash).
    const isCompleted = status === "completed";
    return {
      sent, failed, pending: pendingActive, held, finalized,
      total: 0,
      percent: isCompleted ? 100 : 0,
      sentPct: isCompleted ? 100 : 0,
      failedPct: 0,
      heldPct: 0,
      pendingPct: 0,
    };
  }

  const sentPct = (sent / total) * 100;
  const failedPct = (failed / total) * 100;
  const heldPct = (held / total) * 100;
  const pendingPct = (pendingActive / total) * 100;
  let percent = Math.round((finalized / total) * 100);
  if (status === "completed") percent = 100;
  if (status !== "completed" && percent === 100 && finalized < total) percent = 99;

  return {
    sent, failed, pending: pendingActive, held, finalized, total,
    percent,
    sentPct, failedPct, heldPct, pendingPct,
  };
}

/**
 * Exposed helper so other surfaces (e.g. the detail-page "Send Progress"
 * header) can render label text using the SAME disjoint-set math the
 * bar uses. Reusing one source of truth avoids the held⊂pending
 * double-counting bug that would otherwise reappear in any sibling
 * formula written by hand.
 */
export function computeProgressBreakdown(
  props: CampaignProgressProps,
): ProgressBreakdown {
  return computeBreakdown(props);
}

export function CampaignProgress(props: CampaignProgressProps) {
  const b = computeBreakdown(props);
  const isEmpty = b.total === 0;
  const isLg = props.size === "lg";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className={cn("flex flex-col gap-1 min-w-[100px]", props.className)}
          data-testid={props.testId ?? "campaign-progress"}
        >
          <div className="flex items-center justify-between gap-2">
            <span
              className={cn(
                "font-medium tabular-nums text-foreground",
                isLg ? "text-2xl" : "text-xs",
              )}
              data-testid={`${props.testId ?? "campaign-progress"}-percent`}
            >
              {`${b.percent}%`}
            </span>
            {b.held > 0 && (
              <span
                className={cn(
                  "font-medium text-amber-600 dark:text-amber-400 tabular-nums",
                  isLg ? "text-sm" : "text-[10px]",
                )}
                data-testid={`${props.testId ?? "campaign-progress"}-held`}
                title="Currently held by Marketing Pressure Guard"
              >
                {b.held.toLocaleString()} held
              </span>
            )}
          </div>
          <div
            className={cn(
              "relative w-full overflow-hidden rounded-full bg-muted",
              isLg ? "h-4" : "h-2",
            )}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={b.percent}
            aria-label={`Campaign progress: ${b.percent}%`}
          >
            {!isEmpty && (
              <div className="absolute inset-0 flex">
                {/* Three-segment bar per spec:
                    1. Completed (green) = sent + failed — both are
                       terminal/finalized outcomes from the user's
                       perspective; the per-status breakdown lives in
                       the tooltip below.
                    2. Held (amber)      = deferred by pressure guard.
                    3. Pending (gray)    = waiting in claim queue. */}
                {b.sentPct + b.failedPct > 0 && (
                  <div
                    className="h-full bg-emerald-500 dark:bg-emerald-400 transition-all"
                    style={{ width: `${b.sentPct + b.failedPct}%` }}
                    data-testid={`${props.testId ?? "campaign-progress"}-segment-completed`}
                  />
                )}
                {b.heldPct > 0 && (
                  <div
                    className="h-full bg-amber-500 dark:bg-amber-400 transition-all"
                    style={{ width: `${b.heldPct}%` }}
                    data-testid={`${props.testId ?? "campaign-progress"}-segment-held`}
                  />
                )}
                {b.pendingPct > 0 && (
                  <div
                    className="h-full bg-muted-foreground/30 transition-all"
                    style={{ width: `${b.pendingPct}%` }}
                    data-testid={`${props.testId ?? "campaign-progress"}-segment-pending`}
                  />
                )}
              </div>
            )}
          </div>
        </div>
      </TooltipTrigger>
      <TooltipContent className="text-xs">
        {isEmpty ? (
          <div>No sends queued yet</div>
        ) : (
          <div className="space-y-1 min-w-[200px]">
            <div className="flex items-center justify-between gap-4">
              <span className="flex items-center gap-1.5">
                <span className="inline-block h-2 w-2 rounded-sm bg-emerald-500" />
                Sent
              </span>
              <span className="font-mono tabular-nums">{b.sent.toLocaleString()}</span>
            </div>
            {b.failed > 0 && (
              <div className="flex items-center justify-between gap-4">
                <span className="flex items-center gap-1.5">
                  <span className="inline-block h-2 w-2 rounded-sm bg-destructive" />
                  Failed
                </span>
                <span className="font-mono tabular-nums">{b.failed.toLocaleString()}</span>
              </div>
            )}
            {b.held > 0 && (
              <div className="flex items-center justify-between gap-4">
                <span className="flex items-center gap-1.5">
                  <span className="inline-block h-2 w-2 rounded-sm bg-amber-500" />
                  Held (pressure)
                </span>
                <span className="font-mono tabular-nums">{b.held.toLocaleString()}</span>
              </div>
            )}
            <div className="flex items-center justify-between gap-4">
              <span className="flex items-center gap-1.5">
                <span className="inline-block h-2 w-2 rounded-sm bg-muted-foreground/40" />
                Pending
              </span>
              <span className="font-mono tabular-nums">{b.pending.toLocaleString()}</span>
            </div>
            <div className="flex items-center justify-between gap-4 pt-1 border-t border-border">
              <span className="font-medium">Total</span>
              <span className="font-mono tabular-nums font-medium">{b.total.toLocaleString()}</span>
            </div>
          </div>
        )}
      </TooltipContent>
    </Tooltip>
  );
}
