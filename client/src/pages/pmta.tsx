import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface PmtaSnapshot {
  id: string;
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

function StatusBadge({ status }: { status: string }) {
  if (status === "ok") {
    return (
      <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-300" data-testid={`badge-status-ok`}>
        <CheckCircle2 className="h-3 w-3 mr-1" /> OK
      </Badge>
    );
  }
  if (status === "ssh_error") {
    return (
      <Badge variant="outline" className="bg-red-50 text-red-700 border-red-200 dark:bg-red-950 dark:text-red-300" data-testid={`badge-status-ssh-error`}>
        <XCircle className="h-3 w-3 mr-1" /> SSH error
      </Badge>
    );
  }
  if (status === "parse_error") {
    return (
      <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950 dark:text-amber-300" data-testid={`badge-status-parse-error`}>
        <AlertTriangle className="h-3 w-3 mr-1" /> Parse error
      </Badge>
    );
  }
  return <Badge variant="outline" data-testid={`badge-status-${status}`}>{status}</Badge>;
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
      // Refetch a few times to surface results without waiting for the 30s poll.
      setTimeout(() => queryClient.invalidateQueries({ queryKey: ["/api/pmta/snapshots/latest"] }), 5_000);
      setTimeout(() => queryClient.invalidateQueries({ queryKey: ["/api/pmta/snapshots/latest"] }), 15_000);
    },
    onError: (err: any) => {
      toast({
        title: "Refresh failed",
        description: err?.message ?? "Unknown error",
        variant: "destructive",
      });
    },
  });

  const snapshots = data?.snapshots ?? [];
  const configuredDomains = data?.configuredDomains ?? [];
  const seen = new Set(snapshots.map((s) => s.domain));
  const missing = configuredDomains.filter((d) => !seen.has(d));

  const totalPending = snapshots.reduce((s, r) => s + (r.pendingCount || 0), 0);
  const totalErrors = snapshots.reduce((s, r) => s + (r.errorCount || 0), 0);
  const sshErrors = snapshots.filter((r) => r.status === "ssh_error").length;

  return (
    <div className="p-4 lg:p-6 space-y-6 bg-white rounded-2xl">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2" data-testid="heading-pmta">
            <Server className="h-6 w-6 text-blue-600" />
            PMTA Queue Monitoring
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Snapshots refreshed every 5 minutes from the PMTA host over SSH. The UI itself never opens an SSH session — it reads cached snapshots from the database.
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
                Set the following secrets on the server, then restart workers:
                <code className="block mt-2 font-mono text-xs">
                  PMTA_SSH_HOST, PMTA_SSH_PORT (default 22), PMTA_SSH_USER, PMTA_SSH_PRIVATE_KEY, PMTA_DOMAINS (comma-separated)
                </code>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Total pending</CardDescription>
            <CardTitle className="text-3xl font-mono" data-testid="stat-total-pending">
              {isLoading ? <Skeleton className="h-8 w-24" /> : totalPending.toLocaleString()}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Error lines (across all domains)</CardDescription>
            <CardTitle className="text-3xl font-mono" data-testid="stat-total-errors">
              {isLoading ? <Skeleton className="h-8 w-24" /> : totalErrors.toLocaleString()}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>SSH-failed domains</CardDescription>
            <CardTitle className="text-3xl font-mono" data-testid="stat-ssh-errors">
              {isLoading ? <Skeleton className="h-8 w-24" /> : sshErrors.toLocaleString()}
            </CardTitle>
          </CardHeader>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Queues by domain</CardTitle>
          <CardDescription>
            Click a row to see matched error lines and raw output excerpt.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isError ? (
            <div className="text-sm text-red-600" data-testid="text-pmta-error">
              Failed to load snapshots: {String((error as any)?.message ?? error)}
            </div>
          ) : isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : snapshots.length === 0 ? (
            <div className="text-sm text-muted-foreground" data-testid="text-pmta-empty">
              No snapshots captured yet. {data?.configured ? "The first tick happens within ~5 minutes of worker startup, or click Refresh now." : "Configure the collector first."}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Domain</TableHead>
                  <TableHead className="text-right">Pending</TableHead>
                  <TableHead className="text-right">Errors</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Captured</TableHead>
                  <TableHead className="text-right">Details</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {snapshots.map((s) => (
                  <TableRow
                    key={s.id}
                    className="cursor-pointer hover:bg-muted/40"
                    onClick={() => setSelected(s)}
                    data-testid={`row-pmta-${s.domain}`}
                  >
                    <TableCell className="font-mono text-sm" data-testid={`text-domain-${s.domain}`}>
                      {s.domain}
                    </TableCell>
                    <TableCell className="text-right font-mono" data-testid={`text-pending-${s.domain}`}>
                      {s.pendingCount.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {s.errorCount > 0 ? (
                        <span className="text-red-600 font-semibold" data-testid={`text-errors-${s.domain}`}>
                          {s.errorCount}
                        </span>
                      ) : (
                        <span className="text-muted-foreground" data-testid={`text-errors-${s.domain}`}>0</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={s.status} />
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground" data-testid={`text-captured-${s.domain}`}>
                      {timeAgo(s.capturedAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="sm" data-testid={`button-details-${s.domain}`}>
                        View
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
                {missing.map((d) => (
                  <TableRow key={`missing-${d}`} className="opacity-60" data-testid={`row-pmta-missing-${d}`}>
                    <TableCell className="font-mono text-sm">{d}</TableCell>
                    <TableCell className="text-right font-mono">—</TableCell>
                    <TableCell className="text-right font-mono">—</TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-muted-foreground">awaiting first tick</Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">—</TableCell>
                    <TableCell />
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

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
