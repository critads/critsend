import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useJobStream, isSSEConnected } from "@/hooks/use-job-stream";
import { Link, useLocation } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Search,
  Plus,
  MoreVertical,
  Trash2,
  Copy,
  Play,
  Pause,
  BarChart3,
  Mail,
  Clock,
  CheckCircle2,
  AlertCircle,
  Eye,
  RefreshCw,
  MousePointerClick,
  UserMinus,
  ChevronLeft,
  ChevronRight,
  ShieldAlert,
  Filter,
} from "lucide-react";
import type { Campaign, ErrorLog, Segment } from "@shared/schema";

function CampaignStatusBadge({ status, onClick, campaignId }: { status: string; onClick?: () => void; campaignId?: string }) {
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
    <Badge
      variant={config.variant}
      className={`gap-1 ${config.className || ""} ${onClick ? "cursor-pointer" : ""}`}
      onClick={onClick}
      data-testid={onClick && campaignId ? `badge-failed-status-${campaignId}` : undefined}
    >
      {config.icon}
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </Badge>
  );
}

export default function Campaigns() {
  useJobStream();
  const [, navigate] = useLocation();
  const [search, setSearch] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const [deleteConfirm, setDeleteConfirm] = useState<Campaign | null>(null);
  const [bulkDeleteConfirm, setBulkDeleteConfirm] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [failedInfoCampaign, setFailedInfoCampaign] = useState<Campaign | null>(null);
  const { toast } = useToast();

  const { data: campaigns, isLoading, isError, error } = useQuery<Campaign[]>({
    queryKey: ["/api/campaigns"],
    refetchInterval: (query) => {
      if (isSSEConnected()) return false;
      const data = query.state.data as Campaign[] | undefined;
      const hasSending = data?.some((c) => c.status === "sending");
      return hasSending ? 10000 : false;
    },
    structuralSharing: (oldData: any, newData: any) => {
      if (!oldData || !newData || !Array.isArray(oldData) || !Array.isArray(newData)) return newData;
      return newData.map((newCampaign: any) => {
        const oldCampaign = oldData.find((c: any) => c.id === newCampaign.id);
        if (!oldCampaign || newCampaign.status === "completed" || newCampaign.status === "failed" || newCampaign.status === "cancelled") {
          return newCampaign;
        }
        if (oldCampaign.status === "sending" && newCampaign.status === "sending") {
          return {
            ...newCampaign,
            sentCount: Math.max(newCampaign.sentCount || 0, oldCampaign.sentCount || 0),
            failedCount: Math.max(newCampaign.failedCount || 0, oldCampaign.failedCount || 0),
          };
        }
        return newCampaign;
      });
    },
  });

  const { data: campaignStats } = useQuery<Record<string, { opens: number; clicks: number; unsubscribes: number; complaints: number }>>({
    queryKey: ["/api/campaigns/stats"],
    refetchInterval: 60000,
  });

  const { data: segments } = useQuery<Segment[]>({
    queryKey: ["/api/segments"],
    staleTime: 5 * 60 * 1000,
  });

  const segmentNameById = new Map<string, string>(
    (segments ?? []).map((s) => [s.id, s.name]),
  );

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/campaigns/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/campaigns"] });
      setDeleteConfirm(null);
      toast({
        title: "Campaign deleted",
        description: "The campaign has been removed.",
      });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to delete campaign. Please try again.",
        variant: "destructive",
      });
    },
  });

  const bulkDeleteMutation = useMutation({
    mutationFn: (ids: string[]) => apiRequest("DELETE", "/api/campaigns/bulk", { ids }),
    onSuccess: (_, ids) => {
      queryClient.invalidateQueries({ queryKey: ["/api/campaigns"] });
      setSelectedIds(new Set());
      setBulkDeleteConfirm(false);
      toast({
        title: `${ids.length} campaign${ids.length > 1 ? "s" : ""} deleted`,
        description: "The selected campaigns have been removed.",
      });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to delete campaigns. Please try again.",
        variant: "destructive",
      });
    },
  });

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (!filteredCampaigns) return;
    if (selectedIds.size === filteredCampaigns.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredCampaigns.map((c) => c.id)));
    }
  };

  const copyMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("POST", `/api/campaigns/${id}/copy`);
      return res.json() as Promise<Campaign>;
    },
    onSuccess: (newCampaign) => {
      queryClient.invalidateQueries({ queryKey: ["/api/campaigns"] });
      toast({
        title: "Campaign copied",
        description: "Redirecting you to edit the copy now.",
      });
      navigate(`/campaigns/${newCampaign.id}/edit`);
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to copy campaign. Please try again.",
        variant: "destructive",
      });
    },
  });

  const pauseResumeMutation = useMutation({
    mutationFn: ({ id, action }: { id: string; action: "pause" | "resume" }) =>
      apiRequest("POST", `/api/campaigns/${id}/${action}`),
    onSuccess: (_, { action }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/campaigns"] });
      toast({
        title: action === "pause" ? "Campaign paused" : "Campaign resumed",
        description: action === "pause" ? "The campaign has been paused." : "The campaign is now sending.",
      });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to update campaign status. Please try again.",
        variant: "destructive",
      });
    },
  });

  const { data: failedInfo, isLoading: isLoadingErrors } = useQuery<{ pauseReason: string | null; errors: ErrorLog[] }>({
    queryKey: ["/api/campaigns", failedInfoCampaign?.id, "errors"],
    enabled: !!failedInfoCampaign,
  });

  const requeueMutation = useMutation({
    mutationFn: (id: string) => apiRequest("POST", `/api/campaigns/${id}/requeue`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/campaigns"] });
      setFailedInfoCampaign(null);
      toast({
        title: "Campaign requeued",
        description: "The campaign has been requeued for sending.",
      });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to requeue campaign. Please try again.",
        variant: "destructive",
      });
    },
  });

  const PAGE_SIZE = 20;

  const filteredCampaigns = campaigns?.filter((c) =>
    c.name.toLowerCase().includes(search.toLowerCase()) ||
    c.subject.toLowerCase().includes(search.toLowerCase())
  );

  const totalPages = Math.ceil((filteredCampaigns?.length ?? 0) / PAGE_SIZE);
  const paginatedCampaigns = filteredCampaigns?.slice(
    (currentPage - 1) * PAGE_SIZE,
    currentPage * PAGE_SIZE
  );

  return (
    <div className="p-6 lg:p-8 space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Campaigns</h1>
          <p className="text-muted-foreground">
            Create and manage your email campaigns
          </p>
        </div>
        <Link href="/campaigns/new">
          <Button data-testid="button-new-campaign">
            <Plus className="h-4 w-4 mr-2" />
            New Campaign
          </Button>
        </Link>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-4 flex-wrap">
          <CardTitle className="flex items-center gap-2">
            <Mail className="h-5 w-5" />
            All Campaigns
          </CardTitle>
          <div className="flex items-center gap-3 flex-wrap">
            {selectedIds.size > 0 && (
              <Button
                variant="destructive"
                size="sm"
                onClick={() => setBulkDeleteConfirm(true)}
                data-testid="button-bulk-delete"
              >
                <Trash2 className="h-4 w-4 mr-2" />
                Delete {selectedIds.size} selected
              </Button>
            )}
            <div className="relative w-full sm:w-72">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search campaigns..."
                value={search}
                onChange={(e) => { setSearch(e.target.value); setCurrentPage(1); }}
                className="pl-9"
                data-testid="input-search-campaigns"
              />
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-4">
              {[1, 2, 3, 4, 5].map((i) => (
                <Skeleton key={i} className="h-16 w-full" />
              ))}
            </div>
          ) : isError ? (
            <div className="flex flex-col items-center justify-center py-16 text-center gap-4" data-testid="campaigns-error-state">
              <div className="rounded-full bg-destructive/10 p-4">
                <AlertCircle className="h-10 w-10 text-destructive" />
              </div>
              <div>
                <h3 className="text-lg font-semibold mb-1">Failed to load campaigns</h3>
                <p className="text-muted-foreground text-sm max-w-sm">
                  {(error as any)?.message || "The server returned an error. Check the Error Logs page for details."}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => queryClient.invalidateQueries({ queryKey: ["/api/campaigns"] })}
                data-testid="button-retry-campaigns"
              >
                <RefreshCw className="h-4 w-4 mr-2" />
                Retry
              </Button>
            </div>
          ) : filteredCampaigns && filteredCampaigns.length > 0 ? (
            <div className="space-y-4">
            <div className="rounded-md border overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[40px]">
                      <Checkbox
                        checked={filteredCampaigns.length > 0 && selectedIds.size === filteredCampaigns.length}
                        onCheckedChange={toggleSelectAll}
                        data-testid="checkbox-select-all"
                        aria-label="Select all campaigns"
                      />
                    </TableHead>
                    <TableHead>Campaign</TableHead>
                    <TableHead><span className="flex items-center gap-1"><Filter className="h-3.5 w-3.5" />Segment</span></TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Sent</TableHead>
                    <TableHead><span className="flex items-center gap-1"><Eye className="h-3.5 w-3.5" />Opens</span></TableHead>
                    <TableHead><span className="flex items-center gap-1"><MousePointerClick className="h-3.5 w-3.5" />Clicks</span></TableHead>
                    <TableHead><span className="flex items-center gap-1"><UserMinus className="h-3.5 w-3.5" />Unsubs</span></TableHead>
                    <TableHead><span className="flex items-center gap-1"><ShieldAlert className="h-3.5 w-3.5" />Plaintes</span></TableHead>
                    <TableHead>Dates</TableHead>
                    <TableHead className="w-[50px]"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {paginatedCampaigns?.map((campaign) => (
                    <TableRow
                      key={campaign.id}
                      data-testid={`campaign-row-${campaign.id}`}
                      className={selectedIds.has(campaign.id) ? "bg-muted/50" : ""}
                    >
                      <TableCell>
                        <Checkbox
                          checked={selectedIds.has(campaign.id)}
                          onCheckedChange={() => toggleSelect(campaign.id)}
                          data-testid={`checkbox-campaign-${campaign.id}`}
                          aria-label={`Select ${campaign.name}`}
                        />
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col gap-1">
                          <span className="font-medium">{campaign.name}</span>
                          <span className="text-sm text-muted-foreground truncate max-w-[300px]">
                            {campaign.subject}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell data-testid={`text-segment-${campaign.id}`}>
                        {campaign.segmentId ? (
                          <Link href={`/segments/${campaign.segmentId}`}>
                            <span className="text-sm text-foreground hover:text-primary hover:underline truncate max-w-[180px] inline-block align-bottom">
                              {segmentNameById.get(campaign.segmentId) ?? "—"}
                            </span>
                          </Link>
                        ) : (
                          <span className="text-sm text-muted-foreground">All subscribers</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <CampaignStatusBadge
                          status={campaign.status}
                          campaignId={campaign.id}
                          onClick={campaign.status === "failed" ? () => setFailedInfoCampaign(campaign) : undefined}
                        />
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col gap-0.5">
                          <span className="font-medium">{campaign.sentCount.toLocaleString()}</span>
                          {campaign.failedCount > 0 && (
                            <span className="text-xs text-destructive">
                              {campaign.failedCount} failed
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell data-testid={`text-opens-${campaign.id}`}>
                        <div className="flex flex-col gap-0.5">
                          <span className="font-medium tabular-nums">
                            {(campaignStats?.[campaign.id]?.opens ?? 0).toLocaleString()}
                          </span>
                          {campaign.sentCount > 0 && (campaignStats?.[campaign.id]?.opens ?? 0) > 0 && (
                            <span className="text-xs text-muted-foreground tabular-nums">
                              {((campaignStats![campaign.id].opens / campaign.sentCount) * 100).toFixed(1)}%
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell data-testid={`text-clicks-${campaign.id}`}>
                        <div className="flex flex-col gap-0.5">
                          <span className="font-medium tabular-nums">
                            {(campaignStats?.[campaign.id]?.clicks ?? 0).toLocaleString()}
                          </span>
                          {campaign.sentCount > 0 && (campaignStats?.[campaign.id]?.clicks ?? 0) > 0 && (
                            <span className="text-xs text-muted-foreground tabular-nums">
                              {((campaignStats![campaign.id].clicks / campaign.sentCount) * 100).toFixed(1)}%
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell data-testid={`text-unsubs-${campaign.id}`}>
                        <span className={`font-medium tabular-nums ${(campaignStats?.[campaign.id]?.unsubscribes ?? 0) > 0 ? "text-destructive" : ""}`}>
                          {(campaignStats?.[campaign.id]?.unsubscribes ?? 0).toLocaleString()}
                        </span>
                      </TableCell>
                      <TableCell data-testid={`text-complaints-${campaign.id}`}>
                        <span className={`font-medium tabular-nums ${(campaignStats?.[campaign.id]?.complaints ?? 0) > 0 ? "text-orange-600" : ""}`}>
                          {(campaignStats?.[campaign.id]?.complaints ?? 0).toLocaleString()}
                        </span>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col gap-1 text-sm">
                          {campaign.startedAt && (
                            <div className="flex items-center gap-1 text-muted-foreground">
                              <span className="font-medium text-foreground/70">Sending</span>
                              <span>{new Date(campaign.startedAt).toLocaleString()}</span>
                            </div>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              data-testid={`button-campaign-menu-${campaign.id}`}
                            >
                              <MoreVertical className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <Link href={`/campaigns/${campaign.id}`}>
                              <DropdownMenuItem>
                                <Eye className="h-4 w-4 mr-2" />
                                View
                              </DropdownMenuItem>
                            </Link>
                            <Link href={`/analytics/${campaign.id}`}>
                              <DropdownMenuItem>
                                <BarChart3 className="h-4 w-4 mr-2" />
                                View Stats
                              </DropdownMenuItem>
                            </Link>
                            <DropdownMenuItem onClick={() => copyMutation.mutate(campaign.id)}>
                              <Copy className="h-4 w-4 mr-2" />
                              Copy
                            </DropdownMenuItem>
                            {campaign.status === "sending" && (
                              <DropdownMenuItem
                                onClick={() => pauseResumeMutation.mutate({ id: campaign.id, action: "pause" })}
                              >
                                <Pause className="h-4 w-4 mr-2" />
                                Pause
                              </DropdownMenuItem>
                            )}
                            {campaign.status === "paused" && (
                              <DropdownMenuItem
                                onClick={() => pauseResumeMutation.mutate({ id: campaign.id, action: "resume" })}
                              >
                                <Play className="h-4 w-4 mr-2" />
                                Resume
                              </DropdownMenuItem>
                            )}
                            {campaign.status === "failed" && (
                              <DropdownMenuItem
                                onClick={() => setFailedInfoCampaign(campaign)}
                                data-testid={`button-why-failed-${campaign.id}`}
                              >
                                <AlertCircle className="h-4 w-4 mr-2" />
                                Why Failed?
                              </DropdownMenuItem>
                            )}
                            {campaign.status === "failed" && (
                              <DropdownMenuItem
                                onClick={() => requeueMutation.mutate(campaign.id)}
                                data-testid={`button-requeue-${campaign.id}`}
                              >
                                <RefreshCw className="h-4 w-4 mr-2" />
                                Requeue
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              className="text-destructive"
                              onClick={() => setDeleteConfirm(campaign)}
                            >
                              <Trash2 className="h-4 w-4 mr-2" />
                              Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {totalPages > 1 && (
              <div className="flex items-center justify-between" data-testid="campaigns-pagination">
                <p className="text-sm text-muted-foreground">
                  Showing {((currentPage - 1) * PAGE_SIZE) + 1}–{Math.min(currentPage * PAGE_SIZE, filteredCampaigns.length)} of {filteredCampaigns.length} campaigns
                </p>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                    disabled={currentPage === 1}
                    data-testid="button-prev-page"
                  >
                    <ChevronLeft className="h-4 w-4 mr-1" />
                    Previous
                  </Button>
                  <span className="text-sm font-medium tabular-nums px-2">
                    {currentPage} / {totalPages}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                    disabled={currentPage === totalPages}
                    data-testid="button-next-page"
                  >
                    Next
                    <ChevronRight className="h-4 w-4 ml-1" />
                  </Button>
                </div>
              </div>
            )}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <Mail className="h-16 w-16 text-muted-foreground/50 mb-4" />
              <h3 className="text-lg font-semibold mb-2">No campaigns found</h3>
              <p className="text-muted-foreground max-w-md mb-4">
                {search
                  ? "No campaigns match your search. Try a different query."
                  : "Create your first campaign to start sending emails to your subscribers."}
              </p>
              {!search && (
                <Link href="/campaigns/new">
                  <Button>
                    <Plus className="h-4 w-4 mr-2" />
                    Create Your First Campaign
                  </Button>
                </Link>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!deleteConfirm} onOpenChange={() => setDeleteConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Campaign</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete "{deleteConfirm?.name}"? This will also delete all associated statistics.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteConfirm(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => deleteConfirm && deleteMutation.mutate(deleteConfirm.id)}
              disabled={deleteMutation.isPending}
              data-testid="button-confirm-delete-campaign"
            >
              {deleteMutation.isPending ? "Deleting..." : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={bulkDeleteConfirm} onOpenChange={() => setBulkDeleteConfirm(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {selectedIds.size} Campaign{selectedIds.size > 1 ? "s" : ""}</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete {selectedIds.size} selected campaign{selectedIds.size > 1 ? "s" : ""}? This will also delete all associated statistics and cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBulkDeleteConfirm(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => bulkDeleteMutation.mutate(Array.from(selectedIds))}
              disabled={bulkDeleteMutation.isPending}
              data-testid="button-confirm-bulk-delete"
            >
              {bulkDeleteMutation.isPending ? "Deleting..." : `Delete ${selectedIds.size} Campaign${selectedIds.size > 1 ? "s" : ""}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!failedInfoCampaign} onOpenChange={() => setFailedInfoCampaign(null)}>
        <DialogContent className="max-w-lg" data-testid="dialog-failed-info">
          <DialogHeader>
            <DialogTitle>Campaign Failure Details</DialogTitle>
            <DialogDescription>
              {failedInfoCampaign?.name}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {failedInfo?.pauseReason && (
              <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3">
                <p className="text-sm font-medium text-destructive">Reason</p>
                <p className="text-sm text-muted-foreground mt-1" data-testid="text-pause-reason">
                  {failedInfo.pauseReason}
                </p>
              </div>
            )}
            <div>
              <p className="text-sm font-medium mb-2">Error Logs</p>
              {isLoadingErrors ? (
                <div className="space-y-2">
                  {[1, 2, 3].map((i) => (
                    <Skeleton key={i} className="h-12 w-full" />
                  ))}
                </div>
              ) : failedInfo?.errors && failedInfo.errors.length > 0 ? (
                <ScrollArea className="h-[300px]">
                  <div className="space-y-2 pr-4">
                    {failedInfo.errors.map((error) => (
                      <div
                        key={error.id}
                        className="rounded-md border p-3 text-sm"
                        data-testid={`error-log-${error.id}`}
                      >
                        <div className="flex items-center justify-between gap-2 flex-wrap">
                          <Badge variant="outline" className="text-xs">
                            {error.type}
                          </Badge>
                          <span className="text-xs text-muted-foreground">
                            {new Date(error.timestamp).toLocaleString()}
                          </span>
                        </div>
                        <p className="mt-1 text-muted-foreground">{error.message}</p>
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              ) : (
                <p className="text-sm text-muted-foreground">No error logs found for this campaign.</p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setFailedInfoCampaign(null)}>
              Close
            </Button>
            <Button
              onClick={() => failedInfoCampaign && requeueMutation.mutate(failedInfoCampaign.id)}
              disabled={requeueMutation.isPending}
              data-testid="button-requeue-campaign"
            >
              <RefreshCw className="h-4 w-4 mr-2" />
              {requeueMutation.isPending ? "Requeuing..." : "Requeue Campaign"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
