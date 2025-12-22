import { useQuery } from "@tanstack/react-query";
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
  BarChart3,
  Eye,
  MousePointer2,
  Users,
  ArrowLeft,
  TrendingUp,
  Mail,
  Link as LinkIcon,
} from "lucide-react";
import type { Campaign } from "@shared/schema";

interface CampaignAnalytics {
  campaign: Campaign;
  totalOpens: number;
  uniqueOpens: number;
  totalClicks: number;
  uniqueClicks: number;
  openRate: number;
  clickRate: number;
  topLinks: Array<{ url: string; clicks: number }>;
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

function CampaignAnalyticsView({ campaignId }: { campaignId: string }) {
  const { data, isLoading } = useQuery<CampaignAnalytics>({
    queryKey: ["/api/analytics/campaign", campaignId],
  });

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
          title="Total Opens"
          value={data?.totalOpens.toLocaleString() || 0}
          subValue={`${data?.uniqueOpens.toLocaleString() || 0} unique`}
          icon={Eye}
          isLoading={isLoading}
        />
        <StatCard
          title="Open Rate"
          value={`${(data?.openRate || 0).toFixed(1)}%`}
          icon={TrendingUp}
          isLoading={isLoading}
        />
        <StatCard
          title="Total Clicks"
          value={data?.totalClicks.toLocaleString() || 0}
          subValue={`${data?.uniqueClicks.toLocaleString() || 0} unique`}
          icon={MousePointer2}
          isLoading={isLoading}
        />
        <StatCard
          title="Click Rate"
          value={`${(data?.clickRate || 0).toFixed(1)}%`}
          icon={TrendingUp}
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
                    <Badge variant="secondary">{link.clicks} clicks</Badge>
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
          title="Total Opens"
          value={data?.totalOpens.toLocaleString() || 0}
          icon={Eye}
          isLoading={isLoading}
        />
        <StatCard
          title="Total Clicks"
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
