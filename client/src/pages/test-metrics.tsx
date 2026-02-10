import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useEffect, useState } from "react";
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
  FlaskConical,
  Play,
  Square,
  Trash2,
  RefreshCw,
  Mail,
  CheckCircle,
  XCircle,
  Clock,
  Zap,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface NullsinkMetrics {
  database: {
    totalEmails: number;
    successfulEmails: number;
    failedEmails: number;
    averageHandshakeTimeMs: number;
    averageTotalTimeMs: number;
    emailsPerSecond: number;
  };
  live: {
    totalEmails: number;
    successfulEmails: number;
    failedEmails: number;
    averageTimeMs: number;
    emailsPerSecond: number;
    isRunning: boolean;
    startTime: string | null;
  };
}

interface CapturedEmail {
  id: string;
  fromEmail: string;
  toEmail: string;
  subject: string;
  messageSize: number | null;
  handshakeTimeMs: number | null;
  totalTimeMs: number | null;
  status: string;
  timestamp: string;
  campaignId: string;
  subscriberId?: string | null;
  mtaId?: string | null;
}

interface CapturesResponse {
  captures: CapturedEmail[];
  total: number;
}

interface NullsinkStatus {
  running: boolean;
  config: {
    port: number;
    simulatedLatencyMs: number;
    failureRate: number;
  };
  metrics: {
    totalEmails: number;
    successfulEmails: number;
    failedEmails: number;
    averageTimeMs: number;
    emailsPerSecond: number;
    startTime: string | null;
  };
}

function StatCard({
  title,
  value,
  subValue,
  icon: Icon,
  isLoading,
}: {
  title: string;
  value: string | number;
  subValue?: string;
  icon: React.ComponentType<{ className?: string }>;
  isLoading: boolean;
}) {
  return (
    <Card>
      <CardContent className="p-6">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0 flex-1">
            {isLoading ? (
              <>
                <Skeleton className="h-4 w-20 mb-2" />
                <Skeleton className="h-8 w-16" />
              </>
            ) : (
              <>
                <p className="text-sm text-muted-foreground">{title}</p>
                <p className="text-3xl font-bold">{value}</p>
                {subValue && (
                  <p className="text-sm text-muted-foreground mt-1">{subValue}</p>
                )}
              </>
            )}
          </div>
          <div className="p-3 rounded-full bg-muted flex-shrink-0">
            <Icon className="h-6 w-6 text-muted-foreground" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default function TestMetrics() {
  const { toast } = useToast();
  const [page, setPage] = useState(1);
  const limit = 20;

  const { data: status, isLoading: statusLoading } = useQuery<NullsinkStatus>({
    queryKey: ["/api/nullsink/status"],
    refetchInterval: 2000,
  });

  const { data: metrics, isLoading: metricsLoading } = useQuery<NullsinkMetrics>({
    queryKey: ["/api/nullsink/metrics"],
    refetchInterval: 3000,
  });

  const { data: captures, isLoading: capturesLoading } = useQuery<CapturesResponse>({
    queryKey: ["/api/nullsink/captures", page, limit],
    refetchInterval: 3000,
  });

  const startMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/nullsink/start"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/nullsink/status"] });
      toast({ title: "Nullsink server started" });
    },
    onError: () => {
      toast({ title: "Failed to start server", variant: "destructive" });
    },
  });

  const stopMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/nullsink/stop"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/nullsink/status"] });
      toast({ title: "Nullsink server stopped" });
    },
    onError: () => {
      toast({ title: "Failed to stop server", variant: "destructive" });
    },
  });

  const clearMutation = useMutation({
    mutationFn: () => apiRequest("DELETE", "/api/nullsink/captures"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/nullsink/captures"] });
      queryClient.invalidateQueries({ queryKey: ["/api/nullsink/metrics"] });
      queryClient.invalidateQueries({ queryKey: ["/api/nullsink/status"] });
      toast({ title: "Test data cleared" });
    },
    onError: () => {
      toast({ title: "Failed to clear data", variant: "destructive" });
    },
  });

  const isRunning = status?.running ?? false;
  const dbMetrics = metrics?.database;
  const liveMetrics = metrics?.live || status?.metrics;
  const totalEmails = dbMetrics?.totalEmails ?? liveMetrics?.totalEmails ?? 0;
  const successfulEmails = dbMetrics?.successfulEmails ?? liveMetrics?.successfulEmails ?? 0;
  const failedEmails = dbMetrics?.failedEmails ?? liveMetrics?.failedEmails ?? 0;
  const successRate = totalEmails > 0 ? (successfulEmails / totalEmails * 100).toFixed(1) : "0.0";
  const failureRate = totalEmails > 0 ? (failedEmails / totalEmails * 100).toFixed(1) : "0.0";
  const avgTime = dbMetrics?.averageTotalTimeMs ?? liveMetrics?.averageTimeMs ?? 0;
  const emailsPerSecond = liveMetrics?.emailsPerSecond ?? dbMetrics?.emailsPerSecond ?? 0;

  const totalPages = captures ? Math.ceil(captures.total / limit) : 1;

  return (
    <div className="p-6 lg:p-8 space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-3" data-testid="text-page-title">
            <FlaskConical className="h-8 w-8" />
            Test Metrics Dashboard
          </h1>
          <p className="text-muted-foreground mt-1">
            Monitor nullsink/test mode campaigns and captured emails
          </p>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <Badge
            variant={isRunning ? "default" : "secondary"}
            className="gap-1"
            data-testid="badge-server-status"
          >
            <div className={`w-2 h-2 rounded-full ${isRunning ? "bg-green-400 animate-pulse" : "bg-gray-400"}`} />
            {isRunning ? "Running" : "Stopped"}
          </Badge>
          {isRunning ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => stopMutation.mutate()}
              disabled={stopMutation.isPending}
              data-testid="button-stop-server"
            >
              <Square className="h-4 w-4 mr-1" />
              Stop Server
            </Button>
          ) : (
            <Button
              variant="default"
              size="sm"
              onClick={() => startMutation.mutate()}
              disabled={startMutation.isPending}
              data-testid="button-start-server"
            >
              <Play className="h-4 w-4 mr-1" />
              Start Server
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => clearMutation.mutate()}
            disabled={clearMutation.isPending}
            data-testid="button-clear-data"
          >
            <Trash2 className="h-4 w-4 mr-1" />
            Clear Data
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <StatCard
          title="Total Emails"
          value={totalEmails.toLocaleString()}
          icon={Mail}
          isLoading={statusLoading && metricsLoading}
        />
        <StatCard
          title="Successful"
          value={successfulEmails.toLocaleString()}
          subValue={`${successRate}% success rate`}
          icon={CheckCircle}
          isLoading={statusLoading && metricsLoading}
        />
        <StatCard
          title="Failed"
          value={failedEmails.toLocaleString()}
          subValue={`${failureRate}% failure rate`}
          icon={XCircle}
          isLoading={statusLoading && metricsLoading}
        />
        <StatCard
          title="Throughput"
          value={`${emailsPerSecond.toFixed(2)}/s`}
          subValue={`Avg: ${avgTime.toFixed(0)}ms`}
          icon={Zap}
          isLoading={statusLoading && metricsLoading}
        />
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-4 space-y-0 pb-2">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Clock className="h-5 w-5" />
              Recent Captures
            </CardTitle>
            <CardDescription>
              Emails captured by the nullsink test server
            </CardDescription>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => {
              queryClient.invalidateQueries({ queryKey: ["/api/nullsink/captures"] });
            }}
            data-testid="button-refresh-captures"
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
        </CardHeader>
        <CardContent>
          {capturesLoading ? (
            <div className="space-y-3">
              {[1, 2, 3, 4, 5].map((i) => (
                <Skeleton key={i} className="h-12" />
              ))}
            </div>
          ) : captures?.captures && captures.captures.length > 0 ? (
            <>
              <div className="rounded-md border overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Timestamp</TableHead>
                      <TableHead>From</TableHead>
                      <TableHead>To</TableHead>
                      <TableHead>Subject</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Total Time</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {captures.captures.map((capture, index) => (
                      <TableRow key={capture.id || index} data-testid={`row-capture-${index}`}>
                        <TableCell className="font-mono text-xs">
                          {new Date(capture.timestamp).toLocaleString()}
                        </TableCell>
                        <TableCell className="font-mono text-xs truncate max-w-[150px]">
                          {capture.fromEmail}
                        </TableCell>
                        <TableCell className="font-mono text-xs truncate max-w-[150px]">
                          {capture.toEmail}
                        </TableCell>
                        <TableCell className="truncate max-w-[200px]">
                          {capture.subject || "(no subject)"}
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant={capture.status === "captured" ? "default" : "destructive"}
                            data-testid={`badge-status-${index}`}
                          >
                            {capture.status === "captured" ? "Captured" : "Failed"}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right font-mono text-sm">
                          {capture.totalTimeMs ?? 0}ms
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              {totalPages > 1 && (
                <div className="flex items-center justify-between gap-4 mt-4 flex-wrap">
                  <p className="text-sm text-muted-foreground">
                    Page {page} of {totalPages} ({captures.total} total)
                  </p>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setPage(p => Math.max(1, p - 1))}
                      disabled={page <= 1}
                      data-testid="button-prev-page"
                    >
                      Previous
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                      disabled={page >= totalPages}
                      data-testid="button-next-page"
                    >
                      Next
                    </Button>
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="text-center py-16 text-muted-foreground">
              <FlaskConical className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p>No captured emails yet</p>
              <p className="text-sm mt-1">
                {isRunning
                  ? "Send emails to the nullsink server to capture them"
                  : "Start the nullsink server and send test emails"}
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
