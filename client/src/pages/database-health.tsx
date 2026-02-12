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

function RuleRow({ rule }: { rule: any }) {
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
                  <TableHead>Rows Cleaned</TableHead>
                  <TableHead className="w-16"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rules?.map((rule: any) => (
                  <RuleRow key={rule.id} rule={rule} />
                ))}
                {(!rules || rules.length === 0) && (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center text-muted-foreground">No cleanup rules configured</TableCell>
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
