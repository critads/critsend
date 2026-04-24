import { useState, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest, fetchCsrfToken } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { useJobStream, isSSEConnected } from "@/hooks/use-job-stream";
import {
  Upload,
  FileUp,
  CheckCircle2,
  XCircle,
  Clock,
  Loader2,
  RefreshCw,
  AlertCircle,
  Ban,
  Trash2,
  ShieldAlert,
  Tag,
  BookmarkCheck,
  TriangleAlert,
} from "lucide-react";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import type { ImportJob } from "@shared/schema";

function ConfirmationCard({ job, onConfirmed }: { job: ImportJob; onConfirmed: () => void }) {
  const [cleanExisting, setCleanExisting] = useState(false);
  const [deleteExisting, setDeleteExisting] = useState(false);
  const { toast } = useToast();

  const { data: affectedData, isLoading: affectedLoading } = useQuery<{ affectedSubscribers: number; bckProtected: number }>({
    queryKey: ["/api/import-jobs", job.id, "affected-count"],
    queryFn: async () => {
      const res = await fetch(`/api/import-jobs/${job.id}/affected-count`);
      if (!res.ok) throw new Error("Failed to fetch affected count");
      return res.json();
    },
    enabled: (job.detectedRefs?.length ?? 0) > 0,
  });

  const confirmMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("PATCH", `/api/import-jobs/${job.id}/confirm`, {
        cleanExistingRefs: cleanExisting,
        deleteExistingRefs: deleteExisting,
      });
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/import-jobs"] });
      toast({ title: "Import confirmed", description: "Import is now processing." });
      onConfirmed();
    },
    onError: (error: Error) => {
      toast({ title: "Confirmation failed", description: error.message, variant: "destructive" });
    },
  });

  const cancelMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", `/api/import/${job.id}/cancel`);
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/import-jobs"] });
      toast({ title: "Import cancelled" });
    },
  });

  const detectedRefs = job.detectedRefs || [];
  const affectedCount = affectedData?.affectedSubscribers ?? 0;
  const bckCount = affectedData?.bckProtected ?? 0;

  return (
    <div className="rounded-md border border-amber-500/50 bg-amber-50/50 dark:bg-amber-950/20 p-4 space-y-4">
      <div className="flex items-center gap-2 text-amber-700 dark:text-amber-400">
        <AlertCircle className="h-5 w-5" />
        <span className="font-medium">Awaiting Confirmation — Refs detected in CSV</span>
      </div>

      <div>
        <p className="text-sm font-medium mb-2">Detected refs:</p>
        <div className="flex flex-wrap gap-1.5">
          {detectedRefs.map((ref) => (
            <Badge key={ref} variant="secondary" className="bg-blue-100 text-blue-800 dark:bg-blue-900/50 dark:text-blue-300" data-testid={`badge-ref-${ref}`}>
              {ref}
            </Badge>
          ))}
        </div>
      </div>

      <div className="space-y-3">
        <div className="flex items-start space-x-2">
          <Checkbox
            id={`clean-${job.id}`}
            checked={cleanExisting}
            onCheckedChange={(checked) => {
              setCleanExisting(checked === true);
              if (checked) setDeleteExisting(false);
            }}
            disabled={deleteExisting}
            data-testid="checkbox-clean-refs"
          />
          <div className="grid gap-1.5 leading-none">
            <Label htmlFor={`clean-${job.id}`} className="cursor-pointer font-normal text-sm">
              Remove these refs from existing subscribers before importing
            </Label>
            <p className="text-xs text-muted-foreground">
              Strips ref codes from contacts but keeps the subscriber rows.
              Affected subscribers:{" "}
              {affectedLoading ? (
                <span className="text-amber-600">Calculating...</span>
              ) : (
                <span className="font-medium">{affectedCount.toLocaleString()}</span>
              )}
            </p>
          </div>
        </div>

        <div className="flex items-start space-x-2">
          <Checkbox
            id={`delete-${job.id}`}
            checked={deleteExisting}
            onCheckedChange={(checked) => {
              setDeleteExisting(checked === true);
              if (checked) setCleanExisting(false);
            }}
            disabled={cleanExisting}
            data-testid="checkbox-delete-refs"
          />
          <div className="grid gap-1.5 leading-none">
            <Label htmlFor={`delete-${job.id}`} className="cursor-pointer font-normal text-sm text-red-700 dark:text-red-400 flex items-center gap-1.5">
              <Trash2 className="h-3.5 w-3.5" />
              Delete subscribers with these refs before importing
            </Label>
            <p className="text-xs text-muted-foreground">
              Permanently removes subscriber rows matching these refs.{" "}
              {affectedLoading ? (
                <span className="text-amber-600">Calculating...</span>
              ) : (
                <>
                  <span className="font-medium text-red-600">{affectedCount.toLocaleString()}</span> would be deleted
                  {bckCount > 0 && (
                    <span className="inline-flex items-center gap-1 ml-1">
                      <ShieldAlert className="h-3 w-3 text-amber-600 inline" />
                      <span className="text-amber-600 font-medium">{bckCount.toLocaleString()} BCK-protected (safe)</span>
                    </span>
                  )}
                </>
              )}
            </p>
          </div>
        </div>
      </div>

      <div className="flex gap-2">
        <Button
          onClick={() => confirmMutation.mutate()}
          disabled={confirmMutation.isPending}
          variant={deleteExisting ? "destructive" : "default"}
          data-testid="button-confirm-import"
        >
          {confirmMutation.isPending ? (
            <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Confirming...</>
          ) : deleteExisting ? (
            <><Trash2 className="h-4 w-4 mr-2" />Confirm with Delete</>
          ) : (
            "Confirm Import"
          )}
        </Button>
        <Button
          variant="outline"
          onClick={() => cancelMutation.mutate()}
          disabled={cancelMutation.isPending}
          data-testid="button-cancel-confirmation"
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

function formatDuration(startDate: Date | string | null, endDate: Date | string | null): string | null {
  if (!startDate) return null;
  const start = new Date(startDate).getTime();
  const end = endDate ? new Date(endDate).getTime() : Date.now();
  const sec = Math.max(Math.round((end - start) / 1000), 1);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  if (min < 60) return `${min}m ${remSec}s`;
  const hr = Math.floor(min / 60);
  return `${hr}h ${min % 60}m`;
}

const ERROR_LABELS: Record<string, string> = {
  empty_email: "Empty email field",
  invalid_email: "Invalid email format",
  invalid_email_no_at: "Invalid email (no @)",
  malformed_csv_row: "Malformed CSV row",
  parse_error: "CSV parse error",
  batch_processing_error: "Database batch error",
  processing_error: "Processing error",
  db_constraint: "Database constraint violation",
};

function ActiveJobDisplay({ job }: { job: ImportJob }) {
  const pct = job.totalRows > 0 ? Math.min((job.processedRows / job.totalRows) * 100, 100) : 0;
  const isWaiting = (job.status === "queued" || job.status === "pending") && job.processedRows === 0;

  const startTime = job.startedAt
    ? new Date(job.startedAt).getTime()
    : new Date(job.createdAt).getTime();
  const elapsedMs = Date.now() - startTime;
  const elapsedSec = Math.max(elapsedMs / 1000, 1);
  const rowsPerSec = job.processedRows / elapsedSec;
  const remainingRows = Math.max(job.totalRows - job.processedRows, 0);
  const etaSec = rowsPerSec > 0 ? remainingRows / rowsPerSec : 0;
  const etaMin = Math.max(Math.round(etaSec / 60), 0);
  const etaHours = Math.floor(etaMin / 60);
  const etaMinRemainder = etaMin % 60;
  const elapsed = formatDuration(job.startedAt || job.createdAt, null);

  return (
    <div className="space-y-2">
      <Progress value={pct} className="h-2" />
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>
          {Math.min(job.processedRows, job.totalRows).toLocaleString()} / {job.totalRows.toLocaleString()} rows
        </span>
        <span>{isWaiting ? "Waiting to start..." : `${pct.toFixed(1)}%`}</span>
      </div>
      {job.processedRows > 0 && (
        <div className="flex justify-between text-xs text-muted-foreground mt-1">
          <span className="text-green-600 font-medium">
            {Math.round(rowsPerSec * 60).toLocaleString()} rows/min
          </span>
          <span>
            {elapsed && <span className="mr-3">Elapsed: {elapsed}</span>}
            ETA: {remainingRows === 0 ? "finishing..." : etaHours > 0 ? `${etaHours}h ${etaMinRemainder}m` : `${etaMin}m`}
          </span>
        </div>
      )}
      {(job.newSubscribers > 0 || job.updatedSubscribers > 0 || job.failedRows > 0) && (
        <div className="grid grid-cols-3 gap-3 text-xs mt-2 p-2 rounded bg-muted/50">
          <div>
            <span className="text-muted-foreground">New: </span>
            <span className="font-medium text-green-600">+{job.newSubscribers.toLocaleString()}</span>
          </div>
          <div>
            <span className="text-muted-foreground">Updated: </span>
            <span className="font-medium text-blue-600">{job.updatedSubscribers.toLocaleString()}</span>
          </div>
          <div>
            <span className="text-muted-foreground">Failed: </span>
            <span className={`font-medium ${job.failedRows > 0 ? "text-red-600" : "text-muted-foreground"}`}>
              {job.failedRows.toLocaleString()}
            </span>
          </div>
        </div>
      )}
      <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">
        Import continues in the background even if you navigate away.
      </p>
    </div>
  );
}

function CompletedJobDisplay({ job }: { job: ImportJob }) {
  const reasons = ((job as any).failureReasons || {}) as Record<string, any>;
  const dupCount = reasons["duplicate_in_file"] || (job as any).duplicatesInFile || 0;
  const sampleFails = reasons["_sample_failures"] as Record<string, string> | undefined;
  const errorReasons = Object.fromEntries(
    Object.entries(reasons).filter(([key]) => key !== "duplicate_in_file" && !key.startsWith("_"))
  ) as Record<string, number>;
  const hasErrors = Object.keys(errorReasons).length > 0;
  const duration = formatDuration(job.startedAt, job.completedAt);
  const skippedRows = (job as any).skippedRows || 0;
  const forcedTags: string[] = job.forcedTags ?? [];
  const forcedRefs: string[] = job.forcedRefs ?? [];

  const durationSec = job.startedAt && job.completedAt
    ? Math.max((new Date(job.completedAt).getTime() - new Date(job.startedAt).getTime()) / 1000, 1)
    : 0;
  const displayProcessed = job.totalRows > 0 ? Math.min(job.processedRows, job.totalRows) : job.processedRows;
  const rowsPerSec = durationSec > 0 ? Math.round(displayProcessed / durationSec) : 0;
  const successfullyImported = job.newSubscribers + job.updatedSubscribers;
  const displayImported = job.totalRows > 0 ? Math.min(successfullyImported, job.totalRows) : successfullyImported;

  return (
    <div className="space-y-3">
      {duration && (
        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          <span>Duration: {duration}</span>
          <span>Rows processed: {displayProcessed.toLocaleString()}</span>
          {rowsPerSec > 0 && <span>{rowsPerSec.toLocaleString()} rows/sec</span>}
        </div>
      )}

      <div className={`grid gap-3 text-sm ${dupCount > 0 ? "grid-cols-2 sm:grid-cols-4" : "grid-cols-3"}`}>
        <div className="p-2.5 rounded bg-green-50 dark:bg-green-950/20 text-center" data-testid="stat-new">
          <p className="text-xs text-muted-foreground mb-0.5">New</p>
          <p className="font-semibold text-green-600" data-testid="text-new-count">
            {job.newSubscribers.toLocaleString()}
          </p>
        </div>
        <div className="p-2.5 rounded bg-blue-50 dark:bg-blue-950/20 text-center" data-testid="stat-updated">
          <p className="text-xs text-muted-foreground mb-0.5">Updated</p>
          <p className="font-semibold text-blue-600" data-testid="text-updated-count">
            {job.updatedSubscribers.toLocaleString()}
          </p>
        </div>
        {dupCount > 0 && (
          <div className="p-2.5 rounded bg-amber-50 dark:bg-amber-950/20 text-center" data-testid="stat-duplicates">
            <p className="text-xs text-muted-foreground mb-0.5">Duplicates in file</p>
            <p className="font-semibold text-amber-600" data-testid="text-duplicates-count">
              {dupCount.toLocaleString()}
            </p>
          </div>
        )}
        <div className={`p-2.5 rounded text-center ${job.failedRows > 0 ? "bg-red-50 dark:bg-red-950/20" : "bg-muted/50"}`} data-testid="stat-failed">
          <p className="text-xs text-muted-foreground mb-0.5">Failed</p>
          <p className={`font-semibold ${job.failedRows > 0 ? "text-red-600" : "text-muted-foreground"}`} data-testid="text-failed-count">
            {job.failedRows.toLocaleString()}
          </p>
        </div>
      </div>

      <div className="text-xs text-muted-foreground bg-muted/50 rounded p-2.5 space-y-1">
        <div className="flex justify-between">
          <span>Total rows in file</span>
          <span className="font-medium">{job.totalRows.toLocaleString()}</span>
        </div>
        <div className="flex justify-between">
          <span>Successfully imported (new + updated)</span>
          <span className="font-medium text-green-700 dark:text-green-400">
            {displayImported.toLocaleString()}
          </span>
        </div>
        {skippedRows > 0 && (
          <div className="flex justify-between">
            <span>Empty/skipped lines</span>
            <span className="font-medium">{skippedRows.toLocaleString()}</span>
          </div>
        )}
        {dupCount > 0 && (
          <div className="flex justify-between text-amber-700 dark:text-amber-400">
            <span>Duplicate emails within file (merged)</span>
            <span className="font-medium">{dupCount.toLocaleString()}</span>
          </div>
        )}
      </div>

      {(forcedTags.length > 0 || forcedRefs.length > 0) && (
        <div className="flex flex-wrap gap-2 text-xs">
          {forcedTags.length > 0 && (
            <div className="flex items-center gap-1.5 bg-muted/60 rounded px-2 py-1">
              <Tag className="h-3 w-3 text-muted-foreground" />
              <span className="text-muted-foreground">Forced tags:</span>
              {forcedTags.map((t) => <Badge key={t} variant="secondary" className="text-xs py-0 h-4">{t}</Badge>)}
            </div>
          )}
          {forcedRefs.length > 0 && (
            <div className="flex items-center gap-1.5 bg-muted/60 rounded px-2 py-1">
              <BookmarkCheck className="h-3 w-3 text-muted-foreground" />
              <span className="text-muted-foreground">Forced refs:</span>
              {forcedRefs.map((r) => <Badge key={r} variant="outline" className="text-xs py-0 h-4">{r}</Badge>)}
            </div>
          )}
        </div>
      )}

      {hasErrors && (
        <details className="text-xs">
          <summary className="cursor-pointer font-medium text-red-700 dark:text-red-400 hover:underline">
            {job.failedRows.toLocaleString()} rows failed — click to see details
          </summary>
          <div className="mt-2 bg-red-50 dark:bg-red-950/30 rounded p-2.5 space-y-1">
            {Object.entries(errorReasons).map(([key, count]) => (
              <div key={key} className="flex justify-between text-red-600 dark:text-red-400">
                <span>{ERROR_LABELS[key] || key}</span>
                <span className="font-medium">{(count as number).toLocaleString()}</span>
              </div>
            ))}
            {sampleFails && Object.keys(sampleFails).length > 0 && (
              <div className="mt-2 pt-2 border-t border-red-200 dark:border-red-800">
                <p className="font-medium mb-1">Sample failing rows:</p>
                {Object.entries(sampleFails).map(([lineKey, content]) => (
                  <p key={lineKey} className="font-mono text-[10px] break-all text-red-500">
                    {lineKey}: {content}
                  </p>
                ))}
              </div>
            )}
          </div>
        </details>
      )}
    </div>
  );
}

function ImportJobCard({ job, onCancel }: { job: ImportJob; onCancel: (id: string) => void }) {
  const { toast } = useToast();

  const forceCompleteMutation = useMutation({
    mutationFn: () => apiRequest("POST", `/api/import/${job.id}/force-complete`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/import-jobs"] });
      toast({ title: "Import marked as completed" });
    },
    onError: () => {
      toast({ title: "Force complete failed", variant: "destructive" });
    },
  });

  const forceDeleteMutation = useMutation({
    mutationFn: () => apiRequest("DELETE", `/api/import/${job.id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/import-jobs"] });
      toast({ title: "Import removed" });
    },
    onError: () => {
      toast({ title: "Force delete failed", variant: "destructive" });
    },
  });

  const handleForceComplete = () => {
    if (window.confirm("Mark this import as completed? Only do this if all rows are already in the database.")) {
      forceCompleteMutation.mutate();
    }
  };

  const handleForceDelete = () => {
    if (window.confirm("Remove this import job? This will not delete any subscribers already imported.")) {
      forceDeleteMutation.mutate();
    }
  };

  const forceRequeueMutation = useMutation({
    mutationFn: () => apiRequest("POST", `/api/import/${job.id}/requeue`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/import-jobs"] });
      toast({ title: "Import requeued", description: "The import will begin processing shortly." });
    },
    onError: (err: unknown) => {
      let msg = err instanceof Error ? err.message : "Could not requeue the import.";
      // apiRequest throws errors like `409: {"error":"csv_file_missing","message":"..."}`.
      // Extract the human-readable `message` field when present.
      const jsonMatch = msg.match(/^\d+:\s*(\{.*\})$/);
      if (jsonMatch) {
        try {
          const body = JSON.parse(jsonMatch[1]);
          if (typeof body?.message === "string") msg = body.message;
          else if (typeof body?.error === "string") msg = body.error;
        } catch {
          /* fall back to raw message */
        }
      }
      toast({ title: "Requeue failed", description: msg, variant: "destructive" });
    },
  });

  const handleForceRequeue = () => {
    if (window.confirm("Re-run this import? The original CSV will be processed again from the beginning.")) {
      forceRequeueMutation.mutate();
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "completed": return <CheckCircle2 className="h-5 w-5 text-green-600" />;
      case "failed": return <XCircle className="h-5 w-5 text-red-600" />;
      case "cancelled": return <Ban className="h-5 w-5 text-muted-foreground" />;
      case "processing": return <Loader2 className="h-5 w-5 text-blue-600 animate-spin" />;
      case "awaiting_confirmation": return <AlertCircle className="h-5 w-5 text-amber-500" />;
      default: return <Clock className="h-5 w-5 text-muted-foreground" />;
    }
  };

  const getStatusBadge = (status: string) => {
    const variants: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
      pending: "outline",
      queued: "outline",
      processing: "default",
      awaiting_confirmation: "outline",
      completed: "secondary",
      failed: "destructive",
      cancelled: "secondary",
    };
    const labels: Record<string, string> = {
      awaiting_confirmation: "awaiting confirmation",
      processing: "importing",
    };
    return <Badge variant={variants[status] || "outline"} data-testid={`badge-status-${job.id}`}>{labels[status] || status}</Badge>;
  };

  const isActive = job.status === "processing" || job.status === "queued" || job.status === "pending";
  const canCancel = isActive;

  return (
    <div className="p-4 rounded-md border bg-card" data-testid={`import-job-${job.id}`}>
      <div className="flex items-start justify-between gap-4 mb-3">
        <div className="flex items-center gap-3">
          {getStatusIcon(job.status)}
          <div>
            <p className="font-medium truncate max-w-[300px]" data-testid={`text-filename-${job.id}`}>
              {job.filename}
            </p>
            <p className="text-sm text-muted-foreground">
              {new Date(job.createdAt).toLocaleString()}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap justify-end">
          {isActive && (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={handleForceComplete}
                disabled={forceCompleteMutation.isPending}
                data-testid={`button-force-complete-${job.id}`}
                className="text-amber-600 border-amber-300 hover:bg-amber-50 dark:hover:bg-amber-950"
              >
                <CheckCircle2 className="h-4 w-4 mr-1" />
                Force Complete
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={handleForceDelete}
                disabled={forceDeleteMutation.isPending}
                data-testid={`button-force-delete-${job.id}`}
                className="text-red-600 border-red-300 hover:bg-red-50 dark:hover:bg-red-950"
              >
                <Trash2 className="h-4 w-4 mr-1" />
                Force Delete
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => onCancel(job.id)}
                data-testid={`button-cancel-import-${job.id}`}
              >
                <Ban className="h-4 w-4 mr-1" />
                Cancel
              </Button>
            </>
          )}
          {(() => {
            const canRequeue = job.status === "queued" || job.status === "failed" || job.status === "cancelled";
            if (!canRequeue) return null;
            const errMsg = (job.errorMessage || "").toLowerCase();
            const fileMissing = errMsg.includes("csv file not found") || errMsg.includes("no longer on the server");
            if (fileMissing) {
              return (
                <Badge
                  variant="outline"
                  className="text-amber-700 border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:text-amber-300"
                  data-testid={`badge-reupload-required-${job.id}`}
                  title="The original CSV file is no longer on the server. Please re-upload it from the Upload tab."
                >
                  <Upload className="h-3 w-3 mr-1" />
                  Re-upload required
                </Badge>
              );
            }
            return (
              <Button
                variant="outline"
                size="sm"
                onClick={handleForceRequeue}
                disabled={forceRequeueMutation.isPending}
                data-testid={`button-requeue-${job.id}`}
                className="text-blue-600 border-blue-300 hover:bg-blue-50 dark:hover:bg-blue-950"
              >
                <RefreshCw className="h-4 w-4 mr-1" />
                Requeue
              </Button>
            );
          })()}
          {getStatusBadge(job.status)}
        </div>
      </div>

      {job.status === "awaiting_confirmation" && (
        <ConfirmationCard job={job} onConfirmed={() => queryClient.invalidateQueries({ queryKey: ["/api/import-jobs"] })} />
      )}

      {isActive && <ActiveJobDisplay job={job} />}

      {job.status === "completed" && <CompletedJobDisplay job={job} />}

      {job.status === "failed" && job.errorMessage && (
        <p className="text-sm text-destructive" data-testid={`text-error-${job.id}`}>{job.errorMessage}</p>
      )}
    </div>
  );
}

export default function Import() {
  const [isDragging, setIsDragging] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [tagMode, setTagMode] = useState<"merge" | "override">("merge");
  const [removeMode, setRemoveMode] = useState(false);
  const [forcedTagsInput, setForcedTagsInput] = useState("");
  const [forcedRefsInput, setForcedRefsInput] = useState("");
  const [uploadProgress, setUploadProgress] = useState<number>(0);
  const [isChunkedUpload, setIsChunkedUpload] = useState(false);
  const { toast } = useToast();

  useJobStream();

  const { data: queueHealth } = useQuery<{ pendingCount: number; oldestPendingAgeSeconds: number | null }>({
    queryKey: ["/api/import/queue-health"],
    refetchInterval: (query) => {
      const d = query.state.data as { pendingCount: number } | undefined;
      return d?.pendingCount ? 15000 : 60000;
    },
  });

  const { data: jobs, isLoading, refetch } = useQuery<ImportJob[]>({
    queryKey: ["/api/import-jobs"],
    refetchInterval: (query) => {
      const data = query.state.data as ImportJob[] | undefined;
      const hasProcessing = data?.some((j) => j.status === "processing");
      const hasWaiting = data?.some((j) => j.status === "queued" || j.status === "pending" || j.status === "awaiting_confirmation");
      if (hasProcessing) {
        return isSSEConnected() ? false : 3000;
      }
      if (hasWaiting) {
        return 10000;
      }
      return false;
    },
    structuralSharing: (oldData, newData) => {
      if (!oldData || !Array.isArray(oldData) || !Array.isArray(newData)) return newData;
      const oldJobs = oldData as ImportJob[];
      const newJobs = newData as ImportJob[];
      const oldMap = new Map(oldJobs.map(j => [j.id, j]));
      return newJobs.map(newJob => {
        const oldJob = oldMap.get(newJob.id);
        if (!oldJob || newJob.status === "completed" || newJob.status === "failed") return newJob;
        if (newJob.status !== "completed" && newJob.status !== "failed") {
          return {
            ...newJob,
            processedRows: Math.max(newJob.processedRows, oldJob.processedRows || 0),
            newSubscribers: Math.max(newJob.newSubscribers, oldJob.newSubscribers || 0),
            updatedSubscribers: Math.max(newJob.updatedSubscribers, oldJob.updatedSubscribers || 0),
            failedRows: Math.max(newJob.failedRows, oldJob.failedRows || 0),
          };
        }
        return newJob;
      });
    },
  });

  const uploadMutation = useMutation({
    mutationFn: async ({ file, tagMode, forcedTags, forcedRefs, removeMode }: { file: File; tagMode: "merge" | "override"; forcedTags: string; forcedRefs: string; removeMode: boolean }) => {
      const MAX_FILE_SIZE = 1024 * 1024 * 1024;
      const CHUNK_SIZE = 25 * 1024 * 1024;
      const USE_CHUNKED_THRESHOLD = 25 * 1024 * 1024;

      if (file.size > MAX_FILE_SIZE) {
        throw new Error(`File too large. Maximum size is 1GB, your file is ${(file.size / (1024 * 1024)).toFixed(0)}MB.`);
      }

      if (file.size > USE_CHUNKED_THRESHOLD) {
        setIsChunkedUpload(true);
        setUploadProgress(0);

        const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
        const csrfToken = await fetchCsrfToken();
        const startResponse = await fetch("/api/import/chunked/start", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-csrf-token": csrfToken },
          body: JSON.stringify({
            filename: file.name,
            tagMode,
            totalChunks,
            totalSize: file.size,
            forcedTags: forcedTags || undefined,
            forcedRefs: forcedRefs || undefined,
            removeMode: removeMode || undefined,
          }),
        });

        if (!startResponse.ok) {
          const errorData = await startResponse.json().catch(() => null);
          throw new Error(errorData?.error || "Failed to start chunked upload");
        }

        const { uploadId } = await startResponse.json();

        for (let i = 0; i < totalChunks; i++) {
          const start = i * CHUNK_SIZE;
          const end = Math.min(start + CHUNK_SIZE, file.size);
          const chunk = file.slice(start, end);

          const chunkFormData = new FormData();
          chunkFormData.append("chunk", chunk, `chunk_${i}`);

          const chunkResponse = await fetch(`/api/import/chunked/${uploadId}/chunk/${i}`, {
            method: "POST",
            headers: { "x-csrf-token": csrfToken },
            body: chunkFormData,
          });

          if (!chunkResponse.ok) {
            const errorData = await chunkResponse.json().catch(() => null);
            throw new Error(errorData?.error || `Failed to upload chunk ${i + 1}/${totalChunks}`);
          }

          setUploadProgress(Math.round(((i + 1) / totalChunks) * 100));
        }

        const completeResponse = await fetch(`/api/import/chunked/${uploadId}/complete`, {
          method: "POST",
          headers: { "x-csrf-token": csrfToken },
        });

        if (!completeResponse.ok) {
          const errorData = await completeResponse.json().catch(() => null);
          throw new Error(errorData?.error || "Failed to complete chunked upload");
        }

        setIsChunkedUpload(false);
        return completeResponse.json();
      }

      const formData = new FormData();
      formData.append("file", file);
      formData.append("tagMode", tagMode);
      if (forcedTags) formData.append("forcedTags", forcedTags);
      if (forcedRefs) formData.append("forcedRefs", forcedRefs);
      if (removeMode) formData.append("removeMode", "true");
      const importCsrfToken = await fetchCsrfToken();
      const response = await fetch("/api/import", {
        method: "POST",
        headers: { "x-csrf-token": importCsrfToken },
        body: formData,
      });
      if (!response.ok) {
        const errorData = await response.json().catch(() => null);
        const errorMessage = errorData?.message || errorData?.error || `Upload failed (${response.status})`;
        throw new Error(errorMessage);
      }
      return response.json();
    },
    onSuccess: (data: any) => {
      if (data?.importJob) {
        queryClient.setQueryData<ImportJob[]>(["/api/import-jobs"], (old) => {
          if (!old) return [data.importJob];
          const exists = old.some((j: ImportJob) => j.id === data.importJob.id);
          if (exists) return old;
          return [data.importJob, ...old];
        });
      } else {
        queryClient.invalidateQueries({ queryKey: ["/api/import-jobs"] });
      }
      queryClient.invalidateQueries({ queryKey: ["/api/subscribers"] });
      setSelectedFile(null);
      setUploadProgress(0);
      setIsChunkedUpload(false);
      setForcedTagsInput("");
      setForcedRefsInput("");
      setRemoveMode(false);
      toast({
        title: removeMode ? "Removal started" : "Import started",
        description: removeMode
          ? "Your CSV is being processed. Matching tags and refs will be removed from existing subscribers."
          : "Your CSV is being processed. If refs are detected, you will be asked to confirm before merging.",
      });
    },
    onError: (error: Error) => {
      setUploadProgress(0);
      setIsChunkedUpload(false);
      toast({
        title: "Import failed",
        description: error.message || "Failed to upload file. Please try again.",
        variant: "destructive",
      });
    },
  });

  const cancelMutation = useMutation({
    mutationFn: async (jobId: string) => {
      const response = await apiRequest("POST", `/api/import/${jobId}/cancel`);
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/import-jobs"] });
      toast({ title: "Import cancelled", description: "The import job has been cancelled." });
    },
    onError: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/import-jobs"] });
      toast({ title: "Cancel failed", description: "Could not cancel the import. It may have already completed.", variant: "destructive" });
    },
  });

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file && file.type === "text/csv") {
      setSelectedFile(file);
    } else {
      toast({
        title: "Invalid file",
        description: "Please upload a CSV file.",
        variant: "destructive",
      });
    }
  }, [toast]);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) setSelectedFile(file);
  };

  const handleUpload = () => {
    if (selectedFile) uploadMutation.mutate({ file: selectedFile, tagMode, forcedTags: forcedTagsInput, forcedRefs: forcedRefsInput, removeMode });
  };

  return (
    <div className="p-6 lg:p-8 space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Import Subscribers</h1>
        <p className="text-muted-foreground">
          Upload a CSV file to import subscribers with tags and segment refs
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Upload className="h-5 w-5" />
            Upload CSV
          </CardTitle>
          <CardDescription>
            Unified import: tags, refs, and IP addresses in one CSV. Refs column is optional.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div
            className={`border-2 border-dashed rounded-lg p-8 text-center transition-colors ${
              isDragging
                ? "border-primary bg-primary/5"
                : "border-muted-foreground/25 hover:border-primary/50"
            }`}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            <FileUp className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
            <p className="text-lg font-medium mb-2">
              {selectedFile ? selectedFile.name : "Drop your CSV file here"}
            </p>
            <p className="text-sm text-muted-foreground mb-4">
              {selectedFile
                ? `${(selectedFile.size / 1024).toFixed(1)} KB`
                : "or click to browse"}
            </p>
            <input
              type="file"
              accept=".csv"
              onChange={handleFileSelect}
              className="hidden"
              id="csv-upload"
              data-testid="input-file-upload"
            />
            <label htmlFor="csv-upload">
              <Button variant="outline" asChild>
                <span>Browse Files</span>
              </Button>
            </label>
          </div>

          {selectedFile && (
            <div className="space-y-4">
              <div className="rounded-md border p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <h4 className="font-medium flex items-center gap-2">
                      <Trash2 className="h-4 w-4 text-red-500" />
                      Remove Tags/Refs Mode
                    </h4>
                    <p className="text-xs text-muted-foreground">
                      Strip specific tags and refs from matching subscribers without creating new ones
                    </p>
                  </div>
                  <Switch
                    checked={removeMode}
                    onCheckedChange={setRemoveMode}
                    data-testid="switch-remove-mode"
                  />
                </div>
                {removeMode && (
                  <div className="flex items-start gap-2 rounded bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-800 px-3 py-2 text-xs text-red-800 dark:text-red-300" data-testid="note-remove-mode">
                    <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                    <span>
                      <strong>Remove mode active.</strong> Tags and refs from the CSV (or forced values below) will be removed from existing subscribers. No new subscribers will be created.
                    </span>
                  </div>
                )}
              </div>

              {!removeMode && (
                <div className="rounded-md border p-4">
                  <h4 className="font-medium mb-3">Tag handling for existing emails</h4>
                  <RadioGroup
                    value={tagMode}
                    onValueChange={(value) => setTagMode(value as "merge" | "override")}
                    className="space-y-2"
                  >
                    <div className="flex items-center space-x-2">
                      <RadioGroupItem value="merge" id="merge" data-testid="radio-tag-merge" />
                      <Label htmlFor="merge" className="font-normal cursor-pointer">
                        Merge tags - Add new tags to existing ones
                      </Label>
                    </div>
                    <div className="flex items-center space-x-2">
                      <RadioGroupItem value="override" id="override" data-testid="radio-tag-override" />
                      <Label htmlFor="override" className="font-normal cursor-pointer">
                        Override tags - Replace all existing tags with new ones
                      </Label>
                    </div>
                  </RadioGroup>
                  <p className="text-xs text-muted-foreground mt-2">
                    This applies to the tags column only. Refs are always merged (never overridden).
                  </p>
                </div>
              )}

              <div className="rounded-md border p-4 space-y-3">
                <h4 className="font-medium mb-1">{removeMode ? "Tags & refs to remove (optional)" : "Tags & refs to apply (optional)"}</h4>
                <div className="space-y-1.5">
                  <Label htmlFor="forced-tags" className="text-sm flex items-center gap-1.5">
                    <Tag className="h-3.5 w-3.5" />
                    {removeMode ? "Tags to remove" : "Tags to apply"}
                  </Label>
                  <Input
                    id="forced-tags"
                    placeholder={removeMode ? "e.g. WRONG_TAG, ACCIDENTAL" : "e.g. NEWSLETTER, VIP"}
                    value={forcedTagsInput}
                    onChange={(e) => setForcedTagsInput(e.target.value)}
                    data-testid="input-forced-tags"
                  />
                  <p className="text-xs text-muted-foreground">
                    {removeMode
                      ? "Comma-separated. These tags will be removed from every matching subscriber."
                      : "Comma-separated. When set, overrides the tags column for every imported row."}
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="forced-refs" className="text-sm flex items-center gap-1.5">
                    <BookmarkCheck className="h-3.5 w-3.5" />
                    {removeMode ? "Refs to remove" : "Refs to apply"}
                  </Label>
                  <Input
                    id="forced-refs"
                    placeholder={removeMode ? "e.g. WRONG-REF, BAD-SEGMENT" : "e.g. SEGMENT-A, CAMPAIGN-X"}
                    value={forcedRefsInput}
                    onChange={(e) => setForcedRefsInput(e.target.value)}
                    data-testid="input-forced-refs"
                  />
                  <p className="text-xs text-muted-foreground">
                    {removeMode
                      ? "Comma-separated. These refs will be removed from every matching subscriber."
                      : "Comma-separated. When set, overrides the refs column for every imported row."}
                  </p>
                </div>
                {!removeMode && (forcedTagsInput.trim() || forcedRefsInput.trim()) && (
                  <div className="flex items-start gap-2 rounded bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800 px-3 py-2 text-xs text-amber-800 dark:text-amber-300" data-testid="note-force-mode">
                    <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                    <span>
                      <strong>Email-only mode active.</strong> Only the email column from your CSV will be used — tags and refs columns will be ignored entirely. All subscribers will receive the forced values above.
                    </span>
                  </div>
                )}
              </div>

              {isChunkedUpload && uploadMutation.isPending && (
                <div className="space-y-2">
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Uploading large file in chunks...</span>
                    <span className="font-medium">{uploadProgress}%</span>
                  </div>
                  <Progress value={uploadProgress} className="h-2" />
                  <p className="text-xs text-muted-foreground">
                    Large files ({(selectedFile?.size || 0) > 25 * 1024 * 1024 ? `${Math.round((selectedFile?.size || 0) / (1024 * 1024))}MB` : ''}) are uploaded in 25MB chunks.
                  </p>
                </div>
              )}
              <div className="flex gap-2">
                <Button
                  onClick={handleUpload}
                  disabled={uploadMutation.isPending}
                  variant={removeMode ? "destructive" : "default"}
                  className="flex-1"
                  data-testid="button-start-import"
                >
                  {uploadMutation.isPending ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      {isChunkedUpload ? `Uploading... ${uploadProgress}%` : "Uploading..."}
                    </>
                  ) : removeMode ? (
                    <>
                      <Trash2 className="h-4 w-4 mr-2" />
                      Start Removal
                    </>
                  ) : (
                    <>
                      <Upload className="h-4 w-4 mr-2" />
                      Start Import
                    </>
                  )}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => { setSelectedFile(null); setForcedTagsInput(""); setForcedRefsInput(""); setRemoveMode(false); }}
                  data-testid="button-clear-file"
                >
                  Clear
                </Button>
              </div>
            </div>
          )}

          <div className="rounded-md bg-muted/50 p-4">
            <h4 className="font-medium mb-2 flex items-center gap-2">
              <AlertCircle className="h-4 w-4" />
              Unified CSV Format
            </h4>
            <pre className="text-xs font-mono text-muted-foreground overflow-x-auto whitespace-pre">
{`email;tags;refs;ip_address
john@example.com;VIP,SOLDES,PROMO;2AG,3CB,5DF;192.168.1.1
jane@example.com;NEWSLETTER;;192.168.1.2
bob@example.com;;1AA,2AG;
alice@example.com;VIP;;;`}
            </pre>
            <div className="text-xs text-muted-foreground mt-2 space-y-1.5">
              <p><strong>Separator:</strong> columns separated by semicolons (<code className="bg-muted px-1 rounded">;</code>). Only the <strong>email</strong> column is required.</p>
              <p><strong>Header row:</strong> auto-detected and skipped. Include <code className="bg-muted px-1 rounded">email;tags;refs;ip_address</code> as the first line.</p>
              <p><strong>tags:</strong> comma-separated, stored UPPERCASE (e.g. <code className="bg-muted px-1 rounded">VIP,PROMO</code>). Tag mode (merge/override) applies to tags only.</p>
              <p><strong>refs:</strong> comma-separated, stored UPPERCASE (e.g. <code className="bg-muted px-1 rounded">2AG,3CB</code>). Refs always merge. If the refs column is present, a two-phase confirmation flow is triggered before importing.</p>
              <p><strong>ip_address:</strong> optional IP address for the subscriber.</p>
              <p><strong>File size:</strong> up to 1 GB supported with chunked uploads.</p>
              <p className="text-amber-600 dark:text-amber-400 font-medium mt-1">Import continues in the background even if you navigate away or get disconnected.</p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-4">
          <div>
            <CardTitle>Import History</CardTitle>
            <CardDescription>View the status of your import jobs</CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={() => refetch()} data-testid="button-refresh-jobs">
            <RefreshCw className="h-4 w-4 mr-2" />
            Refresh
          </Button>
        </CardHeader>
        <CardContent>
          {queueHealth &&
            queueHealth.pendingCount > 0 &&
            queueHealth.oldestPendingAgeSeconds !== null &&
            queueHealth.oldestPendingAgeSeconds > 90 && (
              <div
                className="flex items-start gap-3 rounded-md border border-amber-400/60 bg-amber-50 dark:bg-amber-950/20 px-4 py-3 text-sm text-amber-800 dark:text-amber-300 mb-4"
                data-testid="banner-worker-offline"
              >
                <TriangleAlert className="h-4 w-4 mt-0.5 shrink-0 text-amber-500" />
                <span>
                  <strong>Import worker may be temporarily offline.</strong> The system will automatically retry and process your import — no action needed. If this persists beyond a few minutes, you can click <strong>Requeue</strong> to trigger an immediate retry.
                </span>
              </div>
            )}
          {isLoading ? (
            <div className="space-y-4">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-24 w-full" />
              ))}
            </div>
          ) : jobs && jobs.length > 0 ? (
            <div className="space-y-4">
              {jobs.map((job) => (
                <ImportJobCard
                  key={job.id}
                  job={job}
                  onCancel={(id) => cancelMutation.mutate(id)}
                />
              ))}
            </div>
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              <Upload className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p>No import jobs yet</p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
