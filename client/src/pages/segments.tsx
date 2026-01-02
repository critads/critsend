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
import { Filter, Plus, MoreVertical, Trash2, Edit2, Users, X, Mail, Tag } from "lucide-react";
import type { Segment, SegmentRule } from "@shared/schema";
import { fieldOperators, operatorLabels } from "@shared/schema";

interface SegmentWithCount extends Segment {
  subscriberCount?: number;
}

const fieldLabels: Record<string, string> = {
  tags: "Tags",
  email: "Email",
};

export default function Segments() {
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [editingSegment, setEditingSegment] = useState<SegmentWithCount | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<SegmentWithCount | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [rules, setRules] = useState<SegmentRule[]>([
    { field: "positiveTags", operator: "contains", value: "" },
  ]);
  const { toast } = useToast();

  const { data: segments, isLoading } = useQuery<SegmentWithCount[]>({
    queryKey: ["/api/segments"],
  });

  const createMutation = useMutation({
    mutationFn: (data: { name: string; description: string; rules: SegmentRule[] }) =>
      apiRequest("POST", "/api/segments", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/segments"] });
      resetForm();
      setIsCreateOpen(false);
      toast({
        title: "Segment created",
        description: "Your new segment has been created successfully.",
      });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to create segment. Please try again.",
        variant: "destructive",
      });
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: { name: string; description: string; rules: SegmentRule[] } }) =>
      apiRequest("PATCH", `/api/segments/${id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/segments"] });
      setEditingSegment(null);
      resetForm();
      toast({
        title: "Segment updated",
        description: "Your segment has been updated successfully.",
      });
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
      setDeleteConfirm(null);
      toast({
        title: "Segment deleted",
        description: "The segment has been deleted.",
      });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to delete segment. Please try again.",
        variant: "destructive",
      });
    },
  });

  const resetForm = () => {
    setName("");
    setDescription("");
    setRules([{ field: "positiveTags", operator: "contains", value: "" }]);
  };

  const handleEditClick = (segment: SegmentWithCount) => {
    setEditingSegment(segment);
    setName(segment.name);
    setDescription(segment.description || "");
    setRules((segment.rules as SegmentRule[]) || [{ field: "positiveTags", operator: "contains", value: "" }]);
  };

  const addRule = () => {
    setRules([...rules, { field: "positiveTags", operator: "contains", value: "", logic: "AND" }]);
  };

  const removeRule = (index: number) => {
    if (rules.length > 1) {
      setRules(rules.filter((_, i) => i !== index));
    }
  };

  const updateRule = (index: number, updates: Partial<SegmentRule>) => {
    setRules(rules.map((rule, i) => {
      if (i !== index) return rule;
      // When field changes, reset operator to first valid operator for new field
      if (updates.field && updates.field !== rule.field) {
        const newOperators = fieldOperators[updates.field];
        const operatorValid = newOperators.includes(rule.operator as any);
        return { 
          ...rule, 
          ...updates, 
          operator: operatorValid ? rule.operator : newOperators[0] 
        };
      }
      return { ...rule, ...updates };
    }));
  };

  const handleSubmit = () => {
    const validRules = rules.filter((r) => r.value.trim());
    if (!name.trim() || validRules.length === 0) {
      toast({
        title: "Validation Error",
        description: "Please provide a name and at least one rule with a value.",
        variant: "destructive",
      });
      return;
    }

    if (editingSegment) {
      updateMutation.mutate({
        id: editingSegment.id,
        data: { name: name.trim(), description: description.trim(), rules: validRules },
      });
    } else {
      createMutation.mutate({
        name: name.trim(),
        description: description.trim(),
        rules: validRules,
      });
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
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <Label>Rules</Label>
          <Button variant="outline" size="sm" onClick={addRule} data-testid="button-add-rule">
            <Plus className="h-4 w-4 mr-1" />
            Add Rule
          </Button>
        </div>
        {rules.map((rule, index) => (
          <div key={index} className="space-y-2">
            {index > 0 && (
              <Select
                value={rule.logic || "AND"}
                onValueChange={(v) => updateRule(index, { logic: v as "AND" | "OR" })}
              >
                <SelectTrigger className="w-24" data-testid={`select-logic-${index}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="AND">AND</SelectItem>
                  <SelectItem value="OR">OR</SelectItem>
                </SelectContent>
              </Select>
            )}
            <div className="flex gap-2 items-center flex-wrap">
              <Select
                value={rule.field}
                onValueChange={(v) => updateRule(index, { field: v as "tags" | "positiveTags" | "negativeTags" | "email" })}
              >
                <SelectTrigger className="w-36" data-testid={`select-field-${index}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="positiveTags">
                    <span className="flex items-center gap-1">
                      <Tag className="h-3 w-3 text-green-600" />
                      Positive Tags
                    </span>
                  </SelectItem>
                  <SelectItem value="negativeTags">
                    <span className="flex items-center gap-1">
                      <Tag className="h-3 w-3 text-red-600" />
                      Negative Tags
                    </span>
                  </SelectItem>
                  <SelectItem value="tags">
                    <span className="flex items-center gap-1">
                      <Tag className="h-3 w-3" />
                      All Tags
                    </span>
                  </SelectItem>
                  <SelectItem value="email">
                    <span className="flex items-center gap-1">
                      <Mail className="h-3 w-3" />
                      Email
                    </span>
                  </SelectItem>
                </SelectContent>
              </Select>
              <Select
                value={rule.operator}
                onValueChange={(v) => updateRule(index, { operator: v as SegmentRule["operator"] })}
              >
                <SelectTrigger className="w-40" data-testid={`select-operator-${index}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {fieldOperators[rule.field].map((op) => (
                    <SelectItem key={op} value={op}>
                      {operatorLabels[op]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                placeholder={rule.field === "email" ? "e.g., @gmail.com" : "Tag value..."}
                value={rule.value}
                onChange={(e) => updateRule(index, { 
                  value: rule.field !== "email" ? e.target.value.toUpperCase() : e.target.value 
                })}
                className="flex-1 min-w-[150px]"
                data-testid={`input-rule-value-${index}`}
              />
              {rules.length > 1 && (
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => removeRule(index)}
                  data-testid={`button-remove-rule-${index}`}
                >
                  <X className="h-4 w-4" />
                </Button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <div className="p-6 lg:p-8 space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Segments</h1>
          <p className="text-muted-foreground">
            Create and manage audience segments based on tags or email
          </p>
        </div>
        <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
          <DialogTrigger asChild>
            <Button onClick={resetForm} data-testid="button-create-segment">
              <Plus className="h-4 w-4 mr-2" />
              Create Segment
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Create Segment</DialogTitle>
              <DialogDescription>
                Define rules to group subscribers based on tags or email
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
          {segments.map((segment) => (
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
                    <DropdownMenuItem onClick={() => handleEditClick(segment)}>
                      <Edit2 className="h-4 w-4 mr-2" />
                      Edit
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      className="text-destructive"
                      onClick={() => setDeleteConfirm(segment)}
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
                  <span>{segment.subscriberCount?.toLocaleString() || 0} subscribers</span>
                </div>
                <div className="space-y-2">
                  {(segment.rules as SegmentRule[])?.slice(0, 2).map((rule, i) => (
                    <div key={i} className="flex items-center gap-1 flex-wrap">
                      {i > 0 && (
                        <Badge variant="outline" className="text-xs">
                          {rule.logic || "AND"}
                        </Badge>
                      )}
                      <span className="text-sm flex items-center gap-1">
                        {rule.field === "email" ? <Mail className="h-3 w-3" /> : <Tag className="h-3 w-3" />}
                        {fieldLabels[rule.field] || rule.field}
                      </span>
                      <Badge variant="secondary" className="text-xs">
                        {operatorLabels[rule.operator]}
                      </Badge>
                      <Badge className="text-xs">{rule.value}</Badge>
                    </div>
                  ))}
                  {(segment.rules as SegmentRule[])?.length > 2 && (
                    <span className="text-xs text-muted-foreground">
                      +{(segment.rules as SegmentRule[]).length - 2} more rules
                    </span>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <Filter className="h-16 w-16 text-muted-foreground/50 mb-4" />
            <h3 className="text-lg font-semibold mb-2">No segments yet</h3>
            <p className="text-muted-foreground max-w-md mb-4">
              Create segments to target specific groups of subscribers based on tags or email.
            </p>
            <Button onClick={() => setIsCreateOpen(true)}>
              <Plus className="h-4 w-4 mr-2" />
              Create Your First Segment
            </Button>
          </CardContent>
        </Card>
      )}

      <Dialog open={!!editingSegment} onOpenChange={() => setEditingSegment(null)}>
        <DialogContent className="max-w-lg">
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
    </div>
  );
}
