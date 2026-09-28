// Orange launch check — surfaces each MTA's latest Orange Test verdict where
// the sending decision is made: the « Sending Server » list (step 1), the
// Schedule step (step 5) and an acknowledgement dialog before a launch on a
// server whose recent verdict is SPAM / BLOCKED / NOT RECEIVED.
//
// It is a warning, never a block: the operator can always launch. When the
// summary cannot be loaded nothing is shown and the launch proceeds normally.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { AlertTriangle, ExternalLink, Info, ShieldCheck } from "lucide-react";
import { queryClient } from "@/lib/queryClient";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import type { Mta } from "@shared/schema";
import {
  assessOrangeControlValue,
  ORANGE_TEST_DEFAULT_STALE_VERDICT_DAYS,
  type OrangeLaunchCheck,
} from "@shared/orange-test";
import {
  ORANGE_TEST_SUMMARY_QUERY_KEY,
  OrangeVerdictBadge,
  useOrangeTestConfig,
  useOrangeTestSummary,
  type OrangeTestSummaryResponse,
} from "@/components/mtas/orange-test";
import { describeOrangeLaunchCheck, formatOrangeAge, resolveOrangeLaunchCheck } from "@/lib/orange-launch-check";
import { fetchOrangeTestSummary, normalizeOrangeSummaryIds } from "@/lib/orange-test-summary";

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

/** How long a displayed verdict is trusted before the wizard re-reads it. */
export const ORANGE_LAUNCH_SUMMARY_STALE_MS = 30_000;
/** Background refresh while the wizard stays open (tests finish from other sessions). */
export const ORANGE_LAUNCH_SUMMARY_REFETCH_MS = 60_000;

/** Ticks once a minute so displayed ages stay honest while the wizard is open. */
function useMinuteNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

export interface OrangeLaunchChecks {
  /** One check per requested MTA id; null while loading or when the summary failed. */
  checks: Record<string, OrangeLaunchCheck> | null;
  isError: boolean;
  staleAfterDays: number;
  /** Re-reads every listed MTA in the background (used when the Schedule step opens). */
  refresh: () => void;
  /**
   * Re-reads the selected MTA right before the launch decision (bounded wait;
   * falls back to the displayed check, then to "no check"). Never throws.
   */
  assessBeforeLaunch: (mtaId: string) => Promise<OrangeLaunchCheck | null>;
  /** True while `assessBeforeLaunch` is waiting for the server. */
  launchCheckPending: boolean;
}

/**
 * Control values of the given MTAs, assessed for the launch. Unlike the /mtas
 * page (which invalidates on its own mutations) the wizard must notice tests
 * that finish elsewhere while it stays open, so the summary is re-read on
 * focus, every minute, when the Schedule step opens and right before launch.
 */
export function useOrangeLaunchChecks(mtaIds: string[]): OrangeLaunchChecks {
  const summary = useOrangeTestSummary(mtaIds, mtaIds.length > 0, {
    staleTime: ORANGE_LAUNCH_SUMMARY_STALE_MS,
    refetchOnWindowFocus: true,
    idleRefetchIntervalMs: ORANGE_LAUNCH_SUMMARY_REFETCH_MS,
  });
  const config = useOrangeTestConfig();
  const nowMs = useMinuteNow();
  const staleAfterDays = config.data?.staleVerdictDays ?? ORANGE_TEST_DEFAULT_STALE_VERDICT_DAYS;
  const checks = useMemo(() => {
    const values = summary.data?.values;
    if (!values) return null;
    const out: Record<string, OrangeLaunchCheck> = {};
    for (const id of mtaIds) out[id] = assessOrangeControlValue(values[id], { nowMs, staleAfterDays });
    return out;
  }, [summary.data, mtaIds, nowMs, staleAfterDays]);

  const { refetch } = summary;
  const refresh = useCallback(() => {
    if (mtaIds.length === 0) return;
    void refetch().catch(() => {
      /* background refresh: the query's own error state is displayed */
    });
  }, [refetch, mtaIds.length]);

  // Latest checks for the pre-launch fallback, without re-creating the callback.
  const checksRef = useRef(checks);
  checksRef.current = checks;
  const [launchCheckPending, setLaunchCheckPending] = useState(false);
  const summaryKey = normalizeOrangeSummaryIds(mtaIds).join(",");

  const assessBeforeLaunch = useCallback(
    async (mtaId: string): Promise<OrangeLaunchCheck | null> => {
      setLaunchCheckPending(true);
      try {
        const resolved = await resolveOrangeLaunchCheck({
          mtaId,
          cached: checksRef.current?.[mtaId] ?? null,
          staleAfterDays,
          fetchValue: async (id, signal) => {
            const values = await fetchOrangeTestSummary([id], { signal });
            // Keep the displayed chip / panel in step with what was just read.
            queryClient.setQueryData<OrangeTestSummaryResponse>([ORANGE_TEST_SUMMARY_QUERY_KEY, summaryKey], (old) =>
              old ? { values: { ...old.values, ...values } } : old,
            );
            return values[id];
          },
        });
        return resolved.check;
      } finally {
        setLaunchCheckPending(false);
      }
    },
    [staleAfterDays, summaryKey],
  );

  return { checks, isError: summary.isError, staleAfterDays, refresh, assessBeforeLaunch, launchCheckPending };
}

// ---------------------------------------------------------------------------
// Step 1 — one line under each server of the selector
// ---------------------------------------------------------------------------

export function OrangeLaunchCheckChip({ mtaId, check }: { mtaId: string; check: OrangeLaunchCheck | null | undefined }) {
  if (!check) return null;
  const view = describeOrangeLaunchCheck(check);
  const warn = view.tone === "warn";
  return (
    <div
      className={`mt-1 flex flex-wrap items-center gap-1.5 text-xs ${warn ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground"}`}
      data-testid={`orange-launch-check-${mtaId}`}
      data-state={check.warn ? "warn" : check.status}
    >
      {warn && <AlertTriangle className="h-3.5 w-3.5 shrink-0" />}
      <span>Orange:</span>
      {view.badgeVerdict ? (
        <>
          <OrangeVerdictBadge verdict={view.badgeVerdict} testId={`orange-launch-check-verdict-${mtaId}`} />
          <span>{view.age}</span>
        </>
      ) : (
        <span>
          no recent check
          {check.status === "stale" && check.verdict ? ` (last ${check.verdict.replace("_", " ")}, ${view.age})` : ""}
        </span>
      )}
      {check.pendingSince && <span>· new test in progress</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 5 — status of the selected server right above the launch button
// ---------------------------------------------------------------------------

function MtasPageLink() {
  return (
    <Link href="/mtas" className="inline-flex items-center gap-1 underline underline-offset-2" data-testid="link-orange-launch-check-mtas">
      Run an Orange Test from the MTAs page
      <ExternalLink className="h-3 w-3" />
    </Link>
  );
}

export function OrangeLaunchCheckPanel({
  mta,
  check,
  isError,
}: {
  mta: Pick<Mta, "id" | "name"> | null | undefined;
  check: OrangeLaunchCheck | null | undefined;
  isError: boolean;
}) {
  if (!mta) return null;
  if (!check) {
    if (!isError) return null;
    return (
      <p className="text-xs text-muted-foreground" data-testid="orange-launch-check-unavailable">
        The Orange check status of {mta.name} could not be loaded; the launch is not affected.
      </p>
    );
  }
  const view = describeOrangeLaunchCheck(check);

  if (view.tone === "warn" && view.badgeVerdict) {
    return (
      <Alert
        className="border-amber-500/60 bg-amber-50/70 text-amber-950 dark:bg-amber-950/25 dark:text-amber-100 [&>svg]:text-amber-600 dark:[&>svg]:text-amber-400"
        data-testid={`orange-launch-warning-${mta.id}`}
      >
        <AlertTriangle className="h-4 w-4" />
        <AlertTitle className="flex flex-wrap items-center gap-2">
          <span>Latest Orange check on {mta.name}:</span>
          <OrangeVerdictBadge verdict={view.badgeVerdict} testId={`orange-launch-warning-verdict-${mta.id}`} />
          <span className="font-normal text-xs opacity-80">{view.age}</span>
        </AlertTitle>
        <AlertDescription className="space-y-2">
          <p>{view.detail}</p>
          {view.notes.map((note) => (
            <p key={note} className="text-xs opacity-80">{note}</p>
          ))}
          <p className="text-xs">
            This is a warning, not a block: you can still launch this campaign. <MtasPageLink /> for a fresh verdict first.
          </p>
        </AlertDescription>
      </Alert>
    );
  }

  const Icon = view.tone === "ok" ? ShieldCheck : Info;
  return (
    <div
      className="flex flex-wrap items-start gap-2 rounded-md border border-border/70 p-3 text-sm text-muted-foreground"
      data-testid={`orange-launch-status-${mta.id}`}
      data-state={check.status}
    >
      <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${view.tone === "ok" ? "text-emerald-600" : ""}`} />
      <div className="space-y-1">
        <p className="flex flex-wrap items-center gap-2">
          {view.badgeVerdict ? (
            <>
              <span>Latest Orange check on {mta.name}:</span>
              <OrangeVerdictBadge verdict={view.badgeVerdict} testId={`orange-launch-status-verdict-${mta.id}`} />
              <span className="text-xs">{view.age}</span>
            </>
          ) : (
            <span>
              {view.headline} on {mta.name}.
            </span>
          )}
        </p>
        {view.detail && <p className="text-xs">{view.detail}</p>}
        {view.notes.map((note) => (
          <p key={note} className="text-xs">{note}</p>
        ))}
        {!view.badgeVerdict && (
          <p className="text-xs">
            <MtasPageLink />.
          </p>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Acknowledgement before launching on a warned server
// ---------------------------------------------------------------------------

export function OrangeLaunchConfirmDialog({
  open,
  onOpenChange,
  mtaName,
  check,
  actionLabel,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Falls back to "the selected server" so the dialog never depends on the MTA list. */
  mtaName: string | null | undefined;
  /** The check that triggered the dialog (fresh pre-launch read, or the displayed one). */
  check: OrangeLaunchCheck | null | undefined;
  /** "Send now" or "Schedule" — the dialog appends "anyway". */
  actionLabel: string;
  onConfirm: () => void;
}) {
  if (!check || !check.warn || !check.verdict) return null;
  const view = describeOrangeLaunchCheck(check);
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent data-testid="dialog-orange-launch-confirm">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-amber-600" />
            Launch despite the Orange verdict?
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3 text-sm">
              <p className="flex flex-wrap items-center gap-2">
                <span>Latest Orange check on <strong>{mtaName || "the selected server"}</strong>:</span>
                <OrangeVerdictBadge verdict={check.verdict} testId="orange-launch-confirm-verdict" />
                <span className="text-xs">{formatOrangeAge(check.ageMs)}</span>
              </p>
              <p>{view.detail}</p>
              {view.notes.map((note) => (
                <p key={note} className="text-xs">{note}</p>
              ))}
              <p className="text-xs">
                This is only a warning: the campaign is sent normally if you continue. You can also cancel and pick another server or run a new Orange Test first.
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="button-cancel-orange-launch">Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm} data-testid="button-confirm-orange-launch">
            {actionLabel} anyway
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
