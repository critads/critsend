import { useState, useEffect, useCallback, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Activity,
  AlertTriangle,
  CheckCircle,
  RefreshCw,
  ShieldAlert,
  Database,
  Zap,
  Clock,
  XCircle,
  TrendingUp,
  Rocket,
  Loader2,
} from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface LabeledValue {
  labels: Record<string, string>;
  value: number;
}

interface Http5xxEntry {
  method: string;
  route: string;
  statusCode: string;
  count: number;
}

interface SystemMetrics {
  timestamp: string;
  uptimeSeconds: number;
  errors: {
    loadShedTotal: number;
    loadShedByReason: LabeledValue[];
    checkoutTimeouts: number;
    leaseExceeded: LabeledValue[];
    poolSaturationEvents: number;
    totalErrors: number;
    errorsByType: LabeledValue[];
    http5xx: Http5xxEntry[];
    total5xx: number;
    totalRequests: number;
    errorRate5xx: number;
  };
  pools: {
    main: {
      total: number;
      idle: number;
      waiting: number;
      max: number;
      saturation: number;
    };
    tracking: {
      inUse: number;
      max: number;
      total: number;
      idle: number;
      waiting: number;
    };
  };
  tracking: {
    bufferDepth: number;
    enqueued: number;
    flushed: number;
    dropped: number;
    droppedByReason: LabeledValue[];
    deduped: number;
  };
  bounces: {
    bufferDepth: number;
    enqueued: number;
    flushed: number;
    dropped: number;
    deduped: number;
    partialFailures: number;
    totalByType: LabeledValue[];
  };
  counterDrift: {
    fixed: LabeledValue[];
    lastRunMs: number;
    lastRunAt: number;
  };
  system: {
    heapUsedMB: number;
    heapTotalMB: number;
    rssMB: number;
    activeCampaigns: number;
    emailsSent: number;
    workerRestarts: number;
  };
  queues: {
    campaign: number;
    import: number;
    tag: number;
  };
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatNumber(n: number): string {
  return n.toLocaleString();
}

function formatTimestamp(ts: string): string {
  return new Date(ts).toLocaleString();
}

function formatEpoch(epoch: number): string {
  if (!epoch) return "Never";
  return new Date(epoch * 1000).toLocaleString();
}

function StatusDot({ status }: { status: "ok" | "warning" | "critical" }) {
  const color = status === "ok" ? "bg-amber-500" : status === "warning" ? "bg-yellow-500" : "bg-red-500";
  return <div className={`w-2.5 h-2.5 rounded-full ${color} inline-block`} />;
}

function PoolBar({ used, max, label }: { used: number; max: number; label: string }) {
  const pct = max > 0 ? Math.min((used / max) * 100, 100) : 0;
  const status = pct >= 90 ? "critical" : pct >= 70 ? "warning" : "ok";
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-sm">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono font-medium">{used}/{max}</span>
      </div>
      <Progress
        value={pct}
        className={`h-2 ${status === "critical" ? "[&>div]:bg-red-500" : status === "warning" ? "[&>div]:bg-yellow-500" : "[&>div]:bg-amber-500"}`}
      />
    </div>
  );
}

function MetricCard({ title, value, subtitle, icon: Icon, status }: {
  title: string;
  value: string | number;
  subtitle?: string;
  icon: any;
  status?: "ok" | "warning" | "critical";
}) {
  const borderClass = status === "critical"
    ? "border-red-500/30 dark:border-red-500/20"
    : status === "warning"
      ? "border-yellow-500/30 dark:border-yellow-500/20"
      : "";

  return (
    <Card className={borderClass}>
      <CardContent className="pt-6">
        <div className="flex items-start justify-between">
          <div className="space-y-1">
            <p className="text-sm text-muted-foreground">{title}</p>
            <p className="text-2xl font-bold font-mono" data-testid={`metric-${title.toLowerCase().replace(/\s+/g, "-")}`}>
              {typeof value === "number" ? formatNumber(value) : value}
            </p>
            {subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
          </div>
          <div className="p-2 rounded-lg bg-muted">
            <Icon className="h-5 w-5 text-muted-foreground" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function DeployCard() {
  const { toast } = useToast();
  const [confirming, setConfirming] = useState<"full" | "code-only" | null>(null);
  const [polling, setPolling] = useState(false);
  const logEndRef = useRef<HTMLPreElement>(null);

  const { data: deployStatus, refetch: refetchStatus } = useQuery<{
    status: string;
    startedAt?: string;
    finishedAt?: string;
    log?: string;
    exitCode?: number;
    mode?: string;
  }>({
    queryKey: ["/api/admin/deploy/status"],
    refetchInterval: polling ? 2000 : false,
  });

  useEffect(() => {
    if (deployStatus?.status === "running") {
      setPolling(true);
    } else if (polling && deployStatus?.status && deployStatus.status !== "running") {
      setPolling(false);
      if (deployStatus.status === "success") {
        toast({ title: "Deploy complete", description: "The application has been redeployed successfully." });
      } else if (deployStatus.status === "failed") {
        toast({ title: "Deploy failed", description: `Exit code: ${deployStatus.exitCode ?? "unknown"}`, variant: "destructive" });
      }
    }
  }, [deployStatus?.status]);

  useEffect(() => {
    if (logEndRef.current) {
      logEndRef.current.scrollTop = logEndRef.current.scrollHeight;
    }
  }, [deployStatus?.log]);

  const handleDeploy = async (mode: "full" | "code-only") => {
    setConfirming(null);
    try {
      await apiRequest("POST", "/api/admin/deploy", { skipSchema: mode === "code-only" });
      setPolling(true);
      refetchStatus();
      toast({
        title: "Deploy started",
        description: mode === "full"
          ? "Pulling code, rebuilding, and pushing schema..."
          : "Pulling code and rebuilding (no schema push)...",
      });
    } catch (err: any) {
      const msg = err?.message || "Failed to start deploy";
      toast({ title: "Deploy error", description: msg, variant: "destructive" });
    }
  };

  const handleCancel = async () => {
    try {
      await apiRequest("POST", "/api/admin/deploy/cancel");
      refetchStatus();
      toast({ title: "Deploy cancelled", description: "The running deploy has been stopped." });
    } catch (err: any) {
      const msg = err?.message || "Failed to cancel deploy";
      toast({ title: "Cancel error", description: msg, variant: "destructive" });
    }
  };

  const isRunning = deployStatus?.status === "running";
  const lastStatus = deployStatus?.status || "idle";
  const lastMode = deployStatus?.mode;

  return (
    <Card data-testid="card-deploy">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Rocket className="h-5 w-5 text-blue-500" />
            <CardTitle className="text-lg">Deploy</CardTitle>
          </div>
          <Badge variant={
            lastStatus === "running" ? "default" :
            lastStatus === "success" ? "secondary" :
            lastStatus === "failed" || lastStatus === "cancelled" ? "destructive" : "outline"
          } data-testid="badge-deploy-status">
            {lastStatus === "idle" ? "No deploys yet" :
             lastStatus === "running" ? "Deploying..." :
             lastStatus === "success" ? `Last deploy succeeded${lastMode ? ` (${lastMode})` : ""}` :
             lastStatus === "cancelled" ? "Last deploy cancelled" :
             "Last deploy failed"}
          </Badge>
        </div>
        <CardDescription>Pull latest code, rebuild, and reload the application</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {!confirming ? (
          isRunning ? (
            <div className="flex gap-2">
              <Button disabled className="flex-1" data-testid="button-deploy-running">
                <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Deploying...
              </Button>
              <Button
                onClick={handleCancel}
                variant="destructive"
                className="flex-none"
                data-testid="button-deploy-cancel-running"
              >
                <XCircle className="h-4 w-4 mr-2" /> Cancel
              </Button>
            </div>
          ) : (
            <div className="flex gap-2">
              <Button
                onClick={() => setConfirming("full")}
                className="flex-1"
                data-testid="button-deploy-full"
              >
                <Rocket className="h-4 w-4 mr-2" /> Deploy + Schema
              </Button>
              <Button
                onClick={() => setConfirming("code-only")}
                variant="secondary"
                className="flex-1"
                data-testid="button-deploy-code-only"
              >
                <Rocket className="h-4 w-4 mr-2" /> Deploy (code only)
              </Button>
            </div>
          )
        ) : (
          <div className="flex flex-col gap-2 p-3 border rounded-lg bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-800">
            <p className="text-sm font-medium text-amber-800 dark:text-amber-200">
              {confirming === "full"
                ? "This will pull latest code, rebuild, push schema changes to the database, and restart. The site may be briefly unavailable (~15s)."
                : "This will pull latest code, rebuild, and restart WITHOUT touching the database schema. Use this for code-only changes."}
            </p>
            <div className="flex gap-2">
              <Button size="sm" variant="destructive" onClick={() => handleDeploy(confirming)} data-testid="button-deploy-confirm">
                Yes, deploy{confirming === "full" ? " + schema" : " (code only)"}
              </Button>
              <Button size="sm" variant="outline" onClick={() => setConfirming(null)} data-testid="button-deploy-cancel">
                Cancel
              </Button>
            </div>
          </div>
        )}

        {deployStatus?.log && deployStatus.log.length > 0 && (
          <pre
            ref={logEndRef}
            className="mt-2 p-3 rounded-lg bg-zinc-950 text-zinc-200 text-xs font-mono max-h-64 overflow-y-auto whitespace-pre-wrap"
            data-testid="pre-deploy-log"
          >
            {deployStatus.log}
          </pre>
        )}

        {deployStatus?.startedAt && (
          <p className="text-xs text-muted-foreground">
            Started: {new Date(deployStatus.startedAt).toLocaleString()}
            {deployStatus.finishedAt && ` — Finished: ${new Date(deployStatus.finishedAt).toLocaleString()}`}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

export default function SystemMetricsPage() {
  const [autoRefresh, setAutoRefresh] = useState(true);

  const { data, isLoading, isError, error, refetch, dataUpdatedAt } = useQuery<SystemMetrics>({
    queryKey: ["/api/system-metrics"],
    refetchInterval: autoRefresh ? 10000 : false,
    retry: 2,
  });

  // Task #148: rolling-1h 503 attribution. Admin-gated; non-admin viewers
  // get a 403 which we silently swallow so the rest of the page keeps
  // rendering. Polls on the same cadence as the main metrics query.
  const { data: attribution } = useQuery<{
    windowMs: number;
    total: number;
    bySource: Record<string, number>;
    byRoute: Record<string, number>;
    byPair: Array<{ source: string; route: string; count: number }>;
    recent: Array<{
      ts: number; rid: string; method: string; path: string; route: string;
      source: string; kind?: string; code?: string;
      poolActive: number; poolIdle: number; poolTotal: number;
      poolMax: number; poolWaiting: number;
      poolSaturation: number; leaseHolding: number;
    }>;
    cumulative: { total: number; bySource: Record<string, number>; byRoute: Record<string, number> };
  }>({
    queryKey: ["/api/admin/503-attribution"],
    refetchInterval: autoRefresh ? 10000 : false,
    retry: false,
  });

  const handleRefresh = useCallback(() => { refetch(); }, [refetch]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "r" && !e.metaKey && !e.ctrlKey && !(e.target instanceof HTMLInputElement)) {
        handleRefresh();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleRefresh]);

  if (isLoading) {
    return (
      <div className="p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold">System Metrics</h1>
            <p className="text-muted-foreground">Loading...</p>
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Card key={i}><CardContent className="pt-6"><Skeleton className="h-16 w-full" /></CardContent></Card>
          ))}
        </div>
      </div>
    );
  }

  if (isError && !data) {
    return (
      <div className="p-6 space-y-6">
        <div>
          <h1 className="text-2xl font-semibold" data-testid="heading-system-metrics">System Metrics</h1>
          <p className="text-muted-foreground text-sm">Live server diagnostics</p>
        </div>
        <Card className="border-red-500/30">
          <CardContent className="pt-6">
            <div className="flex flex-col items-center gap-4 py-8">
              <XCircle className="h-10 w-10 text-red-500" />
              <div className="text-center">
                <p className="font-medium">Failed to load metrics</p>
                <p className="text-sm text-muted-foreground mt-1">
                  {error instanceof Error ? error.message : "Could not reach the server"}
                </p>
              </div>
              <Button variant="outline" onClick={handleRefresh} data-testid="button-retry-metrics">
                <RefreshCw className="h-4 w-4 mr-1" />
                Retry
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!data) return null;

  const errStatus = data.errors.total5xx > 0 || data.errors.loadShedTotal > 0 ? "critical"
    : data.errors.checkoutTimeouts > 0 || data.errors.poolSaturationEvents > 0 ? "warning" : "ok";

  const mainPoolPct = data.pools.main.max > 0 ? ((data.pools.main.total - data.pools.main.idle) / data.pools.main.max) : 0;
  const trackingPoolPct = data.pools.tracking.max > 0 ? ((data.pools.tracking.total - data.pools.tracking.idle) / data.pools.tracking.max) : 0;
  const poolStatus = mainPoolPct >= 0.9 || trackingPoolPct >= 0.9 ? "critical"
    : mainPoolPct >= 0.7 || trackingPoolPct >= 0.7 ? "warning" : "ok";

  const driftTotal = data.counterDrift.fixed.reduce((s, v) => s + v.value, 0);

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-semibold" data-testid="heading-system-metrics">System Metrics</h1>
          <p className="text-muted-foreground text-sm">
            Live server diagnostics since last restart ({formatUptime(data.uptimeSeconds)} ago)
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground">
            Updated {dataUpdatedAt ? new Date(dataUpdatedAt).toLocaleTimeString() : "—"}
          </span>
          <Button
            variant={autoRefresh ? "default" : "outline"}
            size="sm"
            onClick={() => setAutoRefresh(!autoRefresh)}
            data-testid="button-toggle-auto-refresh"
          >
            {autoRefresh ? "Auto-refresh ON" : "Auto-refresh OFF"}
          </Button>
          <Button variant="outline" size="sm" onClick={handleRefresh} data-testid="button-refresh-metrics">
            <RefreshCw className="h-4 w-4 mr-1" />
            Refresh
          </Button>
        </div>
      </div>

      <DeployCard />

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard
          title="5xx Errors"
          value={data.errors.total5xx}
          subtitle={`${data.errors.errorRate5xx.toFixed(3)}% of ${formatNumber(data.errors.totalRequests)} requests`}
          icon={XCircle}
          status={data.errors.total5xx > 0 ? "critical" : "ok"}
        />
        <MetricCard
          title="Load Shed (503)"
          value={data.errors.loadShedTotal}
          subtitle="Requests rejected due to pool pressure"
          icon={ShieldAlert}
          status={data.errors.loadShedTotal > 0 ? "critical" : "ok"}
        />
        <MetricCard
          title="Pool Timeouts"
          value={data.errors.checkoutTimeouts}
          subtitle="DB connection checkout failures"
          icon={Clock}
          status={data.errors.checkoutTimeouts > 0 ? "warning" : "ok"}
        />
        <MetricCard
          title="Tracking Drops"
          value={data.tracking.dropped}
          subtitle="Events lost (buffer full or write failure)"
          icon={AlertTriangle}
          status={data.tracking.dropped > 0 ? "critical" : "ok"}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Database className="h-5 w-5 text-muted-foreground" />
              <CardTitle className="text-lg">Connection Pools</CardTitle>
              <StatusDot status={poolStatus} />
            </div>
            <CardDescription>Database connection utilization</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <PoolBar
              used={data.pools.main.total - data.pools.main.idle}
              max={data.pools.main.max}
              label="Main Pool"
            />
            <div className="grid grid-cols-3 gap-2 text-xs text-center">
              <div>
                <span className="text-muted-foreground">Active</span>
                <p className="font-mono font-medium" data-testid="metric-main-pool-active">{data.pools.main.total - data.pools.main.idle}</p>
              </div>
              <div>
                <span className="text-muted-foreground">Idle</span>
                <p className="font-mono font-medium">{data.pools.main.idle}</p>
              </div>
              <div>
                <span className="text-muted-foreground">Waiting</span>
                <p className="font-mono font-medium" data-testid="metric-main-pool-waiting">
                  {data.pools.main.waiting > 0 ? (
                    <span className="text-red-500">{data.pools.main.waiting}</span>
                  ) : "0"}
                </p>
              </div>
            </div>

            <PoolBar
              used={data.pools.tracking.total - data.pools.tracking.idle}
              max={data.pools.tracking.max}
              label="Tracking Pool"
            />
            <div className="grid grid-cols-3 gap-2 text-xs text-center">
              <div>
                <span className="text-muted-foreground">Active</span>
                <p className="font-mono font-medium">{data.pools.tracking.total - data.pools.tracking.idle}</p>
              </div>
              <div>
                <span className="text-muted-foreground">Idle</span>
                <p className="font-mono font-medium">{data.pools.tracking.idle}</p>
              </div>
              <div>
                <span className="text-muted-foreground">Waiting</span>
                <p className="font-mono font-medium">
                  {data.pools.tracking.waiting > 0 ? (
                    <span className="text-red-500">{data.pools.tracking.waiting}</span>
                  ) : "0"}
                </p>
              </div>
            </div>

            <div className="pt-2 border-t text-xs space-y-1">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Pool saturation events</span>
                <span className="font-mono">{formatNumber(data.errors.poolSaturationEvents)}</span>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Zap className="h-5 w-5 text-muted-foreground" />
              <CardTitle className="text-lg">Tracking Buffer</CardTitle>
              <StatusDot status={data.tracking.dropped > 0 ? "critical" : "ok"} />
            </div>
            <CardDescription>Open/click event processing pipeline</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-4 mb-4">
              <div className="space-y-1">
                <span className="text-xs text-muted-foreground">Enqueued</span>
                <p className="text-lg font-mono font-medium" data-testid="metric-tracking-enqueued">{formatNumber(data.tracking.enqueued)}</p>
              </div>
              <div className="space-y-1">
                <span className="text-xs text-muted-foreground">Flushed to DB</span>
                <p className="text-lg font-mono font-medium">{formatNumber(data.tracking.flushed)}</p>
              </div>
              <div className="space-y-1">
                <span className="text-xs text-muted-foreground">Deduped</span>
                <p className="text-lg font-mono font-medium">{formatNumber(data.tracking.deduped)}</p>
              </div>
              <div className="space-y-1">
                <span className="text-xs text-muted-foreground">Dropped</span>
                <p className={`text-lg font-mono font-medium ${data.tracking.dropped > 0 ? "text-red-500" : ""}`} data-testid="metric-tracking-dropped">
                  {formatNumber(data.tracking.dropped)}
                </p>
              </div>
            </div>
            <div className="text-xs flex justify-between border-t pt-2">
              <span className="text-muted-foreground">Buffer depth (pending flush)</span>
              <span className="font-mono">{formatNumber(data.tracking.bufferDepth)}</span>
            </div>
            {data.tracking.droppedByReason.length > 0 && data.tracking.dropped > 0 && (
              <div className="mt-3 p-2 rounded bg-red-500/10 text-xs space-y-1">
                <span className="font-medium text-red-600 dark:text-red-400">Drop breakdown:</span>
                {data.tracking.droppedByReason.filter(v => v.value > 0).map((v, i) => (
                  <div key={i} className="flex justify-between">
                    <span>{v.labels.reason || "unknown"}</span>
                    <span className="font-mono">{formatNumber(v.value)}</span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {data.errors.http5xx.length > 0 && (
        <Card className="border-red-500/30 dark:border-red-500/20">
          <CardHeader>
            <div className="flex items-center gap-2">
              <XCircle className="h-5 w-5 text-red-500" />
              <CardTitle className="text-lg">HTTP 5xx Errors</CardTitle>
              <Badge variant="destructive">{formatNumber(data.errors.total5xx)} total</Badge>
            </div>
            <CardDescription>Server errors by route (since last restart)</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Method</TableHead>
                  <TableHead>Route</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Count</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.errors.http5xx
                  .sort((a, b) => b.count - a.count)
                  .map((row, i) => (
                    <TableRow key={i}>
                      <TableCell className="font-mono text-sm">{row.method}</TableCell>
                      <TableCell className="font-mono text-sm">{row.route}</TableCell>
                      <TableCell>
                        <Badge variant={row.statusCode === "503" ? "secondary" : "destructive"}>
                          {row.statusCode}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right font-mono">{formatNumber(row.count)}</TableCell>
                    </TableRow>
                  ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {attribution && (attribution.total > 0 || attribution.cumulative.total > 0) && (
        <Card data-testid="card-503-attribution" className="border-amber-500/30 dark:border-amber-500/20">
          <CardHeader>
            <div className="flex items-center gap-2">
              <ShieldAlert className="h-5 w-5 text-amber-500" />
              <CardTitle className="text-lg">503 Attribution (last 1h)</CardTitle>
              <Badge variant="secondary" data-testid="badge-503-window-total">
                {formatNumber(attribution.total)} in window · {formatNumber(attribution.cumulative.total)} since boot
              </Badge>
            </div>
            <CardDescription>
              Every 503 (`service_busy`) by source × route. Sources: load_shed, lease_exceeded,
              checkout_timeout, handler_transient, memory_pressure.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {attribution.byPair.length > 0 ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Source</TableHead>
                    <TableHead>Route</TableHead>
                    <TableHead className="text-right">Count (1h)</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {attribution.byPair.slice(0, 12).map((p, i) => (
                    <TableRow key={i} data-testid={`row-503-pair-${i}`}>
                      <TableCell>
                        <Badge variant="outline" className="font-mono">{p.source}</Badge>
                      </TableCell>
                      <TableCell className="font-mono text-sm">{p.route}</TableCell>
                      <TableCell className="text-right font-mono">{formatNumber(p.count)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <p className="text-sm text-muted-foreground">No 503 events in the last hour.</p>
            )}
            {attribution.recent.length > 0 && (
              <div>
                <p className="text-xs text-muted-foreground mb-2">
                  Most recent {attribution.recent.length} events
                </p>
                <div className="rounded border max-h-64 overflow-y-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>When</TableHead>
                        <TableHead>Source</TableHead>
                        <TableHead>Route</TableHead>
                        <TableHead>Pool</TableHead>
                        <TableHead className="text-right">Lease</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {[...attribution.recent].reverse().map((e, i) => (
                        <TableRow key={`${e.ts}-${e.rid}-${i}`} data-testid={`row-503-event-${i}`}>
                          <TableCell className="font-mono text-xs whitespace-nowrap">
                            {new Date(e.ts).toLocaleTimeString()}
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline" className="font-mono text-xs">{e.source}{e.kind ? `:${e.kind}` : ""}</Badge>
                          </TableCell>
                          <TableCell className="font-mono text-xs">{e.method} {e.route}</TableCell>
                          <TableCell className="font-mono text-xs">
                            {e.poolActive}/{e.poolMax} idle={e.poolIdle} total={e.poolTotal} w={e.poolWaiting} sat={e.poolSaturation.toFixed(2)}
                          </TableCell>
                          <TableCell className="text-right font-mono text-xs">{e.leaseHolding}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Activity className="h-5 w-5 text-muted-foreground" />
              <CardTitle className="text-lg">Bounce Buffer</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <span className="text-xs text-muted-foreground">Enqueued</span>
                <p className="font-mono font-medium">{formatNumber(data.bounces.enqueued)}</p>
              </div>
              <div>
                <span className="text-xs text-muted-foreground">Flushed</span>
                <p className="font-mono font-medium">{formatNumber(data.bounces.flushed)}</p>
              </div>
              <div>
                <span className="text-xs text-muted-foreground">Dropped</span>
                <p className={`font-mono font-medium ${data.bounces.dropped > 0 ? "text-red-500" : ""}`}>
                  {formatNumber(data.bounces.dropped)}
                </p>
              </div>
              <div>
                <span className="text-xs text-muted-foreground">Deduped</span>
                <p className="font-mono font-medium">{formatNumber(data.bounces.deduped)}</p>
              </div>
            </div>
            {data.bounces.totalByType.length > 0 && (
              <div className="mt-3 pt-2 border-t space-y-1">
                <span className="text-xs text-muted-foreground">Events by type:</span>
                {data.bounces.totalByType.filter(v => v.value > 0).map((v, i) => (
                  <div key={i} className="flex justify-between text-xs">
                    <span>{v.labels.type || "unknown"}</span>
                    <span className="font-mono">{formatNumber(v.value)}</span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <TrendingUp className="h-5 w-5 text-muted-foreground" />
              <CardTitle className="text-lg">Counter Drift</CardTitle>
              <StatusDot status={driftTotal > 0 ? "warning" : "ok"} />
            </div>
            <CardDescription>Reconciler corrections (should be 0)</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {data.counterDrift.fixed.length > 0 ? (
                data.counterDrift.fixed.map((v, i) => (
                  <div key={i} className="flex justify-between text-sm">
                    <span className="text-muted-foreground">{v.labels.counter || "unknown"}</span>
                    <span className={`font-mono font-medium ${v.value > 0 ? "text-yellow-600 dark:text-yellow-400" : ""}`}>
                      {formatNumber(v.value)}
                    </span>
                  </div>
                ))
              ) : (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <CheckCircle className="h-4 w-4 text-amber-500" />
                  No drift corrections needed
                </div>
              )}
              <div className="pt-2 border-t text-xs space-y-1">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Last run duration</span>
                  <span className="font-mono">{data.counterDrift.lastRunMs > 0 ? `${Math.round(data.counterDrift.lastRunMs)}ms` : "—"}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Last run</span>
                  <span className="font-mono text-[11px]">{formatEpoch(data.counterDrift.lastRunAt)}</span>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Activity className="h-5 w-5 text-muted-foreground" />
              <CardTitle className="text-lg">System</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Uptime</span>
                <span className="font-mono font-medium">{formatUptime(data.uptimeSeconds)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Memory (Heap)</span>
                <span className="font-mono">{data.system.heapUsedMB} / {data.system.heapTotalMB} MB</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Memory (RSS)</span>
                <span className="font-mono">{data.system.rssMB} MB</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Active campaigns</span>
                <span className="font-mono">{data.system.activeCampaigns}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Emails sent</span>
                <span className="font-mono">{formatNumber(data.system.emailsSent)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Worker restarts</span>
                <span className={`font-mono ${data.system.workerRestarts > 0 ? "text-yellow-600" : ""}`}>
                  {formatNumber(data.system.workerRestarts)}
                </span>
              </div>
              <div className="pt-2 border-t">
                <span className="text-muted-foreground text-xs">Job Queues</span>
                <div className="grid grid-cols-3 gap-2 mt-1 text-xs text-center">
                  <div>
                    <span className="text-muted-foreground">Campaign</span>
                    <p className="font-mono font-medium">{data.queues.campaign}</p>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Import</span>
                    <p className="font-mono font-medium">{data.queues.import}</p>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Tag</span>
                    <p className="font-mono font-medium">{data.queues.tag}</p>
                  </div>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {data.errors.errorsByType.length > 0 && data.errors.totalErrors > 0 && (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-muted-foreground" />
              <CardTitle className="text-lg">Errors by Type</CardTitle>
              <Badge variant="outline">{formatNumber(data.errors.totalErrors)} total</Badge>
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {data.errors.errorsByType.filter(v => v.value > 0).map((v, i) => (
                <div key={i} className="p-3 rounded-lg bg-muted/50">
                  <span className="text-xs text-muted-foreground">{v.labels.type || "unknown"}</span>
                  <p className="text-lg font-mono font-medium">{formatNumber(v.value)}</p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {data.errors.loadShedByReason.length > 0 && data.errors.loadShedTotal > 0 && (
        <Card className="border-red-500/30 dark:border-red-500/20">
          <CardHeader>
            <div className="flex items-center gap-2">
              <ShieldAlert className="h-5 w-5 text-red-500" />
              <CardTitle className="text-lg">Load Shed Breakdown</CardTitle>
            </div>
            <CardDescription>Requests rejected with 503 "service_busy"</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Reason</TableHead>
                  <TableHead>Route</TableHead>
                  <TableHead className="text-right">Count</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.errors.loadShedByReason
                  .filter(v => v.value > 0)
                  .sort((a, b) => b.value - a.value)
                  .map((v, i) => (
                    <TableRow key={i}>
                      <TableCell className="font-mono text-sm">{v.labels.reason || "—"}</TableCell>
                      <TableCell className="font-mono text-sm">{v.labels.route || "—"}</TableCell>
                      <TableCell className="text-right font-mono">{formatNumber(v.value)}</TableCell>
                    </TableRow>
                  ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
