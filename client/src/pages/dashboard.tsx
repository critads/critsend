import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Link } from "wouter";
import {
  Users,
  Mail,
  MousePointer2,
  Eye,
  Plus,
  ArrowRight,
  Clock,
  CheckCircle2,
  AlertCircle,
  Send,
  UserPlus,
  TrendingUp,
  BarChart3,
} from "lucide-react";
import {
  Area,
  AreaChart,
  ResponsiveContainer,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from "recharts";

interface DashboardStats {
  totalSubscribers: number;
  totalCampaigns: number;
  totalOpens: number;
  totalClicks: number;
  recentCampaigns: Array<{
    id: string;
    name: string;
    status: string;
    sentCount: number;
    scheduledAt: string | null;
  }>;
  recentImports: Array<{
    id: string;
    filename: string;
    status: string;
    processedRows: number;
    totalRows: number;
  }>;
}

const mockChartData = [
  { name: "Jan", opens: 400, clicks: 240 },
  { name: "Feb", opens: 300, clicks: 139 },
  { name: "Mar", opens: 520, clicks: 280 },
  { name: "Apr", opens: 470, clicks: 308 },
  { name: "May", opens: 540, clicks: 280 },
  { name: "Jun", opens: 680, clicks: 420 },
  { name: "Jul", opens: 720, clicks: 380 },
];

function StatCard({
  title,
  value,
  icon: Icon,
  color,
  isLoading,
}: {
  title: string;
  value: number | string;
  icon: React.ComponentType<{ className?: string }>;
  color: "blue" | "green" | "purple" | "orange";
  isLoading: boolean;
}) {
  const colorClasses = {
    blue: "bg-cyan-500/10 text-cyan-600 dark:text-cyan-400",
    green: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    purple: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
    orange: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  };

  const iconBg = {
    blue: "bg-cyan-500",
    green: "bg-emerald-500",
    purple: "bg-violet-500",
    orange: "bg-amber-500",
  };

  return (
    <Card className="overflow-visible shadow-sm hover:shadow-md transition-shadow">
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
                data-testid={`stat-${title.toLowerCase().replace(/\s/g, "-")}`}
              >
                {typeof value === "number" ? value.toLocaleString() : value}
              </span>
            )}
          </div>
          <div className={`p-3 rounded-xl ${iconBg[color]} shadow-lg`}>
            <Icon className="w-6 h-6 text-white" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function CampaignStatusBadge({ status }: { status: string }) {
  const variants: Record<
    string,
    { variant: "default" | "secondary" | "destructive" | "outline"; icon: React.ReactNode }
  > = {
    draft: { variant: "secondary", icon: <Clock className="h-3 w-3" /> },
    scheduled: { variant: "outline", icon: <Clock className="h-3 w-3" /> },
    sending: { variant: "default", icon: <Mail className="h-3 w-3" /> },
    completed: { variant: "secondary", icon: <CheckCircle2 className="h-3 w-3" /> },
    paused: { variant: "outline", icon: <AlertCircle className="h-3 w-3" /> },
    failed: { variant: "destructive", icon: <AlertCircle className="h-3 w-3" /> },
  };

  const config = variants[status] || variants.draft;

  return (
    <Badge variant={config.variant} className="gap-1">
      {config.icon}
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </Badge>
  );
}

export default function Dashboard() {
  const { data: stats, isLoading } = useQuery<DashboardStats>({
    queryKey: ["/api/dashboard/stats"],
  });

  return (
    <div className="p-6 lg:p-8 space-y-8">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Dashboard</h1>
          <p className="text-muted-foreground mt-1">
            Email Marketing Software To Engage With Your Audience
          </p>
        </div>
        <div className="flex gap-3 flex-wrap">
          <Link href="/campaigns/new">
            <Button className="shadow-lg shadow-primary/20" data-testid="button-new-campaign">
              <Plus className="h-4 w-4 mr-2" />
              New Campaign
            </Button>
          </Link>
          <Link href="/import">
            <Button variant="outline" data-testid="button-import">
              <UserPlus className="h-4 w-4 mr-2" />
              Import
            </Button>
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
        <StatCard
          title="Total Subscribers"
          value={stats?.totalSubscribers ?? 0}
          icon={Users}
          color="blue"
          isLoading={isLoading}
        />
        <StatCard
          title="Campaigns Sent"
          value={stats?.totalCampaigns ?? 0}
          icon={Send}
          color="green"
          isLoading={isLoading}
        />
        <StatCard
          title="Total Opens"
          value={stats?.totalOpens ?? 0}
          icon={Eye}
          color="purple"
          isLoading={isLoading}
        />
        <StatCard
          title="Total Clicks"
          value={stats?.totalClicks ?? 0}
          icon={MousePointer2}
          color="orange"
          isLoading={isLoading}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-2 shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
            <div className="flex items-center gap-2">
              <BarChart3 className="h-5 w-5 text-primary" />
              <CardTitle className="text-lg font-semibold">Email Analytics</CardTitle>
            </div>
            <div className="flex items-center gap-4 text-sm">
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full bg-cyan-500" />
                <span className="text-muted-foreground">Opens</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full bg-violet-500" />
                <span className="text-muted-foreground">Clicks</span>
              </div>
            </div>
          </CardHeader>
          <CardContent className="pt-4">
            <div className="h-[280px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={mockChartData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                  <defs>
                    <linearGradient id="colorOpens" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#06b6d4" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#06b6d4" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="colorClicks" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#8b5cf6" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#8b5cf6" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" vertical={false} />
                  <XAxis
                    dataKey="name"
                    axisLine={false}
                    tickLine={false}
                    tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }}
                  />
                  <YAxis
                    axisLine={false}
                    tickLine={false}
                    tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }}
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: "hsl(var(--card))",
                      border: "1px solid hsl(var(--border))",
                      borderRadius: "8px",
                      boxShadow: "0 4px 12px rgba(0,0,0,0.1)",
                    }}
                    labelStyle={{ color: "hsl(var(--foreground))" }}
                  />
                  <Area
                    type="monotone"
                    dataKey="opens"
                    stroke="#06b6d4"
                    strokeWidth={2}
                    fillOpacity={1}
                    fill="url(#colorOpens)"
                  />
                  <Area
                    type="monotone"
                    dataKey="clicks"
                    stroke="#8b5cf6"
                    strokeWidth={2}
                    fillOpacity={1}
                    fill="url(#colorClicks)"
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        <Card className="shadow-sm">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-lg font-semibold">Reports</CardTitle>
              <Link href="/analytics">
                <Button variant="ghost" size="sm" data-testid="link-view-all-reports">
                  View All
                  <ArrowRight className="h-4 w-4 ml-1" />
                </Button>
              </Link>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-3">
              <div className="flex items-center justify-between py-2 border-b border-border/50">
                <span className="text-sm text-muted-foreground">Sent Emails</span>
                <span className="font-semibold">{stats?.totalCampaigns ?? 0}</span>
              </div>
              <div className="flex items-center justify-between py-2 border-b border-border/50">
                <span className="text-sm text-muted-foreground">Opened</span>
                <div className="flex items-center gap-2">
                  <span className="font-semibold">{stats?.totalOpens ?? 0}</span>
                  <TrendingUp className="h-4 w-4 text-emerald-500" />
                </div>
              </div>
              <div className="flex items-center justify-between py-2 border-b border-border/50">
                <span className="text-sm text-muted-foreground">Clicked</span>
                <div className="flex items-center gap-2">
                  <span className="font-semibold">{stats?.totalClicks ?? 0}</span>
                  <TrendingUp className="h-4 w-4 text-emerald-500" />
                </div>
              </div>
              <div className="flex items-center justify-between py-2 border-b border-border/50">
                <span className="text-sm text-muted-foreground">Subscribers</span>
                <span className="font-semibold">{stats?.totalSubscribers ?? 0}</span>
              </div>
              <div className="flex items-center justify-between py-2">
                <span className="text-sm text-muted-foreground">Unsubscribed</span>
                <span className="font-semibold text-muted-foreground">0</span>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card className="shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between gap-2">
            <CardTitle className="text-lg font-semibold">Recent Campaigns</CardTitle>
            <Link href="/campaigns">
              <Button variant="ghost" size="sm" data-testid="link-view-all-campaigns">
                View all
                <ArrowRight className="h-4 w-4 ml-1" />
              </Button>
            </Link>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="space-y-4">
                {[1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-16 w-full" />
                ))}
              </div>
            ) : stats?.recentCampaigns && stats.recentCampaigns.length > 0 ? (
              <div className="space-y-3">
                {stats.recentCampaigns.map((campaign) => (
                  <div
                    key={campaign.id}
                    className="flex items-center justify-between p-4 rounded-lg bg-muted/30 hover:bg-muted/50 transition-colors"
                    data-testid={`campaign-item-${campaign.id}`}
                  >
                    <div className="flex flex-col gap-1">
                      <span className="font-medium">{campaign.name}</span>
                      <span className="text-sm text-muted-foreground">
                        {campaign.sentCount.toLocaleString()} emails sent
                      </span>
                    </div>
                    <CampaignStatusBadge status={campaign.status} />
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <div className="p-4 rounded-full bg-muted/50 mb-4">
                  <Mail className="h-8 w-8 text-muted-foreground/50" />
                </div>
                <p className="text-muted-foreground mb-2">No campaigns yet</p>
                <Link href="/campaigns/new">
                  <Button variant="ghost" className="text-primary" data-testid="link-create-first-campaign">
                    Create your first campaign
                  </Button>
                </Link>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between gap-2">
            <CardTitle className="text-lg font-semibold">Recent Imports</CardTitle>
            <Link href="/import">
              <Button variant="ghost" size="sm" data-testid="link-view-imports">
                View all
                <ArrowRight className="h-4 w-4 ml-1" />
              </Button>
            </Link>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="space-y-4">
                {[1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-16 w-full" />
                ))}
              </div>
            ) : stats?.recentImports && stats.recentImports.length > 0 ? (
              <div className="space-y-3">
                {stats.recentImports.map((job) => (
                  <div
                    key={job.id}
                    className="flex items-center justify-between p-4 rounded-lg bg-muted/30 hover:bg-muted/50 transition-colors"
                    data-testid={`import-item-${job.id}`}
                  >
                    <div className="flex flex-col gap-1">
                      <span className="font-medium truncate max-w-[200px]">{job.filename}</span>
                      <span className="text-sm text-muted-foreground">
                        {Math.min(job.processedRows, job.totalRows).toLocaleString()} / {job.totalRows.toLocaleString()} rows
                      </span>
                    </div>
                    <Badge
                      variant={
                        job.status === "completed"
                          ? "secondary"
                          : job.status === "processing"
                          ? "default"
                          : job.status === "failed"
                          ? "destructive"
                          : "outline"
                      }
                    >
                      {job.status}
                    </Badge>
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <div className="p-4 rounded-full bg-muted/50 mb-4">
                  <Users className="h-8 w-8 text-muted-foreground/50" />
                </div>
                <p className="text-muted-foreground mb-2">No imports yet</p>
                <Link href="/import">
                  <Button variant="ghost" className="text-primary" data-testid="link-import-first-subscribers">
                    Import your first subscribers
                  </Button>
                </Link>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
