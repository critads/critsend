import { useState } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
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
import {
  Server, Plus, MoreVertical, Trash2, Edit2,
  CheckCircle2, XCircle, FlaskConical, Wifi, WifiOff, Loader2,
  Lightbulb, ChevronDown, ChevronRight, Clock,
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

export default function MTAs() {
  const [, navigate] = useLocation();
  const [deleteConfirm, setDeleteConfirm] = useState<Mta | null>(null);
  const [testingMta, setTestingMta] = useState<Mta | null>(null);
  const [testResult, setTestResult] = useState<SmtpTestResult | null>(null);
  const [showRawError, setShowRawError] = useState(false);
  const { toast } = useToast();

  const { data: mtas, isLoading } = useQuery<Mta[]>({
    queryKey: ["/api/mtas"],
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/mtas/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/mtas"] });
      setDeleteConfirm(null);
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

  return (
    <div className="p-6 lg:p-8 space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">MTAs</h1>
          <p className="text-muted-foreground">
            Configure your Mail Transfer Agents (sending servers)
          </p>
        </div>
        <Button onClick={() => navigate("/mtas/new")} data-testid="button-add-mta">
          <Plus className="h-4 w-4 mr-2" />
          Add MTA
        </Button>
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
            <h3 className="text-lg font-semibold mb-2">No sending servers configured</h3>
            <p className="text-muted-foreground max-w-md mb-4">
              Add an SMTP server to start sending email campaigns.
            </p>
            <Button onClick={() => navigate("/mtas/new")}>
              <Plus className="h-4 w-4 mr-2" />
              Add Your First MTA
            </Button>
          </CardContent>
        </Card>
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
                <div className="flex items-center gap-3 p-4 rounded-lg bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-800">
                  <CheckCircle2 className="h-8 w-8 text-green-600 dark:text-green-400 shrink-0" />
                  <div>
                    <p className="font-semibold text-green-800 dark:text-green-300">Connection successful</p>
                    <p className="text-sm text-green-700 dark:text-green-400">
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
    </div>
  );
}
