import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { queryClient, apiRequest, ApiError } from "@/lib/queryClient";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import {
  XCircle, Loader2, Lightbulb, ChevronDown, ChevronRight,
  Clock, Inbox, ShieldAlert, ShieldCheck, ShieldOff, HelpCircle, MailX, Send, Info,
} from "lucide-react";
import type { Mta } from "@shared/schema";
import {
  isOrangeTestPending,
  type OrangeTestControlValue,
  type OrangeTestPublicConfig,
  type OrangeTestVerdict,
  type OrangeTestView,
} from "@shared/orange-test";

// ---------------------------------------------------------------------------
// Data hooks
// ---------------------------------------------------------------------------

export function useOrangeTestConfig() {
  return useQuery<OrangeTestPublicConfig>({
    queryKey: ["/api/mtas/orange-test/config"],
    staleTime: 5 * 60 * 1000,
  });
}

interface SummaryResponse {
  values: Record<string, OrangeTestControlValue>;
}

/** Control values for the visible MTA cards; polls while any test is pending. */
export function useOrangeTestSummary(mtaIds: string[], enabled: boolean) {
  const key = useMemo(() => [...mtaIds].sort().join(","), [mtaIds]);
  return useQuery<SummaryResponse>({
    queryKey: ["/api/mtas/orange-test/summary", key],
    queryFn: async () => {
      const res = await fetch(`/api/mtas/orange-test/summary?ids=${encodeURIComponent(key)}`, { credentials: "include" });
      if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
      return res.json();
    },
    enabled: enabled && key.length > 0,
    refetchInterval: (query) => {
      const values = query.state.data?.values;
      if (!values) return false;
      const pending = Object.values(values).some((v) => v.latest && isOrangeTestPending(v.latest.status));
      return pending ? 30_000 : false;
    },
  });
}

// ---------------------------------------------------------------------------
// Presentation helpers
// ---------------------------------------------------------------------------

const VERDICT_STYLE: Record<OrangeTestVerdict, { label: string; className: string; Icon: typeof ShieldCheck; hint: string }> = {
  GOOD: {
    label: "GOOD",
    className: "bg-emerald-50 text-emerald-800 border-emerald-300 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-700",
    Icon: ShieldCheck,
    hint: "Orange classified the message as not-spam.",
  },
  SPAM: {
    label: "SPAM",
    className: "bg-amber-50 text-amber-800 border-amber-300 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-700",
    Icon: ShieldAlert,
    hint: "Orange flagged the message with a low spam level: deliverability is degraded.",
  },
  BLOCKED: {
    label: "BLOCKED",
    className: "bg-red-50 text-red-800 border-red-300 dark:bg-red-950/40 dark:text-red-300 dark:border-red-700",
    Icon: ShieldOff,
    hint: "Orange flagged the message with a medium or higher spam level: the MTA is effectively blocked.",
  },
  UNKNOWN: {
    label: "UNKNOWN",
    className: "bg-slate-100 text-slate-700 border-slate-300 dark:bg-slate-900/60 dark:text-slate-300 dark:border-slate-700",
    Icon: HelpCircle,
    hint: "The message arrived but its X-me-spamlevel header is missing or carries a value we do not know.",
  },
  NOT_RECEIVED: {
    label: "NOT RECEIVED",
    className: "bg-zinc-100 text-zinc-700 border-zinc-300 dark:bg-zinc-900/60 dark:text-zinc-300 dark:border-zinc-700",
    Icon: MailX,
    hint: "The listening window closed and the message never reached the Orange mailbox (Inbox or Junk).",
  },
};

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min${s % 60 ? ` ${s % 60} s` : ""}`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 48) return `${h} h${rm ? ` ${rm} min` : ""}`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function useNow(active: boolean, everyMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [active, everyMs]);
  return now;
}

export function OrangeVerdictBadge({ verdict, testId, size = "sm" }: { verdict: OrangeTestVerdict; testId?: string; size?: "sm" | "lg" }) {
  const style = VERDICT_STYLE[verdict];
  const Icon = style.Icon;
  return (
    <Badge
      variant="outline"
      className={`gap-1 ${style.className} ${size === "lg" ? "text-sm px-3 py-1" : ""}`}
      title={style.hint}
      data-testid={testId}
    >
      <Icon className={size === "lg" ? "h-4 w-4" : "h-3 w-3"} />
      {style.label}
    </Badge>
  );
}

/** Card badge: verdict of the most recently sent test, or its waiting state. */
export function OrangeTestCardBadge({ mtaId, value }: { mtaId: string; value: OrangeTestControlValue | undefined }) {
  const now = useNow(Boolean(value?.latest && isOrangeTestPending(value.latest.status)), 30_000);
  if (!value || !value.latest) return null;
  const { latest, latestVerdict } = value;
  if (isOrangeTestPending(latest.status)) {
    const since = latest.sentAt || latest.createdAt;
    const previous = latestVerdict && latestVerdict.id !== latest.id ? latestVerdict : null;
    return (
      <div className="text-sm flex items-center gap-2 flex-wrap" data-testid={`orange-test-card-${mtaId}`}>
        <span className="text-muted-foreground">Orange:</span>
        <Badge variant="outline" className="gap-1 text-xs" data-testid={`orange-test-card-pending-${mtaId}`}>
          <Loader2 className="h-3 w-3 animate-spin" />
          {latest.status === "sending" ? "sending…" : `waiting for ${formatDuration(now - new Date(since).getTime())}`}
        </Badge>
        {previous && previous.verdict && (
          <span className="text-xs text-muted-foreground flex items-center gap-1">
            · previous: <OrangeVerdictBadge verdict={previous.verdict} testId={`orange-test-card-previous-${mtaId}`} />
          </span>
        )}
      </div>
    );
  }
  if (latest.status === "failed") {
    // A refused hand-off is not a verdict: keep showing the last SENT test's verdict next to it.
    const previous = latestVerdict && latestVerdict.id !== latest.id ? latestVerdict : null;
    return (
      <div className="text-sm flex items-center gap-2 flex-wrap" data-testid={`orange-test-card-${mtaId}`}>
        <span className="text-muted-foreground">Orange:</span>
        <Badge variant="outline" className="gap-1 text-xs border-red-400 text-red-700 dark:text-red-400" data-testid={`orange-test-card-failed-${mtaId}`}>
          <XCircle className="h-3 w-3" />
          send failed
        </Badge>
        <span className="text-xs text-muted-foreground">{formatDateTime(latest.createdAt)}</span>
        {previous && previous.verdict && (
          <span className="text-xs text-muted-foreground flex items-center gap-1">
            · last sent test: <OrangeVerdictBadge verdict={previous.verdict} testId={`orange-test-card-previous-${mtaId}`} />
          </span>
        )}
      </div>
    );
  }
  if (!latest.verdict) return null;
  return (
    <div className="text-sm flex items-center gap-2 flex-wrap" data-testid={`orange-test-card-${mtaId}`}>
      <span className="text-muted-foreground">Orange:</span>
      <OrangeVerdictBadge verdict={latest.verdict} testId={`orange-test-card-verdict-${mtaId}`} />
      <span className="text-xs text-muted-foreground" title={`Test ${latest.reference}`}>
        {formatDateTime(latest.sentAt || latest.createdAt)}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dialog
// ---------------------------------------------------------------------------

interface HistoryResponse {
  tests: OrangeTestView[];
}

interface StartResponse {
  test: OrangeTestView;
  reused: boolean;
}

export interface OrangeTestDialogProps {
  mta: Mta | null;
  config: OrangeTestPublicConfig | undefined;
  onClose: () => void;
}

export function OrangeTestDialog({ mta, config, onClose }: OrangeTestDialogProps) {
  const mtaId = mta?.id ?? null;
  const [activeTestId, setActiveTestId] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [showRawError, setShowRawError] = useState(false);
  const [showHeaders, setShowHeaders] = useState(false);

  useEffect(() => {
    setActiveTestId(null);
    setStartError(null);
    setShowRawError(false);
    setShowHeaders(false);
  }, [mtaId]);

  const historyQuery = useQuery<HistoryResponse>({
    queryKey: ["/api/mtas", mtaId, "orange-tests"],
    queryFn: async () => {
      const res = await fetch(`/api/mtas/${mtaId}/orange-tests?limit=10`, { credentials: "include" });
      if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
      return res.json();
    },
    enabled: Boolean(mtaId),
  });

  const history = historyQuery.data?.tests ?? [];
  const focusId = activeTestId ?? history[0]?.id ?? null;

  const testQuery = useQuery<OrangeTestView>({
    queryKey: ["/api/mtas", mtaId, "orange-tests", focusId],
    queryFn: async () => {
      const res = await fetch(`/api/mtas/${mtaId}/orange-tests/${focusId}`, { credentials: "include" });
      if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
      return res.json();
    },
    enabled: Boolean(mtaId && focusId),
    initialData: () => history.find((t) => t.id === focusId),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      if (!status) return 3_000;
      if (status === "sending") return 2_000;
      return isOrangeTestPending(status) ? 5_000 : false;
    },
  });

  const test = testQuery.data ?? null;
  const pending = Boolean(test && isOrangeTestPending(test.status));
  const now = useNow(pending, 1000);

  // Once the focused test reaches a terminal state, refresh the card badges and the history.
  useEffect(() => {
    if (!test || isOrangeTestPending(test.status)) return;
    queryClient.invalidateQueries({ queryKey: ["/api/mtas/orange-test/summary"] });
    queryClient.invalidateQueries({ queryKey: ["/api/mtas", mtaId, "orange-tests"] });
  }, [test?.id, test?.status, mtaId]);

  const startMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("POST", `/api/mtas/${id}/orange-test`);
      return res.json() as Promise<StartResponse>;
    },
    // Cache writes are keyed on the MTA the request was made FOR (`requestedMtaId`),
    // never on the MTA currently shown: the dialog may have switched meanwhile.
    onSuccess: (data, requestedMtaId) => {
      queryClient.setQueryData(["/api/mtas", requestedMtaId, "orange-tests", data.test.id], data.test);
      queryClient.invalidateQueries({ queryKey: ["/api/mtas/orange-test/summary"] });
      queryClient.invalidateQueries({ queryKey: ["/api/mtas", requestedMtaId, "orange-tests"] });
      if (requestedMtaId !== mtaId) return;
      setStartError(null);
      setShowRawError(false);
      setShowHeaders(false);
      setActiveTestId(data.test.id);
    },
    onError: (error: unknown, requestedMtaId) => {
      if (requestedMtaId !== mtaId) return;
      if (error instanceof ApiError) {
        const detail = error.body?.error;
        setStartError(typeof detail === "string" ? detail : `Request failed (${error.status})`);
      } else {
        setStartError("Unexpected error while starting the Orange test.");
      }
    },
  });

  const enabled = Boolean(config?.enabled);
  const eligible = Boolean(mta && mta.mode !== "nullsink" && mta.fromEmail);
  const canStart = enabled && eligible && !pending && !startMutation.isPending;

  const sentAtMs = test?.sentAt ? new Date(test.sentAt).getTime() : null;
  const elapsedMs = sentAtMs !== null ? now - sentAtMs : null;
  const nextPollMs = test?.nextPollAt ? new Date(test.nextPollAt).getTime() - now : null;
  const deadlineMs = test?.deadlineAt ? new Date(test.deadlineAt).getTime() - now : null;

  return (
    <Dialog open={Boolean(mta)} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto" data-testid="orange-test-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Inbox className="h-5 w-5 text-orange-500" />
            Orange Test — {mta?.name}
          </DialogTitle>
          <DialogDescription>
            Sends the raw Plain Test ("Hello moon" / "I'm the sun", no custom headers) to{" "}
            <span className="font-mono">{config?.mailbox ?? "the Orange mailbox"}</span> and reads the mailbox back to get
            Orange's verdict for this MTA. Delivery can take hours when the MTA is queued: the test keeps listening for up to{" "}
            {config?.maxWaitHours ?? 48} h.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {config && !config.enabled && (
            <div className="flex items-start gap-2 p-3 rounded-md border border-amber-300 bg-amber-50 text-amber-900 dark:bg-amber-950/30 dark:border-amber-800 dark:text-amber-200 text-sm" data-testid="orange-test-disabled">
              <Info className="h-4 w-4 mt-0.5 shrink-0" />
              <span>{config.disabledReason}</span>
            </div>
          )}
          {mta && !eligible && (
            <div className="flex items-start gap-2 p-3 rounded-md border border-amber-300 bg-amber-50 text-amber-900 dark:bg-amber-950/30 dark:border-amber-800 dark:text-amber-200 text-sm" data-testid="orange-test-ineligible">
              <Info className="h-4 w-4 mt-0.5 shrink-0" />
              <span>
                {mta.mode === "nullsink"
                  ? "This MTA runs in nullsink mode: it never delivers to Orange, so there is nothing to test."
                  : "This MTA has no From email configured; add one before running an Orange Test."}
              </span>
            </div>
          )}
          {startError && (
            <div className="flex items-start gap-2 p-3 rounded-md border border-red-300 bg-red-50 text-red-800 dark:bg-red-950/30 dark:border-red-800 dark:text-red-300 text-sm" data-testid="orange-test-start-error">
              <XCircle className="h-4 w-4 mt-0.5 shrink-0" />
              <span>{startError}</span>
            </div>
          )}

          {historyQuery.isLoading && !test && (
            <div className="space-y-2">
              <Skeleton className="h-16" />
              <Skeleton className="h-8" />
            </div>
          )}

          {!historyQuery.isLoading && !test && (
            <div className="text-sm text-muted-foreground text-center py-4" data-testid="orange-test-empty">
              No Orange Test has been run for this MTA yet.
            </div>
          )}

          {test && (
            <div className="space-y-3" data-testid={`orange-test-status-${test.status}`}>
              {test.status === "sending" && (
                <div className="flex flex-col items-center justify-center py-6 gap-3">
                  <Loader2 className="h-10 w-10 animate-spin text-primary" />
                  <p className="text-sm text-muted-foreground">Handing the test message to the MTA…</p>
                </div>
              )}

              {test.status === "waiting" && (
                <div className="space-y-3">
                  <div className="flex items-center gap-3 p-4 rounded-lg bg-sky-50 dark:bg-sky-950/30 border border-sky-200 dark:border-sky-800">
                    <Loader2 className="h-8 w-8 animate-spin text-sky-600 dark:text-sky-400 shrink-0" />
                    <div className="min-w-0">
                      <p className="font-semibold text-sky-900 dark:text-sky-200">Sent — waiting for Orange</p>
                      <p className="text-sm text-sky-800 dark:text-sky-300">
                        The MTA accepted the message; the mailbox is polled until it shows up in the Inbox or the Junk folder.
                      </p>
                    </div>
                  </div>
                  <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                    <dt className="text-muted-foreground">Waiting since</dt>
                    <dd data-testid="orange-test-elapsed">{elapsedMs !== null ? formatDuration(elapsedMs) : "—"} ({formatDateTime(test.sentAt)})</dd>
                    <dt className="text-muted-foreground">Next mailbox check</dt>
                    <dd data-testid="orange-test-next-poll">{nextPollMs === null ? "—" : nextPollMs <= 0 ? "now" : `in ${formatDuration(nextPollMs)}`}</dd>
                    <dt className="text-muted-foreground">Gives up</dt>
                    <dd data-testid="orange-test-deadline">
                      {deadlineMs === null
                        ? "—"
                        : deadlineMs <= 0
                          ? `after one last mailbox check (window closed ${formatDateTime(test.deadlineAt)})`
                          : `in ${formatDuration(deadlineMs)} (${formatDateTime(test.deadlineAt)})`}
                    </dd>
                    <dt className="text-muted-foreground">Checks so far</dt>
                    <dd>{test.pollCount}{test.lastCheckAt ? ` · last ${formatDateTime(test.lastCheckAt)}` : ""}</dd>
                  </dl>
                  {test.sendNote && (
                    <p className="text-xs text-muted-foreground flex items-start gap-1.5"><Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />{test.sendNote}</p>
                  )}
                  {test.lastCheckError && (
                    <div className="p-3 rounded-md border border-amber-300 bg-amber-50 text-amber-900 dark:bg-amber-950/30 dark:border-amber-800 dark:text-amber-200 text-xs" data-testid="orange-test-check-error">
                      <span className="font-medium">Last mailbox check failed:</span> {test.lastCheckError}
                    </div>
                  )}
                </div>
              )}

              {test.status === "failed" && test.sendError && (
                <div className="space-y-4" data-testid="orange-test-failure">
                  <div className="flex items-center gap-3 p-4 rounded-lg bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800">
                    <XCircle className="h-8 w-8 text-red-600 dark:text-red-400 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold text-red-800 dark:text-red-300">Send failed — the MTA refused the test</p>
                      {test.sendError.stage && (
                        <div className="flex items-center gap-2 mt-1">
                          <span className="text-xs text-red-700 dark:text-red-400">Failed at:</span>
                          <Badge variant="outline" className="text-xs border-red-400 text-red-700 dark:text-red-400">{test.sendError.stage}</Badge>
                          {test.sendError.smtpCode && (
                            <Badge variant="outline" className="text-xs border-red-400 text-red-700 dark:text-red-400">SMTP {test.sendError.smtpCode}</Badge>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                  {test.sendError.suggestions && test.sendError.suggestions.length > 0 && (
                    <div className="space-y-2">
                      <div className="flex items-center gap-1.5 text-sm font-medium">
                        <Lightbulb className="h-4 w-4 text-amber-500" />
                        What to check
                      </div>
                      <ul className="space-y-1.5 pl-1">
                        {test.sendError.suggestions.map((s, i) => (
                          <li key={i} className="flex items-start gap-2 text-sm text-muted-foreground">
                            <span className="mt-1 h-1.5 w-1.5 rounded-full bg-amber-400 shrink-0" />
                            {s}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {test.sendError.errorMessage && (
                    <div className="space-y-1.5">
                      <button
                        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                        onClick={() => setShowRawError(!showRawError)}
                        data-testid="button-toggle-orange-raw-error"
                      >
                        {showRawError ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                        Raw error details
                      </button>
                      {showRawError && (
                        <div className="p-3 rounded-md bg-muted text-xs font-mono break-all leading-relaxed" data-testid="orange-raw-error-details">
                          {test.sendError.errorCode && (
                            <div><span className="text-muted-foreground">Code: </span>{test.sendError.errorCode}</div>
                          )}
                          <div><span className="text-muted-foreground">Message: </span>{test.sendError.errorMessage}</div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {(test.status === "done" || test.status === "not_received") && test.verdict && (
                <div className="space-y-3" data-testid="orange-test-verdict">
                  <div className={`flex items-center gap-3 p-4 rounded-lg border ${VERDICT_STYLE[test.verdict].className}`}>
                    {(() => { const Icon = VERDICT_STYLE[test.verdict].Icon; return <Icon className="h-8 w-8 shrink-0" />; })()}
                    <div className="min-w-0">
                      <p className="font-semibold flex items-center gap-2">
                        Verdict: <OrangeVerdictBadge verdict={test.verdict} size="lg" testId="orange-test-verdict-badge" />
                      </p>
                      <p className="text-sm opacity-90">{VERDICT_STYLE[test.verdict].hint}</p>
                    </div>
                  </div>
                  <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                    {test.status === "done" && (
                      <>
                        <dt className="text-muted-foreground">X-me-spamlevel</dt>
                        <dd className="font-mono" data-testid="orange-test-spamlevel">{test.spamLevelRaw ?? <span className="italic text-muted-foreground">header absent</span>}</dd>
                        <dt className="text-muted-foreground">Found in</dt>
                        <dd data-testid="orange-test-folder">
                          {test.foundIn === "junk" ? "Junk" : "Inbox"}
                          {test.foundFolder && <span className="text-muted-foreground font-mono text-xs"> ({test.foundFolder})</span>}
                          {test.matchedBy && <span className="text-muted-foreground text-xs"> · matched by {test.matchedBy}</span>}
                        </dd>
                        <dt className="text-muted-foreground">Delivery delay</dt>
                        <dd data-testid="orange-test-delay">{test.deliveryDelayMs !== null ? formatDuration(test.deliveryDelayMs) : "—"}</dd>
                        <dt className="text-muted-foreground">Received</dt>
                        <dd>{formatDateTime(test.receivedAt)}</dd>
                      </>
                    )}
                    {test.status === "not_received" && (
                      <>
                        <dt className="text-muted-foreground">Listened</dt>
                        <dd>{formatDateTime(test.sentAt)} → {formatDateTime(test.finishedAt)} ({test.pollCount} checks)</dd>
                      </>
                    )}
                    <dt className="text-muted-foreground">Sent</dt>
                    <dd>{formatDateTime(test.sentAt)}</dd>
                  </dl>
                  {test.lastCheckError && test.status === "not_received" && (
                    <div className="p-3 rounded-md border border-amber-300 bg-amber-50 text-amber-900 dark:bg-amber-950/30 dark:border-amber-800 dark:text-amber-200 text-xs" data-testid="orange-test-check-error">
                      <span className="font-medium">Last mailbox check failed:</span> {test.lastCheckError}
                    </div>
                  )}
                  {test.rawHeaders && Object.keys(test.rawHeaders).length > 0 && (
                    <div className="space-y-1.5">
                      <button
                        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                        onClick={() => setShowHeaders(!showHeaders)}
                        data-testid="button-toggle-orange-headers"
                      >
                        {showHeaders ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                        Message headers ({Object.keys(test.rawHeaders).length})
                      </button>
                      {showHeaders && (
                        <div className="p-3 rounded-md bg-muted text-xs font-mono break-all leading-relaxed space-y-1" data-testid="orange-test-headers">
                          {Object.entries(test.rawHeaders).map(([name, value]) => (
                            <div key={name}><span className="text-muted-foreground">{name}: </span>{value}</div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              <div className="p-3 rounded-md bg-muted text-xs font-mono break-all space-y-0.5" data-testid="orange-test-identity">
                <div><span className="text-muted-foreground">Ref: </span>{test.reference}</div>
                <div><span className="text-muted-foreground">Message-ID: </span>{test.messageId}</div>
                <div><span className="text-muted-foreground">From: </span>{test.fromEmail} → {test.mailbox}</div>
              </div>
            </div>
          )}

          {history.length > 1 && (
            <div className="space-y-1.5">
              <div className="text-sm font-medium flex items-center gap-1.5"><Clock className="h-4 w-4" />History</div>
              <ul className="divide-y rounded-md border text-sm" data-testid="orange-test-history">
                {history.map((h) => (
                  <li key={h.id}>
                    <button
                      type="button"
                      className={`w-full flex items-center justify-between gap-2 px-3 py-2 text-left hover:bg-muted/60 ${h.id === focusId ? "bg-muted/40" : ""}`}
                      onClick={() => setActiveTestId(h.id)}
                      data-testid={`orange-test-history-${h.id}`}
                    >
                      <span className="font-mono text-xs truncate">{h.reference}</span>
                      <span className="text-xs text-muted-foreground whitespace-nowrap">{formatDateTime(h.sentAt || h.createdAt)}</span>
                      {h.verdict ? (
                        <OrangeVerdictBadge verdict={h.verdict} />
                      ) : isOrangeTestPending(h.status) ? (
                        <Badge variant="outline" className="gap-1 text-xs"><Loader2 className="h-3 w-3 animate-spin" />pending</Badge>
                      ) : (
                        <Badge variant="outline" className="gap-1 text-xs border-red-400 text-red-700 dark:text-red-400"><XCircle className="h-3 w-3" />failed</Badge>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose} data-testid="button-close-orange-test-dialog">
            Close
          </Button>
          <Button
            onClick={() => mta && startMutation.mutate(mta.id)}
            disabled={!canStart}
            title={!enabled ? config?.disabledReason ?? "Orange Test is not configured" : undefined}
            data-testid="button-start-orange-test"
          >
            {startMutation.isPending || (test && test.status === "sending") ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Starting…
              </>
            ) : pending ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Listening…
              </>
            ) : (
              <>
                <Send className="h-4 w-4 mr-2" />
                {test ? "Run again" : "Run Orange test"}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
