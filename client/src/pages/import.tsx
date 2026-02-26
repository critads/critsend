import { useState, useCallback, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest, fetchCsrfToken } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
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
  Tag,
  Hash,
} from "lucide-react";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import type { ImportJob } from "@shared/schema";

function ConfirmationCard({ job, onConfirmed }: { job: ImportJob; onConfirmed: () => void }) {
  const [cleanExisting, setCleanExisting] = useState(false);
  const { toast } = useToast();

  const { data: affectedData, isLoading: affectedLoading } = useQuery<{ affectedSubscribers: number }>({
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
      });
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/import-jobs"] });
      toast({ title: "Import confirmed", description: "Refs merge is now processing." });
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

  return (
    <div className="rounded-md border border-amber-500/50 bg-amber-50/50 dark:bg-amber-950/20 p-4 space-y-4">
      <div className="flex items-center gap-2 text-amber-700 dark:text-amber-400">
        <AlertCircle className="h-5 w-5" />
        <span className="font-medium">Awaiting Confirmation</span>
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

      <div className="flex items-start space-x-2">
        <Checkbox
          id={`clean-${job.id}`}
          checked={cleanExisting}
          onCheckedChange={(checked) => setCleanExisting(checked === true)}
          data-testid="checkbox-clean-refs"
        />
        <div className="grid gap-1.5 leading-none">
          <Label htmlFor={`clean-${job.id}`} className="cursor-pointer font-normal text-sm">
            Remove these refs from existing subscribers before importing
          </Label>
          <p className="text-xs text-muted-foreground">
            Affected subscribers:{" "}
            {affectedLoading ? (
              <span className="text-amber-600">Calculating...</span>
            ) : (
              <span className="font-medium">{(affectedData?.affectedSubscribers ?? 0).toLocaleString()}</span>
            )}
          </p>
        </div>
      </div>

      <div className="flex gap-2">
        <Button
          onClick={() => confirmMutation.mutate()}
          disabled={confirmMutation.isPending}
          data-testid="button-confirm-import"
        >
          {confirmMutation.isPending ? (
            <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Confirming...</>
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

export default function Import() {
  const [isDragging, setIsDragging] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [tagMode, setTagMode] = useState<"merge" | "override">("merge");
  const [importTarget, setImportTarget] = useState<"refs" | "tags">("refs");
  const [uploadProgress, setUploadProgress] = useState<number>(0);
  const [isChunkedUpload, setIsChunkedUpload] = useState(false);
  const { toast } = useToast();

  const { data: jobs, isLoading, refetch } = useQuery<ImportJob[]>({
    queryKey: ["/api/import-jobs"],
    refetchInterval: (query) => {
      const data = query.state.data as ImportJob[] | undefined;
      if (data?.some((j) => j.status === "processing" || j.status === "queued" || j.status === "awaiting_confirmation")) {
        return 2000;
      }
      return false;
    },
  });

  const uploadMutation = useMutation({
    mutationFn: async ({ file, tagMode, importTarget }: { file: File; tagMode: "merge" | "override"; importTarget: "refs" | "tags" }) => {
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
            importTarget,
            totalChunks,
            totalSize: file.size,
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
          
          const progress = Math.round(((i + 1) / totalChunks) * 100);
          setUploadProgress(progress);
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
      formData.append("importTarget", importTarget);
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
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/import-jobs"] });
      queryClient.invalidateQueries({ queryKey: ["/api/subscribers"] });
      setSelectedFile(null);
      setUploadProgress(0);
      setIsChunkedUpload(false);
      toast({
        title: "Import started",
        description: importTarget === "refs"
          ? "Your CSV is being staged. You will be asked to confirm before merging."
          : "Your CSV is being processed in the background.",
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
      toast({
        title: "Import cancelled",
        description: "The import job has been cancelled.",
      });
    },
    onError: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/import-jobs"] });
      toast({
        title: "Cancel failed",
        description: "Could not cancel the import. It may have already completed.",
        variant: "destructive",
      });
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
    if (file) {
      setSelectedFile(file);
    }
  };

  const handleUpload = () => {
    if (selectedFile) {
      uploadMutation.mutate({ file: selectedFile, tagMode, importTarget });
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "completed":
        return <CheckCircle2 className="h-5 w-5 text-green-600" />;
      case "failed":
        return <XCircle className="h-5 w-5 text-red-600" />;
      case "cancelled":
        return <Ban className="h-5 w-5 text-muted-foreground" />;
      case "processing":
        return <Loader2 className="h-5 w-5 text-blue-600 animate-spin" />;
      case "awaiting_confirmation":
        return <AlertCircle className="h-5 w-5 text-amber-500" />;
      default:
        return <Clock className="h-5 w-5 text-muted-foreground" />;
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
    };
    return <Badge variant={variants[status] || "outline"}>{labels[status] || status}</Badge>;
  };

  return (
    <div className="p-6 lg:p-8 space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Import Subscribers</h1>
        <p className="text-muted-foreground">
          Upload a CSV file to import subscribers with their tags or segment refs
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Upload className="h-5 w-5" />
            Upload CSV
          </CardTitle>
          <CardDescription>
            CSV should have columns: email, tags (semicolon-separated), ip_address (optional)
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
              <div className="rounded-md border p-4">
                <h4 className="font-medium mb-3">Import type</h4>
                <RadioGroup
                  value={importTarget}
                  onValueChange={(value) => setImportTarget(value as "refs" | "tags")}
                  className="space-y-2"
                >
                  <div className="flex items-start space-x-2">
                    <RadioGroupItem value="refs" id="target-refs" data-testid="radio-target-refs" />
                    <div>
                      <Label htmlFor="target-refs" className="font-normal cursor-pointer">
                        <span className="flex items-center gap-1.5">
                          <Hash className="h-3.5 w-3.5" />
                          Segment Import (refs)
                        </span>
                      </Label>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        Tags column is parsed as ref codes separated by dashes (e.g. 2ag-3cb-5df). System tags (BCK, bounce) are never touched. You will confirm before merging.
                      </p>
                    </div>
                  </div>
                  <div className="flex items-start space-x-2">
                    <RadioGroupItem value="tags" id="target-tags" data-testid="radio-target-tags" />
                    <div>
                      <Label htmlFor="target-tags" className="font-normal cursor-pointer">
                        <span className="flex items-center gap-1.5">
                          <Tag className="h-3.5 w-3.5" />
                          Tag Import (tags)
                        </span>
                      </Label>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        Tags column is parsed as system tags separated by commas (e.g. VIP,PROMO). Processes immediately.
                      </p>
                    </div>
                  </div>
                </RadioGroup>
              </div>

              {importTarget === "tags" && (
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
                </div>
              )}

              {isChunkedUpload && uploadMutation.isPending && (
                <div className="space-y-2">
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Uploading large file in chunks...</span>
                    <span className="font-medium">{uploadProgress}%</span>
                  </div>
                  <Progress value={uploadProgress} className="h-2" />
                  <p className="text-xs text-muted-foreground">
                    Large files ({(selectedFile?.size || 0) > 25 * 1024 * 1024 ? `${Math.round((selectedFile?.size || 0) / (1024 * 1024))}MB` : ''}) are uploaded in 25MB chunks to ensure reliable delivery.
                  </p>
                </div>
              )}
              <div className="flex gap-2">
                <Button
                  onClick={handleUpload}
                  disabled={uploadMutation.isPending}
                  className="flex-1"
                  data-testid="button-start-import"
                >
                  {uploadMutation.isPending ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      {isChunkedUpload ? `Uploading... ${uploadProgress}%` : "Uploading..."}
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
                  onClick={() => setSelectedFile(null)}
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
              CSV Format
            </h4>
            {importTarget === "refs" ? (
              <>
                <pre className="text-xs font-mono text-muted-foreground overflow-x-auto">
{`email;tags;ip_address
john@example.com;2ag-3cb-5df;192.168.1.1
jane@example.com;1aa-2ag;192.168.1.2`}
                </pre>
                <p className="text-xs text-muted-foreground mt-2">
                  Columns are separated by semicolons (;). Ref codes in the tags column are separated by dashes (-) and stored as refs.
                  System tags (BCK, bounce, unsub) are never affected.
                </p>
              </>
            ) : (
              <>
                <pre className="text-xs font-mono text-muted-foreground overflow-x-auto">
{`email;tags;ip_address
john@example.com;VIP,SOLDES,PROMO;192.168.1.1
jane@example.com;NEWSLETTER;192.168.1.2`}
                </pre>
                <p className="text-xs text-muted-foreground mt-2">
                  Columns are separated by semicolons (;). Tags are separated by commas (,) and automatically converted to uppercase.
                  Imports are processed in batches of 5,000 rows.
                </p>
              </>
            )}
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
          {isLoading ? (
            <div className="space-y-4">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-24 w-full" />
              ))}
            </div>
          ) : jobs && jobs.length > 0 ? (
            <div className="space-y-4">
              {jobs.map((job) => (
                <div
                  key={job.id}
                  className="p-4 rounded-md border bg-card"
                  data-testid={`import-job-${job.id}`}
                >
                  <div className="flex items-start justify-between gap-4 mb-3">
                    <div className="flex items-center gap-3">
                      {getStatusIcon(job.status)}
                      <div>
                        <p className="font-medium truncate max-w-[300px]">
                          {job.filename}
                          {job.importTarget && (
                            <Badge variant="outline" className="ml-2 text-xs">
                              {job.importTarget === "refs" ? "refs" : "tags"}
                            </Badge>
                          )}
                        </p>
                        <p className="text-sm text-muted-foreground">
                          {new Date(job.createdAt).toLocaleString()}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {(job.status === "pending" || job.status === "processing" || job.status === "queued") && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => cancelMutation.mutate(job.id)}
                          disabled={cancelMutation.isPending}
                          data-testid={`button-cancel-import-${job.id}`}
                        >
                          <Ban className="h-4 w-4 mr-1" />
                          Cancel
                        </Button>
                      )}
                      {getStatusBadge(job.status)}
                    </div>
                  </div>

                  {job.status === "awaiting_confirmation" && (
                    <ConfirmationCard job={job} onConfirmed={() => refetch()} />
                  )}

                  {(job.status === "processing" || job.status === "queued") && (
                    <div className="space-y-2">
                      <Progress
                        value={job.totalRows > 0 ? Math.min((job.processedRows / job.totalRows) * 100, 100) : 0}
                        className="h-2"
                      />
                      <div className="flex justify-between text-xs text-muted-foreground">
                        <span>
                          {Math.min(job.processedRows, job.totalRows).toLocaleString()} / {job.totalRows.toLocaleString()} rows
                        </span>
                        <span>
                          {job.status === "queued" && job.processedRows === 0
                            ? "Waiting to start..."
                            : `${(job.totalRows > 0 ? Math.min((job.processedRows / job.totalRows) * 100, 100) : 0).toFixed(1)}%`}
                        </span>
                      </div>
                      {job.processedRows > 0 && (() => {
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
                        
                        return (
                          <div className="flex justify-between text-xs text-muted-foreground mt-1">
                            <span className="text-green-600 font-medium">
                              {Math.round(rowsPerSec * 60).toLocaleString()} rows/min
                            </span>
                            <span>
                              ETA: {remainingRows === 0 ? "finishing..." : etaHours > 0 ? `${etaHours}h ${etaMinRemainder}m` : `${etaMin}m`}
                            </span>
                          </div>
                        );
                      })()}
                    </div>
                  )}

                  {job.status === "completed" && (
                    <div className="grid grid-cols-3 gap-4 text-sm">
                      <div>
                        <p className="text-muted-foreground">New</p>
                        <p className="font-medium text-green-600">
                          +{job.newSubscribers.toLocaleString()}
                        </p>
                      </div>
                      <div>
                        <p className="text-muted-foreground">Updated</p>
                        <p className="font-medium text-blue-600">
                          {job.updatedSubscribers.toLocaleString()}
                        </p>
                      </div>
                      <div>
                        <p className="text-muted-foreground">Failed</p>
                        <p className={`font-medium ${job.failedRows > 0 ? "text-red-600" : "text-muted-foreground"}`}>
                          {job.failedRows.toLocaleString()}
                        </p>
                      </div>
                    </div>
                  )}

                  {job.status === "failed" && job.errorMessage && (
                    <p className="text-sm text-destructive">{job.errorMessage}</p>
                  )}
                </div>
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
