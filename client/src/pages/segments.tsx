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
import { Filter, Plus, MoreVertical, Trash2, Edit2, Users, X, Mail, Tag, Calendar, Globe, Layers } from "lucide-react";
import type { Segment, SegmentRule, SegmentRuleGroup, SegmentRuleItem } from "@shared/schema";
import { fieldOperators, operatorLabels } from "@shared/schema";

interface SegmentWithCount extends Segment {
  subscriberCount?: number;
}

const fieldLabels: Record<string, string> = {
  tags: "Tags",
  email: "Email",
  date_added: "Date Added",
  ip_address: "IP Address",
};

export default function Segments() {
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [editingSegment, setEditingSegment] = useState<SegmentWithCount | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<SegmentWithCount | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [rules, setRules] = useState<SegmentRuleItem[]>([
    { field: "tags", operator: "contains", value: "" },
  ]);
  const { toast } = useToast();

  const { data: segments, isLoading } = useQuery<SegmentWithCount[]>({
    queryKey: ["/api/segments"],
  });

  const isGroup = (item: SegmentRuleItem): item is SegmentRuleGroup => {
    return 'type' in item && item.type === "group";
  };

  const createMutation = useMutation({
    mutationFn: (data: { name: string; description: string; rules: SegmentRuleItem[] }) =>
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
    mutationFn: ({ id, data }: { id: string; data: { name: string; description: string; rules: SegmentRuleItem[] } }) =>
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
    setRules([{ field: "tags", operator: "contains", value: "" }]);
  };

  const handleEditClick = (segment: SegmentWithCount) => {
    setEditingSegment(segment);
    setName(segment.name);
    setDescription(segment.description || "");
    setRules((segment.rules as SegmentRuleItem[]) || [{ field: "tags", operator: "contains", value: "" }]);
  };

  const addRule = () => {
    setRules([...rules, { field: "tags", operator: "contains", value: "", logic: "AND" }]);
  };

  const removeRule = (index: number) => {
    if (rules.length > 1) {
      setRules(rules.filter((_, i) => i !== index));
    }
  };

  const updateRule = (index: number, updates: Partial<SegmentRule>) => {
    setRules(rules.map((item, i) => {
      if (i !== index || isGroup(item)) return item;
      const rule = item as SegmentRule;
      if (updates.field && updates.field !== rule.field) {
        const newOperators = fieldOperators[updates.field as keyof typeof fieldOperators];
        const operatorValid = newOperators.includes(rule.operator as any);
        return { 
          ...rule, 
          ...updates, 
          operator: operatorValid ? rule.operator : newOperators[0],
          value: "",
          value2: undefined,
        };
      }
      return { ...rule, ...updates };
    }));
  };

  const addGroup = () => {
    const newGroup: SegmentRuleGroup = {
      type: "group",
      logic: "AND",
      combinator: "OR",
      rules: [
        { field: "tags", operator: "contains", value: "" },
        { field: "tags", operator: "contains", value: "" },
      ],
    };
    setRules([...rules, newGroup]);
  };

  const updateGroupLogic = (groupIndex: number, logic: "AND" | "OR") => {
    setRules(rules.map((item, i) => {
      if (i !== groupIndex || !isGroup(item)) return item;
      return { ...item, logic };
    }));
  };

  const updateGroupCombinator = (groupIndex: number, combinator: "AND" | "OR") => {
    setRules(rules.map((item, i) => {
      if (i !== groupIndex || !isGroup(item)) return item;
      return { ...item, combinator };
    }));
  };

  const addRuleToGroup = (groupIndex: number) => {
    setRules(rules.map((item, i) => {
      if (i !== groupIndex || !isGroup(item)) return item;
      return { ...item, rules: [...item.rules, { field: "tags" as const, operator: "contains" as const, value: "" }] };
    }));
  };

  const removeRuleFromGroup = (groupIndex: number, ruleIndex: number) => {
    setRules(rules.map((item, i) => {
      if (i !== groupIndex || !isGroup(item)) return item;
      if (item.rules.length <= 1) return item;
      return { ...item, rules: item.rules.filter((_, ri) => ri !== ruleIndex) };
    }));
  };

  const updateGroupRule = (groupIndex: number, ruleIndex: number, updates: Partial<SegmentRule>) => {
    setRules(rules.map((item, i) => {
      if (i !== groupIndex || !isGroup(item)) return item;
      return {
        ...item,
        rules: item.rules.map((rule, ri) => {
          if (ri !== ruleIndex) return rule;
          if (updates.field && updates.field !== rule.field) {
            const newOperators = fieldOperators[updates.field as keyof typeof fieldOperators];
            const operatorValid = newOperators?.includes(rule.operator as any);
            return { ...rule, ...updates, operator: operatorValid ? rule.operator : (newOperators?.[0] || "contains"), value: "", value2: undefined } as SegmentRule;
          }
          return { ...rule, ...updates };
        }),
      };
    }));
  };

  const handleSubmit = () => {
    const validRules = rules.filter((item) => {
      if (isGroup(item)) {
        return item.rules.some(r => r.value.trim());
      }
      return (item as SegmentRule).value.trim();
    }).map((item) => {
      if (isGroup(item)) {
        return { ...item, rules: item.rules.filter(r => r.value.trim()) };
      }
      return item;
    });

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
        <div className="flex items-center justify-between gap-2">
          <Label>Rules</Label>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={addRule} data-testid="button-add-rule">
              <Plus className="h-4 w-4 mr-1" />
              Add Rule
            </Button>
            <Button variant="outline" size="sm" onClick={addGroup} data-testid="button-add-group">
              <Layers className="h-4 w-4 mr-1" />
              Add Group
            </Button>
          </div>
        </div>
        {rules.map((item, index) => (
          <div key={index} className="space-y-2">
            {index > 0 && (
              <Select
                value={isGroup(item) ? (item.logic || "AND") : ((item as SegmentRule).logic || "AND")}
                onValueChange={(v) => {
                  if (isGroup(item)) {
                    updateGroupLogic(index, v as "AND" | "OR");
                  } else {
                    updateRule(index, { logic: v as "AND" | "OR" });
                  }
                }}
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
            {isGroup(item) ? (
              <Card className="p-4 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Layers className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm font-medium">Group</span>
                    <Select
                      value={item.combinator}
                      onValueChange={(v) => updateGroupCombinator(index, v as "AND" | "OR")}
                    >
                      <SelectTrigger className="w-28" data-testid={`select-combinator-${index}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="AND">Match ALL</SelectItem>
                        <SelectItem value="OR">Match ANY</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex gap-1">
                    <Button variant="ghost" size="icon" onClick={() => addRuleToGroup(index)} data-testid={`button-add-rule-to-group-${index}`}>
                      <Plus className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="icon" onClick={() => removeRule(index)} data-testid={`button-remove-group-${index}`}>
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
                {item.rules.map((groupRule, gIndex) => (
                  <div key={gIndex} className="flex gap-2 items-center flex-wrap">
                    <Select
                      value={groupRule.field}
                      onValueChange={(v) => updateGroupRule(index, gIndex, { field: v as any })}
                    >
                      <SelectTrigger className="w-36" data-testid={`select-group-field-${index}-${gIndex}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="tags"><span className="flex items-center gap-1"><Tag className="h-3 w-3" /> Tags</span></SelectItem>
                        <SelectItem value="email"><span className="flex items-center gap-1"><Mail className="h-3 w-3" /> Email</span></SelectItem>
                        <SelectItem value="date_added"><span className="flex items-center gap-1"><Calendar className="h-3 w-3" /> Date Added</span></SelectItem>
                        <SelectItem value="ip_address"><span className="flex items-center gap-1"><Globe className="h-3 w-3" /> IP Address</span></SelectItem>
                      </SelectContent>
                    </Select>
                    <Select
                      value={groupRule.operator}
                      onValueChange={(v) => updateGroupRule(index, gIndex, { operator: v as any })}
                    >
                      <SelectTrigger className="w-40" data-testid={`select-group-operator-${index}-${gIndex}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {fieldOperators[groupRule.field as keyof typeof fieldOperators]?.map((op) => (
                          <SelectItem key={op} value={op}>
                            {operatorLabels[op]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {groupRule.field === "date_added" ? (
                      <div className="flex gap-2 flex-1 min-w-[150px]">
                        <Input
                          type="date"
                          value={groupRule.value}
                          onChange={(e) => updateGroupRule(index, gIndex, { value: e.target.value })}
                          className="flex-1"
                          data-testid={`input-group-rule-value-${index}-${gIndex}`}
                        />
                        {groupRule.operator === "between" && (
                          <Input
                            type="date"
                            value={(groupRule as any).value2 || ""}
                            onChange={(e) => updateGroupRule(index, gIndex, { value2: e.target.value } as any)}
                            className="flex-1"
                            data-testid={`input-group-rule-value2-${index}-${gIndex}`}
                          />
                        )}
                      </div>
                    ) : (
                      <Input
                        placeholder={groupRule.field === "email" ? "e.g., @gmail.com" : groupRule.field === "ip_address" ? "e.g., 192.168.1" : "Tag value..."}
                        value={groupRule.value}
                        onChange={(e) => updateGroupRule(index, gIndex, { 
                          value: groupRule.field === "tags" ? e.target.value.toUpperCase() : e.target.value 
                        })}
                        className="flex-1 min-w-[150px]"
                        data-testid={`input-group-rule-value-${index}-${gIndex}`}
                      />
                    )}
                    {item.rules.length > 1 && (
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => removeRuleFromGroup(index, gIndex)}
                        data-testid={`button-remove-group-rule-${index}-${gIndex}`}
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                ))}
              </Card>
            ) : (
              <div className="flex gap-2 items-center flex-wrap">
                <Select
                  value={(item as SegmentRule).field}
                  onValueChange={(v) => updateRule(index, { field: v as SegmentRule["field"] })}
                >
                  <SelectTrigger className="w-36" data-testid={`select-field-${index}`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="tags">
                      <span className="flex items-center gap-1">
                        <Tag className="h-3 w-3" />
                        Tags
                      </span>
                    </SelectItem>
                    <SelectItem value="email">
                      <span className="flex items-center gap-1">
                        <Mail className="h-3 w-3" />
                        Email
                      </span>
                    </SelectItem>
                    <SelectItem value="date_added">
                      <span className="flex items-center gap-1">
                        <Calendar className="h-3 w-3" />
                        Date Added
                      </span>
                    </SelectItem>
                    <SelectItem value="ip_address">
                      <span className="flex items-center gap-1">
                        <Globe className="h-3 w-3" />
                        IP Address
                      </span>
                    </SelectItem>
                  </SelectContent>
                </Select>
                <Select
                  value={(item as SegmentRule).operator}
                  onValueChange={(v) => updateRule(index, { operator: v as SegmentRule["operator"] })}
                >
                  <SelectTrigger className="w-40" data-testid={`select-operator-${index}`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {fieldOperators[(item as SegmentRule).field].map((op) => (
                      <SelectItem key={op} value={op}>
                        {operatorLabels[op]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {(item as SegmentRule).field === "date_added" ? (
                  <div className="flex gap-2 flex-1 min-w-[150px]">
                    <Input
                      type="date"
                      value={(item as SegmentRule).value}
                      onChange={(e) => updateRule(index, { value: e.target.value })}
                      className="flex-1"
                      data-testid={`input-rule-value-${index}`}
                    />
                    {(item as SegmentRule).operator === "between" && (
                      <Input
                        type="date"
                        value={(item as any).value2 || ""}
                        onChange={(e) => updateRule(index, { value2: e.target.value } as any)}
                        className="flex-1"
                        data-testid={`input-rule-value2-${index}`}
                      />
                    )}
                  </div>
                ) : (
                  <Input
                    placeholder={(item as SegmentRule).field === "email" ? "e.g., @gmail.com" : (item as SegmentRule).field === "ip_address" ? "e.g., 192.168.1" : "Tag value..."}
                    value={(item as SegmentRule).value}
                    onChange={(e) => updateRule(index, { 
                      value: (item as SegmentRule).field === "tags" ? e.target.value.toUpperCase() : e.target.value 
                    })}
                    className="flex-1 min-w-[150px]"
                    data-testid={`input-rule-value-${index}`}
                  />
                )}
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
            )}
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
          <DialogContent className="max-w-lg">
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
                  {(segment.rules as SegmentRuleItem[])?.slice(0, 3).map((item, i) => (
                    <div key={i} className="flex items-center gap-1 flex-wrap">
                      {i > 0 && (
                        <Badge variant="outline" className="text-xs">
                          {isGroup(item) ? (item.logic || "AND") : ((item as SegmentRule).logic || "AND")}
                        </Badge>
                      )}
                      {isGroup(item) ? (
                        <>
                          <Layers className="h-3 w-3" />
                          <span className="text-sm">Group ({item.combinator})</span>
                          <Badge variant="secondary" className="text-xs">{item.rules.length} rules</Badge>
                        </>
                      ) : (
                        <>
                          <span className="text-sm flex items-center gap-1">
                            {(item as SegmentRule).field === "email" ? <Mail className="h-3 w-3" /> : 
                             (item as SegmentRule).field === "date_added" ? <Calendar className="h-3 w-3" /> :
                             (item as SegmentRule).field === "ip_address" ? <Globe className="h-3 w-3" /> :
                             <Tag className="h-3 w-3" />}
                            {fieldLabels[(item as SegmentRule).field] || (item as SegmentRule).field}
                          </span>
                          <Badge variant="secondary" className="text-xs">
                            {operatorLabels[(item as SegmentRule).operator]}
                          </Badge>
                          <Badge className="text-xs">{(item as SegmentRule).value}</Badge>
                        </>
                      )}
                    </div>
                  ))}
                  {(segment.rules as SegmentRuleItem[])?.length > 3 && (
                    <span className="text-xs text-muted-foreground">
                      +{(segment.rules as SegmentRuleItem[]).length - 3} more rules
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
              Create segments to target specific groups of subscribers based on tags, email, date, or IP address.
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
