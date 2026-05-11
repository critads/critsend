import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Bug, ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { BugReport, BugReportStatus } from "@shared/schema";

const STATUS_LABEL: Record<BugReportStatus, string> = {
  new: "New",
  in_progress: "In Progress",
  completed: "Completed",
};

const PAGE_SIZE = 25;

function statusBadge(status: string) {
  if (status === "new") return <Badge variant="destructive" data-testid={`badge-bug-status-${status}`}>New</Badge>;
  if (status === "in_progress") return <Badge data-testid={`badge-bug-status-${status}`}>In Progress</Badge>;
  if (status === "completed") return <Badge variant="secondary" data-testid={`badge-bug-status-${status}`}>Completed</Badge>;
  return <Badge variant="outline">{status}</Badge>;
}

export function BugReportsAdmin() {
  const { toast } = useToast();
  const [status, setStatus] = useState<string>("all");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [enlarged, setEnlarged] = useState(false);

  // Reset to first page whenever filters change
  const onStatusChange = (v: string) => { setStatus(v); setPage(0); };
  const onSearchChange = (v: string) => { setQ(v); setPage(0); };

  const queryKey = ["/api/bug-reports", status, q, page] as const;
  const { data, isLoading } = useQuery<{ reports: BugReport[]; total: number; limit: number; offset: number }>({
    queryKey,
    queryFn: async () => {
      const params = new URLSearchParams();
      if (status !== "all") params.set("status", status);
      if (q.trim()) params.set("q", q.trim());
      params.set("limit", String(PAGE_SIZE));
      params.set("offset", String(page * PAGE_SIZE));
      const res = await fetch(`/api/bug-reports?${params.toString()}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load bug reports");
      return res.json();
    },
    refetchInterval: 30000,
  });

  const selected = data?.reports.find((r) => r.id === selectedId) ?? null;
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const showingFrom = total === 0 ? 0 : page * PAGE_SIZE + 1;
  const showingTo = Math.min(total, (page + 1) * PAGE_SIZE);

  const updateStatus = async (id: string, next: BugReportStatus) => {
    try {
      await apiRequest("PATCH", `/api/bug-reports/${id}`, { status: next });
      queryClient.invalidateQueries({ queryKey: ["/api/bug-reports"] });
      toast({ title: "Status updated", description: `Marked as ${STATUS_LABEL[next]}.` });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Try again.";
      toast({ title: "Update failed", description: msg, variant: "destructive" });
    }
  };

  return (
    <Card data-testid="card-bug-reports">
      <CardHeader>
        <div className="flex items-center gap-2">
          <Bug className="h-5 w-5 text-muted-foreground" />
          <CardTitle className="text-lg">Bug Reports</CardTitle>
          {data && <Badge variant="outline" data-testid="badge-bug-reports-total">{data.total} total</Badge>}
        </div>
        <CardDescription>User-submitted feedback collected from the floating bug button</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col sm:flex-row gap-2 mb-4">
          <Select value={status} onValueChange={onStatusChange}>
            <SelectTrigger className="w-full sm:w-48" data-testid="select-bug-report-filter-status">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="new">New</SelectItem>
              <SelectItem value="in_progress">In Progress</SelectItem>
              <SelectItem value="completed">Completed</SelectItem>
            </SelectContent>
          </Select>
          <Input
            placeholder="Search description, email, or page URL…"
            value={q}
            onChange={(e) => onSearchChange(e.target.value)}
            className="flex-1"
            data-testid="input-bug-report-search"
          />
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-10 text-muted-foreground">
            <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Loading…
          </div>
        ) : !data || data.reports.length === 0 ? (
          <div className="text-center py-10 text-sm text-muted-foreground" data-testid="text-bug-reports-empty">
            No bug reports found.
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>When</TableHead>
                    <TableHead>User</TableHead>
                    <TableHead>Description</TableHead>
                    <TableHead>Page</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.reports.map((r) => (
                    <TableRow key={r.id} data-testid={`row-bug-report-${r.id}`}>
                      <TableCell className="text-xs whitespace-nowrap">
                        {new Date(r.createdAt).toLocaleString()}
                      </TableCell>
                      <TableCell className="text-xs">{r.userEmail || r.userId?.slice(0, 8) || "—"}</TableCell>
                      <TableCell className="text-sm max-w-md truncate" title={r.description}>
                        {r.description}
                      </TableCell>
                      <TableCell className="text-xs max-w-[180px] truncate" title={r.pageUrl ?? ""}>
                        {r.pageUrl ? new URL(r.pageUrl, window.location.origin).pathname : "—"}
                      </TableCell>
                      <TableCell>
                        <Select
                          value={r.status}
                          onValueChange={(v) => updateStatus(r.id, v as BugReportStatus)}
                        >
                          <SelectTrigger className="h-8 w-36" data-testid={`select-bug-report-status-${r.id}`}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="new">New</SelectItem>
                            <SelectItem value="in_progress">In Progress</SelectItem>
                            <SelectItem value="completed">Completed</SelectItem>
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setSelectedId(r.id)}
                          data-testid={`button-bug-report-view-${r.id}`}
                        >
                          View
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            <div className="flex items-center justify-between mt-4 text-xs text-muted-foreground">
              <div data-testid="text-bug-reports-pagination-info">
                Showing {showingFrom}–{showingTo} of {total}
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  disabled={page === 0}
                  data-testid="button-bug-reports-prev"
                >
                  <ChevronLeft className="h-3 w-3 mr-1" /> Prev
                </Button>
                <span data-testid="text-bug-reports-page">
                  Page {page + 1} / {totalPages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage((p) => (p + 1 < totalPages ? p + 1 : p))}
                  disabled={page + 1 >= totalPages}
                  data-testid="button-bug-reports-next"
                >
                  Next <ChevronRight className="h-3 w-3 ml-1" />
                </Button>
              </div>
            </div>
          </>
        )}

        <Dialog open={!!selectedId} onOpenChange={(o) => { if (!o) { setSelectedId(null); setEnlarged(false); } }}>
          <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto" data-testid="dialog-bug-report-detail">
            {selected && (
              <>
                <DialogHeader>
                  <DialogTitle className="flex items-center gap-2">
                    Bug Report {statusBadge(selected.status)}
                  </DialogTitle>
                  <DialogDescription>
                    Submitted {new Date(selected.createdAt).toLocaleString()}
                    {selected.userEmail ? ` by ${selected.userEmail}` : ""}
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-4">
                  <div>
                    <div className="text-xs text-muted-foreground mb-1">Description</div>
                    <p className="whitespace-pre-wrap text-sm" data-testid="text-bug-report-description">
                      {selected.description}
                    </p>
                  </div>
                  {selected.pageUrl && (() => {
                    let safeHref: string | null = null;
                    try {
                      const u = new URL(selected.pageUrl, window.location.origin);
                      if (u.protocol === "http:" || u.protocol === "https:") {
                        safeHref = u.toString();
                      }
                    } catch {
                      safeHref = null;
                    }
                    return (
                      <div>
                        <div className="text-xs text-muted-foreground mb-1">Page URL</div>
                        {safeHref ? (
                          <a
                            href={safeHref}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs font-mono break-all text-primary hover:underline"
                            data-testid="link-bug-report-pageurl"
                          >
                            {selected.pageUrl}
                          </a>
                        ) : (
                          <span className="text-xs font-mono break-all text-muted-foreground">
                            {selected.pageUrl}
                          </span>
                        )}
                      </div>
                    );
                  })()}
                  <div className="grid grid-cols-2 gap-3 text-xs">
                    {selected.viewportWidth && selected.viewportHeight && (
                      <div>
                        <div className="text-muted-foreground">Viewport</div>
                        <div className="font-mono">{selected.viewportWidth} × {selected.viewportHeight}</div>
                      </div>
                    )}
                    {selected.userAgent && (
                      <div className="col-span-2">
                        <div className="text-muted-foreground">User Agent</div>
                        <div className="font-mono break-all">{selected.userAgent}</div>
                      </div>
                    )}
                  </div>
                  {selected.screenshotPath && (
                    <div>
                      <div className="text-xs text-muted-foreground mb-1">Screenshot (click to enlarge)</div>
                      <button
                        type="button"
                        onClick={() => setEnlarged(true)}
                        className="block w-full focus:outline-none focus:ring-2 focus:ring-ring rounded"
                        data-testid="button-bug-report-screenshot-enlarge"
                      >
                        <img
                          src={`/api/bug-reports/${selected.id}/screenshot`}
                          alt="Bug report screenshot"
                          className="w-full rounded border cursor-zoom-in hover:opacity-90 transition-opacity"
                          data-testid="img-bug-report-screenshot"
                        />
                      </button>
                    </div>
                  )}
                  <div className="flex items-center gap-2 pt-2 border-t">
                    <span className="text-xs text-muted-foreground">Status:</span>
                    <Select
                      value={selected.status}
                      onValueChange={(v) => updateStatus(selected.id, v as BugReportStatus)}
                    >
                      <SelectTrigger className="h-8 w-40" data-testid="select-bug-report-detail-status">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="new">New</SelectItem>
                        <SelectItem value="in_progress">In Progress</SelectItem>
                        <SelectItem value="completed">Completed</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </>
            )}
          </DialogContent>
        </Dialog>

        {/* Enlarged screenshot lightbox */}
        <Dialog open={enlarged} onOpenChange={setEnlarged}>
          <DialogContent
            className="max-w-[95vw] max-h-[95vh] p-2 overflow-auto"
            data-testid="dialog-bug-report-screenshot-lightbox"
          >
            <DialogHeader className="sr-only">
              <DialogTitle>Screenshot</DialogTitle>
              <DialogDescription>Full-size bug report screenshot</DialogDescription>
            </DialogHeader>
            {selected?.screenshotPath && (
              <img
                src={`/api/bug-reports/${selected.id}/screenshot`}
                alt="Bug report screenshot — full size"
                className="w-full h-auto rounded"
                data-testid="img-bug-report-screenshot-full"
              />
            )}
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}
