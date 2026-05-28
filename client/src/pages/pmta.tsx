import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  AlertCircle,
  CheckCircle2,
  RefreshCw,
  Server,
  XCircle,
  Loader2,
  AlertTriangle,
  ChevronRight,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface PmtaSnapshot {
  id: string;
  serverId: string | null;
  domain: string;
  capturedAt: string;
  pendingCount: number;
  errorCount: number;
  status: "ok" | "ssh_error" | "parse_error" | string;
  errorMessage: string | null;
  errorLines: string[];
  rawExcerpt: string | null;
}

interface LatestResponse {
  configured: boolean;
  configuredDomains: string[];
  snapshots: PmtaSnapshot[];
  errorQueues: PmtaSnapshot[];
}

function timeAgo(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const sec = Math.max(1, Math.floor((Date.now() - t) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return new Date(iso).toLocaleString();
}

/**
 * Status pill per task contract (green / yellow / red).
 *   - green: status=ok AND errorCount=0
 *   - yellow: status=parse_error OR (status=ok AND errorCount>0)
 *   - red: status=ssh_error
 */
function statusTier(s: PmtaSnapshot): "green" | "yellow" | "red" {
  if (s.status === "ssh_error") return "red";
  if (s.status === "parse_error") return "yellow";
  if ((s.errorCount ?? 0) > 0) return "yellow";
  return "green";
}

function StatusPill({ snapshot }: { snapshot: PmtaSnapshot }) {
  const tier = statusTier(snapshot);
  if (tier === "green") {
    return (
      <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-300" data-testid={`pill-${snapshot.domain}-green`}>
        <CheckCircle2 className="h-3 w-3 mr-1" /> Healthy
      </Badge>
    );
  }
  if (tier === "yellow") {
    return (
      <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950 dark:text-amber-300" data-testid={`pill-${snapshot.domain}-yellow`}>
        <AlertTriangle className="h-3 w-3 mr-1" /> Attention
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="bg-red-50 text-red-700 border-red-200 dark:bg-red-950 dark:text-red-300" data-testid={`pill-${snapshot.domain}-red`}>
      <XCircle className="h-3 w-3 mr-1" /> SSH error
    </Badge>
  );
}

function DomainCard({ snapshot, onOpen }: { snapshot: PmtaSnapshot; onOpen: () => void }) {
  return (
    <Card
      className="cursor-pointer hover:shadow-md transition-shadow"
      onClick={onOpen}
      data-testid={`card-domain-${snapshot.domain}`}
    >
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="text-base font-mono break-all" data-testid={`text-domain-${snapshot.domain}`}>
            {snapshot.domain}
          </CardTitle>
          <StatusPill snapshot={snapshot} />
        </div>
        <CardDescription className="text-xs" data-testid={`text-refreshed-${snapshot.domain}`}>
          Last refresh {timeAgo(snapshot.capturedAt)}
        </CardDescription>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <div className="text-xs text-muted-foreground uppercase tracking-wide">Pending</div>
            <div className="text-2xl font-mono font-semibold" data-testid={`stat-pending-${snapshot.domain}`}>
              {snapshot.pendingCount.toLocaleString()}
            </div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground uppercase tracking-wide">Errors</div>
            <div
              className={`text-2xl font-mono font-semibold ${snapshot.errorCount > 0 ? "text-red-600" : "text-muted-foreground"}`}
              data-testid={`stat-errors-${snapshot.domain}`}
            >
              {snapshot.errorCount.toLocaleString()}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function MissingDomainCard({ domain }: { domain: string }) {
  return (
    <Card className="opacity-60" data-testid={`card-domain-missing-${domain}`}>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="text-base font-mono break-all">{domain}</CardTitle>
          <Badge variant="outline" className="text-muted-foreground">awaiting first tick</Badge>
        </div>
        <CardDescription className="text-xs">No snapshot captured yet</CardDescription>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <div className="text-xs text-muted-foreground uppercase tracking-wide">Pending</div>
            <div className="text-2xl font-mono font-semibold text-muted-foreground">—</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground uppercase tracking-wide">Errors</div>
            <div className="text-2xl font-mono font-semibold text-muted-foreground">—</div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default function PmtaQueuesPage() {
  const { toast } = useToast();
  const [selected, setSelected] = useState<PmtaSnapshot | null>(null);

  const { data, isLoading, isError, error } = useQuery<LatestResponse>({
    queryKey: ["/api/pmta/snapshots/latest"],
    refetchInterval: 30_000,
  });

  const refreshMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/pmta/refresh");
      return res.json();
    },
    onSuccess: (result: any) => {
      toast({
        title: result?.scheduled ? "Refresh enqueued" : "Refresh not scheduled",
        description: result?.scheduled
          ? "The collector leader process will run the tick within a few seconds."
          : `Reason: ${result?.reason ?? "unknown"}`,
      });
      // Snapshots land asynchronously after the leader finishes the SSH tick.
      setTimeout(() => queryClient.invalidateQueries({ queryKey: ["/api/pmta/snapshots/latest"] }), 5_000);
      setTimeout(() => queryClient.invalidateQueries({ queryKey: ["/api/pmta/snapshots/latest"] }), 15_000);
    },
    onError: (err: any) => {
      toast({
        title: "Refresh failed",
        description: err?.message ?? "Unknown error (rate limit is 1/minute per user)",
        variant: "destructive",
      });
    },
  });

  const snapshots = data?.snapshots ?? [];
  const errorQueues = data?.errorQueues ?? [];
  const configuredDomains = data?.configuredDomains ?? [];
  const seen = new Set(snapshots.map((s) => s.domain));
  const missing = configuredDomains.filter((d) => !seen.has(d));

  return (
    <div className="p-4 lg:p-6 space-y-6 bg-white dark:bg-stone-950 rounded-2xl">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2" data-testid="heading-pmta">
            <Server className="h-6 w-6 text-blue-600" />
            PMTA Queue Monitoring
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Cached snapshots refreshed every 5 minutes from the PMTA host over SSH. The UI itself never opens an SSH session.
          </p>
        </div>
        <Button
          onClick={() => refreshMutation.mutate()}
          disabled={refreshMutation.isPending || !data?.configured}
          data-testid="button-refresh-pmta"
        >
          {refreshMutation.isPending ? (
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4 mr-2" />
          )}
          Refresh now
        </Button>
      </div>

      {data && !data.configured && (
        <Card className="border-amber-200 bg-amber-50 dark:bg-amber-950">
          <CardContent className="p-4 flex items-start gap-3">
            <AlertCircle className="h-5 w-5 text-amber-600 flex-shrink-0 mt-0.5" />
            <div className="text-sm">
              <div className="font-medium text-amber-900 dark:text-amber-200">PMTA collector is not configured.</div>
              <div className="text-amber-800 dark:text-amber-300 mt-1">
                Set these secrets on the server, then restart workers:
                <code className="block mt-2 font-mono text-xs">
                  PMTA_SSH_HOST, PMTA_SSH_PORT (default 22), PMTA_SSH_USER, PMTA_SSH_PRIVATE_KEY, PMTA_DOMAINS (comma-separated)
                </code>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Domain cards — one per configured sending domain. */}
      <section data-testid="section-domain-cards">
        <h2 className="text-lg font-semibold mb-3">Sending domains</h2>
        {isError ? (
          <div className="text-sm text-red-600" data-testid="text-pmta-error">
            Failed to load snapshots: {String((error as any)?.message ?? error)}
          </div>
        ) : isLoading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            <Skeleton className="h-32" />
            <Skeleton className="h-32" />
            <Skeleton className="h-32" />
          </div>
        ) : snapshots.length === 0 && missing.length === 0 ? (
          <div className="text-sm text-muted-foreground" data-testid="text-pmta-empty">
            No snapshots captured yet. {data?.configured ? "The first tick happens within ~5 minutes of worker startup, or click Refresh now." : "Configure the collector first."}
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {snapshots.map((s) => (
              <DomainCard key={s.id} snapshot={s} onOpen={() => setSelected(s)} />
            ))}
            {missing.map((d) => (
              <MissingDomainCard key={`missing-${d}`} domain={d} />
            ))}
          </div>
        )}
      </section>

      {/* Dedicated cross-domain errors section per task contract. */}
      <section data-testid="section-error-queues">
        <h2 className="text-lg font-semibold mb-3 flex items-center gap-2">
          <AlertTriangle className="h-5 w-5 text-amber-600" />
          Queues with delivery errors
        </h2>
        {isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : errorQueues.length === 0 ? (
          <div className="text-sm text-muted-foreground" data-testid="text-no-errors">
            No queues currently report delivery errors. Pattern matched:{" "}
            <code className="font-mono text-xs">error | timeout | refused | blocked | defer | 421 | 450 | 451 | 452 | 550 | 554</code>
          </div>
        ) : (
          <div className="space-y-3" data-testid="list-error-queues">
            {errorQueues.map((q) => (
              <Card
                key={`err-${q.id}`}
                className="border-amber-200 dark:border-amber-800 cursor-pointer hover:shadow-md transition-shadow"
                onClick={() => setSelected(q)}
                data-testid={`error-queue-${q.domain}`}
              >
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-3">
                      <CardTitle className="text-base font-mono">{q.domain}</CardTitle>
                      <StatusPill snapshot={q} />
                    </div>
                    <div className="flex items-center gap-2 text-sm">
                      <span className="text-muted-foreground">
                        {q.errorCount} error line{q.errorCount === 1 ? "" : "s"}
                      </span>
                      <ChevronRight className="h-4 w-4 text-muted-foreground" />
                    </div>
                  </div>
                  <CardDescription className="text-xs">
                    Captured {timeAgo(q.capturedAt)} · {q.pendingCount.toLocaleString()} pending
                  </CardDescription>
                </CardHeader>
                {q.errorLines.length > 0 && (
                  <CardContent className="pt-0">
                    <pre
                      className="font-mono text-xs bg-stone-900 text-amber-200 p-3 rounded-md overflow-x-auto max-h-32"
                      data-testid={`error-lines-preview-${q.domain}`}
                    >
                      {q.errorLines.slice(0, 3).join("\n")}
                      {q.errorLines.length > 3 && `\n… and ${q.errorLines.length - 3} more (click for full list)`}
                    </pre>
                  </CardContent>
                )}
                {q.status === "ssh_error" && q.errorMessage && (
                  <CardContent className="pt-0">
                    <div className="text-xs text-red-700 dark:text-red-300 font-mono" data-testid={`ssh-error-${q.domain}`}>
                      SSH: {q.errorMessage}
                    </div>
                  </CardContent>
                )}
              </Card>
            ))}
          </div>
        )}
      </section>

      <Dialog open={selected !== null} onOpenChange={(o) => !o && setSelected(null)}>
        <DialogContent className="max-w-3xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="font-mono">{selected?.domain}</DialogTitle>
            <DialogDescription>
              Captured {selected ? timeAgo(selected.capturedAt) : ""} ·{" "}
              {selected?.pendingCount.toLocaleString()} pending ·{" "}
              {selected?.errorCount} error line(s)
            </DialogDescription>
          </DialogHeader>
          {selected?.status !== "ok" && selected?.errorMessage && (
            <div className="text-sm rounded-md border border-red-200 bg-red-50 dark:bg-red-950 dark:border-red-800 p-3" data-testid="text-detail-error-message">
              <div className="font-semibold text-red-700 dark:text-red-300 mb-1">
                {selected.status === "ssh_error" ? "SSH error" : "Parse error"}
              </div>
              <pre className="whitespace-pre-wrap font-mono text-xs">{selected.errorMessage}</pre>
            </div>
          )}
          {selected && selected.errorLines.length > 0 && (
            <div>
              <div className="text-sm font-medium mb-2">Matched error lines</div>
              <pre className="font-mono text-xs bg-stone-900 text-amber-200 p-3 rounded-md overflow-x-auto max-h-64" data-testid="text-detail-error-lines">
                {selected.errorLines.join("\n")}
              </pre>
            </div>
          )}
          {selected?.rawExcerpt && (
            <div>
              <div className="text-sm font-medium mb-2">Raw output (truncated)</div>
              <pre className="font-mono text-xs bg-stone-100 dark:bg-stone-900 p-3 rounded-md overflow-x-auto max-h-72 whitespace-pre-wrap" data-testid="text-detail-raw">
                {selected.rawExcerpt}
              </pre>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
