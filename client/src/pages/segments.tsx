import { useState, useEffect, useCallback, useRef, type ChangeEvent } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest, fetchCsrfToken } from "@/lib/queryClient";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import {
  Filter,
  Plus,
  MoreVertical,
  Trash2,
  Edit2,
  Users,
  Eye,
  Download,
  Copy,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  Search,
  Loader2,
  FileText,
  Upload,
  X,
} from "lucide-react";
import type { Segment, SegmentGroup, SegmentRulesV2, Subscriber } from "@shared/schema";
import { operatorLabelsV2 } from "@shared/schema";
import {
  GroupBuilder,
  defaultRootGroup,
  getRulesAsV2,
  hasValidCondition,
  fieldLabels,
  unaryOperators,
} from "@/components/segment-builder";

interface SegmentSubscribersResponse {
  subscribers: Subscriber[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

interface PreviewResult {
  count: number;
  sample: Subscriber[];
}

type SegmentWithExclusions = Segment & { exclusionHashCount?: number };
const MAX_EXCLUSION_FILE_BYTES = 100 * 1024 * 1024;

function summarizeRules(rules: unknown): Array<{ text: string; depth: number }> {
  const root = getRulesAsV2(rules);
  const results: Array<{ text: string; depth: number }> = [];

  function walk(group: SegmentGroup, depth: number) {
    for (const child of group.children) {
      if (results.length >= 3) return;
      if (child.type === "condition") {
        const label = operatorLabelsV2[child.operator] || child.operator;
        const val = unaryOperators.includes(child.operator) ? "" : ` "${child.value || ""}"`;
        results.push({ text: `${fieldLabels[child.field] || child.field} ${label}${val}`, depth });
      } else {
        results.push({ text: `Group (${child.combinator})`, depth });
        walk(child, depth + 1);
      }
    }
  }

  walk(root, 0);
  return results;
}

export default function Segments() {
  const [editingSegment, setEditingSegment] = useState<SegmentWithExclusions | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<Segment | null>(null);
  const [viewingSegment, setViewingSegment] = useState<Segment | null>(null);
  const [viewPage, setViewPage] = useState(1);
  const [isExporting, setIsExporting] = useState<string | null>(null);
  const [segmentPage, setSegmentPage] = useState(1);
  const SEGMENTS_PER_PAGE = 20;

  const [searchInput, setSearchInput] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [refreshingSegmentIds, setRefreshingSegmentIds] = useState<Set<string>>(new Set());

  const handleSearchChange = useCallback((value: string) => {
    setSearchInput(value);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => {
      setSearchQuery(value.trim());
      setSegmentPage(1);
    }, 300);
  }, []);

  useEffect(() => {
    return () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    };
  }, []);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [rootGroup, setRootGroup] = useState<SegmentGroup>(defaultRootGroup());
  const [previewResult, setPreviewResult] = useState<PreviewResult | null>(null);
  const [isCountLoading, setIsCountLoading] = useState(false);
  const [exclusionFile, setExclusionFile] = useState<File | null>(null);
  const [exclusionUploadProgress, setExclusionUploadProgress] = useState<number | null>(null);
  const exclusionInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  const { data: segmentsPage, isLoading } = useQuery<{
    segments: SegmentWithExclusions[];
    total: number;
    page: number;
    limit: number;
  }>({
    queryKey: ["/api/segments", "paginated", segmentPage, SEGMENTS_PER_PAGE, searchQuery],
    queryFn: async () => {
      const params = new URLSearchParams({
        paginate: "true",
        page: String(segmentPage),
        limit: String(SEGMENTS_PER_PAGE),
      });
      if (searchQuery) params.set("search", searchQuery);
      const res = await fetch(`/api/segments?${params}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch segments");
      return res.json();
    },
  });
  const segments = segmentsPage?.segments;
  const totalSegments = segmentsPage?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalSegments / SEGMENTS_PER_PAGE));

  // If a delete/duplicate leaves us on an out-of-range page (e.g. last
  // segment on page 3 deleted while total still > 0), step back to the
  // last valid page instead of showing the empty-state.
  useEffect(() => {
    if (segmentPage > totalPages) {
      setSegmentPage(totalPages);
    }
  }, [segmentPage, totalPages]);

  const visibleIds = (segments ?? []).map((s) => s.id);
  const visibleIdsKey = visibleIds.join(",");

  const uncachedIds = (segments ?? []).filter((s) => s.cachedCount == null).map((s) => s.id);
  const uncachedIdsKey = uncachedIds.join(",");

  const { data: fetchedCounts, refetch: refetchCounts, isFetching: isRefreshingCounts } = useQuery<
    Record<string, number>
  >({
    queryKey: ["/api/segments/counts", uncachedIdsKey],
    queryFn: async () => {
      if (!uncachedIdsKey) return {};
      const res = await fetch(`/api/segments/counts?ids=${encodeURIComponent(uncachedIdsKey)}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to fetch segment counts");
      return res.json();
    },
    enabled: uncachedIds.length > 0,
  });

  const segmentCounts: Record<string, number> = {};
  for (const s of segments ?? []) {
    if (fetchedCounts?.[s.id] != null) {
      segmentCounts[s.id] = fetchedCounts[s.id];
    } else if (s.cachedCount != null) {
      segmentCounts[s.id] = s.cachedCount;
    }
  }

  const handleRefreshCounts = async () => {
    if (!visibleIdsKey) return;
    try {
      const res = await fetch(
        `/api/segments/counts?ids=${encodeURIComponent(visibleIdsKey)}&refresh=true`,
        { credentials: "include" }
      );
      if (!res.ok) throw new Error("Failed to refresh counts");
      const freshCounts: Record<string, number> = await res.json();
      queryClient.setQueryData<Record<string, number>>(
        ["/api/segments/counts", uncachedIdsKey],
        (prev) => ({ ...prev, ...freshCounts })
      );
      queryClient.invalidateQueries({ queryKey: ["/api/segments", "paginated"] });
      toast({ title: "Counts refreshed", description: "Subscriber counts are now up to date." });
    } catch {
      toast({
        title: "Error",
        description: "Failed to refresh counts. Please try again.",
        variant: "destructive",
      });
    }
  };

  const handleRefreshSingleCount = async (segmentId: string) => {
    setRefreshingSegmentIds((prev) => new Set(prev).add(segmentId));
    try {
      const res = await fetch(
        `/api/segments/counts?ids=${encodeURIComponent(segmentId)}&refresh=true`,
        { credentials: "include" }
      );
      if (!res.ok) throw new Error("Failed to refresh count");
      const freshCounts: Record<string, number> = await res.json();
      queryClient.setQueryData<Record<string, number>>(
        ["/api/segments/counts", uncachedIdsKey],
        (prev) => ({ ...prev, ...freshCounts })
      );
      queryClient.invalidateQueries({ queryKey: ["/api/segments", "paginated"] });
      toast({ title: "Count refreshed", description: "Subscriber count updated." });
    } catch {
      toast({
        title: "Error",
        description: "Failed to refresh count. Please try again.",
        variant: "destructive",
      });
    } finally {
      setRefreshingSegmentIds((prev) => {
        const next = new Set(prev);
        next.delete(segmentId);
        return next;
      });
    }
  };

  const { data: segmentSubscribers, isLoading: isLoadingSubscribers } =
    useQuery<SegmentSubscribersResponse>({
      queryKey: ["/api/segments", viewingSegment?.id, "subscribers", viewPage],
      queryFn: async () => {
        const res = await fetch(
          `/api/segments/${viewingSegment!.id}/subscribers?page=${viewPage}&limit=50`,
          { credentials: "include" }
        );
        if (!res.ok) throw new Error("Failed to fetch subscribers");
        return res.json();
      },
      enabled: !!viewingSegment,
    });

  const resetForm = () => {
    setName("");
    setDescription("");
    setRootGroup(defaultRootGroup());
    setPreviewResult(null);
    setIsCountLoading(false);
    setExclusionFile(null);
    setExclusionUploadProgress(null);
    if (exclusionInputRef.current) exclusionInputRef.current.value = "";
  };

  const handleEditClick = (segment: SegmentWithExclusions) => {
    setEditingSegment(segment);
    setName(segment.name);
    setDescription(segment.description || "");
    setRootGroup(getRulesAsV2(segment.rules));
    setPreviewResult(null);
  };

  const refreshSegmentQueries = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/segments"] });
    queryClient.invalidateQueries({ queryKey: ["/api/segments/counts"] });
  };

  const replaceExclusionsMutation = useMutation({
    mutationFn: async ({ id, file }: { id: string; file: File }) => {
      const csrfToken = await fetchCsrfToken();
      return new Promise<Response>((resolve, reject) => {
        const request = new XMLHttpRequest();
        request.open("PUT", `/api/segments/${id}/exclusions`);
        request.withCredentials = true;
        request.setRequestHeader("x-csrf-token", csrfToken);
        request.upload.onprogress = (event) => {
          if (event.lengthComputable) setExclusionUploadProgress(Math.round(event.loaded / event.total * 100));
        };
        request.onerror = () => reject(new Error("The exclusion file upload failed."));
        request.onload = async () => {
          const response = new Response(request.responseText, { status: request.status });
          if (request.status >= 200 && request.status < 300) return resolve(response);
          const body = await response.clone().json().catch(() => null);
          reject(new Error(typeof body?.error === "string" ? body.error : "Failed to replace exclusions."));
        };
        const formData = new FormData();
        formData.append("exclusionFile", file);
        request.send(formData);
      });
    },
    onSuccess: async (response) => {
      const result = await response.json();
      refreshSegmentQueries();
      setEditingSegment((current) => current ? { ...current, exclusionHashCount: result.exclusionHashCount, cachedCount: result.cachedCount } : current);
      setExclusionFile(null);
      setExclusionUploadProgress(null);
      if (exclusionInputRef.current) exclusionInputRef.current.value = "";
      toast({ title: "Exclusions replaced", description: `${result.exclusionHashCount.toLocaleString()} active hashes. ${result.cachedCount.toLocaleString()} subscribers remain.` });
    },
    onError: (error: Error) => {
      setExclusionUploadProgress(null);
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const removeExclusionsMutation = useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/segments/${id}/exclusions`),
    onSuccess: async (response) => {
      const result = await response.json();
      refreshSegmentQueries();
      setEditingSegment((current) => current ? { ...current, exclusionHashCount: 0, cachedCount: result.cachedCount } : current);
      toast({ title: "Exclusions removed", description: "The subscriber count has been recalculated." });
    },
    onError: () => toast({ title: "Error", description: "Failed to remove exclusions.", variant: "destructive" }),
  });

  const handleExclusionFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".csv")) {
      toast({ title: "Invalid CSV", description: "The selected file must have a .csv extension.", variant: "destructive" });
      event.target.value = "";
      return;
    }
    if (file.size === 0) {
      toast({ title: "Empty CSV", description: "The selected CSV does not contain any data.", variant: "destructive" });
      event.target.value = "";
      return;
    }
    if (file.size > MAX_EXCLUSION_FILE_BYTES) {
      toast({ title: "CSV too large", description: "Choose a CSV file up to 100 MB.", variant: "destructive" });
      event.target.value = "";
      return;
    }
    setExclusionFile(file);
  };

  const updateMutation = useMutation({
    mutationFn: ({
      id,
      data,
    }: {
      id: string;
      data: { name: string; description: string; rules: SegmentRulesV2 };
    }) => apiRequest("PATCH", `/api/segments/${id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/segments"] });
      queryClient.invalidateQueries({ queryKey: ["/api/segments/counts"] });
      setEditingSegment(null);
      resetForm();
      toast({ title: "Segment updated", description: "Your segment has been updated successfully." });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to update segment. Please try again.",
        variant: "destructive",
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/segments/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/segments"] });
      queryClient.invalidateQueries({ queryKey: ["/api/segments/counts"] });
      setDeleteConfirm(null);
      toast({ title: "Segment deleted", description: "The segment has been deleted." });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to delete segment. Please try again.",
        variant: "destructive",
      });
    },
  });

  const duplicateMutation = useMutation({
    mutationFn: (id: string) => apiRequest("POST", `/api/segments/${id}/duplicate`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/segments"] });
      queryClient.invalidateQueries({ queryKey: ["/api/segments/counts"] });
      toast({
        title: "Segment duplicated",
        description: "A copy of the segment has been created.",
      });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to duplicate segment. Please try again.",
        variant: "destructive",
      });
    },
  });

  const handleUpdate = () => {
    if (!editingSegment) return;
    if (!name.trim()) {
      toast({
        title: "Validation Error",
        description: "Please provide a segment name.",
        variant: "destructive",
      });
      return;
    }
    if (!hasValidCondition(rootGroup)) {
      toast({
        title: "Validation Error",
        description: "Please add at least one condition with a value.",
        variant: "destructive",
      });
      return;
    }
    updateMutation.mutate({
      id: editingSegment.id,
      data: {
        name: name.trim(),
        description: description.trim(),
        rules: { version: 2 as const, root: rootGroup } as SegmentRulesV2,
      },
    });
  };

  const handlePreviewCount = async () => {
    if (!hasValidCondition(rootGroup)) {
      toast({
        title: "No rules defined",
        description: "Please add at least one condition with a value to preview.",
        variant: "destructive",
      });
      return;
    }
    setIsCountLoading(true);
    setPreviewResult(null);
    try {
      const res = await apiRequest("POST", "/api/segments/preview-count", {
        rules: { version: 2, root: rootGroup } as SegmentRulesV2,
      });
      const data = await res.json();
      setPreviewResult(data);
    } catch {
      toast({
        title: "Error",
        description: "Failed to preview. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsCountLoading(false);
    }
  };

  const handleExportSegment = async (segment: Segment) => {
    setIsExporting(segment.id);
    try {
      const response = await fetch(`/api/segments/${segment.id}/export`, {
        credentials: "include",
      });
      if (!response.ok) throw new Error("Export failed");
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `segment-${segment.name.replace(/[^a-zA-Z0-9]/g, "_")}-${
        new Date().toISOString().split("T")[0]
      }.csv`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      a.remove();
      toast({
        title: "Export started",
        description: `Segment "${segment.name}" exported successfully.`,
      });
    } catch {
      toast({
        title: "Error",
        description: "Failed to export segment. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsExporting(null);
    }
  };

  const editFormContent = (
    <div className="space-y-6">
      <div className="space-y-2">
        <Label htmlFor="segment-name">Segment Name</Label>
        <Input
          id="segment-name"
          placeholder="e.g., VIP Customers"
          value={name}
          onChange={(e) => setName(e.target.value)}
          data-testid="input-segment-name"
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="segment-description">Description (optional)</Label>
        <Textarea
          id="segment-description"
          placeholder="Describe this segment..."
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="resize-none"
          rows={2}
          data-testid="input-segment-description"
        />
      </div>
      <div className="space-y-3">
        <Label>Rules</Label>
        <GroupBuilder
          group={rootGroup}
          onChange={setRootGroup}
          depth={0}
          testIdPrefix="root"
        />
      </div>
      {editingSegment && (
        <div className="rounded-lg border border-dashed bg-muted/30 p-4 space-y-3">
          <div className="flex items-start gap-3">
            <div className="rounded-md bg-background p-2"><FileText className="h-4 w-4 text-primary" /></div>
            <div>
              <Label htmlFor="edit-segment-exclusions">Exclusion hashes</Label>
              <p className="text-sm text-muted-foreground" data-testid="text-active-exclusion-count">
                {(editingSegment.exclusionHashCount ?? 0).toLocaleString()} active SHA-256 hashes
              </p>
            </div>
          </div>
          <input ref={exclusionInputRef} id="edit-segment-exclusions" type="file" accept=".csv,text/csv" className="sr-only" onChange={handleExclusionFileChange} disabled={replaceExclusionsMutation.isPending} data-testid="input-edit-exclusion-csv" />
          {exclusionFile ? (
            <div className="flex items-center justify-between gap-2 rounded-md border bg-background px-3 py-2">
              <span className="truncate text-sm">{exclusionFile.name}</span>
              <Button type="button" variant="ghost" size="icon" onClick={() => { setExclusionFile(null); if (exclusionInputRef.current) exclusionInputRef.current.value = ""; }} disabled={replaceExclusionsMutation.isPending}><X className="h-4 w-4" /></Button>
            </div>
          ) : (
            <Button type="button" variant="outline" onClick={() => exclusionInputRef.current?.click()} disabled={replaceExclusionsMutation.isPending} data-testid="button-select-edit-exclusion-csv"><Upload className="mr-2 h-4 w-4" />Select replacement CSV</Button>
          )}
          {exclusionFile && (
            <Button type="button" onClick={() => { setExclusionUploadProgress(0); replaceExclusionsMutation.mutate({ id: editingSegment.id, file: exclusionFile }); }} disabled={replaceExclusionsMutation.isPending} data-testid="button-replace-exclusions">
              {replaceExclusionsMutation.isPending ? "Replacing..." : "Replace exclusions"}
            </Button>
          )}
          {exclusionUploadProgress !== null && (
            <div className="space-y-1" aria-live="polite"><div className="h-2 overflow-hidden rounded-full bg-muted"><div className="h-full bg-primary" style={{ width: `${exclusionUploadProgress}%` }} /></div><p className="text-xs text-muted-foreground">{exclusionUploadProgress < 100 ? `Uploading: ${exclusionUploadProgress}%` : "Validating and replacing..."}</p></div>
          )}
          {(editingSegment.exclusionHashCount ?? 0) > 0 && (
            <Button type="button" variant="destructive" onClick={() => {
              if (window.confirm(`Remove all ${(editingSegment.exclusionHashCount ?? 0).toLocaleString()} exclusion hashes? The segment subscriber count will increase for matching addresses.`)) {
                removeExclusionsMutation.mutate(editingSegment.id);
              }
            }} disabled={removeExclusionsMutation.isPending || replaceExclusionsMutation.isPending} data-testid="button-remove-exclusions">
              {removeExclusionsMutation.isPending ? "Removing..." : "Remove all exclusions"}
            </Button>
          )}
        </div>
      )}
      <div className="flex items-center gap-3 pt-2 flex-wrap">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handlePreviewCount}
          disabled={isCountLoading}
          data-testid="button-preview-count"
        >
          <Users className="h-4 w-4 mr-1" />
          {isCountLoading ? "Counting..." : "Preview Subscribers"}
        </Button>
        {previewResult !== null && (
          <span className="text-sm text-muted-foreground" data-testid="text-preview-count">
            {previewResult.count.toLocaleString()} subscriber
            {previewResult.count !== 1 ? "s" : ""} match
          </span>
        )}
      </div>
      {previewResult && previewResult.sample.length > 0 && (
        <div className="rounded-md border" data-testid="preview-sample-table">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Email</TableHead>
                <TableHead>Tags</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {previewResult.sample.map((sub) => (
                <TableRow key={sub.id} data-testid={`preview-sample-row-${sub.id}`}>
                  <TableCell className="font-mono text-sm">{sub.email}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {sub.tags && sub.tags.length > 0 ? (
                        sub.tags.slice(0, 3).map((tag) => (
                          <Badge key={tag} variant="secondary" className="text-xs">
                            {tag}
                          </Badge>
                        ))
                      ) : (
                        <span className="text-muted-foreground text-sm">None</span>
                      )}
                      {sub.tags && sub.tags.length > 3 && (
                        <Badge variant="outline" className="text-xs">
                          +{sub.tags.length - 3}
                        </Badge>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );

  return (
    <div className="p-6 lg:p-8 space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Segments</h1>
          <p className="text-muted-foreground">
            Create and manage audience segments based on tags, email, date, or IP address
          </p>
        </div>
        <Button asChild data-testid="button-create-segment">
          <Link href="/segments/new">
            <Plus className="h-4 w-4 mr-2" />
            Create Segment
          </Link>
        </Button>
      </div>

      <div className="relative w-full sm:w-72">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search segments..."
          value={searchInput}
          onChange={(e) => handleSearchChange(e.target.value)}
          className="pl-9"
          data-testid="input-search-segments"
        />
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-48" />
          ))}
        </div>
      ) : segments && segments.length > 0 ? (
        <>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {segments.map((segment) => {
            const summary = summarizeRules(segment.rules);
            return (
              <Card key={segment.id} data-testid={`segment-card-${segment.id}`}>
                <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0">
                  <div className="flex-1 min-w-0">
                    <CardTitle className="text-lg truncate">{segment.name}</CardTitle>
                    {segment.description && (
                      <CardDescription className="mt-1 line-clamp-2">
                        {segment.description}
                      </CardDescription>
                    )}
                  </div>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        data-testid={`button-segment-menu-${segment.id}`}
                      >
                        <MoreVertical className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        onClick={() => {
                          setViewPage(1);
                          setViewingSegment(segment);
                        }}
                        data-testid={`menu-view-subscribers-${segment.id}`}
                      >
                        <Eye className="h-4 w-4 mr-2" />
                        View Subscribers
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => duplicateMutation.mutate(segment.id)}
                        disabled={duplicateMutation.isPending}
                        data-testid={`menu-duplicate-segment-${segment.id}`}
                      >
                        <Copy className="h-4 w-4 mr-2" />
                        Duplicate
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => handleExportSegment(segment)}
                        disabled={isExporting === segment.id}
                        data-testid={`menu-export-segment-${segment.id}`}
                      >
                        <Download className="h-4 w-4 mr-2" />
                        {isExporting === segment.id ? "Exporting..." : "Export CSV"}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => handleEditClick(segment)}
                        data-testid={`menu-edit-segment-${segment.id}`}
                      >
                        <Edit2 className="h-4 w-4 mr-2" />
                        Edit
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className="text-destructive"
                        onClick={() => setDeleteConfirm(segment)}
                        data-testid={`menu-delete-segment-${segment.id}`}
                      >
                        <Trash2 className="h-4 w-4 mr-2" />
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex items-center justify-between text-sm text-muted-foreground">
                    <div className="flex items-center gap-2">
                      <Users className="h-4 w-4" />
                      <span data-testid={`text-segment-count-${segment.id}`}>
                        {segmentCounts[segment.id] != null
                          ? `${segmentCounts[segment.id].toLocaleString()} subscribers`
                          : "Loading..."}
                      </span>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6"
                      onClick={() => handleRefreshSingleCount(segment.id)}
                      disabled={refreshingSegmentIds.has(segment.id)}
                      title="Refresh subscriber count"
                      data-testid={`button-refresh-count-${segment.id}`}
                    >
                      {refreshingSegmentIds.has(segment.id) ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <RefreshCw className="h-3.5 w-3.5" />
                      )}
                    </Button>
                  </div>
                  <div className="space-y-1">
                    {summary.map((item, i) => (
                      <div
                        key={i}
                        className="flex items-center gap-1 flex-wrap text-sm"
                        style={{ paddingLeft: `${item.depth * 12}px` }}
                        data-testid={`text-rule-summary-${segment.id}-${i}`}
                      >
                        <span className="text-muted-foreground">{item.text}</span>
                      </div>
                    ))}
                    {summary.length === 0 && (
                      <span className="text-xs text-muted-foreground">No rules</span>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mt-4">
          <p className="text-sm text-muted-foreground">
            Showing {((segmentPage - 1) * SEGMENTS_PER_PAGE) + 1}–{Math.min(segmentPage * SEGMENTS_PER_PAGE, totalSegments)} of {totalSegments} segments
          </p>
          <div className="flex items-center gap-2 flex-wrap">
            <Button
              variant="outline"
              size="sm"
              onClick={handleRefreshCounts}
              disabled={isRefreshingCounts || visibleIds.length === 0}
              data-testid="button-refresh-counts"
              title="Recompute subscriber counts (bypass 5-minute cache)"
            >
              <RefreshCw className={`h-4 w-4 mr-1 ${isRefreshingCounts ? "animate-spin" : ""}`} />
              {isRefreshingCounts ? "Refreshing..." : "Refresh counts"}
            </Button>
            {totalPages > 1 && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setSegmentPage(p => Math.max(1, p - 1))}
                  disabled={segmentPage <= 1}
                  data-testid="button-segments-prev-page"
                >
                  <ChevronLeft className="h-4 w-4 mr-1" />
                  Previous
                </Button>
                <span className="text-sm text-muted-foreground px-2">
                  Page {segmentPage} of {totalPages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setSegmentPage(p => Math.min(totalPages, p + 1))}
                  disabled={segmentPage >= totalPages}
                  data-testid="button-segments-next-page"
                >
                  Next
                  <ChevronRight className="h-4 w-4 ml-1" />
                </Button>
              </>
            )}
          </div>
        </div>
        </>
      ) : (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <Filter className="h-16 w-16 text-muted-foreground/50 mb-4" />
            <h3 className="text-lg font-semibold mb-2">No segments yet</h3>
            <p className="text-muted-foreground max-w-md mb-4">
              Create segments to target specific groups of subscribers based on tags, email, date,
              or IP address.
            </p>
            <Button asChild data-testid="button-create-first-segment">
              <Link href="/segments/new">
                <Plus className="h-4 w-4 mr-2" />
                Create Your First Segment
              </Link>
            </Button>
          </CardContent>
        </Card>
      )}

      <Dialog open={!!editingSegment} onOpenChange={() => setEditingSegment(null)}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit Segment</DialogTitle>
            <DialogDescription>Update the rules for this segment</DialogDescription>
          </DialogHeader>
          {editFormContent}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingSegment(null)}>
              Cancel
            </Button>
            <Button
              onClick={handleUpdate}
              disabled={updateMutation.isPending}
              data-testid="button-update-segment"
            >
              {updateMutation.isPending ? "Saving..." : "Save Changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!deleteConfirm} onOpenChange={() => setDeleteConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Segment</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete "{deleteConfirm?.name}"? This will not delete
              subscribers.
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
              data-testid="button-confirm-delete-segment"
            >
              {deleteMutation.isPending ? "Deleting..." : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!viewingSegment}
        onOpenChange={(open) => {
          if (!open) {
            setViewingSegment(null);
            setViewPage(1);
          }
        }}
      >
        <DialogContent className="max-w-4xl max-h-[85vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 flex-wrap">
              <Eye className="h-5 w-5" />
              {viewingSegment?.name}
            </DialogTitle>
            <DialogDescription>
              {segmentSubscribers
                ? `${segmentSubscribers.total.toLocaleString()} matching subscribers`
                : "Loading subscribers..."}
            </DialogDescription>
          </DialogHeader>
          <div className="flex-1 overflow-auto">
            {isLoadingSubscribers ? (
              <div className="space-y-3">
                {[1, 2, 3, 4, 5].map((i) => (
                  <Skeleton key={i} className="h-12 w-full" />
                ))}
              </div>
            ) : segmentSubscribers && segmentSubscribers.subscribers.length > 0 ? (
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Email</TableHead>
                      <TableHead>Tags</TableHead>
                      <TableHead>Import Date</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {segmentSubscribers.subscribers.map((sub) => (
                      <TableRow
                        key={sub.id}
                        data-testid={`segment-subscriber-row-${sub.id}`}
                      >
                        <TableCell className="font-mono text-sm">{sub.email}</TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-1">
                            {sub.tags && sub.tags.length > 0 ? (
                              sub.tags.slice(0, 3).map((tag) => (
                                <Badge key={tag} variant="secondary" className="text-xs">
                                  {tag}
                                </Badge>
                              ))
                            ) : (
                              <span className="text-muted-foreground text-sm">None</span>
                            )}
                            {sub.tags && sub.tags.length > 3 && (
                              <Badge variant="outline" className="text-xs">
                                +{sub.tags.length - 3}
                              </Badge>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="text-muted-foreground text-sm">
                          {new Date(sub.importDate).toLocaleDateString()}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <Users className="h-12 w-12 text-muted-foreground/50 mb-3" />
                <p className="text-muted-foreground">
                  No subscribers match this segment's rules.
                </p>
              </div>
            )}
          </div>
          {segmentSubscribers && segmentSubscribers.totalPages > 1 && (
            <div className="flex items-center justify-between pt-4 border-t flex-wrap gap-4">
              <p className="text-sm text-muted-foreground">
                Showing {(viewPage - 1) * 50 + 1} to{" "}
                {Math.min(viewPage * 50, segmentSubscribers.total)} of{" "}
                {segmentSubscribers.total.toLocaleString()}
              </p>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setViewPage(viewPage - 1)}
                  disabled={viewPage === 1}
                  data-testid="button-view-prev-page"
                >
                  <ChevronLeft className="h-4 w-4 mr-1" />
                  Previous
                </Button>
                <span className="text-sm text-muted-foreground">
                  Page {viewPage} of {segmentSubscribers.totalPages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setViewPage(viewPage + 1)}
                  disabled={viewPage >= segmentSubscribers.totalPages}
                  data-testid="button-view-next-page"
                >
                  Next
                  <ChevronRight className="h-4 w-4 ml-1" />
                </Button>
              </div>
            </div>
          )}
          <DialogFooter>
            {viewingSegment && (
              <Button
                variant="outline"
                onClick={() => handleExportSegment(viewingSegment)}
                disabled={isExporting === viewingSegment.id}
                data-testid="button-export-from-view"
              >
                <Download className="h-4 w-4 mr-2" />
                {isExporting === viewingSegment.id ? "Exporting..." : "Export CSV"}
              </Button>
            )}
            <Button variant="outline" onClick={() => setViewingSegment(null)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
