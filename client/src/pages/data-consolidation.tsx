import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient, ApiError } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  GitMerge,
  Play,
  RefreshCw,
  Square,
  CheckCircle,
  XCircle,
  AlertTriangle,
  Clock,
  Tag,
  Info,
} from "lucide-react";

// ─── Types (mirror server/services/data-consolidation.ts) ───────────────────

type RunStatus = "running" | "completed" | "failed" | "interrupted" | "cancelled";
type Phase =
  | "starting"
  | "refs_universe"
  | "rule3_complaint_u_tags"
  | "rule1_remove_refs"
  | "rule2_add_refs"
  | "finalizing"
  | "done";

interface Counters {
  refsUniverseSize: number;
  rule3EventsTotal: number;
  rule3EventsScanned: number;
  rule3PairsSeen: number;
  rule3TagsAdded: number;
  rule3SkippedNoCampaignTag: number;
  rule3SkippedNoOpenTag: number;
  rule3AlreadyTagged: number;
  rule1RefsRemoved: number;
  rule2RefsAdded: number;
}

interface Run {
  id: string;
  mode: "incremental" | "full";
  status: RunStatus;
  triggeredBy: string | null;
  startedAt: string;
  completedAt: string | null;
  heartbeatAt: string | null;
  cancelRequested: boolean;
  phase: Phase;
  progress: { phase: Phase; done: number; total: number | null; currentRef?: string | null; message?: string } | null;
  cursorFrom: string | null;
  cursorTo: string | null;
  counters: Counters;
  durationMs: number | null;
  error: string | null;
}

interface Status {
  current: Run | null;
  last: Run | null;
  state: { cursorAt: string | null; knownRefsCount: number; lastFullRunAt: string | null };
  config: { complaintIps: string[]; batchSize: number; eventBatchSize: number; overlapMinutes: number; staleHeartbeatMs: number };
  /** Admin gate: only admins may start or stop a run (server-enforced; this only drives the buttons). */
  canManage: boolean;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const PHASE_LABEL: Record<Phase, string> = {
  starting: "Starting",
  refs_universe: "Building the list of known refs",
  rule3_complaint_u_tags: "Rule 3 — complaint-IP opens → U tags",
  rule1_remove_refs: "Rule 1 — U tag → remove ref",
  rule2_add_refs: "Rule 2 — C tag → add ref",
  finalizing: "Saving cursor",
  done: "Done",
};

function formatNumber(n: number | null | undefined): string {
  return Number(n ?? 0).toLocaleString();
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString();
}

function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms} ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m} min ${rs.toString().padStart(2, "0")} s`;
  const h = Math.floor(m / 60);
  return `${h} h ${(m % 60).toString().padStart(2, "0")} min`;
}

function elapsedSince(iso: string): number {
  return Math.max(0, Date.now() - new Date(iso).getTime());
}

function StatusBadge({ status }: { status: RunStatus }) {
  switch (status) {
    case "running":
      return (
        <Badge variant="default" className="gap-1" data-testid={`badge-status-${status}`}>
          <RefreshCw className="w-3 h-3 animate-spin" /> Running
        </Badge>
      );
    case "completed":
      return (
        <Badge variant="secondary" className="gap-1 text-green-700 dark:text-green-400" data-testid={`badge-status-${status}`}>
          <CheckCircle className="w-3 h-3" /> Completed
        </Badge>
      );
    case "failed":
      return (
        <Badge variant="destructive" className="gap-1" data-testid={`badge-status-${status}`}>
          <XCircle className="w-3 h-3" /> Failed
        </Badge>
      );
    case "interrupted":
      return (
        <Badge variant="outline" className="gap-1 text-amber-700 dark:text-amber-400" data-testid={`badge-status-${status}`}>
          <AlertTriangle className="w-3 h-3" /> Interrupted
        </Badge>
      );
    case "cancelled":
      return (
        <Badge variant="outline" className="gap-1" data-testid={`badge-status-${status}`}>
          <Square className="w-3 h-3" /> Cancelled
        </Badge>
      );
  }
}

function ModeBadge({ mode }: { mode: Run["mode"] }) {
  return (
    <Badge variant="outline" data-testid={`badge-mode-${mode}`}>
      {mode === "full" ? "Full recompute" : "Incremental"}
    </Badge>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────────────

function CounterCell({ label, value, hint, testId }: { label: string; value: number; hint?: string; testId: string }) {
  return (
    <div className="rounded-md border p-3" data-testid={testId}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-xl font-semibold tabular-nums">{formatNumber(value)}</div>
      {hint && <div className="text-xs text-muted-foreground mt-1">{hint}</div>}
    </div>
  );
}

function RunCounters({ run }: { run: Run }) {
  const c = run.counters;
  return (
    <div className="space-y-3">
      <div>
        <div className="text-sm font-medium mb-2">Rule 3 — complaint-IP opens → <code>U&lt;ref&gt;</code></div>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
          <CounterCell label="Events scanned" value={c.rule3EventsScanned} hint={`of ${formatNumber(c.rule3EventsTotal)} in window`} testId="counter-rule3-events" />
          <CounterCell label="Subscriber × brand pairs" value={c.rule3PairsSeen} testId="counter-rule3-pairs" />
          <CounterCell label="U tags added" value={c.rule3TagsAdded} testId="counter-rule3-added" />
          <CounterCell label="Skipped: no O tag" value={c.rule3SkippedNoOpenTag} hint="subscriber never opened that brand with a tag" testId="counter-rule3-no-open" />
          <CounterCell label="Skipped: untagged campaign" value={c.rule3SkippedNoCampaignTag} hint="events on campaigns without a brand tag" testId="counter-rule3-no-campaign-tag" />
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
        <CounterCell label="Rule 1 — refs removed" value={c.rule1RefsRemoved} hint="U<ref> present → <ref> dropped" testId="counter-rule1-removed" />
        <CounterCell label="Rule 2 — refs added" value={c.rule2RefsAdded} hint="C<ref> without U<ref> → <ref> added" testId="counter-rule2-added" />
        <CounterCell label="Known refs" value={c.refsUniverseSize} hint="brands checked by rules 1 and 2" testId="counter-refs-universe" />
      </div>
    </div>
  );
}

function CurrentRunCard({ run, onCancel, cancelling, canManage }: { run: Run; onCancel: () => void; cancelling: boolean; canManage: boolean }) {
  const p = run.progress;
  const pct = p && p.total && p.total > 0 ? Math.min(100, Math.round((p.done / p.total) * 100)) : null;
  return (
    <Card data-testid="card-current-run">
      <CardHeader>
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <CardTitle className="flex items-center gap-2">
              <RefreshCw className="w-4 h-4 animate-spin" />
              Run in progress
            </CardTitle>
            <CardDescription>
              Started {formatDate(run.startedAt)} · elapsed {formatDuration(elapsedSince(run.startedAt))}
              {run.triggeredBy ? ` · by ${run.triggeredBy}` : ""}
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <ModeBadge mode={run.mode} />
            <Button
              variant="outline"
              size="sm"
              onClick={onCancel}
              disabled={!canManage || cancelling || run.cancelRequested}
              title={canManage ? undefined : "Admin required"}
              data-testid="button-cancel-run"
            >
              <Square className="w-4 h-4 mr-2" />
              {run.cancelRequested ? "Stopping…" : "Stop"}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span data-testid="text-current-phase">{PHASE_LABEL[run.phase] ?? run.phase}</span>
            <span className="text-muted-foreground tabular-nums" data-testid="text-current-progress">
              {p && p.total != null
                ? `${formatNumber(p.done)} / ${formatNumber(p.total)}${pct != null ? ` (${pct}%)` : ""}`
                : p?.message ?? ""}
              {p?.currentRef ? ` · ref ${p.currentRef}` : ""}
            </span>
          </div>
          <Progress value={pct ?? 0} className={pct == null ? "animate-pulse" : ""} />
        </div>
        <RunCounters run={run} />
        {run.cancelRequested && (
          <p className="text-sm text-muted-foreground">Stop requested — the run ends at its next batch boundary; the cursor will not advance.</p>
        )}
      </CardContent>
    </Card>
  );
}

function LastRunCard({ run }: { run: Run }) {
  return (
    <Card data-testid="card-last-run">
      <CardHeader>
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Clock className="w-4 h-4" />
              Last run
            </CardTitle>
            <CardDescription>
              {formatDate(run.startedAt)} · {formatDuration(run.durationMs)}
              {run.triggeredBy ? ` · by ${run.triggeredBy}` : ""}
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <ModeBadge mode={run.mode} />
            <StatusBadge status={run.status} />
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {run.error && (
          <Alert variant={run.status === "cancelled" ? "default" : "destructive"} data-testid="alert-last-run-error">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>{run.status === "cancelled" ? "Run stopped" : "Run did not complete"}</AlertTitle>
            <AlertDescription className="break-words">
              {run.error}
              {run.status !== "completed" && " — the cursor was not advanced; relaunching is safe."}
            </AlertDescription>
          </Alert>
        )}
        <div className="text-sm text-muted-foreground" data-testid="text-last-run-window">
          Complaint-IP events window: {run.cursorFrom ? `after ${formatDate(run.cursorFrom)}` : "full history"} → {formatDate(run.cursorTo)}
        </div>
        <RunCounters run={run} />
      </CardContent>
    </Card>
  );
}

// ─── Page ───────────────────────────────────────────────────────────────────

export default function DataConsolidation() {
  const { toast } = useToast();
  const [confirmFull, setConfirmFull] = useState(false);

  const { data: status, isLoading: statusLoading } = useQuery<Status>({
    queryKey: ["/api/data-consolidation/status"],
    refetchInterval: (query) => (query.state.data?.current ? 2_000 : 30_000),
  });

  const { data: runs, isLoading: runsLoading } = useQuery<Run[]>({
    queryKey: ["/api/data-consolidation/runs"],
    refetchInterval: status?.current ? 5_000 : 60_000,
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/data-consolidation/status"] });
    queryClient.invalidateQueries({ queryKey: ["/api/data-consolidation/runs"] });
  };

  const startMutation = useMutation({
    mutationFn: async (mode: "incremental" | "full") => {
      const res = await apiRequest("POST", "/api/data-consolidation/run", { mode });
      return res.json();
    },
    onSuccess: (_data, mode) => {
      invalidate();
      toast({
        title: mode === "full" ? "Full recompute started" : "Consolidation started",
        description: "Progress is shown below and survives a page reload.",
      });
    },
    onError: (err: Error) => {
      invalidate();
      if (err instanceof ApiError && err.status === 409) {
        toast({
          title: "A run is already in progress",
          description: err.body?.message ?? "Wait for the current run to finish before starting another one.",
        });
        return;
      }
      toast({ title: "Could not start the run", description: err.message, variant: "destructive" });
    },
  });

  const cancelMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/data-consolidation/cancel", {});
      return res.json();
    },
    onSuccess: () => {
      invalidate();
      toast({ title: "Stop requested", description: "The run will end at its next batch boundary." });
    },
    onError: (err: Error) => {
      invalidate();
      toast({ title: "Could not stop the run", description: err.message, variant: "destructive" });
    },
  });

  const current = status?.current ?? null;
  const last = status?.last ?? null;
  const busy = Boolean(current) || startMutation.isPending;
  const firstRun = !status?.state.cursorAt;
  const canManage = status?.canManage === true;

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2" data-testid="text-page-title">
            <GitMerge className="w-6 h-6" />
            Data Consolidation
          </h1>
          <p className="text-muted-foreground text-sm mt-1" data-testid="text-page-subtitle">
            Reconcile subscriber refs with their U / C / O tags, in bounded batches, on demand.
          </p>
          {!statusLoading && status && !canManage && (
            <p className="text-xs text-amber-700 dark:text-amber-400 mt-1" data-testid="text-admin-required">
              Only administrators can start or stop a run — you can follow progress and history here.
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            onClick={() => setConfirmFull(true)}
            disabled={!canManage || busy || statusLoading}
            title={canManage || statusLoading ? undefined : "Admin required"}
            data-testid="button-run-full"
          >
            <RefreshCw className="w-4 h-4 mr-2" />
            Full recompute
          </Button>
          <Button
            onClick={() => startMutation.mutate("incremental")}
            disabled={!canManage || busy || statusLoading}
            title={canManage || statusLoading ? undefined : "Admin required"}
            data-testid="button-run-incremental"
          >
            {startMutation.isPending ? <RefreshCw className="w-4 h-4 animate-spin mr-2" /> : <Play className="w-4 h-4 mr-2" />}
            {firstRun ? "Run (first run: full history)" : "Run (incremental)"}
          </Button>
        </div>
      </div>

      <Card data-testid="card-rules">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Tag className="w-4 h-4" />
            What a run does
          </CardTitle>
          <CardDescription>
            A ref is a brand code (e.g. <code>1CT</code>); tags <code>U1CT</code> / <code>C1CT</code> / <code>O1CT</code> mean
            unsubscribed / clicked / opened that brand. Rules run in the order 3 → 1 → 2 so new U tags are honoured in the same pass.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ol className="space-y-2 text-sm list-decimal pl-5">
            <li data-testid="text-rule-3">
              <span className="font-medium">Complaint-IP open ⇒ U tag.</span> For every open recorded from the complaint IP
              ({status?.config.complaintIps.join(", ") ?? "…"}) on a campaign of brand <code>&lt;ref&gt;</code>, a subscriber who
              currently carries <code>O&lt;ref&gt;</code> receives <code>U&lt;ref&gt;</code>. Subscribers without the O tag and
              campaigns without a brand tag are skipped and counted.
            </li>
            <li data-testid="text-rule-1">
              <span className="font-medium">U tag ⇒ ref removed.</span> A subscriber carrying <code>U&lt;ref&gt;</code> loses the ref{" "}
              <code>&lt;ref&gt;</code>.
            </li>
            <li data-testid="text-rule-2">
              <span className="font-medium">C tag ⇒ ref added.</span> A subscriber carrying <code>C&lt;ref&gt;</code> (and not{" "}
              <code>U&lt;ref&gt;</code>) gains <code>&lt;ref&gt;</code>, only if missing.
            </li>
          </ol>
          <div className="mt-4 flex items-start gap-2 text-xs text-muted-foreground" data-testid="text-rules-notes">
            <Info className="w-4 h-4 shrink-0 mt-0.5" />
            <p>
              Exact, case-sensitive match only (<code>US1CT</code> / <code>E1CT</code> variants and free tags such as{" "}
              <code>STOP-…</code> are never touched). O / C tags are never removed. The first run covers the whole history; later
              runs only read complaint-IP events newer than the cursor (with a {status?.config.overlapMinutes ?? 60}-minute overlap)
              and only touch rows that are still inconsistent. Re-running right away changes nothing.
            </p>
          </div>
        </CardContent>
      </Card>

      {statusLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : (
        <>
          {current && (
            <CurrentRunCard run={current} onCancel={() => cancelMutation.mutate()} cancelling={cancelMutation.isPending} canManage={canManage} />
          )}

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Card data-testid="card-state-cursor">
              <CardHeader className="pb-2">
                <CardDescription>Complaint-IP cursor</CardDescription>
                <CardTitle className="text-base">{status?.state.cursorAt ? formatDate(status.state.cursorAt) : "Never run"}</CardTitle>
              </CardHeader>
              <CardContent className="text-xs text-muted-foreground">
                Next incremental run reads events after this instant (minus the overlap).
              </CardContent>
            </Card>
            <Card data-testid="card-state-refs">
              <CardHeader className="pb-2">
                <CardDescription>Known refs</CardDescription>
                <CardTitle className="text-base">{formatNumber(status?.state.knownRefsCount)}</CardTitle>
              </CardHeader>
              <CardContent className="text-xs text-muted-foreground">
                Brands checked by rules 1 and 2 — rediscovered on every run from all subscriber U / C tags, campaign tags and the brands directory.
              </CardContent>
            </Card>
            <Card data-testid="card-state-full">
              <CardHeader className="pb-2">
                <CardDescription>Last full recompute</CardDescription>
                <CardTitle className="text-base">{formatDate(status?.state.lastFullRunAt)}</CardTitle>
              </CardHeader>
              <CardContent className="text-xs text-muted-foreground">
                Full mode rescans every U / C tag and the whole complaint-IP history.
              </CardContent>
            </Card>
          </div>

          {last ? (
            <LastRunCard run={last} />
          ) : (
            !current && (
              <Card data-testid="card-no-run">
                <CardContent className="py-8 text-center text-sm text-muted-foreground">
                  No run yet. The first run processes the whole history and may take a while on a large base; it runs in the
                  background and you can leave this page.
                </CardContent>
              </Card>
            )
          )}
        </>
      )}

      <Card data-testid="card-history">
        <CardHeader>
          <CardTitle className="text-base">History</CardTitle>
          <CardDescription>Most recent runs first.</CardDescription>
        </CardHeader>
        <CardContent>
          {runsLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : !runs || runs.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="text-history-empty">No run recorded.</p>
          ) : (
            <Table data-testid="table-history">
              <TableHeader>
                <TableRow>
                  <TableHead>Started</TableHead>
                  <TableHead>Mode</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Duration</TableHead>
                  <TableHead className="text-right">R3 events</TableHead>
                  <TableHead className="text-right">R3 U tags</TableHead>
                  <TableHead className="text-right">R1 refs −</TableHead>
                  <TableHead className="text-right">R2 refs +</TableHead>
                  <TableHead>By</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.map((r) => (
                  <TableRow key={r.id} data-testid={`row-run-${r.id}`}>
                    <TableCell className="whitespace-nowrap">{formatDate(r.startedAt)}</TableCell>
                    <TableCell><ModeBadge mode={r.mode} /></TableCell>
                    <TableCell><StatusBadge status={r.status} /></TableCell>
                    <TableCell className="whitespace-nowrap">{formatDuration(r.durationMs)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(r.counters.rule3EventsScanned)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(r.counters.rule3TagsAdded)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(r.counters.rule1RefsRemoved)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(r.counters.rule2RefsAdded)}</TableCell>
                    <TableCell className="text-muted-foreground">{r.triggeredBy ?? "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <AlertDialog open={confirmFull} onOpenChange={setConfirmFull}>
        <AlertDialogContent data-testid="dialog-confirm-full">
          <AlertDialogHeader>
            <AlertDialogTitle>Start a full recompute?</AlertDialogTitle>
            <AlertDialogDescription>
              Full mode replays the whole complaint-IP history instead of only the events after the cursor (rules 1 and 2
              always check every known ref, in both modes). It is safe (same guarded writes) but heavier on the database;
              use it if you suspect the complaint-IP cursor missed something.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-confirm-full-cancel">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmFull(false);
                startMutation.mutate("full");
              }}
              data-testid="button-confirm-full-start"
            >
              Start full recompute
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
