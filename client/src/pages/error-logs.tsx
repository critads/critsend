import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { useToast } from "@/hooks/use-toast";
import {
  AlertTriangle,
  AlertCircle,
  Info,
  Trash2,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  Mail,
  Upload,
  Server,
  Clock,
  ChevronLeft,
} from "lucide-react";
import type { ErrorLog } from "@shared/schema";

interface ErrorLogStats {
  total: number;
  byType: Record<string, number>;
  bySeverity: Record<string, number>;
  last24Hours: number;
}

const severityConfig: Record<string, { icon: React.ReactNode; className: string }> = {
  error: { 
    icon: <AlertCircle className="h-4 w-4" />, 
    className: "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300" 
  },
  warning: { 
    icon: <AlertTriangle className="h-4 w-4" />, 
    className: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300" 
  },
  info: { 
    icon: <Info className="h-4 w-4" />, 
    className: "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300" 
  },
};

const typeConfig: Record<string, { icon: React.ReactNode; label: string }> = {
  send_failed: { icon: <Mail className="h-4 w-4" />, label: "Send Failed" },
  import_failed: { icon: <Upload className="h-4 w-4" />, label: "Import Failed" },
  import_row_failed: { icon: <Upload className="h-4 w-4" />, label: "Import Row Failed" },
  campaign_failed: { icon: <Server className="h-4 w-4" />, label: "Campaign Failed" },
  system_error: { icon: <AlertCircle className="h-4 w-4" />, label: "System Error" },
};

function ErrorLogRow({ log }: { log: ErrorLog }) {
  const [isOpen, setIsOpen] = useState(false);
  const severityCfg = severityConfig[log.severity] || severityConfig.error;
  const typeCfg = typeConfig[log.type] || { icon: <AlertCircle className="h-4 w-4" />, label: log.type };

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <TableRow className="group">
        <TableCell>
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="icon" className="h-6 w-6" data-testid={`button-expand-${log.id}`}>
              {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            </Button>
          </CollapsibleTrigger>
        </TableCell>
        <TableCell className="font-mono text-xs text-muted-foreground">
          {new Date(log.timestamp).toLocaleString()}
        </TableCell>
        <TableCell>
          <Badge variant="secondary" className={`gap-1 ${severityCfg.className}`}>
            {severityCfg.icon}
            {log.severity}
          </Badge>
        </TableCell>
        <TableCell>
          <Badge variant="outline" className="gap-1">
            {typeCfg.icon}
            {typeCfg.label}
          </Badge>
        </TableCell>
        <TableCell className="max-w-[300px] truncate" title={log.message}>
          {log.message}
        </TableCell>
        <TableCell className="text-muted-foreground">
          {log.email || "-"}
        </TableCell>
      </TableRow>
      <CollapsibleContent asChild>
        <TableRow className="bg-muted/30">
          <TableCell colSpan={6} className="p-4">
            <div className="space-y-3">
              <div>
                <span className="text-sm font-medium">Full Message:</span>
                <p className="text-sm text-muted-foreground mt-1 whitespace-pre-wrap">{log.message}</p>
              </div>
              {log.details && (
                <div>
                  <span className="text-sm font-medium">Details:</span>
                  <pre className="text-xs bg-muted p-3 rounded-md mt-1 overflow-x-auto whitespace-pre-wrap">
                    {log.details}
                  </pre>
                </div>
              )}
              <div className="flex gap-6 text-sm">
                {log.campaignId && (
                  <div>
                    <span className="text-muted-foreground">Campaign ID: </span>
                    <span className="font-mono">{log.campaignId}</span>
                  </div>
                )}
                {log.importJobId && (
                  <div>
                    <span className="text-muted-foreground">Import Job ID: </span>
                    <span className="font-mono">{log.importJobId}</span>
                  </div>
                )}
                {log.subscriberId && (
                  <div>
                    <span className="text-muted-foreground">Subscriber ID: </span>
                    <span className="font-mono">{log.subscriberId}</span>
                  </div>
                )}
              </div>
            </div>
          </TableCell>
        </TableRow>
      </CollapsibleContent>
    </Collapsible>
  );
}

export default function ErrorLogs() {
  const [page, setPage] = useState(1);
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [severityFilter, setSeverityFilter] = useState<string>("all");
  const [clearConfirm, setClearConfirm] = useState(false);
  const { toast } = useToast();

  const { data: logsData, isLoading: logsLoading, refetch } = useQuery<{ logs: ErrorLog[]; total: number }>({
    queryKey: ["/api/error-logs", page, typeFilter, severityFilter],
    queryFn: async () => {
      const params = new URLSearchParams({ page: String(page), limit: "50" });
      if (typeFilter !== "all") params.append("type", typeFilter);
      if (severityFilter !== "all") params.append("severity", severityFilter);
      const res = await fetch(`/api/error-logs?${params}`);
      if (!res.ok) throw new Error("Failed to fetch logs");
      return res.json();
    },
  });

  const { data: stats, isLoading: statsLoading } = useQuery<ErrorLogStats>({
    queryKey: ["/api/error-logs/stats"],
  });

  const clearMutation = useMutation({
    mutationFn: () => apiRequest("DELETE", "/api/error-logs"),
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/error-logs"] });
      queryClient.invalidateQueries({ queryKey: ["/api/error-logs/stats"] });
      setClearConfirm(false);
      toast({
        title: "Logs cleared",
        description: `${data.deleted} error logs have been deleted.`,
      });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to clear error logs. Please try again.",
        variant: "destructive",
      });
    },
  });

  const totalPages = logsData ? Math.ceil(logsData.total / 50) : 1;

  return (
    <div className="p-6 lg:p-8 space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Error Logs</h1>
          <p className="text-muted-foreground">
            Review and manage system errors, failed sends, and import issues
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => refetch()} data-testid="button-refresh-logs">
            <RefreshCw className="h-4 w-4 mr-2" />
            Refresh
          </Button>
          <Button 
            variant="destructive" 
            onClick={() => setClearConfirm(true)}
            disabled={!stats?.total}
            data-testid="button-clear-logs"
          >
            <Trash2 className="h-4 w-4 mr-2" />
            Clear All
          </Button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Total Errors</CardDescription>
            <CardTitle className="text-2xl" data-testid="stat-total-errors">
              {statsLoading ? <Skeleton className="h-8 w-16" /> : stats?.total.toLocaleString() || 0}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Last 24 Hours</CardDescription>
            <CardTitle className="text-2xl" data-testid="stat-last-24h">
              {statsLoading ? <Skeleton className="h-8 w-16" /> : stats?.last24Hours.toLocaleString() || 0}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Send Failures</CardDescription>
            <CardTitle className="text-2xl text-destructive" data-testid="stat-send-failures">
              {statsLoading ? <Skeleton className="h-8 w-16" /> : stats?.byType?.send_failed?.toLocaleString() || 0}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Import Failures</CardDescription>
            <CardTitle className="text-2xl text-yellow-600" data-testid="stat-import-failures">
              {statsLoading ? <Skeleton className="h-8 w-16" /> : ((stats?.byType?.import_failed || 0) + (stats?.byType?.import_row_failed || 0)).toLocaleString()}
            </CardTitle>
          </CardHeader>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-4 flex-wrap">
          <CardTitle className="flex items-center gap-2">
            <AlertCircle className="h-5 w-5" />
            Error Log History
          </CardTitle>
          <div className="flex gap-2 flex-wrap">
            <Select value={severityFilter} onValueChange={setSeverityFilter}>
              <SelectTrigger className="w-[140px]" data-testid="select-severity-filter">
                <SelectValue placeholder="Severity" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Severity</SelectItem>
                <SelectItem value="error">Error</SelectItem>
                <SelectItem value="warning">Warning</SelectItem>
                <SelectItem value="info">Info</SelectItem>
              </SelectContent>
            </Select>
            <Select value={typeFilter} onValueChange={setTypeFilter}>
              <SelectTrigger className="w-[180px]" data-testid="select-type-filter">
                <SelectValue placeholder="Type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Types</SelectItem>
                <SelectItem value="send_failed">Send Failed</SelectItem>
                <SelectItem value="import_failed">Import Failed</SelectItem>
                <SelectItem value="import_row_failed">Import Row Failed</SelectItem>
                <SelectItem value="campaign_failed">Campaign Failed</SelectItem>
                <SelectItem value="system_error">System Error</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent>
          {logsLoading ? (
            <div className="space-y-4">
              {[1, 2, 3, 4, 5].map((i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : logsData && logsData.logs.length > 0 ? (
            <>
              <div className="rounded-md border overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[40px]"></TableHead>
                      <TableHead>Timestamp</TableHead>
                      <TableHead>Severity</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Message</TableHead>
                      <TableHead>Email</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {logsData.logs.map((log) => (
                      <ErrorLogRow key={log.id} log={log} />
                    ))}
                  </TableBody>
                </Table>
              </div>
              
              {totalPages > 1 && (
                <div className="flex items-center justify-between mt-4">
                  <p className="text-sm text-muted-foreground">
                    Showing {((page - 1) * 50) + 1} to {Math.min(page * 50, logsData.total)} of {logsData.total} errors
                  </p>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setPage(p => Math.max(1, p - 1))}
                      disabled={page === 1}
                      data-testid="button-prev-page"
                    >
                      <ChevronLeft className="h-4 w-4 mr-1" />
                      Previous
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                      disabled={page === totalPages}
                      data-testid="button-next-page"
                    >
                      Next
                      <ChevronRight className="h-4 w-4 ml-1" />
                    </Button>
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <Clock className="h-16 w-16 text-muted-foreground/50 mb-4" />
              <h3 className="text-lg font-semibold mb-2">No errors found</h3>
              <p className="text-muted-foreground max-w-md">
                {typeFilter !== "all" || severityFilter !== "all"
                  ? "No errors match your current filters. Try adjusting the filters."
                  : "No errors have been logged yet. This is a good thing!"}
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={clearConfirm} onOpenChange={setClearConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Clear All Error Logs</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete all {stats?.total.toLocaleString()} error logs? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setClearConfirm(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => clearMutation.mutate()}
              disabled={clearMutation.isPending}
              data-testid="button-confirm-clear"
            >
              {clearMutation.isPending ? "Clearing..." : "Clear All Logs"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
