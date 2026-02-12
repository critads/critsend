import { useQuery } from "@tanstack/react-query";
import { useRoute, Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import {
  ArrowLeft,
  Mail,
  Server,
  Users,
  Clock,
  Zap,
  Eye,
  MousePointer2,
  BarChart3,
  CheckCircle2,
  AlertCircle,
  Pause,
  Tag,
  Pencil,
  RefreshCw,
  Timer,
} from "lucide-react";
import type { Campaign, Mta, Segment } from "@shared/schema";

function CampaignStatusBadge({ status }: { status: string }) {
  const variants: Record<string, { variant: "default" | "secondary" | "destructive" | "outline"; icon: React.ReactNode; className?: string }> = {
    draft: { variant: "secondary", icon: <Clock className="h-3 w-3" /> },
    scheduled: { variant: "outline", icon: <Clock className="h-3 w-3" />, className: "border-blue-500 text-blue-600" },
    sending: { variant: "default", icon: <Mail className="h-3 w-3" /> },
    completed: { variant: "secondary", icon: <CheckCircle2 className="h-3 w-3" />, className: "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300" },
    paused: { variant: "outline", icon: <Pause className="h-3 w-3" />, className: "border-yellow-500 text-yellow-600" },
    failed: { variant: "destructive", icon: <AlertCircle className="h-3 w-3" /> },
  };

  const config = variants[status] || variants.draft;

  return (
    <Badge variant={config.variant} className={`gap-1 ${config.className || ""}`}>
      {config.icon}
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </Badge>
  );
}

const sendingSpeedLabels: Record<string, string> = {
  slow: "Slow (500 emails/min)",
  medium: "Medium (1,000 emails/min)",
  fast: "Fast (2,000 emails/min)",
  godzilla: "Godzilla (3,000 emails/min)",
};

export default function CampaignDetail() {
  const [, params] = useRoute("/campaigns/:id");
  const campaignId = params?.id;

  const { data: campaign, isLoading: campaignLoading } = useQuery<Campaign>({
    queryKey: ["/api/campaigns", campaignId],
    enabled: !!campaignId,
  });

  const { data: mtas } = useQuery<Mta[]>({
    queryKey: ["/api/mtas"],
  });

  const { data: segments } = useQuery<Segment[]>({
    queryKey: ["/api/segments"],
  });

  const mta = mtas?.find(m => m.id === campaign?.mtaId);
  const segment = segments?.find(s => s.id === campaign?.segmentId);

  if (campaignLoading) {
    return (
      <div className="p-6 lg:p-8 space-y-6">
        <Skeleton className="h-10 w-48" />
        <div className="grid gap-6 md:grid-cols-2">
          <Skeleton className="h-64" />
          <Skeleton className="h-64" />
        </div>
      </div>
    );
  }

  if (!campaign) {
    return (
      <div className="p-6 lg:p-8">
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <AlertCircle className="h-16 w-16 text-muted-foreground/50 mb-4" />
          <h3 className="text-lg font-semibold mb-2">Campaign not found</h3>
          <p className="text-muted-foreground max-w-md mb-4">
            The campaign you're looking for doesn't exist or has been deleted.
          </p>
          <Link href="/campaigns">
            <Button>
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back to Campaigns
            </Button>
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 lg:p-8 space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div className="flex items-center gap-4">
          <Link href="/campaigns">
            <Button variant="ghost" size="icon" data-testid="button-back">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div>
            <div className="flex items-center gap-3 flex-wrap">
              <h1 className="text-2xl font-bold tracking-tight" data-testid="text-campaign-name">
                {campaign.name}
              </h1>
              <CampaignStatusBadge status={campaign.status} />
            </div>
            <p className="text-muted-foreground" data-testid="text-campaign-subject">
              {campaign.subject}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {campaign.status === "draft" && (
            <Link href={`/campaigns/${campaign.id}/edit`}>
              <Button variant="outline" data-testid="button-edit-campaign">
                <Pencil className="h-4 w-4 mr-2" />
                Edit Campaign
              </Button>
            </Link>
          )}
          <Link href={`/analytics/${campaign.id}`}>
            <Button data-testid="button-view-analytics">
              <BarChart3 className="h-4 w-4 mr-2" />
              View Analytics
            </Button>
          </Link>
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Mail className="h-5 w-5" />
              Email Details
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3">
              <div className="flex justify-between">
                <span className="text-muted-foreground">From Name</span>
                <span className="font-medium" data-testid="text-from-name">{campaign.fromName}</span>
              </div>
              <Separator />
              <div className="flex justify-between">
                <span className="text-muted-foreground">From Email</span>
                <span className="font-medium" data-testid="text-from-email">{campaign.fromEmail}</span>
              </div>
              <Separator />
              <div className="flex justify-between">
                <span className="text-muted-foreground">Reply To</span>
                <span className="font-medium" data-testid="text-reply-email">{campaign.replyEmail || "-"}</span>
              </div>
              <Separator />
              <div className="flex justify-between">
                <span className="text-muted-foreground">Preheader</span>
                <span className="font-medium text-right max-w-[200px] truncate" data-testid="text-preheader">
                  {campaign.preheader || "-"}
                </span>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Server className="h-5 w-5" />
              Sending Configuration
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3">
              <div className="flex justify-between">
                <span className="text-muted-foreground">MTA Server</span>
                <span className="font-medium" data-testid="text-mta">{mta?.name || "Unknown"}</span>
              </div>
              <Separator />
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">Audience</span>
                <div className="flex items-center gap-2">
                  <Users className="h-4 w-4 text-muted-foreground" />
                  <span className="font-medium" data-testid="text-segment">{segment?.name || "Unknown"}</span>
                </div>
              </div>
              <Separator />
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">Sending Speed</span>
                <div className="flex items-center gap-2">
                  <Zap className="h-4 w-4 text-muted-foreground" />
                  <span className="font-medium" data-testid="text-speed">
                    {sendingSpeedLabels[campaign.sendingSpeed] || campaign.sendingSpeed}
                  </span>
                </div>
              </div>
              <Separator />
              <div className="flex justify-between">
                <span className="text-muted-foreground">Scheduled</span>
                <span className="font-medium" data-testid="text-scheduled">
                  {campaign.scheduledAt 
                    ? new Date(campaign.scheduledAt).toLocaleString()
                    : "Not scheduled"}
                </span>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Eye className="h-5 w-5" />
              Tracking Settings
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3">
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">Track Opens</span>
                <Badge variant={campaign.trackOpens ? "default" : "secondary"}>
                  {campaign.trackOpens ? "Enabled" : "Disabled"}
                </Badge>
              </div>
              <Separator />
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">Track Clicks</span>
                <Badge variant={campaign.trackClicks ? "default" : "secondary"}>
                  {campaign.trackClicks ? "Enabled" : "Disabled"}
                </Badge>
              </div>
              <Separator />
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">Open Tag</span>
                {campaign.openTag ? (
                  <Badge variant="outline" className="gap-1">
                    <Tag className="h-3 w-3" />
                    {campaign.openTag}
                  </Badge>
                ) : (
                  <span className="text-muted-foreground">-</span>
                )}
              </div>
              <Separator />
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">Click Tag</span>
                {campaign.clickTag ? (
                  <Badge variant="outline" className="gap-1">
                    <Tag className="h-3 w-3" />
                    {campaign.clickTag}
                  </Badge>
                ) : (
                  <span className="text-muted-foreground">-</span>
                )}
              </div>
              <Separator />
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">Unsubscribe Tag</span>
                {campaign.unsubscribeTag ? (
                  <Badge variant="outline" className="gap-1">
                    <Tag className="h-3 w-3" />
                    {campaign.unsubscribeTag}
                  </Badge>
                ) : (
                  <span className="text-muted-foreground">-</span>
                )}
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <BarChart3 className="h-5 w-5" />
              Statistics
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="text-center p-4 bg-muted/50 rounded-lg">
                <div className="text-3xl font-bold text-foreground" data-testid="stat-sent">
                  {campaign.sentCount.toLocaleString()}
                </div>
                <div className="text-sm text-muted-foreground">Emails Sent</div>
              </div>
              <div className="text-center p-4 bg-muted/50 rounded-lg">
                <div className="text-3xl font-bold text-destructive" data-testid="stat-failed">
                  {campaign.failedCount.toLocaleString()}
                </div>
                <div className="text-sm text-muted-foreground">Failed</div>
              </div>
            </div>
            {campaign.retryUntil && (
              <div className="border rounded-lg p-3 space-y-2" data-testid="retry-status">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <RefreshCw className="h-4 w-4" />
                  Auto-Retry
                </div>
                <div className="flex justify-between items-center text-sm">
                  <span className="text-muted-foreground flex items-center gap-1">
                    <Timer className="h-3 w-3" />
                    Retry Window
                  </span>
                  {new Date(campaign.retryUntil) > new Date() ? (
                    <Badge variant="outline" className="gap-1 border-blue-500 text-blue-600">
                      Active
                    </Badge>
                  ) : (
                    <Badge variant="secondary" className="gap-1">
                      Expired
                    </Badge>
                  )}
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Retries Until</span>
                  <span className="font-medium">
                    {new Date(campaign.retryUntil).toLocaleString()}
                  </span>
                </div>
                {campaign.failedCount > 0 && new Date(campaign.retryUntil) > new Date() && (
                  <p className="text-xs text-muted-foreground">
                    Failed emails will be automatically retried until the window expires.
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Email Content Preview</CardTitle>
          <CardDescription>Preview of the email HTML content</CardDescription>
        </CardHeader>
        <CardContent>
          {campaign.htmlContent ? (
            <div className="border rounded-lg overflow-hidden bg-white">
              <iframe
                srcDoc={campaign.htmlContent}
                className="w-full min-h-[500px] border-0"
                title="Email Preview"
                sandbox="allow-same-origin"
                data-testid="iframe-email-preview"
              />
            </div>
          ) : (
            <div className="flex items-center justify-center py-16 text-muted-foreground">
              No HTML content available
            </div>
          )}
        </CardContent>
      </Card>

      {(campaign.unsubscribeText || campaign.companyAddress) && (
        <Card>
          <CardHeader>
            <CardTitle>Footer Information</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {campaign.unsubscribeText && (
              <div>
                <span className="text-sm text-muted-foreground">Unsubscribe Text</span>
                <p className="font-medium">{campaign.unsubscribeText}</p>
              </div>
            )}
            {campaign.companyAddress && (
              <div>
                <span className="text-sm text-muted-foreground">Company Address</span>
                <p className="font-medium whitespace-pre-wrap">{campaign.companyAddress}</p>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
