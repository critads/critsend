import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  BarChart3,
  TrendingUp,
  TrendingDown,
  Users,
  Mail,
  Eye,
  MousePointer,
  AlertTriangle,
  ArrowUp,
  ArrowDown,
  RefreshCw,
  Calendar,
} from "lucide-react";

interface OverviewData {
  totalSubscribers: number;
  totalCampaigns: number;
  totalSent: number;
  totalOpens: number;
  totalClicks: number;
  totalBounces: number;
  totalUnsubscribes: number;
  openRate: number;
  clickRate: number;
  bounceRate: number;
  unsubscribeRate: number;
}

interface EngagementRow {
  date: string;
  sent: number;
  opens: number;
  clicks: number;
  bounces: number;
  unsubscribes: number;
}

interface DeliverabilityData {
  deliveryRate: number;
  bounceRate: number;
  complaintRate: number;
  inboxPlacementEstimate: number;
  totalSent: number;
  totalDelivered: number;
  totalBounced: number;
  totalComplaints: number;
  byMta: Array<{
    mtaId: string;
    mtaName: string;
    totalSent: number;
    deliveryRate: number;
    bounceRate: number;
  }>;
}

interface GrowthRow {
  date: string;
  newSubscribers: number;
  removedSubscribers: number;
  netGrowth: number;
  totalAtDate: number;
}

interface TopCampaign {
  id: string;
  name: string;
  subject: string;
  status: string;
  totalSent: number;
  totalOpens: number;
  totalClicks: number;
  openRate: number;
  clickRate: number;
}

interface CohortRow {
  cohort: string;
  total_subscribers: number;
  active_subscribers: number;
  active_rate: number;
  engagement_rate: number;
}

function MetricCard({
  title,
  value,
  icon: Icon,
  color,
  isLoading,
  suffix,
}: {
  title: string;
  value: number | string;
  icon: React.ComponentType<{ className?: string }>;
  color: "blue" | "green" | "purple" | "orange" | "red" | "cyan";
  isLoading: boolean;
  suffix?: string;
}) {
  const iconBg: Record<string, string> = {
    blue: "bg-primary",
    green: "bg-primary/80",
    purple: "bg-primary/60",
    orange: "bg-primary/40",
    red: "bg-destructive",
    cyan: "bg-primary",
  };

  return (
    <Card className="overflow-visible shadow-sm">
      <CardContent className="p-6">
        <div className="flex items-center justify-between">
          <div className="flex flex-col gap-1">
            <span className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
              {title}
            </span>
            {isLoading ? (
              <Skeleton className="h-9 w-20" />
            ) : (
              <span
                className="text-3xl font-bold tracking-tight"
                data-testid={`stat-${title.toLowerCase().replace(/\s+/g, "-")}`}
              >
                {typeof value === "number" ? value.toLocaleString() : value}
                {suffix}
              </span>
            )}
          </div>
          <div className={`p-3 rounded-xl ${iconBg[color]} shadow-lg`}>
            <Icon className="w-6 h-6 text-primary-foreground" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function RateBar({ value, max, color }: { value: number; max: number; color: string }) {
  const width = max > 0 ? Math.min((value / max) * 100, 100) : 0;
  return (
    <div className="w-full bg-muted rounded-full h-2.5">
      <div
        className={`h-2.5 rounded-full ${color}`}
        style={{ width: `${width}%` }}
      />
    </div>
  );
}

function ProgressRate({ rate, label }: { rate: number; label: string }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-semibold">{rate.toFixed(2)}%</span>
      </div>
      <div className="w-full bg-muted rounded-full h-3">
        <div
          className="h-3 rounded-full bg-primary transition-all"
          style={{ width: `${Math.min(rate, 100)}%` }}
        />
      </div>
    </div>
  );
}

function DaySelector({
  selected,
  onChange,
}: {
  selected: number;
  onChange: (days: number) => void;
}) {
  const options = [7, 14, 30, 60, 90];
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <Calendar className="h-4 w-4 text-muted-foreground" />
      {options.map((d) => (
        <Button
          key={d}
          variant={selected === d ? "default" : "outline"}
          size="sm"
          onClick={() => onChange(d)}
          data-testid={`button-days-${d}`}
        >
          {d}d
        </Button>
      ))}
    </div>
  );
}

function OverviewTab() {
  const { data, isLoading } = useQuery<OverviewData>({
    queryKey: ["/api/analytics/overview"],
  });

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <MetricCard
          title="Total Subscribers"
          value={data?.totalSubscribers ?? 0}
          icon={Users}
          color="blue"
          isLoading={isLoading}
        />
        <MetricCard
          title="Total Campaigns"
          value={data?.totalCampaigns ?? 0}
          icon={Mail}
          color="green"
          isLoading={isLoading}
        />
        <MetricCard
          title="Total Sent"
          value={data?.totalSent ?? 0}
          icon={BarChart3}
          color="purple"
          isLoading={isLoading}
        />
        <MetricCard
          title="Open Rate"
          value={`${(data?.openRate ?? 0).toFixed(2)}%`}
          icon={Eye}
          color="orange"
          isLoading={isLoading}
        />
        <MetricCard
          title="Click Rate"
          value={`${(data?.clickRate ?? 0).toFixed(2)}%`}
          icon={MousePointer}
          color="cyan"
          isLoading={isLoading}
        />
        <MetricCard
          title="Bounce Rate"
          value={`${(data?.bounceRate ?? 0).toFixed(2)}%`}
          icon={AlertTriangle}
          color="red"
          isLoading={isLoading}
        />
      </div>
    </div>
  );
}

function EngagementTab() {
  const [days, setDays] = useState(30);
  const { data, isLoading } = useQuery<EngagementRow[]>({
    queryKey: ["/api/analytics/engagement", `?days=${days}`],
  });

  const maxSent = data ? Math.max(...data.map((r) => r.sent), 1) : 1;
  const maxOpens = data ? Math.max(...data.map((r) => r.opens), 1) : 1;
  const maxClicks = data ? Math.max(...data.map((r) => r.clicks), 1) : 1;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h3 className="text-lg font-semibold">Engagement Trends</h3>
          <p className="text-sm text-muted-foreground">Daily email engagement over time</p>
        </div>
        <DaySelector selected={days} onChange={setDays} />
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-6 space-y-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : data && data.length > 0 ? (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[120px]">Date</TableHead>
                    <TableHead className="text-right w-[80px]">Sent</TableHead>
                    <TableHead>Sent</TableHead>
                    <TableHead className="text-right w-[80px]">Opens</TableHead>
                    <TableHead>Opens</TableHead>
                    <TableHead className="text-right w-[80px]">Clicks</TableHead>
                    <TableHead>Clicks</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.map((row) => (
                    <TableRow key={row.date} data-testid={`engagement-row-${row.date}`}>
                      <TableCell className="font-mono text-xs">
                        {new Date(row.date).toLocaleDateString()}
                      </TableCell>
                      <TableCell className="text-right font-semibold">{row.sent}</TableCell>
                      <TableCell className="min-w-[100px]">
                        <RateBar value={row.sent} max={maxSent} color="bg-primary" />
                      </TableCell>
                      <TableCell className="text-right font-semibold">{row.opens}</TableCell>
                      <TableCell className="min-w-[100px]">
                        <RateBar value={row.opens} max={maxOpens} color="bg-primary/80" />
                      </TableCell>
                      <TableCell className="text-right font-semibold">{row.clicks}</TableCell>
                      <TableCell className="min-w-[100px]">
                        <RateBar value={row.clicks} max={maxClicks} color="bg-primary/60" />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
              <BarChart3 className="h-12 w-12 mb-4 opacity-50" />
              <p>No engagement data for this period</p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function DeliverabilityTab() {
  const [days, setDays] = useState(30);
  const { data, isLoading } = useQuery<DeliverabilityData>({
    queryKey: ["/api/analytics/deliverability", `?days=${days}`],
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h3 className="text-lg font-semibold">Delivery Health</h3>
          <p className="text-sm text-muted-foreground">Email delivery metrics and MTA performance</p>
        </div>
        <DaySelector selected={days} onChange={setDays} />
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i}>
              <CardContent className="p-6">
                <Skeleton className="h-4 w-24 mb-2" />
                <Skeleton className="h-8 w-16" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <Card>
              <CardContent className="p-6 space-y-3">
                <ProgressRate rate={data?.deliveryRate ?? 0} label="Delivery Rate" />
                <p className="text-xs text-muted-foreground">
                  {(data?.totalDelivered ?? 0).toLocaleString()} / {(data?.totalSent ?? 0).toLocaleString()} delivered
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-6 space-y-3">
                <ProgressRate rate={data?.bounceRate ?? 0} label="Bounce Rate" />
                <p className="text-xs text-muted-foreground">
                  {(data?.totalBounced ?? 0).toLocaleString()} bounced
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-6 space-y-3">
                <ProgressRate rate={data?.complaintRate ?? 0} label="Complaint Rate" />
                <p className="text-xs text-muted-foreground">
                  {(data?.totalComplaints ?? 0).toLocaleString()} complaints
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-6 space-y-3">
                <ProgressRate rate={data?.inboxPlacementEstimate ?? 0} label="Inbox Placement Est." />
                <p className="text-xs text-muted-foreground">
                  Estimated inbox delivery
                </p>
              </CardContent>
            </Card>
          </div>

          {data?.byMta && data.byMta.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Per-MTA Breakdown</CardTitle>
                <CardDescription>Delivery performance by mail transfer agent</CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>MTA</TableHead>
                        <TableHead className="text-right">Sent</TableHead>
                        <TableHead className="text-right">Delivery Rate</TableHead>
                        <TableHead className="text-right">Bounce Rate</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.byMta.map((mta) => (
                        <TableRow key={mta.mtaId} data-testid={`mta-row-${mta.mtaId}`}>
                          <TableCell className="font-medium">{mta.mtaName}</TableCell>
                          <TableCell className="text-right">{mta.totalSent.toLocaleString()}</TableCell>
                          <TableCell className="text-right">
                            <Badge variant={mta.deliveryRate > 95 ? "default" : "secondary"}>
                              {mta.deliveryRate.toFixed(2)}%
                            </Badge>
                          </TableCell>
                          <TableCell className="text-right">
                            <Badge variant={mta.bounceRate < 2 ? "secondary" : "destructive"}>
                              {mta.bounceRate.toFixed(2)}%
                            </Badge>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

function SubscriberGrowthTab() {
  const [days, setDays] = useState(30);
  const { data, isLoading } = useQuery<GrowthRow[]>({
    queryKey: ["/api/analytics/subscriber-growth", `?days=${days}`],
  });

  const maxTotal = data ? Math.max(...data.map((r) => r.totalAtDate), 1) : 1;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h3 className="text-lg font-semibold">Subscriber Growth</h3>
          <p className="text-sm text-muted-foreground">Track subscriber additions and removals over time</p>
        </div>
        <DaySelector selected={days} onChange={setDays} />
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-6 space-y-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : data && data.length > 0 ? (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[120px]">Date</TableHead>
                    <TableHead className="text-right">New</TableHead>
                    <TableHead className="text-right">Removed</TableHead>
                    <TableHead className="text-right">Net Growth</TableHead>
                    <TableHead className="text-right w-[80px]">Total</TableHead>
                    <TableHead>Running Total</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.map((row) => (
                    <TableRow key={row.date} data-testid={`growth-row-${row.date}`}>
                      <TableCell className="font-mono text-xs">
                        {new Date(row.date).toLocaleDateString()}
                      </TableCell>
                      <TableCell className="text-right">
                        {row.newSubscribers > 0 && (
                          <span className="inline-flex items-center gap-1 text-foreground">
                            <ArrowUp className="h-3 w-3" />
                            {row.newSubscribers}
                          </span>
                        )}
                        {row.newSubscribers === 0 && <span className="text-muted-foreground">0</span>}
                      </TableCell>
                      <TableCell className="text-right">
                        {row.removedSubscribers > 0 && (
                          <span className="inline-flex items-center gap-1 text-destructive">
                            <ArrowDown className="h-3 w-3" />
                            {row.removedSubscribers}
                          </span>
                        )}
                        {row.removedSubscribers === 0 && <span className="text-muted-foreground">0</span>}
                      </TableCell>
                      <TableCell className="text-right">
                        <span
                          className={
                            row.netGrowth > 0
                              ? "text-foreground font-semibold"
                              : row.netGrowth < 0
                              ? "text-destructive font-semibold"
                              : "text-muted-foreground"
                          }
                        >
                          {row.netGrowth > 0 ? "+" : ""}
                          {row.netGrowth}
                        </span>
                      </TableCell>
                      <TableCell className="text-right font-semibold">
                        {row.totalAtDate.toLocaleString()}
                      </TableCell>
                      <TableCell className="min-w-[120px]">
                        <RateBar value={row.totalAtDate} max={maxTotal} color="bg-primary" />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
              <Users className="h-12 w-12 mb-4 opacity-50" />
              <p>No growth data for this period</p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function TopCampaignsTab() {
  const [sortBy, setSortBy] = useState<"openRate" | "clickRate">("openRate");
  const { data, isLoading } = useQuery<TopCampaign[]>({
    queryKey: ["/api/analytics/top-campaigns", `?limit=10&sortBy=${sortBy}`],
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h3 className="text-lg font-semibold">Top Performing Campaigns</h3>
          <p className="text-sm text-muted-foreground">Campaigns ranked by performance metrics</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">Sort by:</span>
          <Button
            variant={sortBy === "openRate" ? "default" : "outline"}
            size="sm"
            onClick={() => setSortBy("openRate")}
            data-testid="button-sort-open-rate"
          >
            <Eye className="h-3.5 w-3.5 mr-1.5" />
            Open Rate
          </Button>
          <Button
            variant={sortBy === "clickRate" ? "default" : "outline"}
            size="sm"
            onClick={() => setSortBy("clickRate")}
            data-testid="button-sort-click-rate"
          >
            <MousePointer className="h-3.5 w-3.5 mr-1.5" />
            Click Rate
          </Button>
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-6 space-y-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : data && data.length > 0 ? (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>#</TableHead>
                    <TableHead>Campaign</TableHead>
                    <TableHead className="text-right">Sent</TableHead>
                    <TableHead className="text-right">Open Rate</TableHead>
                    <TableHead>Open Rate</TableHead>
                    <TableHead className="text-right">Click Rate</TableHead>
                    <TableHead>Click Rate</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.map((campaign, index) => (
                    <TableRow key={campaign.id} data-testid={`campaign-row-${campaign.id}`}>
                      <TableCell className="font-mono text-muted-foreground">{index + 1}</TableCell>
                      <TableCell>
                        <div className="flex flex-col gap-0.5">
                          <span className="font-medium">{campaign.name}</span>
                          <span className="text-xs text-muted-foreground truncate max-w-[200px]">
                            {campaign.subject}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="text-right">{campaign.totalSent.toLocaleString()}</TableCell>
                      <TableCell className="text-right">
                        <Badge variant={campaign.openRate > 20 ? "default" : "secondary"}>
                          {campaign.openRate.toFixed(1)}%
                        </Badge>
                      </TableCell>
                      <TableCell className="min-w-[80px]">
                        <RateBar value={campaign.openRate} max={100} color="bg-primary/80" />
                      </TableCell>
                      <TableCell className="text-right">
                        <Badge variant={campaign.clickRate > 5 ? "default" : "secondary"}>
                          {campaign.clickRate.toFixed(1)}%
                        </Badge>
                      </TableCell>
                      <TableCell className="min-w-[80px]">
                        <RateBar value={campaign.clickRate} max={100} color="bg-primary/60" />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
              <TrendingUp className="h-12 w-12 mb-4 opacity-50" />
              <p>No campaign data available</p>
              <p className="text-sm mt-1">Send campaigns to see performance data</p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function CohortTab() {
  const [period, setPeriod] = useState<"monthly" | "weekly">("monthly");
  const { data, isLoading } = useQuery<CohortRow[]>({
    queryKey: ["/api/analytics/cohort", `?period=${period}`],
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h3 className="text-lg font-semibold">Cohort Analysis</h3>
          <p className="text-sm text-muted-foreground">Subscriber retention and engagement by cohort</p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant={period === "monthly" ? "default" : "outline"}
            size="sm"
            onClick={() => setPeriod("monthly")}
            data-testid="button-period-monthly"
          >
            Monthly
          </Button>
          <Button
            variant={period === "weekly" ? "default" : "outline"}
            size="sm"
            onClick={() => setPeriod("weekly")}
            data-testid="button-period-weekly"
          >
            Weekly
          </Button>
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-6 space-y-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : data && data.length > 0 ? (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Cohort</TableHead>
                    <TableHead className="text-right">Total Subscribers</TableHead>
                    <TableHead className="text-right">Active</TableHead>
                    <TableHead className="text-right">Active %</TableHead>
                    <TableHead>Active %</TableHead>
                    <TableHead className="text-right">Engagement %</TableHead>
                    <TableHead>Engagement</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.map((row) => {
                    const cohortDate = new Date(row.cohort);
                    const label = period === "monthly"
                      ? cohortDate.toLocaleDateString(undefined, { year: "numeric", month: "short" })
                      : cohortDate.toLocaleDateString();
                    return (
                      <TableRow key={row.cohort} data-testid={`cohort-row-${row.cohort}`}>
                        <TableCell className="font-medium">{label}</TableCell>
                        <TableCell className="text-right">{row.total_subscribers.toLocaleString()}</TableCell>
                        <TableCell className="text-right">{row.active_subscribers.toLocaleString()}</TableCell>
                        <TableCell className="text-right">
                          <Badge variant={parseFloat(String(row.active_rate)) > 80 ? "default" : "secondary"}>
                            {parseFloat(String(row.active_rate)).toFixed(1)}%
                          </Badge>
                        </TableCell>
                        <TableCell className="min-w-[80px]">
                          <RateBar value={parseFloat(String(row.active_rate))} max={100} color="bg-primary/80" />
                        </TableCell>
                        <TableCell className="text-right">
                          <Badge variant={parseFloat(String(row.engagement_rate)) > 20 ? "default" : "secondary"}>
                            {parseFloat(String(row.engagement_rate)).toFixed(1)}%
                          </Badge>
                        </TableCell>
                        <TableCell className="min-w-[80px]">
                          <RateBar value={parseFloat(String(row.engagement_rate))} max={100} color="bg-primary/60" />
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
              <Users className="h-12 w-12 mb-4 opacity-50" />
              <p>No cohort data available</p>
              <p className="text-sm mt-1">Import subscribers to see cohort analysis</p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default function AdvancedAnalytics() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [refreshing, setRefreshing] = useState(false);

  // The server-side analytics cache has a 5-min TTL. The Refresh button
  // hits a single invalidate endpoint that fans out across web + worker
  // processes via Redis pub/sub, then invalidates every analytics query in
  // react-query so whichever charts are mounted (with whatever days/sortBy
  // the user has selected) refetch from a freshly recomputed cache.
  const refreshAll = async () => {
    setRefreshing(true);
    try {
      const resp = await fetch("/api/analytics/cache/invalidate", {
        method: "POST",
        credentials: "include",
      });
      if (!resp.ok) {
        throw new Error(`Server returned ${resp.status}`);
      }
      await queryClient.invalidateQueries({ queryKey: ["/api/analytics/overview"] });
      await queryClient.invalidateQueries({ queryKey: ["/api/analytics/engagement"] });
      await queryClient.invalidateQueries({ queryKey: ["/api/analytics/deliverability"] });
      await queryClient.invalidateQueries({ queryKey: ["/api/analytics/subscriber-growth"] });
      await queryClient.invalidateQueries({ queryKey: ["/api/analytics/top-campaigns"] });
      await queryClient.invalidateQueries({ queryKey: ["/api/analytics/cohort"] });
      toast({ title: "Analytics refreshed" });
    } catch (e: any) {
      toast({ title: "Refresh failed", description: e?.message ?? String(e), variant: "destructive" });
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="p-6 lg:p-8 space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Advanced Analytics</h1>
          <p className="text-muted-foreground mt-1">
            In-depth metrics, engagement trends, and subscriber insights
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={refreshAll}
          disabled={refreshing}
          data-testid="button-refresh-analytics"
        >
          <RefreshCw className={`h-4 w-4 mr-1.5 ${refreshing ? "animate-spin" : ""}`} />
          {refreshing ? "Refreshing…" : "Refresh"}
        </Button>
      </div>

      <Tabs defaultValue="overview" data-testid="analytics-tabs">
        <TabsList className="flex-wrap">
          <TabsTrigger value="overview" data-testid="tab-overview">
            <BarChart3 className="h-4 w-4 mr-1.5" />
            Overview
          </TabsTrigger>
          <TabsTrigger value="engagement" data-testid="tab-engagement">
            <TrendingUp className="h-4 w-4 mr-1.5" />
            Engagement
          </TabsTrigger>
          <TabsTrigger value="deliverability" data-testid="tab-deliverability">
            <Mail className="h-4 w-4 mr-1.5" />
            Deliverability
          </TabsTrigger>
          <TabsTrigger value="growth" data-testid="tab-growth">
            <Users className="h-4 w-4 mr-1.5" />
            Subscriber Growth
          </TabsTrigger>
          <TabsTrigger value="top-campaigns" data-testid="tab-top-campaigns">
            <Eye className="h-4 w-4 mr-1.5" />
            Top Campaigns
          </TabsTrigger>
          <TabsTrigger value="cohort" data-testid="tab-cohort">
            <RefreshCw className="h-4 w-4 mr-1.5" />
            Cohort
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-6">
          <OverviewTab />
        </TabsContent>
        <TabsContent value="engagement" className="mt-6">
          <EngagementTab />
        </TabsContent>
        <TabsContent value="deliverability" className="mt-6">
          <DeliverabilityTab />
        </TabsContent>
        <TabsContent value="growth" className="mt-6">
          <SubscriberGrowthTab />
        </TabsContent>
        <TabsContent value="top-campaigns" className="mt-6">
          <TopCampaignsTab />
        </TabsContent>
        <TabsContent value="cohort" className="mt-6">
          <CohortTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
