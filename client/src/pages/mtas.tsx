import { useState, useRef, useCallback, useEffect } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation, keepPreviousData } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
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
import { Input } from "@/components/ui/input";
import {
  Server, Plus, MoreVertical, Trash2, Edit2,
  CheckCircle2, XCircle, FlaskConical, Wifi, WifiOff, Loader2,
  Lightbulb, ChevronDown, ChevronRight, Clock, Search,
  ChevronLeft, ChevronRight as ChevronRightIcon, Send, Mail,
} from "lucide-react";
import type { Mta } from "@shared/schema";

interface SmtpTestResult {
  success: boolean;
  connectionTimeMs: number;
  stage?: string;
  errorCode?: string;
  errorMessage?: string;
  smtpCode?: number;
  suggestions?: string[];
  serverBanner?: string;
}

interface PlainTestResult {
  success: boolean;
  connectionTimeMs: number;
  messageId?: string;
  accepted?: string[];
  rejected?: string[];
  from?: string;
  to?: string;
  stage?: string;
  errorCode?: string;
  errorMessage?: string;
  smtpCode?: number;
  suggestions?: string[];
}

interface PaginatedMtas {
  mtas: Mta[];
  total: number;
  page: number;
  totalPages: number;
}

const PAGE_SIZE = 20;

export default function MTAs() {
  const [, navigate] = useLocation();
  const [deleteConfirm, setDeleteConfirm] = useState<Mta | null>(null);
  const [testingMta, setTestingMta] = useState<Mta | null>(null);
  const [testResult, setTestResult] = useState<SmtpTestResult | null>(null);
  const [showRawError, setShowRawError] = useState(false);
  const [plainTestMta, setPlainTestMta] = useState<Mta | null>(null);
  const [plainTestTo, setPlainTestTo] = useState("");
  const [plainTestResult, setPlainTestResult] = useState<PlainTestResult | null>(null);
  const [showPlainRawError, setShowPlainRawError] = useState(false);
  const [plainTestHeaders, setPlainTestHeaders] = useState<Array<{ key: string; value: string }>>([]);
  const [searchInput, setSearchInput] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  const { toast } = useToast();

  const handleSearchChange = useCallback((value: string) => {
    setSearchInput(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setDebouncedSearch(value.trim());
      setCurrentPage(1);
    }, 300);
  }, []);

  useEffect(() => {
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, []);

  const queryParams = new URLSearchParams();
  queryParams.set("paginate", "true");
  queryParams.set("page", String(currentPage));
  queryParams.set("limit", String(PAGE_SIZE));
  if (debouncedSearch) queryParams.set("search", debouncedSearch);
  const queryString = queryParams.toString();

  const { data: mtasData, isLoading } = useQuery<PaginatedMtas>({
    queryKey: ["/api/mtas", { page: currentPage, search: debouncedSearch }],
    queryFn: async () => {
      const res = await fetch(`/api/mtas?${queryString}`, { credentials: "include" });
      if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
      return res.json();
    },
    placeholderData: keepPreviousData,
  });

  const mtas = mtasData?.mtas;
  const totalPages = mtasData?.totalPages ?? 1;
  const totalMtas = mtasData?.total ?? 0;

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/mtas/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/mtas"] });
      setDeleteConfirm(null);
      setCurrentPage(1);
      toast({ title: "MTA deleted", description: "Sending server removed." });
    },
    onError: (error: any) => {
      const msg = error?.message?.includes("409")
        ? "This MTA is still used by active records. Remove any campaign references first."
        : "Failed to delete MTA. Please try again.";
      toast({ title: "Delete failed", description: msg, variant: "destructive" });
    },
  });

  const testMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("POST", `/api/mtas/${id}/test`);
      return res.json() as Promise<SmtpTestResult>;
    },
    onSuccess: (data) => {
      setTestResult(data);
    },
    onError: () => {
      setTestResult({
        success: false,
        connectionTimeMs: 0,
        stage: "Unknown",
        errorMessage: "Unexpected error while testing connection.",
        suggestions: ["Check server logs for more details."],
      });
    },
  });

  const handleTestConnection = (mta: Mta) => {
    setTestingMta(mta);
    setTestResult(null);
    setShowRawError(false);
    testMutation.mutate(mta.id);
  };

  const plainTestMutation = useMutation({
    mutationFn: async ({ id, to, headers }: { id: string; to: string; headers: Array<{ key: string; value: string }> }) => {
      const res = await apiRequest("POST", `/api/mtas/${id}/plain-test`, { to, headers });
      return res.json() as Promise<PlainTestResult>;
    },
    onSuccess: (data) => {
      setPlainTestResult(data);
    },
    onError: () => {
      setPlainTestResult({
        success: false,
        connectionTimeMs: 0,
        stage: "Unknown",
        errorMessage: "Unexpected error while sending the plain test email.",
        suggestions: ["Check server logs for more details."],
      });
    },
  });

  const isValidEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());
  const isValidHeaderName = (v: string) => /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(v);
  const hasInvalidHeader = plainTestHeaders.some(
    (h) => h.key.trim().length > 0 && !isValidHeaderName(h.key.trim()),
  );

  const openPlainTest = (mta: Mta) => {
    setPlainTestMta(mta);
    setPlainTestTo("");
    setPlainTestResult(null);
    setShowPlainRawError(false);
    setPlainTestHeaders([]);
  };

  const addPlainTestHeader = () =>
    setPlainTestHeaders((prev) => [...prev, { key: "", value: "" }]);
  const updatePlainTestHeader = (i: number, field: "key" | "value", val: string) =>
    setPlainTestHeaders((prev) => prev.map((h, idx) => (idx === i ? { ...h, [field]: val } : h)));
  const removePlainTestHeader = (i: number) =>
    setPlainTestHeaders((prev) => prev.filter((_, idx) => idx !== i));

  const submitPlainTest = () => {
    if (!plainTestMta || !plainTestMta.fromEmail || !isValidEmail(plainTestTo) || hasInvalidHeader) return;
    setPlainTestResult(null);
    setShowPlainRawError(false);
    const cleanedHeaders = plainTestHeaders
      .map((h) => ({ key: h.key.trim(), value: h.value }))
      .filter((h) => h.key.length > 0);
    plainTestMutation.mutate({ id: plainTestMta.id, to: plainTestTo.trim(), headers: cleanedHeaders });
  };

  return (
    <div className="p-6 lg:p-8 space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">MTAs</h1>
          <p className="text-muted-foreground">
            Configure your Mail Transfer Agents (sending servers)
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="relative w-full sm:w-64">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search by name or hostname..."
              value={searchInput}
              onChange={(e) => handleSearchChange(e.target.value)}
              className="pl-9"
              data-testid="input-search-mtas"
            />
          </div>
          <Button onClick={() => navigate("/mtas/new")} data-testid="button-add-mta">
            <Plus className="h-4 w-4 mr-2" />
            Add MTA
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-48" />
          ))}
        </div>
      ) : mtas && mtas.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {mtas.map((mta) => (
            <Card key={mta.id} data-testid={`mta-card-${mta.id}`}>
              <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0">
                <div className="flex items-start gap-3">
                  <div className="p-2 rounded-md bg-muted">
                    <Server className="h-5 w-5 text-muted-foreground" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <CardTitle className="text-lg truncate">{mta.name}</CardTitle>
                      {mta.isActive ? (
                        <Badge variant="secondary" className="gap-1">
                          <CheckCircle2 className="h-3 w-3" />
                          Active
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="gap-1">
                          <XCircle className="h-3 w-3" />
                          Inactive
                        </Badge>
                      )}
                      {mta.mode === "nullsink" && (
                        <Badge
                          variant="outline"
                          className="gap-1 text-amber-600 border-amber-600 dark:text-amber-500 dark:border-amber-500"
                          data-testid={`badge-test-mode-${mta.id}`}
                        >
                          <FlaskConical className="h-3 w-3" />
                          Test Mode
                        </Badge>
                      )}
                    </div>
                    <CardDescription className="font-mono text-xs mt-1">
                      {mta.hostname}:{mta.port}
                    </CardDescription>
                  </div>
                </div>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" data-testid={`button-mta-menu-${mta.id}`}>
                      <MoreVertical className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => navigate(`/mtas/${mta.id}/edit`)}>
                      <Edit2 className="h-4 w-4 mr-2" />
                      Edit
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => handleTestConnection(mta)}
                      data-testid={`button-test-mta-${mta.id}`}
                    >
                      <Wifi className="h-4 w-4 mr-2" />
                      Test Connection
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => openPlainTest(mta)}
                      data-testid={`button-plain-test-mta-${mta.id}`}
                    >
                      <Send className="h-4 w-4 mr-2" />
                      Plain Test
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      className="text-destructive"
                      onClick={() => setDeleteConfirm(mta)}
                    >
                      <Trash2 className="h-4 w-4 mr-2" />
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="text-sm flex items-center gap-2">
                  <span className="text-muted-foreground">Protocol:</span>
                  <Badge variant="outline" className="text-xs font-mono">
                    {(mta as any).protocol || "STARTTLS"}
                  </Badge>
                </div>
                <div className="text-sm">
                  <span className="text-muted-foreground">User:</span>{" "}
                  <span className="font-mono">{mta.username}</span>
                </div>
                {mta.fromName && (
                  <div className="text-sm">
                    <span className="text-muted-foreground">From:</span>{" "}
                    <span>{mta.fromName} &lt;{mta.fromEmail}&gt;</span>
                  </div>
                )}
                {mta.trackingDomain && (
                  <div className="text-sm">
                    <span className="text-muted-foreground">Click tracking:</span>{" "}
                    <span className="font-mono text-xs">{mta.trackingDomain}</span>
                  </div>
                )}
                {mta.openTrackingDomain && (
                  <div className="text-sm">
                    <span className="text-muted-foreground">Open tracking:</span>{" "}
                    <span className="font-mono text-xs">{mta.openTrackingDomain}</span>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <Server className="h-16 w-16 text-muted-foreground/50 mb-4" />
            {debouncedSearch ? (
              <>
                <h3 className="text-lg font-semibold mb-2">No MTAs match your search</h3>
                <p className="text-muted-foreground max-w-md mb-4">
                  Try a different search term or clear the search.
                </p>
              </>
            ) : (
              <>
                <h3 className="text-lg font-semibold mb-2">No sending servers configured</h3>
                <p className="text-muted-foreground max-w-md mb-4">
                  Add an SMTP server to start sending email campaigns.
                </p>
                <Button onClick={() => navigate("/mtas/new")}>
                  <Plus className="h-4 w-4 mr-2" />
                  Add Your First MTA
                </Button>
              </>
            )}
          </CardContent>
        </Card>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-between pt-2">
          <p className="text-sm text-muted-foreground" data-testid="text-mta-pagination-info">
            Showing {((currentPage - 1) * PAGE_SIZE) + 1}–{Math.min(currentPage * PAGE_SIZE, totalMtas)} of {totalMtas}
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
              disabled={currentPage <= 1}
              data-testid="button-mta-prev-page"
            >
              <ChevronLeft className="h-4 w-4 mr-1" />
              Previous
            </Button>
            <span className="text-sm text-muted-foreground">
              Page {currentPage} of {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
              disabled={currentPage >= totalPages}
              data-testid="button-mta-next-page"
            >
              Next
              <ChevronRightIcon className="h-4 w-4 ml-1" />
            </Button>
          </div>
        </div>
      )}

      {/* Delete Confirmation Dialog */}
      <Dialog open={!!deleteConfirm} onOpenChange={() => setDeleteConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete MTA</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete "{deleteConfirm?.name}"? This action cannot be undone.
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
              data-testid="button-confirm-delete-mta"
            >
              {deleteMutation.isPending ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Test Connection Dialog */}
      <Dialog
        open={!!testingMta}
        onOpenChange={(open) => {
          if (!open) {
            setTestingMta(null);
            setTestResult(null);
            setShowRawError(false);
          }
        }}
      >
        <DialogContent className="max-w-lg" data-testid="dialog-test-mta">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Wifi className="h-5 w-5" />
              Test Connection
            </DialogTitle>
            <DialogDescription>
              Testing SMTP connectivity for{" "}
              <span className="font-medium text-foreground">{testingMta?.name}</span>
              <span className="font-mono text-xs ml-1 text-muted-foreground">
                ({testingMta?.hostname}:{testingMta?.port})
              </span>
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            {testMutation.isPending && (
              <div className="flex flex-col items-center justify-center py-8 gap-3" data-testid="test-loading">
                <Loader2 className="h-10 w-10 animate-spin text-primary" />
                <p className="text-sm text-muted-foreground">Connecting to SMTP server…</p>
                <p className="text-xs text-muted-foreground">This may take up to 15 seconds</p>
              </div>
            )}

            {testResult?.success && (
              <div className="space-y-4" data-testid="test-success">
                <div className="flex items-center gap-3 p-4 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800">
                  <CheckCircle2 className="h-8 w-8 text-amber-600 dark:text-amber-400 shrink-0" />
                  <div>
                    <p className="font-semibold text-amber-800 dark:text-amber-300">Connection successful</p>
                    <p className="text-sm text-amber-700 dark:text-amber-400">
                      SMTP server accepted the connection and credentials.
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Clock className="h-4 w-4" />
                  <span>Connected in <strong>{testResult.connectionTimeMs} ms</strong></span>
                </div>
                {testResult.serverBanner && (
                  <div className="p-3 rounded-md bg-muted text-xs font-mono break-all">
                    {testResult.serverBanner}
                  </div>
                )}
              </div>
            )}

            {testResult && !testResult.success && (
              <div className="space-y-4" data-testid="test-failure">
                <div className="flex items-center gap-3 p-4 rounded-lg bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800">
                  <WifiOff className="h-8 w-8 text-red-600 dark:text-red-400 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold text-red-800 dark:text-red-300">Connection failed</p>
                    {testResult.stage && (
                      <div className="flex items-center gap-2 mt-1">
                        <span className="text-xs text-red-700 dark:text-red-400">Failed at:</span>
                        <Badge variant="outline" className="text-xs border-red-400 text-red-700 dark:text-red-400">
                          {testResult.stage}
                        </Badge>
                        {testResult.smtpCode && (
                          <Badge variant="outline" className="text-xs border-red-400 text-red-700 dark:text-red-400">
                            SMTP {testResult.smtpCode}
                          </Badge>
                        )}
                      </div>
                    )}
                  </div>
                </div>

                {testResult.connectionTimeMs > 0 && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Clock className="h-4 w-4" />
                    <span>Failed after <strong>{testResult.connectionTimeMs} ms</strong></span>
                  </div>
                )}

                <Separator />

                {testResult.suggestions && testResult.suggestions.length > 0 && (
                  <div className="space-y-2">
                    <div className="flex items-center gap-1.5 text-sm font-medium">
                      <Lightbulb className="h-4 w-4 text-amber-500" />
                      What to check
                    </div>
                    <ul className="space-y-1.5 pl-1">
                      {testResult.suggestions.map((s, i) => (
                        <li key={i} className="flex items-start gap-2 text-sm text-muted-foreground">
                          <span className="mt-1 h-1.5 w-1.5 rounded-full bg-amber-400 shrink-0" />
                          {s}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {testResult.errorMessage && (
                  <div className="space-y-1.5">
                    <button
                      className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                      onClick={() => setShowRawError(!showRawError)}
                      data-testid="button-toggle-raw-error"
                    >
                      {showRawError
                        ? <ChevronDown className="h-3.5 w-3.5" />
                        : <ChevronRight className="h-3.5 w-3.5" />
                      }
                      Raw error details
                    </button>
                    {showRawError && (
                      <div
                        className="p-3 rounded-md bg-muted text-xs font-mono break-all leading-relaxed"
                        data-testid="raw-error-details"
                      >
                        {testResult.errorCode && (
                          <div><span className="text-muted-foreground">Code: </span>{testResult.errorCode}</div>
                        )}
                        <div><span className="text-muted-foreground">Message: </span>{testResult.errorMessage}</div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          <DialogFooter className="gap-2">
            {testResult && (
              <Button
                variant="outline"
                onClick={() => {
                  setTestResult(null);
                  setShowRawError(false);
                  testMutation.mutate(testingMta!.id);
                }}
                disabled={testMutation.isPending}
                data-testid="button-retest-mta"
              >
                Test Again
              </Button>
            )}
            <Button
              onClick={() => {
                setTestingMta(null);
                setTestResult(null);
                setShowRawError(false);
              }}
              data-testid="button-close-test-dialog"
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Plain Test Dialog */}
      <Dialog
        open={!!plainTestMta}
        onOpenChange={(open) => {
          if (!open) {
            setPlainTestMta(null);
            setPlainTestResult(null);
            setShowPlainRawError(false);
          }
        }}
      >
        <DialogContent className="max-w-lg" data-testid="dialog-plain-test-mta">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Send className="h-5 w-5" />
              Plain Test
            </DialogTitle>
            <DialogDescription>
              Sends a raw email via{" "}
              <span className="font-medium text-foreground">{plainTestMta?.name}</span> with
              subject <span className="font-mono">"Hello moon"</span> and body{" "}
              <span className="font-mono">"I'm the sun"</span>. No unsubscribe link and no
              open or click tracking. You can optionally add custom headers below.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <label htmlFor="plain-test-to" className="text-sm font-medium">
                Recipient email
              </label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  id="plain-test-to"
                  type="email"
                  placeholder="you@example.com"
                  value={plainTestTo}
                  onChange={(e) => setPlainTestTo(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && isValidEmail(plainTestTo) && !plainTestMutation.isPending) {
                      submitPlainTest();
                    }
                  }}
                  className="pl-9"
                  disabled={plainTestMutation.isPending}
                  data-testid="input-plain-test-to"
                />
              </div>
              {plainTestMta?.fromEmail ? (
                <p className="text-xs text-muted-foreground">
                  From:{" "}
                  <span className="font-mono">
                    {plainTestMta.fromName ? `${plainTestMta.fromName} <${plainTestMta.fromEmail}>` : plainTestMta.fromEmail}
                  </span>
                </p>
              ) : (
                <p className="text-xs text-red-600 dark:text-red-400">
                  This MTA has no From email configured.
                </p>
              )}
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium">Custom headers (optional)</label>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={addPlainTestHeader}
                  disabled={plainTestMutation.isPending || plainTestHeaders.length >= 25}
                  data-testid="button-add-plain-test-header"
                >
                  <Plus className="h-3.5 w-3.5 mr-1" />
                  Add header
                </Button>
              </div>
              {plainTestHeaders.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No custom headers — the test sends a raw email by default.
                </p>
              ) : (
                <div className="space-y-2">
                  {plainTestHeaders.map((h, i) => {
                    const invalidName = h.key.trim().length > 0 && !isValidHeaderName(h.key.trim());
                    return (
                      <div key={i} className="flex items-start gap-2" data-testid={`row-plain-test-header-${i}`}>
                        <div className="flex-1 space-y-1">
                          <Input
                            placeholder="Header-Name"
                            value={h.key}
                            onChange={(e) => updatePlainTestHeader(i, "key", e.target.value)}
                            disabled={plainTestMutation.isPending}
                            className={`font-mono text-sm ${invalidName ? "border-red-400 focus-visible:ring-red-400" : ""}`}
                            data-testid={`input-plain-test-header-key-${i}`}
                          />
                          {invalidName && (
                            <p className="text-[11px] text-red-600 dark:text-red-400">
                              Use letters, digits and hyphens (e.g. X-Custom-Tag).
                            </p>
                          )}
                        </div>
                        <Input
                          placeholder="value"
                          value={h.value}
                          onChange={(e) => updatePlainTestHeader(i, "value", e.target.value)}
                          disabled={plainTestMutation.isPending}
                          className="flex-1 font-mono text-sm"
                          data-testid={`input-plain-test-header-value-${i}`}
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-9 w-9 shrink-0 text-muted-foreground hover:text-destructive"
                          onClick={() => removePlainTestHeader(i)}
                          disabled={plainTestMutation.isPending}
                          data-testid={`button-remove-plain-test-header-${i}`}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    );
                  })}
                </div>
              )}
              {plainTestHeaders.length > 0 && (
                <p className="text-[11px] text-muted-foreground">
                  Advanced: re-defining standard headers (From, Subject, Message-ID) can produce a malformed test email.
                </p>
              )}
            </div>

            {plainTestMutation.isPending && (
              <div className="flex flex-col items-center justify-center py-6 gap-3" data-testid="plain-test-loading">
                <Loader2 className="h-10 w-10 animate-spin text-primary" />
                <p className="text-sm text-muted-foreground">Sending plain test email…</p>
              </div>
            )}

            {plainTestResult?.success && (
              <div className="space-y-3" data-testid="plain-test-success">
                <div className="flex items-center gap-3 p-4 rounded-lg bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800">
                  <CheckCircle2 className="h-8 w-8 text-emerald-600 dark:text-emerald-400 shrink-0" />
                  <div>
                    <p className="font-semibold text-emerald-800 dark:text-emerald-300">Email sent</p>
                    <p className="text-sm text-emerald-700 dark:text-emerald-400">
                      The MTA accepted the message for delivery.
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Clock className="h-4 w-4" />
                  <span>Sent in <strong>{plainTestResult.connectionTimeMs} ms</strong></span>
                </div>
                {plainTestResult.messageId && (
                  <div className="p-3 rounded-md bg-muted text-xs font-mono break-all" data-testid="plain-test-message-id">
                    <span className="text-muted-foreground">Message-ID: </span>{plainTestResult.messageId}
                  </div>
                )}
              </div>
            )}

            {plainTestResult && !plainTestResult.success && (
              <div className="space-y-4" data-testid="plain-test-failure">
                <div className="flex items-center gap-3 p-4 rounded-lg bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800">
                  <XCircle className="h-8 w-8 text-red-600 dark:text-red-400 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold text-red-800 dark:text-red-300">Send failed</p>
                    {plainTestResult.stage && (
                      <div className="flex items-center gap-2 mt-1">
                        <span className="text-xs text-red-700 dark:text-red-400">Failed at:</span>
                        <Badge variant="outline" className="text-xs border-red-400 text-red-700 dark:text-red-400">
                          {plainTestResult.stage}
                        </Badge>
                        {plainTestResult.smtpCode && (
                          <Badge variant="outline" className="text-xs border-red-400 text-red-700 dark:text-red-400">
                            SMTP {plainTestResult.smtpCode}
                          </Badge>
                        )}
                      </div>
                    )}
                  </div>
                </div>

                {plainTestResult.suggestions && plainTestResult.suggestions.length > 0 && (
                  <div className="space-y-2">
                    <div className="flex items-center gap-1.5 text-sm font-medium">
                      <Lightbulb className="h-4 w-4 text-amber-500" />
                      What to check
                    </div>
                    <ul className="space-y-1.5 pl-1">
                      {plainTestResult.suggestions.map((s, i) => (
                        <li key={i} className="flex items-start gap-2 text-sm text-muted-foreground">
                          <span className="mt-1 h-1.5 w-1.5 rounded-full bg-amber-400 shrink-0" />
                          {s}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {plainTestResult.errorMessage && (
                  <div className="space-y-1.5">
                    <button
                      className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                      onClick={() => setShowPlainRawError(!showPlainRawError)}
                      data-testid="button-toggle-plain-raw-error"
                    >
                      {showPlainRawError
                        ? <ChevronDown className="h-3.5 w-3.5" />
                        : <ChevronRight className="h-3.5 w-3.5" />
                      }
                      Raw error details
                    </button>
                    {showPlainRawError && (
                      <div
                        className="p-3 rounded-md bg-muted text-xs font-mono break-all leading-relaxed"
                        data-testid="plain-raw-error-details"
                      >
                        {plainTestResult.errorCode && (
                          <div><span className="text-muted-foreground">Code: </span>{plainTestResult.errorCode}</div>
                        )}
                        <div><span className="text-muted-foreground">Message: </span>{plainTestResult.errorMessage}</div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={() => {
                setPlainTestMta(null);
                setPlainTestResult(null);
                setShowPlainRawError(false);
              }}
              data-testid="button-close-plain-test-dialog"
            >
              Close
            </Button>
            <Button
              onClick={submitPlainTest}
              disabled={!isValidEmail(plainTestTo) || !plainTestMta?.fromEmail || hasInvalidHeader || plainTestMutation.isPending}
              data-testid="button-send-plain-test"
            >
              {plainTestMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Sending…
                </>
              ) : (
                <>
                  <Send className="h-4 w-4 mr-2" />
                  {plainTestResult ? "Send again" : "Send test"}
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
