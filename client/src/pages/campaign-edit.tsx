import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useLocation, useRoute, Link } from "wouter";
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
  Upload,
  Code,
  X,
  AlertCircle,
  Loader2,
  RefreshCw,
} from "lucide-react";
import type { Mta, Segment, InsertCampaign, Campaign } from "@shared/schema";

const steps = [
  { id: 1, title: "Basic Info", icon: Mail },
  { id: 2, title: "Audience", icon: Users },
  { id: 3, title: "Content", icon: FileText },
  { id: 4, title: "Tracking", icon: Settings },
  { id: 5, title: "Schedule", icon: Clock },
];

const sendingSpeeds = [
  { value: "slow", label: "Slow", description: "500 emails/min" },
  { value: "medium", label: "Medium", description: "1,000 emails/min" },
  { value: "fast", label: "Fast", description: "2,000 emails/min" },
  { value: "godzilla", label: "Godzilla", description: "3,000 emails/min" },
];

export default function CampaignEdit() {
  const [, navigate] = useLocation();
  const [, params] = useRoute("/campaigns/:id/edit");
  const campaignId = params?.id;
  
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
    htmlContent: "",
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
  const [htmlLoaded, setHtmlLoaded] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [showPreview, setShowPreview] = useState(true);
  const [testEmail, setTestEmail] = useState("");
  const [sendingTest, setSendingTest] = useState(false);
  const [dataLoaded, setDataLoaded] = useState(false);
  const [processingImages, setProcessingImages] = useState(false);
  const { toast } = useToast();

  const processHtmlImages = async (html: string, mtaId?: string): Promise<string> => {
    if (!campaignId) return html;
    
    try {
      setProcessingImages(true);
      const res = await apiRequest("POST", `/api/campaigns/${campaignId}/process-html`, {
        html,
        ...(mtaId ? { mtaId } : {}),
      });
      const data = await res.json();
      
      if (data.downloaded > 0) {
        toast({
          title: "Images processed",
          description: `Downloaded ${data.downloaded} image(s) to local storage.${data.failed > 0 ? ` ${data.failed} failed.` : ""}`,
        });
      }
      
      return data.html;
    } catch (error) {
      console.error("Error processing HTML images:", error);
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      toast({
        title: "Image processing failed",
        description: `Could not process images: ${errorMessage}. Using original HTML.`,
        variant: "destructive",
      });
      return html;
    } finally {
      setProcessingImages(false);
    }
  };

  const { data: campaign, isLoading: loadingCampaign, error: campaignError } = useQuery<Campaign>({
    queryKey: ["/api/campaigns", campaignId],
    enabled: !!campaignId,
    staleTime: 0,
    refetchOnMount: "always",
  });

  useEffect(() => {
    if (campaign && !dataLoaded) {
      setFormData({
        name: campaign.name || "",
        mtaId: campaign.mtaId || "",
        segmentId: campaign.segmentId || "",
        fromName: campaign.fromName || "",
        fromEmail: campaign.fromEmail || "",
        replyEmail: campaign.replyEmail || "",
        subject: campaign.subject || "",
        preheader: campaign.preheader || "",
        htmlContent: campaign.htmlContent || "",
        trackClicks: campaign.trackClicks ?? true,
        trackOpens: campaign.trackOpens ?? true,
        unsubscribeText: campaign.unsubscribeText || "Unsubscribe",
        companyAddress: campaign.companyAddress || "",
        sendingSpeed: (campaign.sendingSpeed as "slow" | "medium" | "fast" | "godzilla") || "medium",
        openTag: campaign.openTag || "",
        clickTag: campaign.clickTag || "",
        unsubscribeTag: campaign.unsubscribeTag || "",
        scheduledAt: campaign.scheduledAt,
        status: campaign.status || "draft",
      });
      if (campaign.htmlContent) {
        setHtmlLoaded(true);
      }
      setDataLoaded(true);
    }
  }, [campaign, dataLoaded]);

  const formatParisTime = (date: Date | null): string => {
    if (!date) return "";
    const parisDate = new Date(date.toLocaleString("en-US", { timeZone: "Europe/Paris" }));
    const year = parisDate.getFullYear();
    const month = String(parisDate.getMonth() + 1).padStart(2, "0");
    const day = String(parisDate.getDate()).padStart(2, "0");
    const hours = String(parisDate.getHours()).padStart(2, "0");
    const minutes = String(parisDate.getMinutes()).padStart(2, "0");
    return `${year}-${month}-${day}T${hours}:${minutes}`;
  };

  const parseParisTime = (dateStr: string): Date | null => {
    if (!dateStr) return null;
    const [datePart, timePart] = dateStr.split("T");
    const [year, month, day] = datePart.split("-").map(Number);
    const [hours, minutes] = timePart.split(":").map(Number);
    const parisDateStr = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:00`;
    const utcDate = new Date(parisDateStr + "+01:00");
    return utcDate;
  };

  const handleHtmlDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    
    const file = e.dataTransfer.files[0];
    if (file && (file.type === "text/html" || file.name.endsWith(".html") || file.name.endsWith(".htm"))) {
      const reader = new FileReader();
      reader.onload = async (event) => {
        const content = event.target?.result as string;
        const processedHtml = await processHtmlImages(content, formData.mtaId || undefined);
        updateField("htmlContent", processedHtml);
        setHtmlLoaded(true);
      };
      reader.readAsText(file);
    } else {
      toast({
        title: "Invalid file",
        description: "Please drop an HTML file (.html or .htm)",
        variant: "destructive",
      });
    }
  };

  const handleHtmlFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = async (event) => {
        const content = event.target?.result as string;
        const processedHtml = await processHtmlImages(content, formData.mtaId || undefined);
        updateField("htmlContent", processedHtml);
        setHtmlLoaded(true);
      };
      reader.readAsText(file);
    }
  };

  const clearHtml = () => {
    updateField("htmlContent", "");
    setHtmlLoaded(false);
  };

  const { data: mtas, isLoading: loadingMtas } = useQuery<Mta[]>({
    queryKey: ["/api/mtas"],
  });

  const { data: segments, isLoading: loadingSegments } = useQuery<Segment[]>({
    queryKey: ["/api/segments"],
  });

  const countMutation = useMutation({
    mutationFn: async (segmentId: string) => {
      const res = await apiRequest("GET", `/api/segments/${segmentId}/count`);
      return res.json();
    },
    onSuccess: (data: { count: number }) => {
      setSubscriberCount(data?.count ?? 0);
    },
  });

  useEffect(() => {
    if (formData.segmentId) {
      countMutation.mutate(formData.segmentId);
    }
  }, [formData.segmentId]);

  const updateMutation = useMutation({
    mutationFn: (data: Partial<InsertCampaign>) =>
      apiRequest("PATCH", `/api/campaigns/${campaignId}`, data),
    onMutate: async (newData) => {
      await queryClient.cancelQueries({ queryKey: ["/api/campaigns", campaignId] });
      const previousCampaign = queryClient.getQueryData(["/api/campaigns", campaignId]);
      queryClient.setQueryData(["/api/campaigns", campaignId], (old: Campaign | undefined) => 
        old ? { ...old, ...newData } : old
      );
      return { previousCampaign };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/campaigns"] });
      queryClient.invalidateQueries({ queryKey: ["/api/campaigns", campaignId] });
      toast({
        title: "Campaign updated",
        description: "Your campaign has been saved.",
      });
      navigate("/campaigns");
    },
    onError: (_error, _newData, context) => {
      if (context?.previousCampaign) {
        queryClient.setQueryData(["/api/campaigns", campaignId], context.previousCampaign);
      }
      toast({
        title: "Error",
        description: "Failed to update campaign. Please try again.",
        variant: "destructive",
      });
    },
  });

  const sendMutation = useMutation({
    mutationFn: (data: Partial<InsertCampaign>) =>
      apiRequest("PATCH", `/api/campaigns/${campaignId}`, { ...data, status: formData.scheduledAt ? "scheduled" : "sending" }),
    onMutate: async (newData) => {
      await queryClient.cancelQueries({ queryKey: ["/api/campaigns", campaignId] });
      const previousCampaign = queryClient.getQueryData(["/api/campaigns", campaignId]);
      queryClient.setQueryData(["/api/campaigns", campaignId], (old: Campaign | undefined) => 
        old ? { ...old, ...newData } : old
      );
      return { previousCampaign };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/campaigns"] });
      queryClient.invalidateQueries({ queryKey: ["/api/campaigns", campaignId] });
      toast({
        title: formData.scheduledAt ? "Campaign scheduled" : "Campaign started",
        description: formData.scheduledAt
          ? "Your campaign has been scheduled for sending."
          : "Your campaign is now being sent.",
      });
      navigate("/campaigns");
    },
    onError: (_error, _newData, context) => {
      if (context?.previousCampaign) {
        queryClient.setQueryData(["/api/campaigns", campaignId], context.previousCampaign);
      }
      toast({
        title: "Error",
        description: "Failed to start campaign. Please try again.",
        variant: "destructive",
      });
    },
  });

  const sendTestEmail = async () => {
    if (!testEmail || !formData.mtaId) {
      toast({
        title: "Missing information",
        description: "Please enter a test email and select an MTA server.",
        variant: "destructive",
      });
      return;
    }
    
    setSendingTest(true);
    try {
      const res = await apiRequest("POST", "/api/campaigns/test", {
        email: testEmail,
        mtaId: formData.mtaId,
        fromName: formData.fromName,
        fromEmail: formData.fromEmail,
        subject: formData.subject,
        preheader: formData.preheader,
        htmlContent: formData.htmlContent,
        companyAddress: formData.companyAddress,
        unsubscribeText: formData.unsubscribeText,
        trackOpens: formData.trackOpens,
        trackClicks: formData.trackClicks,
      });
      
      if (res.ok) {
        toast({
          title: "Test sent",
          description: `Test email sent to ${testEmail}`,
        });
      } else {
        const error = await res.json();
        throw new Error(error.error || "Failed to send test");
      }
    } catch (error: any) {
      toast({
        title: "Failed to send test",
        description: error.message || "Please check MTA configuration.",
        variant: "destructive",
      });
    } finally {
      setSendingTest(false);
    }
  };

  const updateField = (field: keyof InsertCampaign, value: unknown) => {
    setFormData({ ...formData, [field]: value });
  };

  const autoSaveMutation = useMutation({
    mutationFn: (data: Partial<InsertCampaign>) =>
      apiRequest("PATCH", `/api/campaigns/${campaignId}`, data),
    onMutate: async (newData) => {
      await queryClient.cancelQueries({ queryKey: ["/api/campaigns", campaignId] });
      queryClient.setQueryData(["/api/campaigns", campaignId], (old: Campaign | undefined) => 
        old ? { ...old, ...newData } : old
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/campaigns"] });
    },
  });

  const handleMtaSelect = (mtaId: string) => {
    const selectedMta = mtas?.find(m => m.id === mtaId);
    setFormData(prev => ({
      ...prev,
      mtaId,
      ...(selectedMta?.fromName ? { fromName: selectedMta.fromName } : {}),
      ...(selectedMta?.fromEmail ? { fromEmail: selectedMta.fromEmail } : {}),
      ...(selectedMta?.unsubscribeText ? { unsubscribeText: selectedMta.unsubscribeText } : {}),
      ...(selectedMta?.companyAddress ? { companyAddress: selectedMta.companyAddress } : {}),
    }));
  };

  const isStepValid = (step: number): boolean => {
    switch (step) {
      case 1:
        return !!(formData.name && formData.fromName && formData.fromEmail && formData.mtaId);
      case 2:
        return !!formData.segmentId;
      case 3:
        return !!(formData.subject && formData.htmlContent);
      case 4:
        return true;
      case 5:
        return true;
      default:
        return false;
    }
  };

  const nextStep = () => {
    if (isStepValid(currentStep) && currentStep < 5) {
      autoSaveMutation.mutate(formData);
      setCurrentStep(currentStep + 1);
    }
  };

  const prevStep = () => {
    if (currentStep > 1) {
      autoSaveMutation.mutate(formData);
      setCurrentStep(currentStep - 1);
    }
  };

  const handleSaveDraft = () => {
    updateMutation.mutate(formData);
  };

  const handleSend = () => {
    sendMutation.mutate(formData);
  };

  if (loadingCampaign) {
    return (
      <div className="p-6 lg:p-8 space-y-6">
        <div className="flex items-center gap-4">
          <Skeleton className="h-10 w-10" />
          <div className="space-y-2">
            <Skeleton className="h-8 w-48" />
            <Skeleton className="h-4 w-64" />
          </div>
        </div>
        <div className="flex gap-2">
          {steps.map((step) => (
            <Skeleton key={step.id} className="h-10 w-28" />
          ))}
        </div>
        <Card>
          <CardHeader>
            <Skeleton className="h-6 w-32" />
            <Skeleton className="h-4 w-24" />
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (campaignError) {
    return (
      <div className="p-6 lg:p-8">
        <Card>
          <CardContent className="p-8 text-center">
            <AlertCircle className="h-16 w-16 mx-auto mb-4 text-destructive" />
            <h2 className="text-2xl font-bold mb-2">Campaign Not Found</h2>
            <p className="text-muted-foreground mb-6">
              This campaign no longer exists or could not be loaded.
            </p>
            <Button asChild>
              <Link href="/campaigns" data-testid="link-back-campaigns-error">
                Back to Campaigns
              </Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (campaign && campaign.status !== "draft") {
    return (
      <div className="p-6 lg:p-8">
        <Card>
          <CardContent className="p-8 text-center">
            <AlertCircle className="h-16 w-16 mx-auto mb-4 text-muted-foreground" />
            <h2 className="text-2xl font-bold mb-2">Campaign Cannot Be Edited</h2>
            <p className="text-muted-foreground mb-6">
              This campaign has a status of "{campaign.status}" and can no longer be edited.
              Only draft campaigns can be modified.
            </p>
            <div className="flex justify-center gap-4">
              <Button variant="outline" asChild>
                <Link href={`/campaigns/${campaignId}`} data-testid="link-view-campaign">
                  View Campaign
                </Link>
              </Button>
              <Button asChild>
                <Link href="/campaigns" data-testid="link-back-campaigns">
                  Back to Campaigns
                </Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

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
            <div className="space-y-2">
              <Label>Sending Server *</Label>
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
                      onClick={() => handleMtaSelect(mta.id)}
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
                          {(mta.fromName || mta.fromEmail) && (
                            <p className="text-xs text-muted-foreground">
                              {mta.fromName}{mta.fromName && mta.fromEmail ? " · " : ""}{mta.fromEmail}
                            </p>
                          )}
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
                  <Button variant="ghost" onClick={() => navigate("/mtas")} className="text-primary">
                    Configure MTAs
                  </Button>
                </div>
              )}
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
                  <Button variant="ghost" onClick={() => navigate("/segments")} className="text-primary">
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

      case 3:
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
              <Label>HTML Content *</Label>
              {!htmlLoaded ? (
                <div
                  className={`border-2 border-dashed rounded-md p-8 text-center transition-colors ${
                    isDragging
                      ? "border-primary bg-primary/5"
                      : "border-muted-foreground/25 hover:border-muted-foreground/50"
                  }`}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setIsDragging(true);
                  }}
                  onDragLeave={() => setIsDragging(false)}
                  onDrop={handleHtmlDrop}
                  data-testid="dropzone-html"
                >
                  {processingImages ? (
                    <>
                      <Loader2 className="h-12 w-12 mx-auto mb-4 text-muted-foreground animate-spin" />
                      <p className="text-lg font-medium mb-2">Processing images...</p>
                      <p className="text-sm text-muted-foreground mb-4">
                        Downloading and saving images locally
                      </p>
                    </>
                  ) : (
                    <>
                      <Upload className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
                      <p className="text-lg font-medium mb-2">Drop your HTML file here</p>
                      <p className="text-sm text-muted-foreground mb-4">
                        or click to browse for a file
                      </p>
                      <input
                        type="file"
                        accept=".html,.htm,text/html"
                        onChange={handleHtmlFileSelect}
                        className="hidden"
                        id="html-file-input"
                        data-testid="input-html-file"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => document.getElementById("html-file-input")?.click()}
                        data-testid="button-browse-html"
                      >
                        <Upload className="h-4 w-4 mr-2" />
                        Browse Files
                      </Button>
                    </>
                  )}
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        variant={showPreview ? "default" : "outline"}
                        size="sm"
                        onClick={() => setShowPreview(true)}
                        data-testid="button-show-preview"
                      >
                        <Eye className="h-4 w-4 mr-1" />
                        Preview
                      </Button>
                      <Button
                        type="button"
                        variant={!showPreview ? "default" : "outline"}
                        size="sm"
                        onClick={() => setShowPreview(false)}
                        data-testid="button-show-code"
                      >
                        <Code className="h-4 w-4 mr-1" />
                        Code
                      </Button>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={async () => {
                          const processed = await processHtmlImages(formData.htmlContent, formData.mtaId || undefined);
                          updateField("htmlContent", processed);
                        }}
                        disabled={processingImages}
                        data-testid="button-reprocess-images"
                      >
                        {processingImages ? (
                          <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                        ) : (
                          <RefreshCw className="h-4 w-4 mr-1" />
                        )}
                        Re-process images
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={clearHtml}
                        className="text-destructive"
                        data-testid="button-clear-html"
                      >
                        <X className="h-4 w-4 mr-1" />
                        Clear
                      </Button>
                    </div>
                  </div>
                  {showPreview ? (
                    <div className="border rounded-md bg-white overflow-hidden">
                      <iframe
                        srcDoc={formData.htmlContent}
                        className="w-full min-h-[400px] border-0"
                        title="Email Preview"
                        sandbox="allow-same-origin"
                        data-testid="iframe-html-preview"
                      />
                    </div>
                  ) : (
                    <Textarea
                      id="html-content"
                      placeholder="<html>...</html>"
                      value={formData.htmlContent}
                      onChange={(e) => updateField("htmlContent", e.target.value)}
                      className="font-mono text-sm min-h-[400px]"
                      data-testid="textarea-html-content"
                    />
                  )}
                </div>
              )}
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

      case 4:
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

      case 5:
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
              <Label htmlFor="schedule">Schedule (optional) - Paris Time</Label>
              <Input
                id="schedule"
                type="datetime-local"
                value={formData.scheduledAt ? formatParisTime(new Date(formData.scheduledAt)) : ""}
                onChange={(e) => updateField("scheduledAt", parseParisTime(e.target.value))}
                data-testid="input-schedule"
              />
              <p className="text-xs text-muted-foreground">
                Leave empty to send immediately, or pick a date and time (Paris timezone)
              </p>
            </div>

            <Card>
              <CardContent className="p-4 space-y-3">
                <Label>Send Test Email</Label>
                <div className="flex gap-2">
                  <Input
                    type="email"
                    placeholder="test@example.com"
                    value={testEmail}
                    onChange={(e) => setTestEmail(e.target.value)}
                    className="flex-1"
                    data-testid="input-test-email"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    onClick={sendTestEmail}
                    disabled={sendingTest || !testEmail || !formData.mtaId || !formData.htmlContent}
                    data-testid="button-send-test"
                  >
                    {sendingTest ? (
                      <>Sending...</>
                    ) : (
                      <>
                        <Mail className="h-4 w-4 mr-2" />
                        Send Test
                      </>
                    )}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Send a test email to verify your content before launching
                </p>
              </CardContent>
            </Card>

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
          <h1 className="text-3xl font-bold tracking-tight">Edit Campaign</h1>
          <p className="text-muted-foreground">
            Modify your email campaign settings
          </p>
        </div>
      </div>

      <div className="flex gap-2 overflow-x-auto pb-2">
        {steps.map((step) => (
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
            disabled={updateMutation.isPending || processingImages}
            data-testid="button-save-draft"
          >
            {updateMutation.isPending ? "Saving..." : "Save Changes"}
          </Button>
          {currentStep < 5 ? (
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
              disabled={sendMutation.isPending || !isStepValid(currentStep) || processingImages}
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
