import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useLocation } from "wouter";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Mail,
  Server,
  Users,
  FileText,
  Settings,
  Clock,
  Zap,
  Eye,
  MousePointer2,
} from "lucide-react";
import type { Mta, Segment, InsertCampaign } from "@shared/schema";

const steps = [
  { id: 1, title: "Basic Info", icon: Mail },
  { id: 2, title: "Server", icon: Server },
  { id: 3, title: "Audience", icon: Users },
  { id: 4, title: "Content", icon: FileText },
  { id: 5, title: "Tracking", icon: Settings },
  { id: 6, title: "Schedule", icon: Clock },
];

const sendingSpeeds = [
  { value: "slow", label: "Slow", description: "500 emails/min" },
  { value: "medium", label: "Medium", description: "1,000 emails/min" },
  { value: "fast", label: "Fast", description: "2,000 emails/min" },
  { value: "godzilla", label: "Godzilla", description: "3,000 emails/min" },
];

export default function CampaignNew() {
  const [, navigate] = useLocation();
  const [currentStep, setCurrentStep] = useState(1);
  const [formData, setFormData] = useState<Partial<InsertCampaign>>({
    name: "",
    mtaId: "",
    segmentId: "",
    fromName: "",
    fromEmail: "",
    replyEmail: "",
    subject: "",
    preheader: "",
    htmlContent: "<html><body><h1>Hello!</h1><p>Your content here...</p></body></html>",
    trackClicks: true,
    trackOpens: true,
    unsubscribeText: "Unsubscribe",
    companyAddress: "",
    sendingSpeed: "medium",
    openTag: "",
    clickTag: "",
    unsubscribeTag: "",
    scheduledAt: null,
    status: "draft",
  });
  const [subscriberCount, setSubscriberCount] = useState<number | null>(null);
  const { toast } = useToast();

  const { data: mtas, isLoading: loadingMtas } = useQuery<Mta[]>({
    queryKey: ["/api/mtas"],
  });

  const { data: segments, isLoading: loadingSegments } = useQuery<Segment[]>({
    queryKey: ["/api/segments"],
  });

  const countMutation = useMutation({
    mutationFn: (segmentId: string) =>
      apiRequest("GET", `/api/segments/${segmentId}/count`),
    onSuccess: (data: { count: number }) => {
      setSubscriberCount(data.count);
    },
  });

  useEffect(() => {
    if (formData.segmentId) {
      countMutation.mutate(formData.segmentId);
    }
  }, [formData.segmentId]);

  const createMutation = useMutation({
    mutationFn: (data: Partial<InsertCampaign>) =>
      apiRequest("POST", "/api/campaigns", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/campaigns"] });
      toast({
        title: "Campaign created",
        description: "Your campaign has been saved as draft.",
      });
      navigate("/campaigns");
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to create campaign. Please try again.",
        variant: "destructive",
      });
    },
  });

  const sendMutation = useMutation({
    mutationFn: (data: Partial<InsertCampaign>) =>
      apiRequest("POST", "/api/campaigns", { ...data, status: formData.scheduledAt ? "scheduled" : "sending" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/campaigns"] });
      toast({
        title: formData.scheduledAt ? "Campaign scheduled" : "Campaign started",
        description: formData.scheduledAt
          ? "Your campaign has been scheduled for sending."
          : "Your campaign is now being sent.",
      });
      navigate("/campaigns");
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to start campaign. Please try again.",
        variant: "destructive",
      });
    },
  });

  const updateField = (field: keyof InsertCampaign, value: unknown) => {
    setFormData({ ...formData, [field]: value });
  };

  const isStepValid = (step: number): boolean => {
    switch (step) {
      case 1:
        return !!(formData.name && formData.fromName && formData.fromEmail);
      case 2:
        return !!formData.mtaId;
      case 3:
        return !!formData.segmentId;
      case 4:
        return !!(formData.subject && formData.htmlContent);
      case 5:
        return true;
      case 6:
        return true;
      default:
        return false;
    }
  };

  const nextStep = () => {
    if (isStepValid(currentStep) && currentStep < 6) {
      setCurrentStep(currentStep + 1);
    }
  };

  const prevStep = () => {
    if (currentStep > 1) {
      setCurrentStep(currentStep - 1);
    }
  };

  const handleSaveDraft = () => {
    createMutation.mutate(formData);
  };

  const handleSend = () => {
    sendMutation.mutate(formData);
  };

  const renderStepContent = () => {
    switch (currentStep) {
      case 1:
        return (
          <div className="space-y-6">
            <div className="space-y-2">
              <Label htmlFor="campaign-name">Campaign Name *</Label>
              <Input
                id="campaign-name"
                placeholder="e.g., March Newsletter"
                value={formData.name}
                onChange={(e) => updateField("name", e.target.value)}
                data-testid="input-campaign-name"
              />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="from-name">From Name *</Label>
                <Input
                  id="from-name"
                  placeholder="Your Company"
                  value={formData.fromName}
                  onChange={(e) => updateField("fromName", e.target.value)}
                  data-testid="input-from-name"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="from-email">From Email *</Label>
                <Input
                  id="from-email"
                  type="email"
                  placeholder="hello@company.com"
                  value={formData.fromEmail}
                  onChange={(e) => updateField("fromEmail", e.target.value)}
                  data-testid="input-from-email"
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="reply-email">Reply-To Email (optional)</Label>
              <Input
                id="reply-email"
                type="email"
                placeholder="reply@company.com"
                value={formData.replyEmail || ""}
                onChange={(e) => updateField("replyEmail", e.target.value)}
                data-testid="input-reply-email"
              />
            </div>
          </div>
        );

      case 2:
        return (
          <div className="space-y-6">
            <div className="space-y-2">
              <Label>Select Sending Server *</Label>
              {loadingMtas ? (
                <Skeleton className="h-10 w-full" />
              ) : mtas && mtas.length > 0 ? (
                <div className="grid gap-3">
                  {mtas.filter(m => m.isActive).map((mta) => (
                    <div
                      key={mta.id}
                      className={`p-4 rounded-md border cursor-pointer transition-colors ${
                        formData.mtaId === mta.id
                          ? "border-primary bg-primary/5"
                          : "border-border hover:border-primary/50"
                      }`}
                      onClick={() => updateField("mtaId", mta.id)}
                      data-testid={`mta-option-${mta.id}`}
                    >
                      <div className="flex items-center gap-3">
                        <div className={`p-2 rounded-md ${formData.mtaId === mta.id ? "bg-primary" : "bg-muted"}`}>
                          <Server className={`h-4 w-4 ${formData.mtaId === mta.id ? "text-primary-foreground" : "text-muted-foreground"}`} />
                        </div>
                        <div>
                          <p className="font-medium">{mta.name}</p>
                          <p className="text-sm text-muted-foreground font-mono">
                            {mta.hostname}:{mta.port}
                          </p>
                        </div>
                        {formData.mtaId === mta.id && (
                          <Check className="h-5 w-5 text-primary ml-auto" />
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-8 text-muted-foreground">
                  <Server className="h-12 w-12 mx-auto mb-4 opacity-50" />
                  <p>No active sending servers available.</p>
                  <Button variant="link" onClick={() => navigate("/mtas")}>
                    Configure MTAs
                  </Button>
                </div>
              )}
            </div>
          </div>
        );

      case 3:
        return (
          <div className="space-y-6">
            <div className="space-y-2">
              <Label>Select Segment *</Label>
              {loadingSegments ? (
                <Skeleton className="h-10 w-full" />
              ) : segments && segments.length > 0 ? (
                <Select
                  value={formData.segmentId || ""}
                  onValueChange={(v) => updateField("segmentId", v)}
                >
                  <SelectTrigger data-testid="select-segment">
                    <SelectValue placeholder="Choose a segment" />
                  </SelectTrigger>
                  <SelectContent>
                    {segments.map((segment) => (
                      <SelectItem key={segment.id} value={segment.id}>
                        {segment.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <div className="text-center py-8 text-muted-foreground">
                  <Users className="h-12 w-12 mx-auto mb-4 opacity-50" />
                  <p>No segments available.</p>
                  <Button variant="link" onClick={() => navigate("/segments")}>
                    Create Segment
                  </Button>
                </div>
              )}
            </div>
            {subscriberCount !== null && (
              <Card>
                <CardContent className="flex items-center gap-4 p-4">
                  <Users className="h-8 w-8 text-primary" />
                  <div>
                    <p className="text-2xl font-bold">{subscriberCount.toLocaleString()}</p>
                    <p className="text-sm text-muted-foreground">subscribers in this segment</p>
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        );

      case 4:
        return (
          <div className="space-y-6">
            <div className="space-y-2">
              <Label htmlFor="subject">Subject Line *</Label>
              <Input
                id="subject"
                placeholder="Your email subject..."
                value={formData.subject}
                onChange={(e) => updateField("subject", e.target.value)}
                data-testid="input-subject"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="preheader">Preheader (optional)</Label>
              <Input
                id="preheader"
                placeholder="Preview text shown in inbox..."
                value={formData.preheader || ""}
                onChange={(e) => updateField("preheader", e.target.value)}
                data-testid="input-preheader"
              />
              <p className="text-xs text-muted-foreground">
                This text appears after the subject in most email clients
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="html-content">HTML Content *</Label>
              <Textarea
                id="html-content"
                placeholder="<html>...</html>"
                value={formData.htmlContent}
                onChange={(e) => updateField("htmlContent", e.target.value)}
                className="font-mono text-sm min-h-[300px]"
                data-testid="textarea-html-content"
              />
              <p className="text-xs text-muted-foreground">
                Paste or edit your HTML newsletter content
              </p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="unsubscribe-text">Unsubscribe Link Text</Label>
                <Input
                  id="unsubscribe-text"
                  placeholder="Unsubscribe"
                  value={formData.unsubscribeText || ""}
                  onChange={(e) => updateField("unsubscribeText", e.target.value)}
                  data-testid="input-unsubscribe-text"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="company-address">Company Address</Label>
                <Input
                  id="company-address"
                  placeholder="123 Main St, City, Country"
                  value={formData.companyAddress || ""}
                  onChange={(e) => updateField("companyAddress", e.target.value)}
                  data-testid="input-company-address"
                />
              </div>
            </div>
          </div>
        );

      case 5:
        return (
          <div className="space-y-6">
            <Card>
              <CardContent className="p-4 space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <Eye className="h-5 w-5 text-muted-foreground" />
                    <div>
                      <p className="font-medium">Track Opens</p>
                      <p className="text-sm text-muted-foreground">
                        Track when subscribers open your email
                      </p>
                    </div>
                  </div>
                  <Switch
                    checked={formData.trackOpens}
                    onCheckedChange={(v) => updateField("trackOpens", v)}
                    data-testid="switch-track-opens"
                  />
                </div>
                {formData.trackOpens && (
                  <div className="pl-8 space-y-2">
                    <Label htmlFor="open-tag">Add tag on open (optional)</Label>
                    <Input
                      id="open-tag"
                      placeholder="e.g., OPENED_MARCH"
                      value={formData.openTag || ""}
                      onChange={(e) => updateField("openTag", e.target.value.toUpperCase())}
                      data-testid="input-open-tag"
                    />
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-4 space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <MousePointer2 className="h-5 w-5 text-muted-foreground" />
                    <div>
                      <p className="font-medium">Track Clicks</p>
                      <p className="text-sm text-muted-foreground">
                        Track when subscribers click links
                      </p>
                    </div>
                  </div>
                  <Switch
                    checked={formData.trackClicks}
                    onCheckedChange={(v) => updateField("trackClicks", v)}
                    data-testid="switch-track-clicks"
                  />
                </div>
                {formData.trackClicks && (
                  <div className="pl-8 space-y-2">
                    <Label htmlFor="click-tag">Add tag on click (optional)</Label>
                    <Input
                      id="click-tag"
                      placeholder="e.g., CLICKED_MARCH"
                      value={formData.clickTag || ""}
                      onChange={(e) => updateField("clickTag", e.target.value.toUpperCase())}
                      data-testid="input-click-tag"
                    />
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-4 space-y-2">
                <Label htmlFor="unsub-tag">Add tag on unsubscribe (optional)</Label>
                <Input
                  id="unsub-tag"
                  placeholder="e.g., UNSUB_MARCH"
                  value={formData.unsubscribeTag || ""}
                  onChange={(e) => updateField("unsubscribeTag", e.target.value.toUpperCase())}
                  data-testid="input-unsubscribe-tag"
                />
                <p className="text-xs text-muted-foreground">
                  This tag will be added when a subscriber clicks the unsubscribe link
                </p>
              </CardContent>
            </Card>
          </div>
        );

      case 6:
        return (
          <div className="space-y-6">
            <div className="space-y-2">
              <Label>Sending Speed</Label>
              <div className="grid grid-cols-2 gap-3">
                {sendingSpeeds.map((speed) => (
                  <div
                    key={speed.value}
                    className={`p-4 rounded-md border cursor-pointer transition-colors ${
                      formData.sendingSpeed === speed.value
                        ? "border-primary bg-primary/5"
                        : "border-border hover:border-primary/50"
                    }`}
                    onClick={() => updateField("sendingSpeed", speed.value)}
                    data-testid={`speed-option-${speed.value}`}
                  >
                    <div className="flex items-center gap-2">
                      <Zap className={`h-4 w-4 ${formData.sendingSpeed === speed.value ? "text-primary" : "text-muted-foreground"}`} />
                      <span className="font-medium">{speed.label}</span>
                    </div>
                    <p className="text-sm text-muted-foreground mt-1">{speed.description}</p>
                  </div>
                ))}
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="schedule">Schedule (optional)</Label>
              <Input
                id="schedule"
                type="datetime-local"
                value={formData.scheduledAt ? new Date(formData.scheduledAt).toISOString().slice(0, 16) : ""}
                onChange={(e) => updateField("scheduledAt", e.target.value ? new Date(e.target.value) : null)}
                data-testid="input-schedule"
              />
              <p className="text-xs text-muted-foreground">
                Leave empty to send immediately, or pick a date and time
              </p>
            </div>

            {subscriberCount !== null && (
              <Card className="bg-primary/5 border-primary/20">
                <CardContent className="p-4">
                  <div className="flex items-center gap-4">
                    <Mail className="h-10 w-10 text-primary" />
                    <div>
                      <p className="text-sm text-muted-foreground">Ready to send to</p>
                      <p className="text-3xl font-bold text-primary">
                        {subscriberCount.toLocaleString()}
                      </p>
                      <p className="text-sm text-muted-foreground">subscribers</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        );

      default:
        return null;
    }
  };

  return (
    <div className="p-6 lg:p-8 space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={() => navigate("/campaigns")}>
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Create Campaign</h1>
          <p className="text-muted-foreground">
            Follow the steps to create a new email campaign
          </p>
        </div>
      </div>

      <div className="flex gap-2 overflow-x-auto pb-2">
        {steps.map((step, index) => (
          <div
            key={step.id}
            className={`flex items-center gap-2 px-4 py-2 rounded-md cursor-pointer transition-colors whitespace-nowrap ${
              currentStep === step.id
                ? "bg-primary text-primary-foreground"
                : currentStep > step.id
                ? "bg-muted text-foreground"
                : "bg-muted/50 text-muted-foreground"
            }`}
            onClick={() => step.id <= currentStep && setCurrentStep(step.id)}
          >
            <step.icon className="h-4 w-4" />
            <span className="text-sm font-medium">{step.title}</span>
            {currentStep > step.id && <Check className="h-4 w-4" />}
          </div>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {(() => {
              const StepIcon = steps[currentStep - 1].icon;
              return <StepIcon className="h-5 w-5" />;
            })()}
            {steps[currentStep - 1].title}
          </CardTitle>
          <CardDescription>
            Step {currentStep} of {steps.length}
          </CardDescription>
        </CardHeader>
        <CardContent>{renderStepContent()}</CardContent>
      </Card>

      <div className="flex items-center justify-between gap-4 flex-wrap">
        <Button
          variant="outline"
          onClick={prevStep}
          disabled={currentStep === 1}
          data-testid="button-prev-step"
        >
          <ArrowLeft className="h-4 w-4 mr-2" />
          Previous
        </Button>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={handleSaveDraft}
            disabled={createMutation.isPending}
            data-testid="button-save-draft"
          >
            {createMutation.isPending ? "Saving..." : "Save Draft"}
          </Button>
          {currentStep < 6 ? (
            <Button
              onClick={nextStep}
              disabled={!isStepValid(currentStep)}
              data-testid="button-next-step"
            >
              Next
              <ArrowRight className="h-4 w-4 ml-2" />
            </Button>
          ) : (
            <Button
              onClick={handleSend}
              disabled={sendMutation.isPending || !isStepValid(currentStep)}
              data-testid="button-send-campaign"
            >
              {sendMutation.isPending
                ? "Starting..."
                : formData.scheduledAt
                ? "Schedule Campaign"
                : "Send Now"}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
