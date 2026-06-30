import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { format } from "date-fns";
import type { DateRange } from "react-day-picker";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useQuery, useMutation, keepPreviousData } from "@tanstack/react-query";
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
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
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
  Edit,
  X,
  Clipboard,
  Square,
  Zap,
  CalendarIcon,
} from "lucide-react";
import type { Campaign, CampaignListItem, ErrorLog, Segment } from "@shared/schema";
import { CampaignProgress } from "@/components/campaign-progress";

function CampaignStatusBadge({ status, onClick, campaignId }: { status: string; onClick?: () => void; campaignId?: string }) {
  const variants: Record<string, { variant: "default" | "secondary" | "destructive" | "outline"; icon: React.ReactNode; className?: string }> = {
    draft: { variant: "secondary", icon: <Clock className="h-3 w-3" /> },
    scheduled: { variant: "outline", icon: <Clock className="h-3 w-3" />, className: "border-blue-500 text-blue-600" },
    sending: { variant: "default", icon: <Mail className="h-3 w-3" /> },
    completed: { variant: "secondary", icon: <CheckCircle2 className="h-3 w-3" />, className: "bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300" },
    paused: { variant: "outline", icon: <Pause className="h-3 w-3" />, className: "border-yellow-500 text-yellow-600" },
    failed: { variant: "destructive", icon: <AlertCircle className="h-3 w-3" /> },
  };

  const config = variants[status] || variants.draft;
  const label = status.charAt(0).toUpperCase() + status.slice(1);

  const badge = (
    <Badge
      variant={config.variant}
      className={`gap-1 ${config.className || ""} ${onClick ? "cursor-pointer" : ""}`}
    >
      {config.icon}
      {label}
    </Badge>
  );

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className="inline-flex focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-md"
        aria-label={`View ${label} details`}
        data-testid={campaignId ? `badge-failed-status-${campaignId}` : undefined}
      >
        {badge}
      </button>
    );
  }

  return badge;
}

// Generic parser for the structured delete-error responses. apiRequest throws
// `${status}: ${body}` on non-2xx. Pulls out the server-provided `message` for
// follow-up blocks (409), busy-DB timeouts (503, Task #211), and partial bulk
// failures (500) so the toast tells the user exactly what to do next.
function parseDeleteError(err: Error): { title: string; message: string } | null {
  const m = err?.message?.match(/^(\d{3}):\s*(\{.*\})$/);
  if (!m) return null;
  try {
    const body = JSON.parse(m[2]);
    if (body?.error === "follow_up_pending") {
      return { title: "Follow-up pending", message: body.message ?? "A follow-up is pending for this campaign." };
    }
    if (body?.error === "delete_timeout") {
      return { title: "Database busy", message: body.message ?? "The database is busy right now. Please try again in a moment." };
    }
    if (body?.error === "bulk_delete_partial_failure") {
      return { title: "Some deletes failed", message: body.message ?? "Some campaigns could not be deleted. Please try again." };
    }
  } catch {
    // body wasn't JSON — fall back to generic toast
  }
  return null;
}

interface PaginatedCampaigns {
  campaigns: CampaignListItem[];
  total: number;
  page: number;
  totalPages: number;
}

export default function Campaigns() {
  useJobStream();
  const [, navigate] = useLocation();
  const [searchInput, setSearchInput] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const [originalsOnly, setOriginalsOnly] = useState(false);
  // Task #188: scheduled-date filter. `dateFilter` drives the segmented
  // button group; `customRange` only matters when dateFilter === 'custom'.
  // Bounds are computed in the browser's local timezone — Today = local
  // midnight to local midnight + 24h — so a French operator sees campaigns
  // scheduled "today" by their wall clock, not UTC.
  const [dateFilter, setDateFilter] = useState<"all" | "today" | "yesterday" | "custom">("all");
  const [customRange, setCustomRange] = useState<DateRange | undefined>(undefined);
  const [customPopoverOpen, setCustomPopoverOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<Campaign | null>(null);
  const [bulkDeleteConfirm, setBulkDeleteConfirm] = useState(false);
  const [endConfirm, setEndConfirm] = useState<CampaignListItem | null>(null);
  const [urgentConfirm, setUrgentConfirm] = useState<CampaignListItem | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [failedInfoCampaign, setFailedInfoCampaign] = useState<Campaign | null>(null);
  const { toast } = useToast();
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  const PAGE_SIZE = 20;

  const handleSearchChange = useCallback((value: string) => {
    setSearchInput(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setDebouncedSearch(value);
      setCurrentPage(1);
    }, 300);
  }, []);

  useEffect(() => {
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, []);

  // Task #188: resolve `dateFilter` into ISO [from, to) bounds. `null` means
  // no bound (either "all" is selected or Custom is open but incomplete —
  // we don't want to send a partial filter that would surprise the user).
  const dateBounds = useMemo<{ from: string | null; to: string | null }>(() => {
    if (dateFilter === "all") return { from: null, to: null };
    // Use calendar-day arithmetic (setDate) rather than `+ 24*60*60*1000` so
    // we get correct local-day [from, to) boundaries across DST transitions
    // (a "day" can be 23h or 25h on switch days — fixed-millisecond math
    // would mis-bucket campaigns by ±1h on those days).
    const startOfDay = (d: Date) => {
      const x = new Date(d);
      x.setHours(0, 0, 0, 0);
      return x;
    };
    const addDays = (d: Date, n: number) => {
      const x = new Date(d);
      x.setDate(x.getDate() + n);
      return x;
    };
    if (dateFilter === "today") {
      const from = startOfDay(new Date());
      const to = addDays(from, 1);
      return { from: from.toISOString(), to: to.toISOString() };
    }
    if (dateFilter === "yesterday") {
      const todayStart = startOfDay(new Date());
      const from = addDays(todayStart, -1);
      return { from: from.toISOString(), to: todayStart.toISOString() };
    }
    // custom: require both ends; the upper bound is exclusive next-day start.
    if (dateFilter === "custom" && customRange?.from && customRange?.to) {
      const from = startOfDay(customRange.from);
      const to = addDays(startOfDay(customRange.to), 1);
      return { from: from.toISOString(), to: to.toISOString() };
    }
    return { from: null, to: null };
  }, [dateFilter, customRange]);

  const queryParams = new URLSearchParams();
  queryParams.set("page", String(currentPage));
  queryParams.set("limit", String(PAGE_SIZE));
  if (debouncedSearch) queryParams.set("search", debouncedSearch);
  if (originalsOnly) queryParams.set("originalsOnly", "true");
  if (dateBounds.from) queryParams.set("scheduledFrom", dateBounds.from);
  if (dateBounds.to) queryParams.set("scheduledTo", dateBounds.to);
  const queryString = queryParams.toString();

  const { data: campaignsData, isLoading, isError, error } = useQuery<PaginatedCampaigns>({
    queryKey: ["/api/campaigns", { page: currentPage, search: debouncedSearch, originalsOnly, from: dateBounds.from, to: dateBounds.to }],
    // Task #148: route through `apiRequest` so 503 responses surface as
    // `ApiError` with `.status` + parsed `.body` — required for the
    // soft-busy branch in the error UI below to fire reliably.
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/campaigns?${queryString}`);
      return res.json();
    },
    placeholderData: keepPreviousData,
    // Task #199: align the client staleTime with the server-side list cache
    // (default 3 min). Within this window React Query serves the cached list
    // on mount/refocus instead of re-hitting the API — live status/counter
    // changes still arrive via SSE (handleCampaignEvent patches this cache).
    staleTime: 3 * 60 * 1000,
    refetchInterval: (query) => {
      const data = query.state.data as PaginatedCampaigns | undefined;
      const hasSending = data?.campaigns?.some((c) => c.status === "sending");
      if (!hasSending) return false;
      // Task #199: the heavy 20-30s polling that self-saturated the web DB
      // pool (and tripped the 503 "Serveur momentanément occupé" screen) is
      // gone. Live sent/failed/pending/deferred counters now ride SSE in
      // real time. We keep ONE slow 60s refetch while a campaign is sending
      // purely so the one value SSE does not carry — `pressureHeldCount`, the
      // drain-queue snapshot behind the amber "held" progress segment — does
      // not freeze indefinitely. These polls are served from the server cache
      // (cost no DB read), so the held value refreshes at the cache TTL
      // boundary (~3 min) rather than every 60s — acceptable for a cosmetic
      // progress segment, and the bar still advances live via SSE sent counts.
      return 60000;
    },
    // Phase-1 perf fix: pause polling when the tab is hidden. React
    // Query defaults to keeping interval refetches running in the
    // background; on a multi-tab session this multiplies the polling
    // rate by N for tabs the user isn't even looking at, which was a
    // major contributor to the pool-saturation 503s on /campaigns.
    refetchIntervalInBackground: false,
    structuralSharing: (oldData: any, newData: any) => {
      if (!oldData || !newData || !oldData.campaigns || !newData.campaigns) return newData;
      return {
        ...newData,
        campaigns: newData.campaigns.map((newCampaign: any) => {
          const oldCampaign = oldData.campaigns.find((c: any) => c.id === newCampaign.id);
          if (!oldCampaign || newCampaign.status === "completed" || newCampaign.status === "failed" || newCampaign.status === "cancelled") {
            return newCampaign;
          }
          if (oldCampaign.status === "sending" && newCampaign.status === "sending") {
            return {
              ...newCampaign,
              sentCount: Math.max(newCampaign.sentCount || 0, oldCampaign.sentCount || 0),
              failedCount: Math.max(newCampaign.failedCount || 0, oldCampaign.failedCount || 0),
              // NOTE: pressureHeldCount is intentionally NOT held monotonic —
              // it's a live snapshot of the drain queue, so it SHOULD shrink
              // (often quickly) as the drain worker dispatches deferred sends.
            };
          }
          return newCampaign;
        }),
      };
    },
  });

  const campaigns = campaignsData?.campaigns;
  const totalPages = campaignsData?.totalPages ?? 1;
  const totalCampaigns = campaignsData?.total ?? 0;

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
    onError: (err: Error) => {
      // Surface the server's structured error: a pending follow-up block (409,
      // Task #56) or a busy-DB timeout (503, Task #211) so the user knows which
      // action to take next.
      const parsed = parseDeleteError(err);
      toast({
        title: parsed?.title ?? "Error",
        description: parsed?.message ?? "Failed to delete campaign. Please try again.",
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
    onError: (err: Error) => {
      // Bulk deletes can partially fail: some blocked by a pending follow-up,
      // some timed out against a busy DB (Task #211). The server returns a
      // structured message listing exactly what happened — surface it and
      // refresh the list since some deletes may have succeeded.
      queryClient.invalidateQueries({ queryKey: ["/api/campaigns"] });
      setSelectedIds(new Set());
      setBulkDeleteConfirm(false);
      const parsed = parseDeleteError(err);
      toast({
        title: parsed?.title ?? "Error",
        description: parsed?.message ?? "Failed to delete campaigns. Please try again.",
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
    if (!campaigns) return;
    if (selectedIds.size === campaigns.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(campaigns.map((c) => c.id)));
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

  const endMutation = useMutation<{ deletedDeferred: number }, Error, string>({
    mutationFn: async (id: string) => {
      const res = await apiRequest("POST", `/api/campaigns/${id}/end`);
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/campaigns"] });
      setEndConfirm(null);
      toast({
        title: "Campaign ended",
        description: data.deletedDeferred > 0
          ? `Removed ${data.deletedDeferred.toLocaleString()} deferred recipient${data.deletedDeferred > 1 ? "s" : ""}.`
          : "Campaign marked as ended (no deferred recipients to remove).",
      });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to end campaign. Please try again.",
        variant: "destructive",
      });
    },
  });

  // 2026-05-23 — async urgent-flush. Server returns 202 + jobId immediately
  // (no DB-stalling synchronous UPDATE). We poll GET /api/urgent-flush/:jobId
  // every 2s for progress and surface a single toast that updates from
  // "en cours… X/Y" → "terminé ✓" or "erreur".
  const urgentMutation = useMutation<
    { ok: boolean; jobId: string; status: string; totalHeld: number; processed: number; alreadyRunning?: boolean },
    Error,
    string
  >({
    mutationFn: async (id: string) => {
      const res = await apiRequest("POST", `/api/campaigns/${id}/urgent`);
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/campaigns"] });
      setUrgentConfirm(null);
      toast({
        title: data.alreadyRunning ? "Mode urgent: flush déjà en cours" : "Mode urgent: flush en arrière-plan",
        description: `${data.totalHeld.toLocaleString()} envois à débloquer. Suivi de la progression…`,
      });

      // Poll progress. Stops on completed/failed or after a safety max
      // (totalHeld / 500 batches × 2s poll × 3 safety factor, capped at
      // 30 min) so we don't leak intervals on a stuck/abandoned job.
      const jobId = data.jobId;
      const startTs = Date.now();
      const MAX_POLL_MS = Math.min(30 * 60_000, Math.max(60_000, (data.totalHeld / 500) * 2_000 * 3));
      const poll = setInterval(async () => {
        try {
          const r = await fetch(`/api/urgent-flush/${jobId}`, { credentials: "include" });
          if (!r.ok) {
            // 404/403/5xx: stop polling, leave the campaign list to reflect actual state.
            if (r.status === 404 || r.status === 403) clearInterval(poll);
            return;
          }
          const job = (await r.json()) as { status: string; totalHeld: number; processed: number; error: string | null };
          queryClient.invalidateQueries({ queryKey: ["/api/campaigns"] });
          if (job.status === "completed") {
            clearInterval(poll);
            toast({
              title: "Mode urgent activé ✓",
              description: `${job.processed.toLocaleString()} envois débloqués. La campagne est en cours d'expédition prioritaire.`,
            });
          } else if (job.status === "failed") {
            clearInterval(poll);
            toast({
              title: "Mode urgent: échec du flush",
              description: job.error ?? "Erreur inconnue. Vérifiez les logs serveur.",
              variant: "destructive",
            });
          } else if (Date.now() - startTs > MAX_POLL_MS) {
            clearInterval(poll);
          }
        } catch {
          // Network blip — keep polling; the safety timeout will eventually stop us.
        }
      }, 2_000);
    },
    onError: (err: any) => {
      // 503 (pool saturated) surfaces here with a parsed message via apiRequest.
      const msg = String(err?.message || err || "");
      const tightDb = msg.includes("under load") || msg.includes("503");
      toast({
        title: tightDb ? "Base de données sous charge" : "Erreur",
        description: tightDb
          ? "La DB est saturée — réessayez dans 30 secondes."
          : "Impossible d'activer le mode urgent.",
        variant: "destructive",
      });
    },
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
            <label className="flex items-center gap-2 text-sm" data-testid="toggle-originals-only">
              <Checkbox
                checked={originalsOnly}
                onCheckedChange={(v) => { setOriginalsOnly(!!v); setCurrentPage(1); }}
                aria-label="Originals only"
              />
              Originals only
            </label>
            <div className="flex items-center gap-1 rounded-md border bg-background p-0.5" data-testid="filter-scheduled-date">
              {([
                { key: "all", label: "All" },
                { key: "today", label: "Today" },
                { key: "yesterday", label: "Yesterday" },
              ] as const).map(({ key, label }) => (
                <Button
                  key={key}
                  type="button"
                  size="sm"
                  variant={dateFilter === key ? "default" : "ghost"}
                  className="h-7 px-2.5 text-xs"
                  onClick={() => { setDateFilter(key); setCurrentPage(1); }}
                  data-testid={`button-date-${key}`}
                >
                  {label}
                </Button>
              ))}
              <Popover open={customPopoverOpen} onOpenChange={setCustomPopoverOpen}>
                <PopoverTrigger asChild>
                  <Button
                    type="button"
                    size="sm"
                    variant={dateFilter === "custom" ? "default" : "ghost"}
                    className="h-7 px-2.5 text-xs gap-1.5"
                    data-testid="button-date-custom"
                  >
                    <CalendarIcon className="h-3.5 w-3.5" />
                    {dateFilter === "custom" && customRange?.from && customRange?.to
                      ? `${format(customRange.from, "d MMM")} – ${format(customRange.to, "d MMM")}`
                      : "Custom"}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="end">
                  <Calendar
                    mode="range"
                    selected={customRange}
                    onSelect={(range) => {
                      setCustomRange(range);
                      setDateFilter("custom");
                      setCurrentPage(1);
                      if (range?.from && range?.to) setCustomPopoverOpen(false);
                    }}
                    numberOfMonths={2}
                  />
                  <div className="flex items-center justify-end gap-2 border-t p-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setCustomRange(undefined);
                        setDateFilter("all");
                        setCurrentPage(1);
                        setCustomPopoverOpen(false);
                      }}
                      data-testid="button-date-custom-clear"
                    >
                      Clear
                    </Button>
                  </div>
                </PopoverContent>
              </Popover>
            </div>
            <div className="relative w-full sm:w-72">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search by campaign or segment name..."
                value={searchInput}
                onChange={(e) => handleSearchChange(e.target.value)}
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
          ) : (isError && (() => {
            // Task #199: keep the last-good list on a transient "busy" 503
            // when we already have data (placeholderData: keepPreviousData).
            // Showing a stale-but-valid list is far better UX than wiping the
            // page for the full-screen busy spinner — SSE keeps it live and
            // the next refetch silently recovers. Only fall through to an
            // error screen when there's nothing to show, or the failure is a
            // genuine (non-busy) error worth surfacing.
            const err = error as any;
            const isBusy =
              err?.status === 503 &&
              (err?.body?.error === "service_busy" || (err?.retryAfterSeconds ?? 0) > 0);
            return !campaignsData || !isBusy;
          })()) ? (
            (() => {
              // Task #148: distinguish "server is briefly busy, retry will
              // succeed" (503 service_busy) from genuine failures so users
              // don't see a scary red banner for a 1-second blip.
              const err = error as any;
              // Tighten busy detection: only treat a 503 as transient
              // pressure when it carries the canonical service_busy
              // contract (body.error or a Retry-After header). Genuine
              // 503s from upstream proxies / unrelated failures still
              // surface as the red error card so they're not hidden.
              const isBusy =
                err?.status === 503 &&
                (err?.body?.error === "service_busy" || (err?.retryAfterSeconds ?? 0) > 0);
              if (isBusy) {
                return (
                  <div className="flex flex-col items-center justify-center py-16 text-center gap-4" data-testid="campaigns-busy-state">
                    <div className="rounded-full bg-muted p-4">
                      <RefreshCw className="h-10 w-10 text-muted-foreground animate-spin" />
                    </div>
                    <div>
                      <h3 className="text-lg font-semibold mb-1">Serveur momentanément occupé</h3>
                      <p className="text-muted-foreground text-sm max-w-sm">
                        Nouvelle tentative dans un instant…
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => queryClient.invalidateQueries({ queryKey: ["/api/campaigns"] })}
                      data-testid="button-retry-campaigns"
                    >
                      <RefreshCw className="h-4 w-4 mr-2" />
                      Réessayer maintenant
                    </Button>
                  </div>
                );
              }
              return (
                <div className="flex flex-col items-center justify-center py-16 text-center gap-4" data-testid="campaigns-error-state">
                  <div className="rounded-full bg-destructive/10 p-4">
                    <AlertCircle className="h-10 w-10 text-destructive" />
                  </div>
                  <div>
                    <h3 className="text-lg font-semibold mb-1">Failed to load campaigns</h3>
                    <p className="text-muted-foreground text-sm max-w-sm">
                      {err?.message || "The server returned an error. Check the Error Logs page for details."}
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
              );
            })()
          ) : campaigns && campaigns.length > 0 ? (
            <div className="space-y-4">
            <div className="rounded-md border overflow-x-auto">
              <TooltipProvider delayDuration={200}>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[40px]">
                      <Checkbox
                        checked={campaigns.length > 0 && selectedIds.size === campaigns.length}
                        onCheckedChange={toggleSelectAll}
                        data-testid="checkbox-select-all"
                        aria-label="Select all campaigns"
                      />
                    </TableHead>
                    <TableHead>ID</TableHead>
                    <TableHead>Campaign</TableHead>
                    <TableHead><span className="flex items-center gap-1"><Filter className="h-3.5 w-3.5" />Segment</span></TableHead>
                    <TableHead>MTA</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="min-w-[140px]">Progress</TableHead>
                    <TableHead>Sent</TableHead>
                    <TableHead><span className="flex items-center gap-1"><Eye className="h-3.5 w-3.5" />Opens</span></TableHead>
                    <TableHead><span className="flex items-center gap-1"><MousePointerClick className="h-3.5 w-3.5" />Clicks</span></TableHead>
                    <TableHead><span className="flex items-center gap-1"><UserMinus className="h-3.5 w-3.5" />Unsubs</span></TableHead>
                    <TableHead><span className="flex items-center gap-1"><ShieldAlert className="h-3.5 w-3.5" />Complaints</span></TableHead>
                    <TableHead>Dates</TableHead>
                    <TableHead className="w-[50px]"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {campaigns?.map((campaign) => (
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
                        <div className="flex items-center gap-1">
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <code
                                tabIndex={0}
                                className="text-xs font-mono text-muted-foreground rounded-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                data-testid={`text-campaign-id-${campaign.id}`}
                              >
                                {campaign.id.slice(0, 8)}
                              </code>
                            </TooltipTrigger>
                            <TooltipContent>
                              <span className="font-mono text-xs">{campaign.id}</span>
                            </TooltipContent>
                          </Tooltip>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6"
                            onClick={async (e) => {
                              e.stopPropagation();
                              try {
                                await navigator.clipboard.writeText(campaign.id);
                                toast({ title: "Campaign ID copied" });
                              } catch {
                                toast({
                                  title: "Copy failed",
                                  description: "Could not access clipboard.",
                                  variant: "destructive",
                                });
                              }
                            }}
                            aria-label="Copy campaign ID"
                            data-testid={`button-copy-campaign-id-${campaign.id}`}
                          >
                            <Clipboard className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col gap-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-medium">{campaign.name}</span>
                            {campaign.parentCampaignId && (() => {
                              // Look up the parent in the same campaigns list
                              // so we can render a contextual label.
                              const parent = campaigns?.find((p) => p.id === campaign.parentCampaignId);
                              return (
                                <Badge variant="secondary" className="text-xs" data-testid={`badge-followup-${campaign.id}`}>
                                  {parent ? `Follow-up of ${parent.name}` : "Follow-up"}
                                </Badge>
                              );
                            })()}
                            {campaign.followUpEnabled && !campaign.parentCampaignId && (() => {
                              const child = campaign.followUpCampaignId
                                ? campaigns?.find((c) => c.id === campaign.followUpCampaignId)
                                : null;
                              const when = child?.scheduledAt
                                ? new Date(child.scheduledAt).toLocaleString()
                                : null;
                              return (
                                <Badge variant="outline" className="text-xs" data-testid={`badge-has-followup-${campaign.id}`}>
                                  {when ? `Follow-up scheduled for ${when}` : `Follow-up: ${campaign.followUpDelayHours ?? 36}h after send`}
                                </Badge>
                              );
                            })()}
                          </div>
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
                      <TableCell data-testid={`text-mta-${campaign.id}`}>
                        <span className="text-sm text-muted-foreground truncate max-w-[120px] inline-block align-bottom">
                          {campaign.mtaName ?? "—"}
                        </span>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col gap-1">
                          <CampaignStatusBadge
                            status={campaign.status}
                            campaignId={campaign.id}
                            onClick={campaign.status === "failed" ? () => setFailedInfoCampaign(campaign) : undefined}
                          />
                          {/* Task #181: surface pauseReason inline on the list row so
                              operators see *why* a campaign is paused/failed without
                              opening the failure dialog. Truncated + tooltip keeps the
                              cell compact for long diagnostic messages. */}
                          {campaign.pauseReason && (campaign.status === "paused" || campaign.status === "failed") && (
                            <span
                              className="text-xs text-muted-foreground truncate max-w-[180px]"
                              title={campaign.pauseReason}
                              data-testid={`text-pause-reason-${campaign.id}`}
                            >
                              {campaign.pauseReason}
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell data-testid={`cell-progress-${campaign.id}`}>
                        <CampaignProgress
                          sentCount={campaign.sentCount}
                          failedCount={campaign.failedCount}
                          pendingCount={campaign.realPendingCount ?? campaign.pendingCount ?? 0}
                          heldCount={campaign.pressureHeldCount ?? 0}
                          status={campaign.status}
                          testId={`progress-campaign-${campaign.id}`}
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
                            {(campaign.uniqueOpensCount ?? 0).toLocaleString()}
                          </span>
                          {campaign.sentCount > 0 && (campaign.uniqueOpensCount ?? 0) > 0 && (
                            <span className="text-xs text-muted-foreground tabular-nums">
                              {(((campaign.uniqueOpensCount ?? 0) / campaign.sentCount) * 100).toFixed(1)}%
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell data-testid={`text-clicks-${campaign.id}`}>
                        <div className="flex flex-col gap-0.5">
                          <span className="font-medium tabular-nums">
                            {(campaign.uniqueClicksCount ?? 0).toLocaleString()}
                          </span>
                          {campaign.sentCount > 0 && (campaign.uniqueClicksCount ?? 0) > 0 && (
                            <span className="text-xs text-muted-foreground tabular-nums">
                              {(((campaign.uniqueClicksCount ?? 0) / campaign.sentCount) * 100).toFixed(1)}%
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell data-testid={`text-unsubs-${campaign.id}`}>
                        <span className={`font-medium tabular-nums ${(campaign.unsubscribesCount ?? 0) > 0 ? "text-destructive" : ""}`}>
                          {(campaign.unsubscribesCount ?? 0).toLocaleString()}
                        </span>
                      </TableCell>
                      <TableCell data-testid={`text-complaints-${campaign.id}`}>
                        <span className={`font-medium tabular-nums ${(campaign.complaintsCount ?? 0) > 0 ? "text-orange-600" : ""}`}>
                          {(campaign.complaintsCount ?? 0).toLocaleString()}
                        </span>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col gap-1 text-sm">
                          {campaign.scheduledAt && (
                            <div className="flex items-center gap-1 text-muted-foreground" data-testid={`text-scheduled-${campaign.id}`}>
                              <span className="font-medium text-foreground/70">Scheduled</span>
                              <span>{new Date(campaign.scheduledAt).toLocaleString()}</span>
                            </div>
                          )}
                          {campaign.createdAt && (
                            <div className="flex items-center gap-1 text-muted-foreground" data-testid={`text-created-${campaign.id}`}>
                              <span className="font-medium text-foreground/70">Created</span>
                              <span>{new Date(campaign.createdAt).toLocaleString()}</span>
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
                            {campaign.status === "scheduled" && (
                              <Link href={`/campaigns/${campaign.id}/edit`}>
                                <DropdownMenuItem data-testid={`button-edit-scheduled-${campaign.id}`}>
                                  <Edit className="h-4 w-4 mr-2" />
                                  Edit
                                </DropdownMenuItem>
                              </Link>
                            )}
                            {campaign.status === "scheduled" && (
                              <DropdownMenuItem
                                onClick={() => pauseResumeMutation.mutate({ id: campaign.id, action: "pause" })}
                                data-testid={`button-pause-scheduled-${campaign.id}`}
                              >
                                <Pause className="h-4 w-4 mr-2" />
                                Pause
                              </DropdownMenuItem>
                            )}
                            {campaign.status === "scheduled" && (
                              <DropdownMenuItem
                                onClick={() => setDeleteConfirm(campaign)}
                                data-testid={`button-cancel-scheduled-${campaign.id}`}
                              >
                                <X className="h-4 w-4 mr-2" />
                                Cancel
                              </DropdownMenuItem>
                            )}
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
                            {(campaign.status === "sending" || campaign.status === "paused") && (
                              // 2026-05-22: gating relaxed to status only.
                              // The previous (pressureHeldCount > 0) guard
                              // hid the button on campaigns where the live
                              // subquery hadn't surfaced yet in the list
                              // response (race between SSE counter update
                              // and the polled list refetch), leaving the
                              // operator unable to flush 100k+ visibly-held
                              // queues. The server-side endpoint already
                              // returns a clean 400 ("No held sends —
                              // nothing to flush") when held=0, and the
                              // confirm dialog shows the live count anyway
                              // — so making the button always-visible on
                              // sending/paused is both safer UX and
                              // resistant to UI/data drift.
                              <DropdownMenuItem
                                onClick={() => setUrgentConfirm(campaign)}
                                className="text-orange-600 dark:text-orange-400 focus:text-orange-600 dark:focus:text-orange-400"
                                data-testid={`button-urgent-${campaign.id}`}
                              >
                                <Zap className="h-4 w-4 mr-2" />
                                Urgent — flush held now
                              </DropdownMenuItem>
                            )}
                            {campaign.status !== "draft" && (
                              <DropdownMenuItem
                                onClick={() => setEndConfirm(campaign)}
                                data-testid={`button-end-campaign-${campaign.id}`}
                              >
                                <Square className="h-4 w-4 mr-2" />
                                End campaign
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
              </TooltipProvider>
            </div>
            {totalPages > 1 && (
              <div className="flex items-center justify-between" data-testid="campaigns-pagination">
                <p className="text-sm text-muted-foreground">
                  Showing {((currentPage - 1) * PAGE_SIZE) + 1}–{Math.min(currentPage * PAGE_SIZE, totalCampaigns)} of {totalCampaigns} campaigns
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
                {debouncedSearch
                  ? "No campaigns match your search. Try a different query."
                  : dateFilter !== "all"
                    ? "No campaigns match the selected date range. Try a different period or clear the filter."
                    : "Create your first campaign to start sending emails to your subscribers."}
              </p>
              {dateFilter !== "all" && !debouncedSearch && (
                <Button
                  variant="outline"
                  onClick={() => { setDateFilter("all"); setCustomRange(undefined); setCurrentPage(1); }}
                  data-testid="button-clear-date-filter"
                >
                  <X className="h-4 w-4 mr-2" />
                  Clear date filter
                </Button>
              )}
              {!debouncedSearch && dateFilter === "all" && (
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

      <Dialog open={!!endConfirm} onOpenChange={() => setEndConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>End Campaign</DialogTitle>
            <DialogDescription>
              Are you sure you want to permanently end "{endConfirm?.name}"? This will
              stop the campaign immediately and remove all recipients currently held in
              the deferred queue (6h pressure-guard). Already-sent recipients are kept
              for stats. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEndConfirm(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => endConfirm && endMutation.mutate(endConfirm.id)}
              disabled={endMutation.isPending}
              data-testid="button-confirm-end-campaign"
            >
              {endMutation.isPending ? "Ending..." : "End campaign"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!urgentConfirm} onOpenChange={() => setUrgentConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Zap className="h-5 w-5 text-orange-600 dark:text-orange-400" />
              Activer le mode urgent ?
            </DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-3 text-sm">
                <p>
                  Campagne <strong>"{urgentConfirm?.name}"</strong> — {(urgentConfirm?.pressureHeldCount ?? 0).toLocaleString()} contacts actuellement en attente.
                </p>
                <p className="text-foreground">
                  Cette action va <strong>contourner toutes les protections marketing pressure</strong> pour cette campagne uniquement et pousser tous les envois en attente au MTA immédiatement.
                </p>
                <div className="rounded-md border border-orange-500/30 bg-orange-500/10 p-3 text-foreground">
                  <p className="font-semibold mb-2">⚠️ Conséquences :</p>
                  <ul className="list-disc list-inside space-y-1">
                    <li>La règle des <strong>6h entre deux emails</strong> au même contact est ignorée pour cette campagne.</li>
                    <li>La priorité <strong>FIFO inter-campagnes</strong> (campagnes plus anciennes d'abord) est ignorée.</li>
                    <li>Un contact ayant reçu un autre email il y a moins de 6h <strong>recevra celui-ci en doublon</strong>.</li>
                    <li>Le flag reste actif jusqu'à la fin de la campagne (survit aux redémarrages).</li>
                  </ul>
                </div>
                <p className="text-muted-foreground text-xs">
                  À réserver aux envois critiques (alertes, transactionnel urgent). Action auditée.
                </p>
              </div>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setUrgentConfirm(null)} data-testid="button-cancel-urgent">
              Annuler
            </Button>
            <Button
              className="bg-orange-600 hover:bg-orange-700 text-white"
              onClick={() => urgentConfirm && urgentMutation.mutate(urgentConfirm.id)}
              disabled={urgentMutation.isPending}
              data-testid="button-confirm-urgent"
            >
              <Zap className="h-4 w-4 mr-2" />
              {urgentMutation.isPending ? "Activation…" : "Activer le mode urgent"}
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
