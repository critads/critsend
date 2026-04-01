import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
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
import { ArrowLeft, Filter, Users, Loader2 } from "lucide-react";
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

export default function SegmentNew() {
  const [, navigate] = useLocation();
  const { toast } = useToast();

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [rootGroup, setRootGroup] = useState<SegmentGroup>(defaultRootGroup());
  const [previewResult, setPreviewResult] = useState<PreviewResult | null>(null);
  const [isCountLoading, setIsCountLoading] = useState(false);

  const createMutation = useMutation({
    mutationFn: (data: { name: string; description: string; rules: SegmentRulesV2 }) =>
      apiRequest("POST", "/api/segments", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/segments"] });
      queryClient.invalidateQueries({ queryKey: ["/api/segments/counts"] });
      toast({
        title: "Segment created",
        description: "Your new segment has been created successfully.",
      });
      navigate("/segments");
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to create segment. Please try again.",
        variant: "destructive",
      });
    },
  });

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
    createMutation.mutate({
      name: name.trim(),
      description: description.trim(),
      rules: { version: 2 as const, root: rootGroup } as SegmentRulesV2,
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

  return (
    <div className="p-6 lg:p-8 space-y-6">
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
              disabled={createMutation.isPending}
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
