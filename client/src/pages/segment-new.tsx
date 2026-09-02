import { type ChangeEvent, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest, fetchCsrfToken, queryClient } from "@/lib/queryClient";
import { useLocation, Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { ArrowLeft, CheckCircle2, FileText, Filter, Loader2, Upload, Users, X } from "lucide-react";
import type { Subscriber, SegmentRulesV2, SegmentGroup } from "@shared/schema";
import {
  GroupBuilder,
  defaultRootGroup,
  hasValidCondition,
} from "@/components/segment-builder";

interface PreviewResult {
  count: number;
  sample: Subscriber[];
}

interface ExclusionSummary {
  hashCount: number;
  matchedCount: number;
  finalCount: number;
}

const MAX_EXCLUSION_FILE_BYTES = 100 * 1024 * 1024;

export default function SegmentNew() {
  const [, navigate] = useLocation();
  const { toast } = useToast();

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [rootGroup, setRootGroup] = useState<SegmentGroup>(defaultRootGroup());
  const [previewResult, setPreviewResult] = useState<PreviewResult | null>(null);
  const [isCountLoading, setIsCountLoading] = useState(false);
  const [exclusionFile, setExclusionFile] = useState<File | null>(null);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [exclusionSummary, setExclusionSummary] = useState<ExclusionSummary | null>(null);
  const exclusionInputRef = useRef<HTMLInputElement>(null);

  const createMutation = useMutation({
    mutationFn: async ({
      data,
      file,
    }: {
      data: { name: string; description: string; rules: SegmentRulesV2 };
      file: File | null;
    }) => {
      if (!file) return apiRequest("POST", "/api/segments", data);

      const csrfToken = await fetchCsrfToken();
      return new Promise<Response>((resolve, reject) => {
        const request = new XMLHttpRequest();
        request.open("POST", "/api/segments/with-exclusions");
        request.withCredentials = true;
        request.setRequestHeader("x-csrf-token", csrfToken);
        request.upload.onprogress = (event) => {
          if (event.lengthComputable) {
            setUploadProgress(Math.round((event.loaded / event.total) * 100));
          }
        };
        request.onerror = () => reject(new Error("The exclusion file upload failed."));
        request.onload = async () => {
          const response = new Response(request.responseText, {
            status: request.status,
            statusText: request.statusText,
            headers: { "Content-Type": request.getResponseHeader("Content-Type") || "application/json" },
          });
          if (request.status >= 200 && request.status < 300) resolve(response);
          else {
            const body = await response.clone().json().catch(() => null);
            reject(new Error(
              typeof body?.error === "string"
                ? body.error
                : "The segment could not be created with this exclusion file.",
            ));
          }
        };
        const formData = new FormData();
        formData.append("data", JSON.stringify(data));
        formData.append("exclusionFile", file);
        request.send(formData);
      });
    },
    onSuccess: async (response, variables) => {
      queryClient.invalidateQueries({ queryKey: ["/api/segments"] });
      queryClient.invalidateQueries({ queryKey: ["/api/segments/counts"] });
      const result = await response.json().catch(() => null);
      const summary = result?.exclusionSummary;
      setUploadProgress(null);
      if (variables.file && summary && [summary.hashCount, summary.matchedCount, summary.finalCount].every((value) => typeof value === "number")) {
        setExclusionSummary(summary);
        toast({
          title: "Segment created with exclusions",
          description: `${summary.finalCount.toLocaleString()} subscribers remain in this segment.`,
        });
        return;
      }
      toast({
        title: "Segment created",
        description: "Your new segment has been created successfully.",
      });
      navigate("/segments");
    },
    onError: (error: Error) => {
      setUploadProgress(null);
      toast({
        title: "Error",
        description: error.message || "Failed to create segment. Please try again.",
        variant: "destructive",
      });
    },
  });

  const handleExclusionFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".csv")) {
      toast({ title: "CSV required", description: "Select a .csv file of SHA-256 hashes.", variant: "destructive" });
      event.target.value = "";
      return;
    }
    if (file.size === 0 || file.size > MAX_EXCLUSION_FILE_BYTES) {
      toast({
        title: "File size not supported",
        description: "Choose a CSV between 1 byte and 100 MB.",
        variant: "destructive",
      });
      event.target.value = "";
      return;
    }
    setExclusionSummary(null);
    setExclusionFile(file);
  };

  const removeExclusionFile = () => {
    setExclusionFile(null);
    setUploadProgress(null);
    if (exclusionInputRef.current) exclusionInputRef.current.value = "";
  };

  const handleSubmit = () => {
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
    setUploadProgress(exclusionFile ? 0 : null);
    createMutation.mutate({
      data: {
        name: name.trim(),
        description: description.trim(),
        rules: { version: 2 as const, root: rootGroup } as SegmentRulesV2,
      },
      file: exclusionFile,
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
      let res: Response;
      if (exclusionFile) {
        const csrfToken = await fetchCsrfToken();
        const formData = new FormData();
        formData.append("rules", JSON.stringify({
          version: 2,
          root: rootGroup,
        } satisfies SegmentRulesV2));
        formData.append("exclusionFile", exclusionFile);
        res = await fetch("/api/segments/preview-count", {
          method: "POST",
          credentials: "include",
          headers: { "x-csrf-token": csrfToken },
          body: formData,
        });
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(typeof body?.error === "string" ? body.error : "Failed to preview.");
        }
      } else {
        res = await apiRequest("POST", "/api/segments/preview-count", {
          rules: { version: 2, root: rootGroup } as SegmentRulesV2,
        });
      }
      const data = await res.json();
      setPreviewResult(data);
    } catch (error) {
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to preview. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsCountLoading(false);
    }
  };

  return (
    <div className="p-6 lg:p-8 space-y-6">
      {exclusionSummary && (
        <Card className="border-primary/30 bg-primary/5" data-testid="exclusion-import-summary">
          <CardContent className="flex flex-col gap-4 py-5 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex gap-3">
              <CheckCircle2 className="mt-0.5 h-5 w-5 text-primary" />
              <div>
                <p className="font-semibold">Segment created with exclusions</p>
                <p className="text-sm text-muted-foreground">Your audience is ready to review.</p>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-4 text-center text-sm">
              <div><p className="font-semibold">{exclusionSummary.hashCount.toLocaleString()}</p><p className="text-muted-foreground">hashes imported</p></div>
              <div><p className="font-semibold">{exclusionSummary.matchedCount.toLocaleString()}</p><p className="text-muted-foreground">matched exclusions</p></div>
              <div><p className="font-semibold">{exclusionSummary.finalCount.toLocaleString()}</p><p className="text-muted-foreground">final segment</p></div>
            </div>
            <Button onClick={() => navigate("/segments")} data-testid="button-view-created-segment">View segments</Button>
          </CardContent>
        </Card>
      )}
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" asChild data-testid="button-back-segments">
          <Link href="/segments">
            <ArrowLeft className="h-5 w-5" />
          </Link>
        </Button>
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Create Segment</h1>
          <p className="text-muted-foreground">
            Define rules to group subscribers based on tags, email, date, or IP
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <div className="xl:col-span-2 space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Segment Details</CardTitle>
              <CardDescription>Give your segment a name and optional description</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="segment-name">Segment Name *</Label>
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
              <div className="rounded-lg border border-dashed bg-muted/30 p-4 space-y-3">
                <div className="flex items-start gap-3">
                  <div className="rounded-md bg-background p-2"><FileText className="h-4 w-4 text-primary" /></div>
                  <div className="space-y-1">
                    <Label htmlFor="segment-exclusions">Exclusion hashes (optional CSV)</Label>
                    <p className="text-sm text-muted-foreground">
                      One SHA-256 hash per row. Hash each address as <code className="rounded bg-muted px-1 font-mono text-xs">SHA-256(lower(trim(email)))</code>.
                    </p>
                    <p className="text-xs text-muted-foreground">CSV files up to 100 MB. This is available only when creating a segment.</p>
                  </div>
                </div>
                <input
                  ref={exclusionInputRef}
                  id="segment-exclusions"
                  type="file"
                  accept=".csv,text/csv"
                  className="sr-only"
                  onChange={handleExclusionFileChange}
                  disabled={createMutation.isPending}
                  data-testid="input-exclusion-csv"
                />
                {exclusionFile ? (
                  <div className="flex items-center justify-between gap-3 rounded-md border bg-background px-3 py-2">
                    <div className="min-w-0"><p className="truncate text-sm font-medium">{exclusionFile.name}</p><p className="text-xs text-muted-foreground">{(exclusionFile.size / 1024 / 1024).toFixed(2)} MB</p></div>
                    <Button type="button" variant="ghost" size="icon" onClick={removeExclusionFile} disabled={createMutation.isPending} aria-label="Remove exclusion file" data-testid="button-remove-exclusion-csv"><X className="h-4 w-4" /></Button>
                  </div>
                ) : (
                  <Button type="button" variant="outline" onClick={() => exclusionInputRef.current?.click()} disabled={createMutation.isPending} data-testid="button-select-exclusion-csv"><Upload className="mr-2 h-4 w-4" />Select CSV</Button>
                )}
                {uploadProgress !== null && (
                  <div className="space-y-1" aria-live="polite" data-testid="exclusion-upload-progress">
                    <div className="h-2 overflow-hidden rounded-full bg-muted"><div className="h-full bg-primary transition-[width] duration-200" style={{ width: `${uploadProgress}%` }} /></div>
                    <p className="text-xs text-muted-foreground">{uploadProgress < 100 ? `Uploading exclusions: ${uploadProgress}%` : "Creating segment..."}</p>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Filter className="h-5 w-5" />
                Rules
              </CardTitle>
              <CardDescription>
                Build conditions to filter subscribers. Groups can be nested up to 3 levels deep.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <GroupBuilder
                group={rootGroup}
                onChange={setRootGroup}
                depth={0}
                testIdPrefix="root"
              />
            </CardContent>
          </Card>

          <div className="flex items-center justify-between gap-4 flex-wrap">
            <Button
              variant="outline"
              asChild
              data-testid="button-cancel-segment"
            >
              <Link href="/segments">Cancel</Link>
            </Button>
            <Button
              onClick={handleSubmit}
              disabled={createMutation.isPending || !!exclusionSummary}
              data-testid="button-submit-segment"
            >
              {createMutation.isPending && (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              )}
              {createMutation.isPending ? "Creating..." : "Create Segment"}
            </Button>
          </div>
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Users className="h-5 w-5" />
                Preview
              </CardTitle>
              <CardDescription>
                Test your rules against the current subscriber list
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Button
                type="button"
                variant="outline"
                className="w-full"
                onClick={handlePreviewCount}
                disabled={isCountLoading}
                data-testid="button-preview-count"
              >
                <Users className="h-4 w-4 mr-2" />
                {isCountLoading ? "Counting..." : "Preview Subscribers"}
              </Button>

              {previewResult !== null && (
                <div
                  className="text-center py-3 rounded-md bg-muted"
                  data-testid="text-preview-count"
                >
                  <p className="text-2xl font-bold">
                    {previewResult.count.toLocaleString()}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    subscriber{previewResult.count !== 1 ? "s" : ""} match
                  </p>
                </div>
              )}
            </CardContent>
          </Card>

          {previewResult && previewResult.sample.length > 0 && (
            <Card data-testid="preview-sample-table">
              <CardHeader>
                <CardTitle className="text-sm font-medium">Sample Subscribers</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Email</TableHead>
                      <TableHead>Tags</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {previewResult.sample.map((sub) => (
                      <TableRow
                        key={sub.id}
                        data-testid={`preview-sample-row-${sub.id}`}
                      >
                        <TableCell className="font-mono text-xs truncate max-w-[140px]">
                          {sub.email}
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-1">
                            {sub.tags && sub.tags.length > 0 ? (
                              sub.tags.slice(0, 2).map((tag) => (
                                <Badge
                                  key={tag}
                                  variant="secondary"
                                  className="text-xs"
                                >
                                  {tag}
                                </Badge>
                              ))
                            ) : (
                              <span className="text-muted-foreground text-xs">
                                None
                              </span>
                            )}
                            {sub.tags && sub.tags.length > 2 && (
                              <Badge variant="outline" className="text-xs">
                                +{sub.tags.length - 2}
                              </Badge>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
