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
  TrendingUp,
  TrendingDown,
  Plus,
  ArrowRight,
  Clock,
  CheckCircle2,
  AlertCircle,
} from "lucide-react";

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

function StatCard({
  title,
  value,
  icon: Icon,
  trend,
  trendLabel,
  isLoading,
}: {
  title: string;
  value: number | string;
  icon: React.ComponentType<{ className?: string }>;
  trend?: "up" | "down";
  trendLabel?: string;
  isLoading: boolean;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-8 w-24" />
        ) : (
          <>
            <div className="text-2xl font-bold" data-testid={`stat-${title.toLowerCase().replace(/\s/g, '-')}`}>
              {typeof value === "number" ? value.toLocaleString() : value}
            </div>
            {trend && trendLabel && (
              <div className="flex items-center gap-1 mt-1">
                {trend === "up" ? (
                  <TrendingUp className="h-3 w-3 text-green-600" />
                ) : (
                  <TrendingDown className="h-3 w-3 text-red-600" />
                )}
                <span className={`text-xs ${trend === "up" ? "text-green-600" : "text-red-600"}`}>
                  {trendLabel}
                </span>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function CampaignStatusBadge({ status }: { status: string }) {
  const variants: Record<string, { variant: "default" | "secondary" | "destructive" | "outline"; icon: React.ReactNode }> = {
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
          <p className="text-muted-foreground">Welcome to Critsend - your email marketing command center</p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Link href="/campaigns/new">
            <Button data-testid="button-new-campaign">
              <Plus className="h-4 w-4 mr-2" />
              New Campaign
            </Button>
          </Link>
          <Link href="/import">
            <Button variant="outline" data-testid="button-import">
              Import Subscribers
            </Button>
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <StatCard
          title="Total Subscribers"
          value={stats?.totalSubscribers ?? 0}
          icon={Users}
          trend="up"
          trendLabel="+12% this month"
          isLoading={isLoading}
        />
        <StatCard
          title="Campaigns Sent"
          value={stats?.totalCampaigns ?? 0}
          icon={Mail}
          isLoading={isLoading}
        />
        <StatCard
          title="Total Opens"
          value={stats?.totalOpens ?? 0}
          icon={Eye}
          trend="up"
          trendLabel="23.5% open rate"
          isLoading={isLoading}
        />
        <StatCard
          title="Total Clicks"
          value={stats?.totalClicks ?? 0}
          icon={MousePointer2}
          trend="up"
          trendLabel="4.2% click rate"
          isLoading={isLoading}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
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
              <div className="space-y-4">
                {stats.recentCampaigns.map((campaign) => (
                  <div
                    key={campaign.id}
                    className="flex items-center justify-between p-3 rounded-md bg-muted/50"
                    data-testid={`campaign-item-${campaign.id}`}
                  >
                    <div className="flex flex-col gap-1">
                      <span className="font-medium">{campaign.name}</span>
                      <span className="text-sm text-muted-foreground">
                        {campaign.sentCount.toLocaleString()} sent
                      </span>
                    </div>
                    <CampaignStatusBadge status={campaign.status} />
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-8 text-center">
                <Mail className="h-12 w-12 text-muted-foreground/50 mb-4" />
                <p className="text-muted-foreground">No campaigns yet</p>
                <Link href="/campaigns/new">
                  <Button variant="link" className="mt-2">
                    Create your first campaign
                  </Button>
                </Link>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
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
              <div className="space-y-4">
                {stats.recentImports.map((job) => (
                  <div
                    key={job.id}
                    className="flex items-center justify-between p-3 rounded-md bg-muted/50"
                    data-testid={`import-item-${job.id}`}
                  >
                    <div className="flex flex-col gap-1">
                      <span className="font-medium truncate max-w-[200px]">{job.filename}</span>
                      <span className="text-sm text-muted-foreground">
                        {job.processedRows.toLocaleString()} / {job.totalRows.toLocaleString()} rows
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
              <div className="flex flex-col items-center justify-center py-8 text-center">
                <Users className="h-12 w-12 text-muted-foreground/50 mb-4" />
                <p className="text-muted-foreground">No imports yet</p>
                <Link href="/import">
                  <Button variant="link" className="mt-2">
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
