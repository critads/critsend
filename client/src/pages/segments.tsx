import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import {
  Filter, Plus, MoreVertical, Trash2, Edit2, Users, X,
  Mail, Tag, Calendar, Globe, Layers, Eye, Download, Copy,
  ChevronLeft, ChevronRight,
} from "lucide-react";
import type { Segment, SegmentCondition, SegmentGroup, SegmentRulesV2, Subscriber } from "@shared/schema";
import { fieldOperatorsV2, operatorLabelsV2, migrateRulesV1toV2 } from "@shared/schema";

const fieldLabels: Record<string, string> = {
  tags: "Tags",
  email: "Email",
  date_added: "Date Added",
  ip_address: "IP Address",
};

const fieldIcons: Record<string, typeof Tag> = {
  tags: Tag,
  email: Mail,
  date_added: Calendar,
  ip_address: Globe,
};

const unaryOperators = ["is_empty", "is_not_empty", "has_any_tag", "has_no_tags"];

function makeEmptyCondition(): SegmentCondition {
  return { type: "condition", field: "email", operator: "contains", value: "", value2: null };
}

function makeEmptyGroup(): SegmentGroup {
  return { type: "group", combinator: "AND", children: [makeEmptyCondition()] };
}

function defaultRootGroup(): SegmentGroup {
  return makeEmptyGroup();
}

function getRulesAsV2(rules: unknown): SegmentGroup {
  if (rules && typeof rules === "object" && (rules as any).version === 2) {
    return (rules as SegmentRulesV2).root;
  }
  if (Array.isArray(rules) && rules.length > 0) {
    return migrateRulesV1toV2(rules).root;
  }
  return defaultRootGroup();
}

function isConditionValid(c: SegmentCondition): boolean {
  if (unaryOperators.includes(c.operator)) return true;
  if (typeof c.value === "string") return c.value.trim().length > 0;
  if (Array.isArray(c.value)) return c.value.length > 0;
  return false;
}

function hasValidCondition(group: SegmentGroup): boolean {
  for (const child of group.children) {
    if (child.type === "condition" && isConditionValid(child)) return true;
    if (child.type === "group" && hasValidCondition(child)) return true;
  }
  return false;
}

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

function ConditionRow({
  condition,
  onChange,
  onRemove,
  testIdPrefix,
}: {
  condition: SegmentCondition;
  onChange: (c: SegmentCondition) => void;
  onRemove: () => void;
  testIdPrefix: string;
}) {
  const operators = fieldOperatorsV2[condition.field as keyof typeof fieldOperatorsV2] || [];
  const isUnary = unaryOperators.includes(condition.operator);
  const isBetween = condition.operator === "between";
  const isDays = condition.operator === "in_last_days" || condition.operator === "not_in_last_days";
  const isDate = condition.operator === "before" || condition.operator === "after";
  const isTagText = condition.operator === "has_tag" || condition.operator === "not_has_tag";

  const handleFieldChange = (field: string) => {
    const newOps = fieldOperatorsV2[field as keyof typeof fieldOperatorsV2];
    const opValid = (newOps as readonly string[]).includes(condition.operator);
    onChange({
      ...condition,
      field: field as SegmentCondition["field"],
      operator: opValid ? condition.operator : newOps[0],
      value: "",
      value2: null,
    });
  };

  const handleOperatorChange = (op: string) => {
    const wasUnary = unaryOperators.includes(condition.operator);
    const nowUnary = unaryOperators.includes(op);
    onChange({
      ...condition,
      operator: op,
      value: nowUnary ? null : (wasUnary ? "" : condition.value),
      value2: op === "between" ? (condition.value2 || "") : null,
    });
  };

  const FieldIcon = fieldIcons[condition.field] || Tag;

  return (
    <div className="flex gap-2 items-center flex-wrap">
      <Select value={condition.field} onValueChange={handleFieldChange}>
        <SelectTrigger className="w-36" data-testid={`${testIdPrefix}-field`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {Object.entries(fieldLabels).map(([key, label]) => {
            const Icon = fieldIcons[key] || Tag;
            return (
              <SelectItem key={key} value={key}>
                <span className="flex items-center gap-1"><Icon className="h-3 w-3" /> {label}</span>
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>

      <Select value={condition.operator} onValueChange={handleOperatorChange}>
        <SelectTrigger className="w-44" data-testid={`${testIdPrefix}-operator`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {operators.map((op) => (
            <SelectItem key={op} value={op}>{operatorLabelsV2[op]}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      {!isUnary && (
        <>
          {isBetween ? (
            <div className="flex gap-2 flex-1 min-w-[150px]">
              <Input
                type="date"
                value={typeof condition.value === "string" ? condition.value : ""}
                onChange={(e) => onChange({ ...condition, value: e.target.value })}
                className="flex-1"
                data-testid={`${testIdPrefix}-value`}
              />
              <Input
                type="date"
                value={condition.value2 || ""}
                onChange={(e) => onChange({ ...condition, value2: e.target.value })}
                className="flex-1"
                data-testid={`${testIdPrefix}-value2`}
              />
            </div>
          ) : isDays ? (
            <Input
              type="number"
              min={1}
              placeholder="Days"
              value={typeof condition.value === "string" ? condition.value : ""}
              onChange={(e) => onChange({ ...condition, value: e.target.value })}
              className="w-24"
              data-testid={`${testIdPrefix}-value`}
            />
          ) : isDate ? (
            <Input
              type="date"
              value={typeof condition.value === "string" ? condition.value : ""}
              onChange={(e) => onChange({ ...condition, value: e.target.value })}
              className="flex-1 min-w-[150px]"
              data-testid={`${testIdPrefix}-value`}
            />
          ) : isTagText ? (
            <Input
              placeholder="Tag value..."
              value={typeof condition.value === "string" ? condition.value : ""}
              onChange={(e) => onChange({ ...condition, value: e.target.value.toUpperCase() })}
              className="flex-1 min-w-[150px]"
              data-testid={`${testIdPrefix}-value`}
            />
          ) : (
            <Input
              placeholder={condition.field === "email" ? "e.g., @gmail.com" : condition.field === "ip_address" ? "e.g., 192.168.1" : "Value..."}
              value={typeof condition.value === "string" ? condition.value : ""}
              onChange={(e) => onChange({ ...condition, value: e.target.value })}
              className="flex-1 min-w-[150px]"
              data-testid={`${testIdPrefix}-value`}
            />
          )}
        </>
      )}

      <Button variant="ghost" size="icon" onClick={onRemove} data-testid={`${testIdPrefix}-remove`}>
        <X className="h-4 w-4" />
      </Button>
    </div>
  );
}

function GroupBuilder({
  group,
  onChange,
  onRemove,
  depth,
  testIdPrefix,
}: {
  group: SegmentGroup;
  onChange: (g: SegmentGroup) => void;
  onRemove?: () => void;
  depth: number;
  testIdPrefix: string;
}) {
  const updateChild = (index: number, child: SegmentCondition | SegmentGroup) => {
    const newChildren = [...group.children];
    newChildren[index] = child;
    onChange({ ...group, children: newChildren });
  };

  const removeChild = (index: number) => {
    if (group.children.length <= 1) return;
    onChange({ ...group, children: group.children.filter((_, i) => i !== index) });
  };

  const addCondition = () => {
    onChange({ ...group, children: [...group.children, makeEmptyCondition()] });
  };

  const addNestedGroup = () => {
    onChange({ ...group, children: [...group.children, makeEmptyGroup()] });
  };

  const isRoot = depth === 0;
  const wrapperClass = isRoot ? "space-y-3" : "border rounded-md p-3 space-y-3";

  return (
    <div className={wrapperClass} data-testid={`${testIdPrefix}-group`}>
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <Layers className="h-4 w-4 text-muted-foreground" />
          <Select
            value={group.combinator}
            onValueChange={(v) => onChange({ ...group, combinator: v as "AND" | "OR" })}
          >
            <SelectTrigger className="w-32" data-testid={`${testIdPrefix}-combinator`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="AND">Match ALL</SelectItem>
              <SelectItem value="OR">Match ANY</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex gap-1 flex-wrap">
          <Button variant="outline" size="sm" onClick={addCondition} data-testid={`${testIdPrefix}-add-condition`}>
            <Plus className="h-4 w-4 mr-1" />
            Condition
          </Button>
          {depth < 3 && (
            <Button variant="outline" size="sm" onClick={addNestedGroup} data-testid={`${testIdPrefix}-add-group`}>
              <Layers className="h-4 w-4 mr-1" />
              Group
            </Button>
          )}
          {onRemove && (
            <Button variant="ghost" size="icon" onClick={onRemove} data-testid={`${testIdPrefix}-remove-group`}>
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      {group.children.map((child, index) => (
        <div key={index} className="space-y-2">
          {index > 0 && (
            <Badge variant="outline" className="text-xs" data-testid={`${testIdPrefix}-connector-${index}`}>
              {group.combinator}
            </Badge>
          )}
          {child.type === "condition" ? (
            <ConditionRow
              condition={child}
              onChange={(c) => updateChild(index, c)}
              onRemove={() => removeChild(index)}
              testIdPrefix={`${testIdPrefix}-c${index}`}
            />
          ) : (
            <GroupBuilder
              group={child}
              onChange={(g) => updateChild(index, g)}
              onRemove={() => removeChild(index)}
              depth={depth + 1}
              testIdPrefix={`${testIdPrefix}-g${index}`}
            />
          )}
        </div>
      ))}
    </div>
  );
}

export default function Segments() {
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [editingSegment, setEditingSegment] = useState<Segment | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<Segment | null>(null);
  const [viewingSegment, setViewingSegment] = useState<Segment | null>(null);
  const [viewPage, setViewPage] = useState(1);
  const [isExporting, setIsExporting] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [rootGroup, setRootGroup] = useState<SegmentGroup>(defaultRootGroup());
  const [previewResult, setPreviewResult] = useState<PreviewResult | null>(null);
  const [isCountLoading, setIsCountLoading] = useState(false);
  const { toast } = useToast();

  const { data: segments, isLoading } = useQuery<Segment[]>({
    queryKey: ["/api/segments"],
  });

  const { data: segmentCounts } = useQuery<Record<string, number>>({
    queryKey: ["/api/segments/counts"],
    enabled: !!segments && segments.length > 0,
  });

  const { data: segmentSubscribers, isLoading: isLoadingSubscribers } = useQuery<SegmentSubscribersResponse>({
    queryKey: ["/api/segments", viewingSegment?.id, "subscribers", viewPage],
    queryFn: async () => {
      const res = await fetch(`/api/segments/${viewingSegment!.id}/subscribers?page=${viewPage}&limit=50`, {
        credentials: "include",
      });
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
  };

  const handleEditClick = (segment: Segment) => {
    setEditingSegment(segment);
    setName(segment.name);
    setDescription(segment.description || "");
    setRootGroup(getRulesAsV2(segment.rules));
    setPreviewResult(null);
  };

  const createMutation = useMutation({
    mutationFn: (data: { name: string; description: string; rules: SegmentRulesV2 }) =>
      apiRequest("POST", "/api/segments", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/segments"] });
      queryClient.invalidateQueries({ queryKey: ["/api/segments/counts"] });
      resetForm();
      setIsCreateOpen(false);
      toast({ title: "Segment created", description: "Your new segment has been created successfully." });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to create segment. Please try again.", variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: { name: string; description: string; rules: SegmentRulesV2 } }) =>
      apiRequest("PATCH", `/api/segments/${id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/segments"] });
      queryClient.invalidateQueries({ queryKey: ["/api/segments/counts"] });
      setEditingSegment(null);
      resetForm();
      toast({ title: "Segment updated", description: "Your segment has been updated successfully." });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to update segment. Please try again.", variant: "destructive" });
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
      toast({ title: "Error", description: "Failed to delete segment. Please try again.", variant: "destructive" });
    },
  });

  const duplicateMutation = useMutation({
    mutationFn: (id: string) => apiRequest("POST", `/api/segments/${id}/duplicate`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/segments"] });
      queryClient.invalidateQueries({ queryKey: ["/api/segments/counts"] });
      toast({ title: "Segment duplicated", description: "A copy of the segment has been created." });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to duplicate segment. Please try again.", variant: "destructive" });
    },
  });

  const handleSubmit = () => {
    if (!name.trim()) {
      toast({ title: "Validation Error", description: "Please provide a segment name.", variant: "destructive" });
      return;
    }
    if (!hasValidCondition(rootGroup)) {
      toast({ title: "Validation Error", description: "Please add at least one condition with a value.", variant: "destructive" });
      return;
    }

    const payload = {
      name: name.trim(),
      description: description.trim(),
      rules: { version: 2 as const, root: rootGroup } as SegmentRulesV2,
    };

    if (editingSegment) {
      updateMutation.mutate({ id: editingSegment.id, data: payload });
    } else {
      createMutation.mutate(payload);
    }
  };

  const handlePreviewCount = async () => {
    if (!hasValidCondition(rootGroup)) {
      toast({ title: "No rules defined", description: "Please add at least one condition with a value to preview.", variant: "destructive" });
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
      toast({ title: "Error", description: "Failed to preview. Please try again.", variant: "destructive" });
    } finally {
      setIsCountLoading(false);
    }
  };

  const handleExportSegment = async (segment: Segment) => {
    setIsExporting(segment.id);
    try {
      const response = await fetch(`/api/segments/${segment.id}/export`, { credentials: "include" });
      if (!response.ok) throw new Error("Export failed");
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `segment-${segment.name.replace(/[^a-zA-Z0-9]/g, "_")}-${new Date().toISOString().split("T")[0]}.csv`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      a.remove();
      toast({ title: "Export started", description: `Segment "${segment.name}" exported successfully.` });
    } catch {
      toast({ title: "Error", description: "Failed to export segment. Please try again.", variant: "destructive" });
    } finally {
      setIsExporting(null);
    }
  };

  const segmentFormContent = (
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
            {previewResult.count.toLocaleString()} subscriber{previewResult.count !== 1 ? "s" : ""} match
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
                          <Badge key={tag} variant="secondary" className="text-xs">{tag}</Badge>
                        ))
                      ) : (
                        <span className="text-muted-foreground text-sm">None</span>
                      )}
                      {sub.tags && sub.tags.length > 3 && (
                        <Badge variant="outline" className="text-xs">+{sub.tags.length - 3}</Badge>
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
        <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
          <DialogTrigger asChild>
            <Button onClick={resetForm} data-testid="button-create-segment">
              <Plus className="h-4 w-4 mr-2" />
              Create Segment
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Create Segment</DialogTitle>
              <DialogDescription>
                Define rules to group subscribers based on tags, email, date, or IP
              </DialogDescription>
            </DialogHeader>
            {segmentFormContent}
            <DialogFooter>
              <Button variant="outline" onClick={() => setIsCreateOpen(false)}>
                Cancel
              </Button>
              <Button
                onClick={handleSubmit}
                disabled={createMutation.isPending}
                data-testid="button-submit-segment"
              >
                {createMutation.isPending ? "Creating..." : "Create Segment"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-48" />
          ))}
        </div>
      ) : segments && segments.length > 0 ? (
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
                      <Button variant="ghost" size="icon" data-testid={`button-segment-menu-${segment.id}`}>
                        <MoreVertical className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        onClick={() => { setViewPage(1); setViewingSegment(segment); }}
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
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Users className="h-4 w-4" />
                    <span data-testid={`text-segment-count-${segment.id}`}>
                      {segmentCounts
                        ? `${(segmentCounts[segment.id] ?? 0).toLocaleString()} subscribers`
                        : "Loading..."}
                    </span>
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
      ) : (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <Filter className="h-16 w-16 text-muted-foreground/50 mb-4" />
            <h3 className="text-lg font-semibold mb-2">No segments yet</h3>
            <p className="text-muted-foreground max-w-md mb-4">
              Create segments to target specific groups of subscribers based on tags, email, date, or IP address.
            </p>
            <Button onClick={() => setIsCreateOpen(true)} data-testid="button-create-first-segment">
              <Plus className="h-4 w-4 mr-2" />
              Create Your First Segment
            </Button>
          </CardContent>
        </Card>
      )}

      <Dialog open={!!editingSegment} onOpenChange={() => setEditingSegment(null)}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit Segment</DialogTitle>
            <DialogDescription>
              Update the rules for this segment
            </DialogDescription>
          </DialogHeader>
          {segmentFormContent}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingSegment(null)}>
              Cancel
            </Button>
            <Button
              onClick={handleSubmit}
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
              Are you sure you want to delete "{deleteConfirm?.name}"? This will not delete subscribers.
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

      <Dialog open={!!viewingSegment} onOpenChange={(open) => { if (!open) { setViewingSegment(null); setViewPage(1); } }}>
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
                      <TableRow key={sub.id} data-testid={`segment-subscriber-row-${sub.id}`}>
                        <TableCell className="font-mono text-sm">{sub.email}</TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-1">
                            {sub.tags && sub.tags.length > 0 ? (
                              sub.tags.slice(0, 3).map((tag) => (
                                <Badge key={tag} variant="secondary" className="text-xs">{tag}</Badge>
                              ))
                            ) : (
                              <span className="text-muted-foreground text-sm">None</span>
                            )}
                            {sub.tags && sub.tags.length > 3 && (
                              <Badge variant="outline" className="text-xs">+{sub.tags.length - 3}</Badge>
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
                <p className="text-muted-foreground">No subscribers match this segment's rules.</p>
              </div>
            )}
          </div>
          {segmentSubscribers && segmentSubscribers.totalPages > 1 && (
            <div className="flex items-center justify-between pt-4 border-t flex-wrap gap-4">
              <p className="text-sm text-muted-foreground">
                Showing {((viewPage - 1) * 50) + 1} to{" "}
                {Math.min(viewPage * 50, segmentSubscribers.total)} of {segmentSubscribers.total.toLocaleString()}
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
