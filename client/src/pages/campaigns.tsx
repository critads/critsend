import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
} from "lucide-react";
import type { Campaign } from "@shared/schema";

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

export default function Campaigns() {
  const [search, setSearch] = useState("");
  const [deleteConfirm, setDeleteConfirm] = useState<Campaign | null>(null);
  const { toast } = useToast();

  const { data: campaigns, isLoading } = useQuery<Campaign[]>({
    queryKey: ["/api/campaigns"],
    refetchInterval: (query) => {
      // Auto-refresh every 2 seconds if any campaign is sending
      const data = query.state.data as Campaign[] | undefined;
      const hasSending = data?.some((c) => c.status === "sending");
      return hasSending ? 2000 : false;
    },
  });

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

  const copyMutation = useMutation({
    mutationFn: (id: string) => apiRequest("POST", `/api/campaigns/${id}/copy`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/campaigns"] });
      toast({
        title: "Campaign copied",
        description: "A copy of the campaign has been created.",
      });
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

  const filteredCampaigns = campaigns?.filter((c) =>
    c.name.toLowerCase().includes(search.toLowerCase()) ||
    c.subject.toLowerCase().includes(search.toLowerCase())
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
          <div className="relative w-full sm:w-72">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search campaigns..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
              data-testid="input-search-campaigns"
            />
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-4">
              {[1, 2, 3, 4, 5].map((i) => (
                <Skeleton key={i} className="h-16 w-full" />
              ))}
            </div>
          ) : filteredCampaigns && filteredCampaigns.length > 0 ? (
            <div className="rounded-md border overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Campaign</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Sent</TableHead>
                    <TableHead>Scheduled</TableHead>
                    <TableHead className="w-[50px]"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredCampaigns.map((campaign) => (
                    <TableRow key={campaign.id} data-testid={`campaign-row-${campaign.id}`}>
                      <TableCell>
                        <div className="flex flex-col gap-1">
                          <span className="font-medium">{campaign.name}</span>
                          <span className="text-sm text-muted-foreground truncate max-w-[300px]">
                            {campaign.subject}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <CampaignStatusBadge status={campaign.status} />
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
                      <TableCell className="text-muted-foreground">
                        {campaign.scheduledAt
                          ? new Date(campaign.scheduledAt).toLocaleString()
                          : "Not scheduled"}
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
    </div>
  );
}
