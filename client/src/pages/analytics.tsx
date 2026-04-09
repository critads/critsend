import { useQuery } from "@tanstack/react-query";
import { useState, useEffect, useRef } from "react";
import { useRoute, Link } from "wouter";
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
  BarChart3,
  Eye,
  MousePointer2,
  Users,
  ArrowLeft,
  TrendingUp,
  Mail,
  Link as LinkIcon,
  Globe,
  UserMinus,
  AtSign,
  Monitor,
  Smartphone,
  Chrome,
  Flame,
  ChevronDown,
  ChevronUp,
  Layers,
} from "lucide-react";
import {
  BarChart,
  Bar,
  Cell,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ResponsiveContainer,
} from "recharts";
import type { Campaign } from "@shared/schema";

interface CampaignAnalytics {
  campaign: Campaign;
  totalOpens: number;
  uniqueOpens: number;
  totalClicks: number;
  uniqueClicks: number;
  unsubscribeCount: number;
  openRate: number;
  clickRate: number;
  topLinks: Array<{ url: string; clicks: number; uniqueClickers: number }>;
  topOpenerIps: Array<{ ip: string; count: number }>;
  recentActivity: Array<{
    email: string;
    type: string;
    timestamp: string;
    link?: string;
  }>;
}

interface OverallAnalytics {
  totalOpens: number;
  totalClicks: number;
  totalCampaigns: number;
  avgOpenRate: number;
  avgClickRate: number;
  recentCampaigns: Array<{
    id: string;
    name: string;
    openRate: number;
    clickRate: number;
    sentCount: number;
  }>;
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
        <div className="flex items-center justify-between">
          <div>
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
          <div className="p-3 rounded-full bg-muted">
            <Icon className="h-6 w-6 text-muted-foreground" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

interface DeviceStats {
  deviceTypes: Array<{ value: string; count: number }>;
  browsers: Array<{ value: string; count: number }>;
  operatingSystems: Array<{ value: string; count: number }>;
}

interface ProviderOpenRate {
  provider: string;
  recipients: number;
  uniqueOpeners: number;
  openRate: number;
}

interface BatchOpenStat {
  batchNum: number;
  sent: number;
  opened: number;
  openRate: number;
  batchStart: string;
  batchEnd: string;
}

interface HeatmapData {
  links: Array<{ url: string; clicks: number; uniqueClickers: number; pct: number }>;
  totalClicks: number;
}

function BreakdownCard({
  title,
  icon: Icon,
  rows,
  isLoading,
}: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  rows: Array<{ value: string; count: number }> | undefined;
  isLoading: boolean;
}) {
  const total = rows?.reduce((sum, r) => sum + r.count, 0) ?? 0;
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Icon className="h-4 w-4" />
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => <Skeleton key={i} className="h-8" />)}
          </div>
        ) : rows && rows.length > 0 ? (
          <div className="space-y-3">
            {rows.map((row) => {
              const pct = total > 0 ? (row.count / total) * 100 : 0;
              return (
                <div key={row.value}>
                  <div className="flex justify-between text-sm mb-1">
                    <span className="font-medium truncate max-w-[60%]">{row.value}</span>
                    <span className="text-muted-foreground tabular-nums">
                      {row.count.toLocaleString()} <span className="text-xs">({pct.toFixed(1)}%)</span>
                    </span>
                  </div>
                  <div className="h-2 rounded-full bg-muted overflow-hidden">
                    <div
                      className="h-full rounded-full bg-primary transition-all"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="text-center py-6 text-sm text-muted-foreground">No data yet</p>
        )}
      </CardContent>
    </Card>
  );
}

function LinkSummaryTable({
  links,
  totalClicks,
}: {
  links: HeatmapData["links"];
  totalClicks: number;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="flex w-full items-center justify-between rounded-md border px-4 py-2.5 text-sm font-semibold hover:bg-muted/50 transition-colors"
        data-testid="button-toggle-link-summary"
      >
        <span>Link Summary — {totalClicks.toLocaleString()} total clicks · {links.length} link{links.length !== 1 ? "s" : ""}</span>
        {open ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
      </button>
      {open && (
        <div className="mt-3 rounded-md border overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8">#</TableHead>
                <TableHead>URL</TableHead>
                <TableHead className="text-right w-28">Clicks</TableHead>
                <TableHead className="text-right w-32">Unique</TableHead>
                <TableHead className="text-right w-24">Share</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {links.map((link, index) => {
                const color =
                  link.pct >= 30 ? "bg-red-500" :
                  link.pct >= 10 ? "bg-orange-500" :
                  link.pct >= 3  ? "bg-yellow-500" :
                  link.clicks > 0 ? "bg-green-500" : "bg-gray-400";
                return (
                  <TableRow key={`${link.url}-${index}`} data-testid={`row-heatmap-${index}`}>
                    <TableCell className="text-muted-foreground">{index + 1}</TableCell>
                    <TableCell>
                      <a
                        href={link.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-mono text-xs text-primary underline underline-offset-2 break-all line-clamp-2"
                      >
                        {link.url}
                      </a>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {link.clicks.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground text-sm">
                      {link.uniqueClickers.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right">
                      <Badge className={`${color} text-white border-0`}>
                        {link.pct.toFixed(1)}%
                      </Badge>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

const BATCH_SIZE_OPTIONS = [
  { label: "1,000", value: 1000 },
  { label: "5,000", value: 5000 },
  { label: "10,000", value: 10000 },
  { label: "25,000", value: 25000 },
  { label: "50,000", value: 50000 },
];

function batchBarColor(openRate: number): string {
  if (openRate >= 20) return "#22c55e";
  if (openRate >= 10) return "#eab308";
  return "#ef4444";
}

function formatShortDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

interface BatchChartEntry {
  name: string;
  label: string;
  dateRange: string;
  openRate: number;
  sent: number;
  opened: number;
}

function BatchTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: BatchChartEntry; value: number }> }) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className="rounded-md border bg-popover px-3 py-2 text-xs shadow-md space-y-0.5">
      <p className="font-semibold">{d.label}</p>
      <p className="text-muted-foreground">{d.dateRange}</p>
      <p>{d.openRate.toFixed(2)}% open rate</p>
      <p>{d.opened.toLocaleString()} opened / {d.sent.toLocaleString()} sent</p>
    </div>
  );
}

function BatchOpenRateCard({ campaignId }: { campaignId: string }) {
  const [batchSize, setBatchSize] = useState(10000);

  const { data, isLoading, isError } = useQuery<BatchOpenStat[]>({
    queryKey: ["/api/analytics/campaign", campaignId, "batch-opens", batchSize],
    queryFn: () =>
      fetch(`/api/analytics/campaign/${campaignId}/batch-opens?batchSize=${batchSize}`)
        .then((r) => {
          if (!r.ok) throw new Error("not_found");
          return r.json();
        }),
    retry: false,
  });

  const chartData = (data ?? []).map((b) => ({
    name: `Batch ${b.batchNum}\n${formatShortDate(b.batchStart)}–${formatShortDate(b.batchEnd)}`,
    label: `Batch ${b.batchNum}`,
    dateRange: `${formatShortDate(b.batchStart)}–${formatShortDate(b.batchEnd)}`,
    openRate: b.openRate,
    sent: b.sent,
    opened: b.opened,
  }));

  return (
    <Card data-testid="card-batch-open-rate">
      <CardHeader>
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Layers className="h-5 w-5" />
              Batch Open Rate Analysis
            </CardTitle>
            <CardDescription>
              Open rate per chronological batch of sent emails — helps identify if early batches perform differently
            </CardDescription>
          </div>
          <Select
            value={String(batchSize)}
            onValueChange={(v) => setBatchSize(Number(v))}
          >
            <SelectTrigger className="w-36" data-testid="select-batch-size">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {BATCH_SIZE_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={String(opt.value)}>
                  {opt.label} / batch
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-48 w-full" />
            <Skeleton className="h-32 w-full" />
          </div>
        ) : isError || !data ? (
          <p className="text-center py-10 text-muted-foreground text-sm">
            No send data available yet for this campaign.
          </p>
        ) : data.length === 1 ? (
          <div className="flex flex-col items-center gap-2 py-6 text-center">
            <p className="text-muted-foreground text-sm">
              All {data[0].sent.toLocaleString()} emails were sent in a single batch.
            </p>
            <div className="flex gap-6 mt-2">
              <div>
                <p className="text-2xl font-bold">{data[0].openRate.toFixed(2)}%</p>
                <p className="text-xs text-muted-foreground">Open rate</p>
              </div>
              <div>
                <p className="text-2xl font-bold">{data[0].opened.toLocaleString()}</p>
                <p className="text-xs text-muted-foreground">Unique openers</p>
              </div>
              <div>
                <p className="text-2xl font-bold">{data[0].sent.toLocaleString()}</p>
                <p className="text-xs text-muted-foreground">Sent</p>
              </div>
            </div>
          </div>
        ) : (
          <div className="space-y-6">
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} className="stroke-muted" />
                  <XAxis
                    dataKey="name"
                    tick={{ fontSize: 11 }}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis
                    tickFormatter={(v) => `${v}%`}
                    tick={{ fontSize: 11 }}
                    tickLine={false}
                    axisLine={false}
                    width={42}
                  />
                  <Tooltip content={<BatchTooltip />} />
                  <Bar dataKey="openRate" radius={[3, 3, 0, 0]}>
                    {chartData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={batchBarColor(entry.openRate)} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="flex flex-wrap gap-3 text-xs text-muted-foreground justify-end">
              <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded-sm bg-[#22c55e]" /> ≥20%</span>
              <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded-sm bg-[#eab308]" /> ≥10%</span>
              <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded-sm bg-[#ef4444]" /> &lt;10%</span>
            </div>
            <div className="rounded-md border overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Batch</TableHead>
                    <TableHead>Sent from – to</TableHead>
                    <TableHead className="text-right">Sent</TableHead>
                    <TableHead className="text-right">Opened</TableHead>
                    <TableHead className="text-right">Open Rate</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.map((b) => (
                    <TableRow key={b.batchNum} data-testid={`row-batch-${b.batchNum}`}>
                      <TableCell className="font-medium">#{b.batchNum}</TableCell>
                      <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                        {formatShortDate(b.batchStart)} – {formatShortDate(b.batchEnd)}
                      </TableCell>
                      <TableCell className="text-right">{b.sent.toLocaleString()}</TableCell>
                      <TableCell className="text-right">{b.opened.toLocaleString()}</TableCell>
                      <TableCell className="text-right">
                        <Badge
                          variant={b.openRate >= 10 ? "default" : b.openRate >= 3 ? "secondary" : "outline"}
                        >
                          {b.openRate.toFixed(2)}%
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function CampaignAnalyticsView({ campaignId }: { campaignId: string }) {
  const { data, isLoading } = useQuery<CampaignAnalytics>({
    queryKey: ["/api/analytics/campaign", campaignId],
  });

  const { data: providerRates, isLoading: providerLoading } = useQuery<ProviderOpenRate[]>({
    queryKey: ["/api/analytics/campaign", campaignId, "provider-open-rates"],
    queryFn: () =>
      fetch(`/api/analytics/campaign/${campaignId}/provider-open-rates`)
        .then(r => r.json()),
  });

  const { data: deviceStats, isLoading: deviceLoading } = useQuery<DeviceStats>({
    queryKey: ["/api/analytics/campaign", campaignId, "device-stats"],
    queryFn: () =>
      fetch(`/api/analytics/campaign/${campaignId}/device-stats`)
        .then(r => r.json()),
  });

  const { data: heatmapData } = useQuery<HeatmapData>({
    queryKey: ["/api/analytics/campaign", campaignId, "heatmap-data"],
    queryFn: () =>
      fetch(`/api/analytics/campaign/${campaignId}/heatmap-data`)
        .then(r => r.json()),
  });

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [iframeHeight, setIframeHeight] = useState(600);
  const [iframeLoaded, setIframeLoaded] = useState(false);

  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (
        e.origin !== window.location.origin ||
        e.source !== iframeRef.current?.contentWindow
      ) return;
      if (e.data?.type === "hm-height" && typeof e.data.height === "number") {
        setIframeHeight(Math.min(e.data.height + 40, 2400));
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link href="/analytics">
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-5 w-5" />
          </Button>
        </Link>
        <div>
          <h1 className="text-3xl font-bold tracking-tight">
            {isLoading ? <Skeleton className="h-8 w-48" /> : data?.campaign.name}
          </h1>
          <p className="text-muted-foreground">Campaign Analytics</p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <StatCard
          title="Unique Openers"
          value={data?.uniqueOpens.toLocaleString() ?? 0}
          subValue={data ? `${data.openRate.toFixed(1)}% open rate` : undefined}
          icon={Eye}
          isLoading={isLoading}
        />
        <StatCard
          title="Unique Clickers"
          value={data?.uniqueClicks.toLocaleString() ?? 0}
          subValue={data ? `${data.clickRate.toFixed(1)}% click rate` : undefined}
          icon={MousePointer2}
          isLoading={isLoading}
        />
        <StatCard
          title="Unsubscribes"
          value={data?.unsubscribeCount.toLocaleString() ?? 0}
          subValue={
            data && data.campaign.sentCount > 0
              ? `${((data.unsubscribeCount / data.campaign.sentCount) * 100).toFixed(2)}% unsub rate`
              : undefined
          }
          icon={UserMinus}
          isLoading={isLoading}
        />
        <StatCard
          title="Emails Sent"
          value={data?.campaign.sentCount?.toLocaleString() ?? 0}
          icon={Mail}
          isLoading={isLoading}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <LinkIcon className="h-5 w-5" />
              Top Links
            </CardTitle>
            <CardDescription>Most clicked links in this campaign</CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="space-y-3">
                {[1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-12" />
                ))}
              </div>
            ) : data?.topLinks && data.topLinks.length > 0 ? (
              <div className="space-y-3">
                {data.topLinks.map((link, index) => (
                  <div
                    key={index}
                    className="flex items-center justify-between p-3 rounded-md bg-muted/50"
                  >
                    <span className="text-sm font-mono truncate max-w-[300px]">
                      {link.url}
                    </span>
                    <div className="flex items-center gap-2 shrink-0 ml-2">
                      <Badge variant="default">{link.uniqueClickers} unique</Badge>
                      <Badge variant="secondary">{link.clicks} total</Badge>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-center py-8 text-muted-foreground">
                No click data yet
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Recent Activity</CardTitle>
            <CardDescription>Latest opens and clicks</CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="space-y-3">
                {[1, 2, 3, 4, 5].map((i) => (
                  <Skeleton key={i} className="h-10" />
                ))}
              </div>
            ) : data?.recentActivity && data.recentActivity.length > 0 ? (
              <div className="space-y-2">
                {data.recentActivity.slice(0, 10).map((activity, index) => (
                  <div
                    key={index}
                    className="flex items-center justify-between text-sm py-2 border-b last:border-0"
                  >
                    <div className="flex items-center gap-2">
                      {activity.type === "open" ? (
                        <Eye className="h-4 w-4 text-blue-500" />
                      ) : activity.type === "unsubscribe" ? (
                        <UserMinus className="h-4 w-4 text-red-500" />
                      ) : (
                        <MousePointer2 className="h-4 w-4 text-green-500" />
                      )}
                      <span className="font-mono text-xs truncate max-w-[180px]">
                        {activity.email}
                      </span>
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {new Date(activity.timestamp).toLocaleString()}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-center py-8 text-muted-foreground">
                No activity yet
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Globe className="h-5 w-5" />
            Top Opener IPs
          </CardTitle>
          <CardDescription>
            Top 30 IP addresses that opened this campaign (all open events, one row per IP)
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-2">
              {[1, 2, 3, 4, 5].map((i) => (
                <Skeleton key={i} className="h-10" />
              ))}
            </div>
          ) : data?.topOpenerIps && data.topOpenerIps.length > 0 ? (
            <div className="rounded-md border overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8">#</TableHead>
                    <TableHead>IP Address</TableHead>
                    <TableHead className="text-right">Open Events</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.topOpenerIps.map((row, index) => (
                    <TableRow key={row.ip} data-testid={`row-ip-${index}`}>
                      <TableCell className="text-muted-foreground">{index + 1}</TableCell>
                      <TableCell className="font-mono text-sm">{row.ip}</TableCell>
                      <TableCell className="text-right">
                        <Badge variant="secondary">{row.count}</Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <p className="text-center py-8 text-muted-foreground">
              No opener IP data yet
            </p>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <BreakdownCard
          title="Device Type"
          icon={Monitor}
          rows={deviceStats?.deviceTypes}
          isLoading={deviceLoading}
        />
        <BreakdownCard
          title="Browser"
          icon={Chrome}
          rows={deviceStats?.browsers}
          isLoading={deviceLoading}
        />
        <BreakdownCard
          title="Operating System"
          icon={Smartphone}
          rows={deviceStats?.operatingSystems}
          isLoading={deviceLoading}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AtSign className="h-5 w-5" />
            Open Rate by Email Provider
          </CardTitle>
          <CardDescription>
            Unique openers vs. recipients per domain (top 50 providers by volume)
          </CardDescription>
        </CardHeader>
        <CardContent>
          {providerLoading ? (
            <div className="space-y-2">
              {[1, 2, 3, 4, 5].map((i) => (
                <Skeleton key={i} className="h-10" />
              ))}
            </div>
          ) : providerRates && providerRates.length > 0 ? (
            <div className="rounded-md border overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8">#</TableHead>
                    <TableHead>Provider</TableHead>
                    <TableHead className="text-right">Recipients</TableHead>
                    <TableHead className="text-right">Unique Openers</TableHead>
                    <TableHead className="text-right">Open Rate</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {providerRates.map((row, index) => (
                    <TableRow key={row.provider} data-testid={`row-provider-${index}`}>
                      <TableCell className="text-muted-foreground">{index + 1}</TableCell>
                      <TableCell className="font-mono text-sm">{row.provider}</TableCell>
                      <TableCell className="text-right">
                        {row.recipients.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right">
                        {row.uniqueOpeners.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right">
                        <Badge
                          variant={row.openRate >= 10 ? "default" : row.openRate >= 3 ? "secondary" : "outline"}
                        >
                          {row.openRate.toFixed(2)}%
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <p className="text-center py-8 text-muted-foreground">
              No provider data yet
            </p>
          )}
        </CardContent>
      </Card>

      {heatmapData && heatmapData.totalClicks > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Flame className="h-5 w-5" />
              Click Heatmap
            </CardTitle>
            <CardDescription>
              Visual overlay showing clicks per link in the campaign email
            </CardDescription>
            <div className="flex flex-wrap items-center gap-3 pt-1 text-xs text-muted-foreground">
              <span className="font-semibold">Legend:</span>
              <span className="flex items-center gap-1">
                <span className="inline-block w-3 h-3 rounded-full bg-[#ef4444]" /> ≥30%
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block w-3 h-3 rounded-full bg-[#f97316]" /> ≥10%
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block w-3 h-3 rounded-full bg-[#eab308]" /> ≥3%
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block w-3 h-3 rounded-full bg-[#22c55e]" /> &gt;0%
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block w-3 h-3 rounded-full bg-[#9ca3af]" /> 0 clicks
              </span>
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="relative rounded-md border overflow-hidden bg-white">
              {!iframeLoaded && (
                <div className="absolute inset-0 flex items-center justify-center bg-muted/60 z-10 min-h-[400px]">
                  <Skeleton className="w-full h-full min-h-[400px]" />
                </div>
              )}
              <iframe
                ref={iframeRef}
                src={`/api/analytics/campaign/${campaignId}/heatmap`}
                title="Click Heatmap"
                width="100%"
                height={iframeHeight}
                style={{ border: "none", display: "block" }}
                sandbox="allow-scripts allow-same-origin"
                onLoad={() => setIframeLoaded(true)}
                data-testid="iframe-click-heatmap"
              />
            </div>

            <LinkSummaryTable links={heatmapData.links} totalClicks={heatmapData.totalClicks} />
          </CardContent>
        </Card>
      )}

      {data && data.campaign.sentCount > 0 && (
        <BatchOpenRateCard campaignId={campaignId} />
      )}
    </div>
  );
}

function OverallAnalyticsView() {
  const { data, isLoading } = useQuery<OverallAnalytics>({
    queryKey: ["/api/analytics/overall"],
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Analytics</h1>
        <p className="text-muted-foreground">
          Track opens, clicks, and engagement across all campaigns
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <StatCard
          title="Total Campaigns"
          value={data?.totalCampaigns.toLocaleString() || 0}
          icon={Mail}
          isLoading={isLoading}
        />
        <StatCard
          title="Total Unique Openers"
          value={data?.totalOpens.toLocaleString() || 0}
          icon={Eye}
          isLoading={isLoading}
        />
        <StatCard
          title="Total Unique Clickers"
          value={data?.totalClicks.toLocaleString() || 0}
          icon={MousePointer2}
          isLoading={isLoading}
        />
        <StatCard
          title="Avg. Open Rate"
          value={`${(data?.avgOpenRate || 0).toFixed(1)}%`}
          icon={TrendingUp}
          isLoading={isLoading}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <BarChart3 className="h-5 w-5" />
            Campaign Performance
          </CardTitle>
          <CardDescription>
            View detailed analytics for each campaign
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-4">
              {[1, 2, 3, 4, 5].map((i) => (
                <Skeleton key={i} className="h-16" />
              ))}
            </div>
          ) : data?.recentCampaigns && data.recentCampaigns.length > 0 ? (
            <div className="rounded-md border overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Campaign</TableHead>
                    <TableHead className="text-right">Sent</TableHead>
                    <TableHead className="text-right">Open Rate</TableHead>
                    <TableHead className="text-right">Click Rate</TableHead>
                    <TableHead className="w-[100px]"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.recentCampaigns.map((campaign) => (
                    <TableRow key={campaign.id}>
                      <TableCell className="font-medium">{campaign.name}</TableCell>
                      <TableCell className="text-right">
                        {campaign.sentCount.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right">
                        <Badge
                          variant={campaign.openRate > 20 ? "default" : "secondary"}
                        >
                          {campaign.openRate.toFixed(1)}%
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <Badge
                          variant={campaign.clickRate > 5 ? "default" : "secondary"}
                        >
                          {campaign.clickRate.toFixed(1)}%
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Link href={`/analytics/${campaign.id}`}>
                          <Button variant="ghost" size="sm">
                            View
                          </Button>
                        </Link>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <div className="text-center py-16 text-muted-foreground">
              <BarChart3 className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p>No campaign data yet</p>
              <p className="text-sm mt-1">
                Send your first campaign to see analytics
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default function Analytics() {
  const [match, params] = useRoute("/analytics/:id");

  if (match && params?.id) {
    return (
      <div className="p-6 lg:p-8">
        <CampaignAnalyticsView campaignId={params.id} />
      </div>
    );
  }

  return (
    <div className="p-6 lg:p-8">
      <OverallAnalyticsView />
    </div>
  );
}
