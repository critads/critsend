import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Database,
  RefreshCw,
  Clock,
  Trash2,
  Shield,
  CheckCircle,
  XCircle,
  AlertTriangle,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

interface TrackingTokenBloatStatus {
  tableName: "tracking_tokens";
  liveRows: number;
  deadRows: number;
  deadRatio: number;
  totalSizeBytes: number;
  totalSizePretty: string;
  heapSizeBytes: number;
  heapSizePretty: string;
  thresholds: { deadRatio: number; minBytesForRatioAlert: number; sizeBytes: number };
  reclaimRecommended: boolean;
  reasons: string[];
  runbookPath: string;
  measuredAt: string;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

function formatNumber(n: number): string {
  return n.toLocaleString();
}

function formatRelativeTime(date: string | null): string {
  if (!date) return "Never";
  const now = new Date();
  const d = new Date(date);
  const diffMs = now.getTime() - d.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return "Just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

function RowCountIndicator({ count }: { count: number }) {
  if (count >= 1000000) {
    return <div className="w-2.5 h-2.5 rounded-full bg-red-500" data-testid="indicator-red" />;
  }
  if (count >= 100000) {
    return <div className="w-2.5 h-2.5 rounded-full bg-yellow-500" data-testid="indicator-yellow" />;
  }
  return <div className="w-2.5 h-2.5 rounded-full bg-green-500" data-testid="indicator-green" />;
}

function StatusBadge({ status }: { status: string }) {
  if (status === "success") {
    return <Badge variant="default" className="gap-1" data-testid="badge-success"><CheckCircle className="w-3 h-3" />Success</Badge>;
  }
  if (status === "failed") {
    return <Badge variant="destructive" className="gap-1" data-testid="badge-failed"><XCircle className="w-3 h-3" />Failed</Badge>;
  }
  return <Badge variant="secondary" className="gap-1" data-testid="badge-partial"><AlertTriangle className="w-3 h-3" />Partial</Badge>;
}

function Sparkline({ values, testId }: { values: number[]; testId?: string }) {
  if (!values || values.length === 0) {
    return <span className="text-xs text-muted-foreground" data-testid={testId}>—</span>;
  }
  const w = 80;
  const h = 24;
  const max = Math.max(...values, 1);
  const stepX = values.length > 1 ? w / (values.length - 1) : 0;
  const points = values
    .map((v, i) => {
      const x = values.length === 1 ? w / 2 : i * stepX;
      const y = h - (v / max) * (h - 2) - 1;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const last = values[values.length - 1];
  return (
    <div className="flex items-center gap-2" data-testid={testId}>
      <svg width={w} height={h} className="overflow-visible">
        {values.length > 1 ? (
          <polyline
            points={points}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            className="text-primary"
          />
        ) : (
          <circle cx={w / 2} cy={h / 2} r="2" className="fill-primary" />
        )}
      </svg>
      <span className="text-xs text-muted-foreground tabular-nums">{last.toLocaleString()}</span>
    </div>
  );
}

function RuleRow({
  rule,
  tableStat,
  recentDeletes,
}: {
  rule: any;
  tableStat?: { rowCount: number; sizeBytes: number; sizePretty: string };
  recentDeletes: number[];
}) {
  const { toast } = useToast();
  const [retentionDays, setRetentionDays] = useState(rule.retentionDays);
  const [enabled, setEnabled] = useState(rule.enabled);
  const isDirty = retentionDays !== rule.retentionDays || enabled !== rule.enabled;

  const updateMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("PUT", `/api/database-health/rules/${rule.id}`, { retentionDays, enabled });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/database-health/rules"] });
      toast({ title: "Rule updated", description: `${rule.displayName} settings saved.` });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  return (
    <TableRow data-testid={`rule-row-${rule.id}`}>
      <TableCell>
        <div>
          <div className="font-medium text-sm" data-testid={`text-rule-name-${rule.id}`}>{rule.displayName}</div>
          <div className="text-xs text-muted-foreground">{rule.tableName}</div>
          {rule.description && <div className="text-xs text-muted-foreground mt-0.5">{rule.description}</div>}
        </div>
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-2">
          <Input
            type="number"
            value={retentionDays}
            onChange={(e) => setRetentionDays(parseInt(e.target.value) || 1)}
            className="w-20"
            min={1}
            max={365}
            data-testid={`input-retention-${rule.id}`}
          />
          <span className="text-xs text-muted-foreground">days</span>
        </div>
      </TableCell>
      <TableCell>
        <Switch
          checked={enabled}
          onCheckedChange={setEnabled}
          data-testid={`switch-enabled-${rule.id}`}
        />
      </TableCell>
      <TableCell>
        <span className="text-sm text-muted-foreground" data-testid={`text-last-run-${rule.id}`}>
          {formatRelativeTime(rule.lastRunAt)}
        </span>
      </TableCell>
      <TableCell>
        <span className="text-sm" data-testid={`text-rows-deleted-${rule.id}`}>
          {formatNumber(rule.lastRowsDeleted || 0)}
        </span>
      </TableCell>
      <TableCell>
        {tableStat ? (
          <div className="text-sm">
            <div data-testid={`text-rule-rows-${rule.id}`}>{formatNumber(tableStat.rowCount)} rows</div>
            <div className="text-xs text-muted-foreground" data-testid={`text-rule-size-${rule.id}`}>
              {tableStat.sizePretty || formatBytes(tableStat.sizeBytes)}
            </div>
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell>
        <Sparkline values={recentDeletes} testId={`sparkline-${rule.id}`} />
      </TableCell>
      <TableCell>
        {isDirty && (
          <Button
            size="sm"
            onClick={() => updateMutation.mutate()}
            disabled={updateMutation.isPending}
            data-testid={`button-save-${rule.id}`}
          >
            {updateMutation.isPending ? <RefreshCw className="w-3 h-3 animate-spin" /> : "Save"}
          </Button>
        )}
      </TableCell>
    </TableRow>
  );
}

export default function DatabaseHealth() {
  const { toast } = useToast();

  const { data: stats, isLoading: statsLoading } = useQuery<Array<{ tableName: string; rowCount: number; sizeBytes: number; sizePretty: string }>>({
    queryKey: ["/api/database-health/stats"],
  });

  const { data: rules, isLoading: rulesLoading } = useQuery<any[]>({
    queryKey: ["/api/database-health/rules"],
  });

  const { data: logs, isLoading: logsLoading } = useQuery<any[]>({
    queryKey: ["/api/database-health/logs"],
  });

  const { data: bloat } = useQuery<TrackingTokenBloatStatus>({
    queryKey: ["/api/database-health/tracking-token-bloat"],
    refetchInterval: 60_000,
  });

  const statsByTable = new Map<string, { rowCount: number; sizeBytes: number; sizePretty: string }>();
  for (const s of stats ?? []) {
    statsByTable.set(s.tableName, { rowCount: s.rowCount, sizeBytes: s.sizeBytes, sizePretty: s.sizePretty });
  }

  // Build a per-rule history of rowsDeleted (oldest -> newest, last 10 runs).
  const deletesByRule = new Map<string, number[]>();
  if (logs) {
    const grouped = new Map<string, any[]>();
    for (const log of logs) {
      if (!log.ruleId) continue;
      const arr = grouped.get(log.ruleId) ?? [];
      arr.push(log);
      grouped.set(log.ruleId, arr);
    }
    for (const [ruleId, arr] of grouped.entries()) {
      const sorted = [...arr]
        .sort((a, b) => new Date(a.executedAt).getTime() - new Date(b.executedAt).getTime())
        .slice(-10)
        .map(l => Number(l.rowsDeleted ?? 0));
      deletesByRule.set(ruleId, sorted);
    }
  }

  const runCleanupMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/database-health/run");
      return res.json();
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/database-health/stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/database-health/rules"] });
      queryClient.invalidateQueries({ queryKey: ["/api/database-health/logs"] });
      const totalDeleted = data.results?.reduce((sum: number, r: any) => sum + r.rowsDeleted, 0) || 0;
      toast({
        title: "Cleanup complete",
        description: `Deleted ${formatNumber(totalDeleted)} rows across ${data.results?.length || 0} tables.`,
      });
    },
    onError: (err: Error) => {
      toast({ title: "Cleanup failed", description: err.message, variant: "destructive" });
    },
  });

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2" data-testid="text-page-title">
            <Database className="w-6 h-6" />
            Database Health
          </h1>
          <p className="text-muted-foreground text-sm mt-1" data-testid="text-page-subtitle">
            Monitor and maintain database performance
          </p>
        </div>
        <Button
          onClick={() => runCleanupMutation.mutate()}
          disabled={runCleanupMutation.isPending}
          data-testid="button-run-cleanup"
        >
          {runCleanupMutation.isPending ? (
            <RefreshCw className="w-4 h-4 animate-spin mr-2" />
          ) : (
            <Trash2 className="w-4 h-4 mr-2" />
          )}
          {runCleanupMutation.isPending ? "Running..." : "Run Cleanup Now"}
        </Button>
      </div>

      {bloat?.reclaimRecommended && (
        <Alert variant="destructive" data-testid="alert-tracking-token-bloat">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle data-testid="text-bloat-title">
            tracking_tokens reclaim recommended
          </AlertTitle>
          <AlertDescription className="space-y-2">
            <ul className="list-disc pl-5 text-sm">
              {bloat.reasons.map((reason, i) => (
                <li key={i} data-testid={`text-bloat-reason-${i}`}>{reason}</li>
              ))}
            </ul>
            <div className="text-xs text-muted-foreground" data-testid="text-bloat-stats">
              live={bloat.liveRows.toLocaleString()} ·
              {" "}dead={bloat.deadRows.toLocaleString()} ·
              {" "}dead ratio={(bloat.deadRatio * 100).toFixed(1)}% ·
              {" "}total size={bloat.totalSizePretty}
            </div>
            <div className="text-sm" data-testid="text-bloat-runbook">
              Run the one-shot reclamation documented in
              {" "}
              <code className="px-1 py-0.5 rounded bg-muted text-foreground">
                {bloat.runbookPath}
              </code>
              {" "}(<code className="px-1 py-0.5 rounded bg-muted text-foreground">
                tsx scripts/reclaim-tracking-tokens.ts --check
              </code>
              {" "}to start).
            </div>
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Shield className="w-5 h-5" />
            Table Statistics
          </CardTitle>
          <CardDescription>Database table sizes and row counts</CardDescription>
        </CardHeader>
        <CardContent>
          {statsLoading ? (
            <div className="space-y-2">
              {[1, 2, 3, 4, 5].map(i => <Skeleton key={i} className="h-10 w-full" />)}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Table Name</TableHead>
                  <TableHead>Row Count</TableHead>
                  <TableHead>Size</TableHead>
                  <TableHead className="w-10">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {stats?.map((table) => (
                  <TableRow key={table.tableName} data-testid={`stat-row-${table.tableName}`}>
                    <TableCell className="font-mono text-sm" data-testid={`text-table-name-${table.tableName}`}>{table.tableName}</TableCell>
                    <TableCell data-testid={`text-row-count-${table.tableName}`}>{formatNumber(table.rowCount)}</TableCell>
                    <TableCell data-testid={`text-size-${table.tableName}`}>{table.sizePretty || formatBytes(table.sizeBytes)}</TableCell>
                    <TableCell><RowCountIndicator count={table.rowCount} /></TableCell>
                  </TableRow>
                ))}
                {(!stats || stats.length === 0) && (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center text-muted-foreground">No table data available</TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Clock className="w-5 h-5" />
            Cleanup Rules
          </CardTitle>
          <CardDescription>Configure automatic data retention policies</CardDescription>
        </CardHeader>
        <CardContent>
          {rulesLoading ? (
            <div className="space-y-2">
              {[1, 2, 3, 4].map(i => <Skeleton key={i} className="h-12 w-full" />)}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Table</TableHead>
                  <TableHead>Retention</TableHead>
                  <TableHead>Enabled</TableHead>
                  <TableHead>Last Run</TableHead>
                  <TableHead>Last Cleaned</TableHead>
                  <TableHead>Current Size</TableHead>
                  <TableHead>Recent Deletes</TableHead>
                  <TableHead className="w-16"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rules?.map((rule: any) => (
                  <RuleRow
                    key={rule.id}
                    rule={rule}
                    tableStat={statsByTable.get(rule.tableName)}
                    recentDeletes={deletesByRule.get(rule.id) ?? []}
                  />
                ))}
                {(!rules || rules.length === 0) && (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center text-muted-foreground">No cleanup rules configured</TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Trash2 className="w-5 h-5" />
            Cleanup History
          </CardTitle>
          <CardDescription>Recent maintenance execution logs</CardDescription>
        </CardHeader>
        <CardContent>
          {logsLoading ? (
            <div className="space-y-2">
              {[1, 2, 3].map(i => <Skeleton key={i} className="h-10 w-full" />)}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Table</TableHead>
                  <TableHead>Rows Deleted</TableHead>
                  <TableHead>Duration</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Triggered By</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {logs?.map((log: any) => (
                  <TableRow key={log.id} data-testid={`log-row-${log.id}`}>
                    <TableCell className="text-sm" data-testid={`text-log-date-${log.id}`}>
                      {formatRelativeTime(log.executedAt)}
                    </TableCell>
                    <TableCell className="font-mono text-sm" data-testid={`text-log-table-${log.id}`}>{log.tableName}</TableCell>
                    <TableCell data-testid={`text-log-rows-${log.id}`}>{formatNumber(log.rowsDeleted)}</TableCell>
                    <TableCell data-testid={`text-log-duration-${log.id}`}>{log.durationMs}ms</TableCell>
                    <TableCell><StatusBadge status={log.status} /></TableCell>
                    <TableCell>
                      <Badge variant="outline" data-testid={`badge-trigger-${log.id}`}>{log.triggeredBy}</Badge>
                    </TableCell>
                  </TableRow>
                ))}
                {(!logs || logs.length === 0) && (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center text-muted-foreground">No cleanup history yet</TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
