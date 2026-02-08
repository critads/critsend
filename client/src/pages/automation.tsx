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
import {
  Workflow,
  Play,
  Pause,
  Plus,
  Trash2,
  Users,
  Clock,
  Tag,
  Mail,
  MoreVertical,
  GitBranch,
  ArrowRight,
} from "lucide-react";
import type { AutomationWorkflow } from "@shared/schema";

interface WorkflowWithCount extends AutomationWorkflow {
  enrollmentCount?: number;
}

interface WorkflowStep {
  type: "send_email" | "wait" | "add_tag" | "remove_tag";
  config: Record<string, string | number>;
}

interface Enrollment {
  id: string;
  workflowId: string;
  subscriberId: string;
  currentStepIndex: number;
  status: string;
  enrolledAt: string;
  nextActionAt: string | null;
  completedAt: string | null;
  lastError: string | null;
  subscriberEmail: string | null;
}

const triggerTypeLabels: Record<string, string> = {
  subscriber_added: "Subscriber Added",
  tag_added: "Tag Added",
  tag_removed: "Tag Removed",
  subscriber_opened: "Subscriber Opened",
  subscriber_clicked: "Subscriber Clicked",
};

const stepTypeLabels: Record<string, string> = {
  send_email: "Send Email",
  wait: "Wait",
  add_tag: "Add Tag",
  remove_tag: "Remove Tag",
};

const statusVariants: Record<string, string> = {
  draft: "secondary",
  active: "default",
  paused: "outline",
  archived: "secondary",
};

const statusColors: Record<string, string> = {
  draft: "bg-muted text-muted-foreground",
  active: "bg-accent text-foreground",
  paused: "bg-muted text-muted-foreground",
  archived: "bg-muted text-muted-foreground",
};

function StepIcon({ type }: { type: string }) {
  switch (type) {
    case "send_email":
      return <Mail className="h-4 w-4" />;
    case "wait":
      return <Clock className="h-4 w-4" />;
    case "add_tag":
    case "remove_tag":
      return <Tag className="h-4 w-4" />;
    default:
      return <ArrowRight className="h-4 w-4" />;
  }
}

export default function Automation() {
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<WorkflowWithCount | null>(null);
  const [viewingEnrollments, setViewingEnrollments] = useState<WorkflowWithCount | null>(null);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [triggerType, setTriggerType] = useState("subscriber_added");
  const [triggerConfig, setTriggerConfig] = useState<Record<string, string>>({});
  const [steps, setSteps] = useState<WorkflowStep[]>([]);

  const { toast } = useToast();

  const { data: workflows, isLoading } = useQuery<WorkflowWithCount[]>({
    queryKey: ["/api/automation"],
  });

  const { data: enrollmentsData } = useQuery<{
    enrollments: Enrollment[];
    total: number;
  }>({
    queryKey: ["/api/automation", viewingEnrollments?.id, "enrollments"],
    enabled: !!viewingEnrollments,
  });

  const createMutation = useMutation({
    mutationFn: (data: {
      name: string;
      description: string;
      triggerType: string;
      triggerConfig: Record<string, string>;
      steps: WorkflowStep[];
    }) => apiRequest("POST", "/api/automation", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/automation"] });
      resetForm();
      setIsCreateOpen(false);
      toast({
        title: "Workflow created",
        description: "Your new automation workflow has been created.",
      });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to create workflow. Please try again.",
        variant: "destructive",
      });
    },
  });

  const activateMutation = useMutation({
    mutationFn: (id: string) => apiRequest("POST", `/api/automation/${id}/activate`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/automation"] });
      toast({
        title: "Workflow activated",
        description: "The workflow is now active and will process new triggers.",
      });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to activate workflow. Please try again.",
        variant: "destructive",
      });
    },
  });

  const pauseMutation = useMutation({
    mutationFn: (id: string) => apiRequest("POST", `/api/automation/${id}/pause`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/automation"] });
      toast({
        title: "Workflow paused",
        description: "The workflow has been paused.",
      });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to pause workflow. Please try again.",
        variant: "destructive",
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/automation/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/automation"] });
      setDeleteConfirm(null);
      toast({
        title: "Workflow deleted",
        description: "The automation workflow has been removed.",
      });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to delete workflow. Please try again.",
        variant: "destructive",
      });
    },
  });

  const resetForm = () => {
    setName("");
    setDescription("");
    setTriggerType("subscriber_added");
    setTriggerConfig({});
    setSteps([]);
  };

  const addStep = () => {
    setSteps([...steps, { type: "send_email", config: {} }]);
  };

  const removeStep = (index: number) => {
    setSteps(steps.filter((_, i) => i !== index));
  };

  const updateStepType = (index: number, type: WorkflowStep["type"]) => {
    setSteps(
      steps.map((step, i) => (i === index ? { type, config: {} } : step))
    );
  };

  const updateStepConfig = (index: number, key: string, value: string | number) => {
    setSteps(
      steps.map((step, i) =>
        i === index ? { ...step, config: { ...step.config, [key]: value } } : step
      )
    );
  };

  const handleSubmit = () => {
    if (!name.trim()) {
      toast({
        title: "Validation Error",
        description: "Please provide a workflow name.",
        variant: "destructive",
      });
      return;
    }

    if (!triggerType) {
      toast({
        title: "Validation Error",
        description: "Please select a trigger type.",
        variant: "destructive",
      });
      return;
    }

    createMutation.mutate({
      name: name.trim(),
      description: description.trim(),
      triggerType,
      triggerConfig,
      steps,
    });
  };

  const needsTagConfig = triggerType === "tag_added" || triggerType === "tag_removed";
  const needsCampaignConfig =
    triggerType === "subscriber_opened" || triggerType === "subscriber_clicked";

  const workflowFormContent = (
    <div className="space-y-6 max-h-[60vh] overflow-y-auto pr-1">
      <div className="space-y-2">
        <Label htmlFor="workflow-name">Workflow Name *</Label>
        <Input
          id="workflow-name"
          placeholder="e.g., Welcome Series"
          value={name}
          onChange={(e) => setName(e.target.value)}
          data-testid="input-workflow-name"
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="workflow-description">Description (optional)</Label>
        <Textarea
          id="workflow-description"
          placeholder="Describe this workflow..."
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="resize-none"
          rows={2}
          data-testid="input-workflow-description"
        />
      </div>

      <div className="space-y-2">
        <Label>Trigger Type *</Label>
        <Select value={triggerType} onValueChange={(v) => { setTriggerType(v); setTriggerConfig({}); }}>
          <SelectTrigger data-testid="select-trigger-type">
            <SelectValue placeholder="Select trigger..." />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="subscriber_added">Subscriber Added</SelectItem>
            <SelectItem value="tag_added">Tag Added</SelectItem>
            <SelectItem value="tag_removed">Tag Removed</SelectItem>
            <SelectItem value="subscriber_opened">Subscriber Opened</SelectItem>
            <SelectItem value="subscriber_clicked">Subscriber Clicked</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {needsTagConfig && (
        <div className="space-y-2">
          <Label htmlFor="trigger-tag">Tag Name</Label>
          <Input
            id="trigger-tag"
            placeholder="e.g., welcome"
            value={triggerConfig.tagName || ""}
            onChange={(e) => setTriggerConfig({ ...triggerConfig, tagName: e.target.value })}
            data-testid="input-trigger-tag"
          />
        </div>
      )}

      {needsCampaignConfig && (
        <div className="space-y-2">
          <Label htmlFor="trigger-campaign">Campaign ID</Label>
          <Input
            id="trigger-campaign"
            placeholder="Campaign ID"
            value={triggerConfig.campaignId || ""}
            onChange={(e) => setTriggerConfig({ ...triggerConfig, campaignId: e.target.value })}
            data-testid="input-trigger-campaign"
          />
        </div>
      )}

      <div className="space-y-4">
        <div className="flex items-center justify-between gap-2">
          <Label>Steps</Label>
          <Button variant="outline" size="sm" onClick={addStep} data-testid="button-add-step">
            <Plus className="h-4 w-4 mr-1" />
            Add Step
          </Button>
        </div>

        {steps.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No steps added yet. Click "Add Step" to build your workflow.
          </p>
        )}

        {steps.map((step, index) => (
          <Card key={index} className="relative">
            <CardContent className="pt-4 pb-4 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Badge variant="secondary" className="text-xs">
                    Step {index + 1}
                  </Badge>
                  <StepIcon type={step.type} />
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => removeStep(index)}
                  data-testid={`button-remove-step-${index}`}
                >
                  <Trash2 className="h-4 w-4 text-muted-foreground" />
                </Button>
              </div>

              <div className="space-y-2">
                <Label>Step Type</Label>
                <Select
                  value={step.type}
                  onValueChange={(v) => updateStepType(index, v as WorkflowStep["type"])}
                >
                  <SelectTrigger data-testid={`select-step-type-${index}`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="send_email">Send Email</SelectItem>
                    <SelectItem value="wait">Wait</SelectItem>
                    <SelectItem value="add_tag">Add Tag</SelectItem>
                    <SelectItem value="remove_tag">Remove Tag</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {step.type === "send_email" && (
                <div className="space-y-3">
                  <div className="space-y-2">
                    <Label>Subject</Label>
                    <Input
                      placeholder="Email subject"
                      value={(step.config.subject as string) || ""}
                      onChange={(e) => updateStepConfig(index, "subject", e.target.value)}
                      data-testid={`input-step-subject-${index}`}
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-2">
                      <Label>From Name</Label>
                      <Input
                        placeholder="Sender name"
                        value={(step.config.fromName as string) || ""}
                        onChange={(e) => updateStepConfig(index, "fromName", e.target.value)}
                        data-testid={`input-step-from-name-${index}`}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>From Email</Label>
                      <Input
                        placeholder="sender@example.com"
                        value={(step.config.fromEmail as string) || ""}
                        onChange={(e) => updateStepConfig(index, "fromEmail", e.target.value)}
                        data-testid={`input-step-from-email-${index}`}
                      />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label>HTML Content</Label>
                    <Textarea
                      placeholder="<html>...</html>"
                      value={(step.config.htmlContent as string) || ""}
                      onChange={(e) => updateStepConfig(index, "htmlContent", e.target.value)}
                      className="resize-none font-mono text-sm"
                      rows={4}
                      data-testid={`input-step-html-${index}`}
                    />
                  </div>
                </div>
              )}

              {step.type === "wait" && (
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-2">
                    <Label>Duration</Label>
                    <Input
                      type="number"
                      min={1}
                      placeholder="1"
                      value={(step.config.duration as number) || ""}
                      onChange={(e) => updateStepConfig(index, "duration", parseInt(e.target.value) || 0)}
                      data-testid={`input-step-duration-${index}`}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Unit</Label>
                    <Select
                      value={(step.config.unit as string) || "hours"}
                      onValueChange={(v) => updateStepConfig(index, "unit", v)}
                    >
                      <SelectTrigger data-testid={`select-step-unit-${index}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="minutes">Minutes</SelectItem>
                        <SelectItem value="hours">Hours</SelectItem>
                        <SelectItem value="days">Days</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              )}

              {(step.type === "add_tag" || step.type === "remove_tag") && (
                <div className="space-y-2">
                  <Label>Tag Name</Label>
                  <Input
                    placeholder="e.g., engaged"
                    value={(step.config.tagName as string) || ""}
                    onChange={(e) => updateStepConfig(index, "tagName", e.target.value)}
                    data-testid={`input-step-tag-${index}`}
                  />
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2" data-testid="text-page-title">
            <Workflow className="h-6 w-6" />
            Automation
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Create automated email workflows triggered by subscriber actions
          </p>
        </div>

        <Dialog open={isCreateOpen} onOpenChange={(open) => { setIsCreateOpen(open); if (!open) resetForm(); }}>
          <DialogTrigger asChild>
            <Button data-testid="button-create-workflow">
              <Plus className="h-4 w-4 mr-1" />
              New Workflow
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-[600px]">
            <DialogHeader>
              <DialogTitle>Create Automation Workflow</DialogTitle>
              <DialogDescription>
                Set up a new automated workflow with triggers and steps.
              </DialogDescription>
            </DialogHeader>
            {workflowFormContent}
            <DialogFooter>
              <Button variant="outline" onClick={() => { setIsCreateOpen(false); resetForm(); }} data-testid="button-cancel-create">
                Cancel
              </Button>
              <Button onClick={handleSubmit} disabled={createMutation.isPending} data-testid="button-submit-workflow">
                {createMutation.isPending ? "Creating..." : "Create Workflow"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1, 2, 3].map((i) => (
            <Card key={i}>
              <CardHeader>
                <Skeleton className="h-5 w-3/4" />
                <Skeleton className="h-4 w-1/2 mt-2" />
              </CardHeader>
              <CardContent>
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-2/3 mt-2" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : !workflows?.length ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <GitBranch className="h-12 w-12 text-muted-foreground mb-4" />
            <h3 className="text-lg font-medium mb-1">No workflows yet</h3>
            <p className="text-sm text-muted-foreground mb-4">
              Create your first automation workflow to engage subscribers automatically.
            </p>
            <Button onClick={() => setIsCreateOpen(true)} data-testid="button-create-first-workflow">
              <Plus className="h-4 w-4 mr-1" />
              Create Workflow
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {workflows.map((workflow) => {
            const workflowSteps = (workflow.steps as WorkflowStep[]) || [];
            return (
              <Card
                key={workflow.id}
                className="hover-elevate cursor-pointer"
                data-testid={`card-workflow-${workflow.id}`}
                onClick={() => setViewingEnrollments(workflow)}
              >
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <CardTitle className="text-base truncate" data-testid={`text-workflow-name-${workflow.id}`}>
                        {workflow.name}
                      </CardTitle>
                      {workflow.description && (
                        <CardDescription className="mt-1 line-clamp-2" data-testid={`text-workflow-desc-${workflow.id}`}>
                          {workflow.description}
                        </CardDescription>
                      )}
                    </div>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
                        <Button variant="ghost" size="icon" data-testid={`button-workflow-menu-${workflow.id}`}>
                          <MoreVertical className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {workflow.status === "active" ? (
                          <DropdownMenuItem
                            onClick={(e) => { e.stopPropagation(); pauseMutation.mutate(workflow.id); }}
                            data-testid={`button-pause-${workflow.id}`}
                          >
                            <Pause className="h-4 w-4 mr-2" />
                            Pause
                          </DropdownMenuItem>
                        ) : (
                          <DropdownMenuItem
                            onClick={(e) => { e.stopPropagation(); activateMutation.mutate(workflow.id); }}
                            data-testid={`button-activate-${workflow.id}`}
                          >
                            <Play className="h-4 w-4 mr-2" />
                            Activate
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuItem
                          onClick={(e) => { e.stopPropagation(); setViewingEnrollments(workflow); }}
                          data-testid={`button-view-enrollments-${workflow.id}`}
                        >
                          <Users className="h-4 w-4 mr-2" />
                          View Enrollments
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          className="text-destructive focus:text-destructive"
                          onClick={(e) => { e.stopPropagation(); setDeleteConfirm(workflow); }}
                          data-testid={`button-delete-${workflow.id}`}
                        >
                          <Trash2 className="h-4 w-4 mr-2" />
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge className={statusColors[workflow.status] || statusColors.draft} data-testid={`badge-status-${workflow.id}`}>
                      {workflow.status}
                    </Badge>
                    <Badge variant="outline" className="text-xs">
                      {triggerTypeLabels[workflow.triggerType] || workflow.triggerType}
                    </Badge>
                  </div>

                  <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
                    <span className="flex items-center gap-1" data-testid={`text-steps-count-${workflow.id}`}>
                      <ArrowRight className="h-3 w-3" />
                      {workflowSteps.length} step{workflowSteps.length !== 1 ? "s" : ""}
                    </span>
                    <span className="flex items-center gap-1" data-testid={`text-enrolled-${workflow.id}`}>
                      <Users className="h-3 w-3" />
                      {workflow.totalEnrolled} enrolled
                    </span>
                  </div>

                  <div className="flex items-center gap-4 text-xs text-muted-foreground flex-wrap">
                    <span data-testid={`text-completed-${workflow.id}`}>
                      {workflow.totalCompleted} completed
                    </span>
                    <span data-testid={`text-failed-${workflow.id}`}>
                      {workflow.totalFailed} failed
                    </span>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <Dialog open={!!deleteConfirm} onOpenChange={(open) => { if (!open) setDeleteConfirm(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Workflow</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete "{deleteConfirm?.name}"? This will also remove all enrollments. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteConfirm(null)} data-testid="button-cancel-delete">
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => deleteConfirm && deleteMutation.mutate(deleteConfirm.id)}
              disabled={deleteMutation.isPending}
              data-testid="button-confirm-delete"
            >
              {deleteMutation.isPending ? "Deleting..." : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!viewingEnrollments} onOpenChange={(open) => { if (!open) setViewingEnrollments(null); }}>
        <DialogContent className="sm:max-w-[600px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Users className="h-5 w-5" />
              Enrollments - {viewingEnrollments?.name}
            </DialogTitle>
            <DialogDescription>
              Subscribers enrolled in this workflow
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[400px] overflow-y-auto space-y-2">
            {!enrollmentsData?.enrollments?.length ? (
              <p className="text-sm text-muted-foreground text-center py-8">
                No subscribers enrolled yet.
              </p>
            ) : (
              enrollmentsData.enrollments.map((enrollment) => (
                <div
                  key={enrollment.id}
                  className="flex items-center justify-between gap-4 p-3 rounded-md bg-muted/50"
                  data-testid={`enrollment-${enrollment.id}`}
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate" data-testid={`text-enrollment-email-${enrollment.id}`}>
                      {enrollment.subscriberEmail || enrollment.subscriberId}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Step {enrollment.currentStepIndex + 1}
                      {enrollment.enrolledAt && (
                        <span className="ml-2">
                          Enrolled {new Date(enrollment.enrolledAt).toLocaleDateString()}
                        </span>
                      )}
                    </p>
                  </div>
                  <Badge
                    variant={
                      enrollment.status === "active"
                        ? "default"
                        : enrollment.status === "completed"
                        ? "outline"
                        : enrollment.status === "failed"
                        ? "destructive"
                        : "secondary"
                    }
                    data-testid={`badge-enrollment-status-${enrollment.id}`}
                  >
                    {enrollment.status}
                  </Badge>
                </div>
              ))
            )}
            {enrollmentsData && enrollmentsData.total > enrollmentsData.enrollments.length && (
              <p className="text-xs text-muted-foreground text-center pt-2">
                Showing {enrollmentsData.enrollments.length} of {enrollmentsData.total} enrollments
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setViewingEnrollments(null)} data-testid="button-close-enrollments">
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
