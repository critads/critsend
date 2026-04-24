import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useRoute, Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
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
  ChevronLeft,
  ChevronRight,
  RotateCcw,
  Filter,
} from "lucide-react";
import type { Campaign, Mta, Segment } from "@shared/schema";

/** Inject <base href> so relative image URLs (/campaigns/...) resolve against
 *  the current server instead of about:srcdoc when using srcDoc in an iframe. */
function withBaseHref(html: string): string {
  const base = `<base href="${window.location.origin}/">`;
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, (m) => `${m}${base}`);
  }
  return `${base}${html}`;
}

interface ErrorSummaryItem {
  message: string;
  count: number;
}

interface ErrorLog {
  id: string;
  email: string | null;
  message: string;
  timestamp: string;
  details?: string | null;
}

interface CampaignErrorsResponse {
  pauseReason: string | null;
  errors: ErrorLog[];
  total: number;
  page: number;
  limit: number;
  summary: ErrorSummaryItem[];
}

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
  drip: "Drip (100 emails/min)",
  very_slow: "Very Slow (250 emails/min)",
  slow: "Slow (500 emails/min)",
  medium: "Medium (1,000 emails/min)",
  fast: "Fast (2,000 emails/min)",
  godzilla: "Godzilla (3,000 emails/min)",
};

// Auto-resend (Task #56) helper card. Fetches the linked counterpart so we
// can render contextual labels ("Follow-up of {parent name}", "Follow-up
// scheduled for {date}"). Renders nothing when there is no link.
function FollowUpLinkCard({ campaign }: { campaign: Campaign }) {
  const linkedId = campaign.parentCampaignId ?? campaign.followUpCampaignId;
  const isParentView = !!campaign.followUpCampaignId && !campaign.parentCampaignId;
  const { data: linked } = useQuery<Campaign>({
    queryKey: ["/api/campaigns", linkedId],
    enabled: !!linkedId,
  });
  if (!linkedId) return null;
  if (campaign.parentCampaignId) {
    return (
      <Card data-testid="card-followup-link">
        <CardContent className="p-4 flex items-center justify-between gap-4 flex-wrap">
          <div>
            <Badge variant="secondary" className="mb-1">
              {linked ? `Follow-up of ${linked.name}` : "Follow-up to opener"}
            </Badge>
            <p className="text-sm text-muted-foreground">
              This campaign was auto-sent to people who opened the original.
            </p>
          </div>
          <Link href={`/campaigns/${campaign.parentCampaignId}`}>
            <Button variant="outline" size="sm" data-testid="link-parent-campaign">
              View original
            </Button>
          </Link>
        </CardContent>
      </Card>
    );
  }
  if (isParentView) {
    const when = linked?.scheduledAt ? new Date(linked.scheduledAt).toLocaleString() : null;
    return (
      <Card data-testid="card-followup-link">
        <CardContent className="p-4 flex items-center justify-between gap-4 flex-wrap">
          <div>
            <Badge variant="outline" className="mb-1">
              {when ? `Follow-up scheduled for ${when}` : "Follow-up scheduled"}
            </Badge>
            <p className="text-sm text-muted-foreground">
              {linked?.status === "completed"
                ? "The follow-up to openers has finished sending."
                : "A follow-up to openers has been spawned for this campaign."}
            </p>
          </div>
          <Link href={`/campaigns/${campaign.followUpCampaignId}`}>
            <Button variant="outline" size="sm" data-testid="link-followup-campaign">
              View follow-up
            </Button>
          </Link>
        </CardContent>
      </Card>
    );
  }
  return null;
}

export default function CampaignDetail() {
  const [, params] = useRoute("/campaigns/:id");
  const campaignId = params?.id;
  const { toast } = useToast();
  const [errorsPage, setErrorsPage] = useState(1);
  const ERRORS_PER_PAGE = 50;

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

  const { data: errorsData, isLoading: errorsLoading } = useQuery<CampaignErrorsResponse>({
    queryKey: ["/api/campaigns", campaignId, "errors", errorsPage],
    queryFn: async () => {
      const res = await fetch(`/api/campaigns/${campaignId}/errors?page=${errorsPage}&limit=${ERRORS_PER_PAGE}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to fetch errors");
      return res.json();
    },
    enabled: !!campaignId && (campaign?.failedCount ?? 0) > 0,
  });

  const retryFailedMutation = useMutation<{ campaign: Campaign; resetCount: number }, Error>({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/campaigns/${campaignId}/retry-failed`);
      return res.json() as Promise<{ campaign: Campaign; resetCount: number }>;
    },
    onSuccess: (data) => {
      toast({
        title: "Retry queued",
        description: `${data.resetCount ?? 0} failed send(s) have been re-queued.`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/campaigns", campaignId] });
      queryClient.invalidateQueries({ queryKey: ["/api/campaigns", campaignId, "errors"] });
    },
    onError: (err) => {
      toast({
        title: "Retry failed",
        description: err.message || "Could not queue retry.",
        variant: "destructive",
      });
    },
  });

  const mta = mtas?.find(m => m.id === campaign?.mtaId);
  const segment = segments?.find(s => s.id === campaign?.segmentId);

  const totalErrorPages = errorsData ? Math.ceil(errorsData.total / ERRORS_PER_PAGE) : 0;

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
              {campaign.segmentId ? (
                <Link href={`/segments/${campaign.segmentId}`}>
                  <Badge
                    variant="outline"
                    className="gap-1 cursor-pointer hover:bg-muted"
                    data-testid="badge-header-segment"
                  >
                    <Filter className="h-3 w-3" />
                    {segment?.name ?? "Segment"}
                  </Badge>
                </Link>
              ) : (
                <Badge variant="outline" className="gap-1" data-testid="badge-header-segment">
                  <Filter className="h-3 w-3" />
                  All subscribers
                </Badge>
              )}
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

      {/* Auto-resend (Task #56) — show linked counterpart when present so the
          user can jump between parent and follow-up child in one click. The
          linked campaign data is fetched on demand so we can render concrete
          "of {parent name}" / "scheduled for {date}" labels per spec. */}
      <FollowUpLinkCard campaign={campaign} />

      {/* Auto-resend (Task #56) — surface the configured-but-not-yet-spawned
          state too so users see the follow-up promise before sending. */}
      {!campaign.followUpCampaignId && !campaign.parentCampaignId && campaign.followUpEnabled && (
        <Card data-testid="card-followup-pending">
          <CardContent className="p-4 flex items-center gap-3">
            <Badge variant="outline">Follow-up enabled</Badge>
            <p className="text-sm text-muted-foreground">
              A follow-up to openers will be created {campaign.followUpDelayHours ?? 36}h after this campaign finishes sending.
            </p>
          </CardContent>
        </Card>
      )}

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
                  {campaign.segmentId ? (
                    <Link href={`/segments/${campaign.segmentId}`}>
                      <span
                        className="font-medium hover:text-primary hover:underline"
                        data-testid="text-segment"
                      >
                        {segment?.name || "Unknown"}
                      </span>
                    </Link>
                  ) : (
                    <span className="font-medium" data-testid="text-segment">
                      All subscribers
                    </span>
                  )}
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
            {(campaign.retryUntil || (campaign.autoRetryCount ?? 0) > 0) && (
              <div className="border rounded-lg p-3 space-y-2" data-testid="retry-status">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <RefreshCw className="h-4 w-4" />
                  Auto-Retry
                </div>
                {(campaign.autoRetryCount ?? 0) > 0 && (
                  <div className="flex justify-between items-center text-sm">
                    <span className="text-muted-foreground">Auto-retry attempts</span>
                    <Badge
                      variant={(campaign.autoRetryCount ?? 0) >= 3 ? "destructive" : "outline"}
                      className="gap-1"
                      data-testid="badge-auto-retry-count"
                    >
                      {campaign.autoRetryCount ?? 0} / 3
                    </Badge>
                  </div>
                )}
                {campaign.retryUntil && (
                  <>
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
                  </>
                )}
                {campaign.failedCount > 0 && (campaign.autoRetryCount ?? 0) < 3 && (
                  <p className="text-xs text-muted-foreground">
                    Failed sends are retried automatically (up to 3 times) before requiring manual action.
                  </p>
                )}
                {(campaign.autoRetryCount ?? 0) >= 3 && campaign.failedCount > 0 && (
                  <p className="text-xs text-destructive">
                    Auto-retry limit reached. Use "Retry Failed Sends" to try again manually.
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ── Failed Sends ──────────────────────────────────────────── */}
      {campaign.failedCount > 0 && (
        <Card data-testid="card-failed-sends">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <AlertCircle className="h-5 w-5 text-destructive" />
                  Failed Sends
                  <Badge variant="destructive" data-testid="badge-failed-count">
                    {campaign.failedCount.toLocaleString()}
                  </Badge>
                </CardTitle>
                <CardDescription className="mt-1">
                  These recipients did not receive the email. You can retry them without
                  re-sending to subscribers who already received it.
                </CardDescription>
              </div>
              <Button
                variant="outline"
                onClick={() => retryFailedMutation.mutate()}
                disabled={retryFailedMutation.isPending}
                data-testid="button-retry-failed"
                className="shrink-0"
              >
                <RotateCcw className={`h-4 w-4 mr-2 ${retryFailedMutation.isPending ? "animate-spin" : ""}`} />
                {retryFailedMutation.isPending ? "Queuing…" : "Retry Failed Sends"}
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Error summary — grouped by reason */}
            {errorsData && errorsData.summary.length > 0 && (
              <div data-testid="table-error-summary">
                <h4 className="text-sm font-semibold mb-2 text-muted-foreground uppercase tracking-wide">
                  Failure Reasons
                </h4>
                <div className="rounded-md border overflow-hidden">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/50">
                      <tr>
                        <th className="text-left px-4 py-2 font-medium">Error</th>
                        <th className="text-right px-4 py-2 font-medium w-24">Count</th>
                      </tr>
                    </thead>
                    <tbody>
                      {errorsData.summary.map((item, i) => (
                        <tr key={i} className="border-t" data-testid={`row-error-summary-${i}`}>
                          <td className="px-4 py-2 text-muted-foreground break-all">{item.message}</td>
                          <td className="px-4 py-2 text-right font-mono">
                            <Badge variant="secondary">{item.count.toLocaleString()}</Badge>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Individual failed emails */}
            <div data-testid="table-failed-emails">
              <h4 className="text-sm font-semibold mb-2 text-muted-foreground uppercase tracking-wide">
                Failed Emails
                <span className="ml-2 font-normal normal-case">
                  ({campaign.failedCount.toLocaleString()} total)
                </span>
              </h4>

              {errorsLoading ? (
                <div className="space-y-2">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <Skeleton key={i} className="h-10 w-full" />
                  ))}
                </div>
              ) : errorsData && errorsData.errors.length > 0 ? (
                <>
                  <div className="rounded-md border overflow-hidden">
                    <table className="w-full text-sm">
                      <thead className="bg-muted/50">
                        <tr>
                          <th className="text-left px-4 py-2 font-medium">Email</th>
                          <th className="text-left px-4 py-2 font-medium">Error</th>
                          <th className="text-right px-4 py-2 font-medium w-40">Time</th>
                        </tr>
                      </thead>
                      <tbody>
                        {errorsData.errors.map((log) => (
                          <tr key={log.id} className="border-t" data-testid={`row-failed-email-${log.id}`}>
                            <td className="px-4 py-2 font-mono text-xs">{log.email || "—"}</td>
                            <td className="px-4 py-2 text-muted-foreground text-xs break-all max-w-xs">
                              {log.message}
                            </td>
                            <td className="px-4 py-2 text-right text-xs text-muted-foreground whitespace-nowrap">
                              {new Date(log.timestamp).toLocaleString()}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {/* Pagination */}
                  {totalErrorPages > 1 && (
                    <div className="flex items-center justify-between pt-2">
                      <span className="text-xs text-muted-foreground">
                        Page {errorsPage} of {totalErrorPages}
                      </span>
                      <div className="flex gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setErrorsPage(p => Math.max(1, p - 1))}
                          disabled={errorsPage <= 1}
                          data-testid="button-errors-prev"
                        >
                          <ChevronLeft className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setErrorsPage(p => Math.min(totalErrorPages, p + 1))}
                          disabled={errorsPage >= totalErrorPages}
                          data-testid="button-errors-next"
                        >
                          <ChevronRight className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <p className="text-sm text-muted-foreground py-4 text-center" data-testid="text-no-error-logs">
                  {campaign.failedCount > 0
                    ? `No detailed error logs available — they may have been cleared by the maintenance job. The ${campaign.failedCount.toLocaleString()} failed sends are still queued and can be retried.`
                    : "No detailed error logs found."}
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Email Content Preview ───────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>Email Content Preview</CardTitle>
          <CardDescription>Preview of the email HTML content</CardDescription>
        </CardHeader>
        <CardContent>
          {campaign.htmlContent ? (
            <div className="border rounded-lg overflow-hidden bg-white">
              <iframe
                srcDoc={withBaseHref(campaign.htmlContent)}
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
