import { useState, useEffect, useCallback, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useLocation, Link } from "wouter";
import { useHtmlImageProcessor } from "@/hooks/use-html-image-processor";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
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
  Zap,
  Eye,
  MousePointer2,
  Code,
  X,
  Loader2,
  Save,
  Filter,
  AlertTriangle,
} from "lucide-react";
import type { Mta, Segment, InsertCampaign } from "@shared/schema";
import DateTimePicker from "@/components/date-time-picker";
import { SegmentCombobox } from "@/components/segment-combobox";
import { HtmlDropzone } from "@/components/campaign-wizard/html-dropzone";
import { TagSuggestionsButton } from "@/components/campaign-wizard/tag-suggestions";
import {
  withBaseHref,
  steps,
  normalizeHost,
  imageSrcHost,
  findExternalImageSrcs,
  normalizeForApi,
  buildBrandMessage,
  type BrandUnsubResult,
} from "@/lib/campaign-wizard";
import {
  useMtaScheduleInsights,
  MtaLowOpenWarning,
  MtaScheduledCampaigns,
} from "@/components/campaign-wizard/mta-insights";

const sendingSpeeds = [
  { value: "drip", label: "Drip", description: "100 emails/min" },
  { value: "very_slow", label: "Very Slow", description: "250 emails/min" },
  { value: "slow", label: "Slow", description: "500 emails/min" },
  { value: "medium", label: "Medium", description: "2,000 emails/min" },
  { value: "fast", label: "Fast", description: "5,000 emails/min" },
  { value: "godzilla", label: "Godzilla", description: "60,000 emails/min" },
];

export default function CampaignNew() {
  const [, navigate] = useLocation();
  const [currentStep, setCurrentStep] = useState(1);
  // Task #138: tracks whether the exclusion combobox is revealed.
  // Independent of `excludeSegmentId` so the "+ Add" button only opens
  // an empty selector instead of silently picking the first option.
  const [showExclusion, setShowExclusion] = useState(false);
  const [formData, setFormData] = useState<Partial<InsertCampaign>>({
    name: "",
    mtaId: "",
    segmentId: "",
    excludeSegmentId: "",
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
    // Default the schedule step to the moment the campaign was created.
    scheduledAt: new Date(),
    status: "draft",
    // Auto-resend to openers (Task #56). Defaults: disabled, 36h delay.
    followUpEnabled: false,
    followUpDelayHours: 36,
  });
  const [subscriberCount, setSubscriberCount] = useState<number | null>(null);
  const [htmlLoaded, setHtmlLoaded] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [showPreview, setShowPreview] = useState(true);
  const [testEmail, setTestEmail] = useState("");
  const [sendingTest, setSendingTest] = useState(false);
  const [assetSessionId, setAssetSessionId] = useState<string | null>(null);
  const [campaignId, setCampaignId] = useState<string | null>(null);
  const [savedIndicator, setSavedIndicator] = useState(false);
  // Brand-unsubscribe safeguard (Task #209): gates the Content -> Tracking step.
  const [brandCheckPending, setBrandCheckPending] = useState(false);
  const [brandWarning, setBrandWarning] = useState<string | null>(null);
  const [brandBlock, setBrandBlock] = useState<string | null>(null);
  const { toast } = useToast();

  const {
    processing: processingImages,
    progress: imageProgress,
    processHtmlImages,
    cancel: cancelImageProcessing,
  } = useHtmlImageProcessor({
    getCampaignId: useCallback(() => campaignId, [campaignId]),
    getSessionId: useCallback(() => assetSessionId, [assetSessionId]),
    setSessionId: setAssetSessionId,
  });

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
  const { data: mtaInsights, refetch: refetchMtaInsights } = useMtaScheduleInsights();

  // Safeguard: flag image src= URLs in the uploaded/pasted HTML that point to a
  // domain not attributed to the SELECTED MTA. The send-time image rewriter only
  // rehosts RELATIVE paths (/images/, /campaigns/) — absolute external URLs are
  // left untouched, so they ship as-is and can hurt deliverability / expose a
  // third-party host. This is BLOCKING: Content -> Tracking is refused while
  // any offending src remains.
  const ourImageHosts = useMemo(() => {
    const set = new Set<string>();
    const selectedMta = mtas?.find((m) => m.id === formData.mtaId);
    for (const d of [selectedMta?.imageHostingDomain, selectedMta?.trackingDomain, selectedMta?.openTrackingDomain]) {
      const h = normalizeHost(d);
      if (h) set.add(h);
    }
    return set;
  }, [mtas, formData.mtaId]);

  // Only enforce once the MTA list is loaded AND the selected MTA actually has
  // at least one configured domain — otherwise an in-flight query or an
  // unconfigured MTA would falsely flag every absolute URL and trap the wizard.
  const externalImageSrcs = useMemo(
    () => (ourImageHosts.size > 0 ? findExternalImageSrcs(formData.htmlContent ?? "", ourImageHosts) : []),
    [formData.htmlContent, ourImageHosts],
  );
  const externalImageHosts = useMemo(() => {
    const hosts = new Set<string>();
    for (const u of externalImageSrcs) {
      const h = imageSrcHost(u);
      if (h) hosts.add(h);
    }
    return [...hosts];
  }, [externalImageSrcs]);

  const { data: segments, isLoading: loadingSegments } = useQuery<Segment[]>({
    queryKey: ["/api/segments"],
  });

  const countMutation = useMutation({
    mutationFn: async (params: { segmentId: string; excludeSegmentId?: string | null }) => {
      const url = params.excludeSegmentId
        ? `/api/segments/${params.segmentId}/count?exclude=${encodeURIComponent(params.excludeSegmentId)}`
        : `/api/segments/${params.segmentId}/count`;
      const res = await apiRequest("GET", url);
      return res.json();
    },
    onSuccess: (data: { count: number }) => {
      setSubscriberCount(data?.count ?? 0);
    },
  });

  useEffect(() => {
    if (formData.segmentId) {
      countMutation.mutate({
        segmentId: formData.segmentId,
        excludeSegmentId: formData.excludeSegmentId || null,
      });
    } else {
      setSubscriberCount(null);
    }
  }, [formData.segmentId, formData.excludeSegmentId]);

  const showSavedIndicator = () => {
    setSavedIndicator(true);
    setTimeout(() => setSavedIndicator(false), 2000);
  };

  const saveDraftMutation = useMutation({
    mutationFn: async (data: Partial<InsertCampaign>) => {
      const normalized = normalizeForApi(data);
      if (campaignId) {
        const res = await apiRequest("PATCH", `/api/campaigns/${campaignId}`, normalized);
        return res.json();
      } else {
        const res = await apiRequest("POST", "/api/campaigns", normalized);
        return res.json();
      }
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/campaigns"] });
      if (data?.id && !campaignId) {
        setCampaignId(data.id);
      }
      showSavedIndicator();
    },
  });

  const sendMutation = useMutation({
    mutationFn: async (data: Partial<InsertCampaign>) => {
      const normalized = normalizeForApi(data);
      let currentCampaignId = campaignId;

      if (!currentCampaignId) {
        const createRes = await apiRequest("POST", "/api/campaigns", normalized);
        const createdCampaign = await createRes.json();
        currentCampaignId = createdCampaign.id;
        setCampaignId(currentCampaignId);
      } else {
        await apiRequest("PATCH", `/api/campaigns/${currentCampaignId}`, normalized);
      }

      const sendPayload = data.scheduledAt ? { scheduledAt: data.scheduledAt } : {};
      const sendRes = await apiRequest("POST", `/api/campaigns/${currentCampaignId}/send`, sendPayload);
      return sendRes.json();
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["/api/campaigns"] });
      const isScheduled = !!formData.scheduledAt;
      toast({
        title: isScheduled ? "Campaign scheduled" : "Campaign started",
        description: result.message || (isScheduled ? "Your campaign has been scheduled." : "Your campaign is now being sent."),
      });
      navigate("/campaigns");
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to start campaign",
        description: error.message || "Please check campaign settings and try again.",
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
    setFormData((prev) => ({ ...prev, [field]: value }));
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

  const nextStep = async () => {
    if (currentStep >= 5 || !isStepValid(currentStep)) return;
    // Reset any prior brand-safeguard messages whenever the operator clicks Next.
    setBrandBlock(null);
    setBrandWarning(null);
    // Image-domain safeguard: every absolute <img src> must use a domain
    // attributed to the selected MTA (relative/data: URLs are fine — they are
    // rehosted at send time). Hard stop, mirrored by the alert in the step.
    if (currentStep === 3 && externalImageSrcs.length > 0) {
      toast({
        title: "Image URLs don't match the MTA's domain",
        description: `${externalImageSrcs.length} image(s) point to ${externalImageHosts.join(", ")} — re-drop the HTML to rehost them, or fix the src= URLs.`,
        variant: "destructive",
      });
      return;
    }
    // The brand-unsubscribe safeguard only gates Content (3) -> Tracking (4).
    if (currentStep === 3) {
      setBrandCheckPending(true);
      try {
        const res = await apiRequest(
          "GET",
          `/api/campaigns/brand-unsub-check?subject=${encodeURIComponent(formData.subject || "")}`,
        );
        const data = (await res.json()) as BrandUnsubResult;
        if (data?.status === "blocked") {
          setBrandBlock(buildBrandMessage(data));
          return; // hard stop: do not advance to Tracking
        }
        if (data?.status === "warn") {
          setBrandWarning(buildBrandMessage(data));
        }
      } catch (err) {
        // Fail-open: an infra blip must never trap the operator in the wizard.
        console.error("Brand unsubscribe check failed, allowing advance:", err);
      } finally {
        setBrandCheckPending(false);
      }
    }
    saveDraftMutation.mutate(formData);
    setCurrentStep(currentStep + 1);
  };

  const prevStep = () => {
    if (currentStep > 1) {
      setBrandBlock(null);
      setBrandWarning(null);
      setCurrentStep(currentStep - 1);
    }
  };

  const handleSaveDraft = () => {
    if (!formData.name) {
      toast({
        title: "Name required",
        description: "Please enter a campaign name before saving.",
        variant: "destructive",
      });
      return;
    }
    saveDraftMutation.mutate(formData);
  };

  const isReadyToSend = (): string[] => {
    const missing: string[] = [];
    if (!formData.name) missing.push("Campaign Name");
    if (!formData.fromName) missing.push("From Name");
    if (!formData.fromEmail) missing.push("From Email");
    if (!formData.mtaId) missing.push("Sending Server");
    if (!formData.segmentId) missing.push("Segment");
    if (!formData.subject) missing.push("Subject Line");
    if (!formData.htmlContent) missing.push("HTML Content");
    return missing;
  };

  const handleSend = () => {
    const missing = isReadyToSend();
    if (missing.length > 0) {
      toast({
        title: "Cannot send campaign",
        description: `Please complete: ${missing.join(", ")}`,
        variant: "destructive",
      });
      return;
    }
    sendMutation.mutate(formData);
  };

  const handleMtaSelect = (mtaId: string) => {
    // Refresh scheduling insights immediately so the "already scheduled"
    // list under the card is current the moment a server is picked.
    refetchMtaInsights();
    const selectedMta = mtas?.find(m => m.id === mtaId);
    setFormData(prev => ({
      ...prev,
      mtaId,
      ...(selectedMta?.fromName ? { fromName: selectedMta.fromName } : {}),
      ...(selectedMta?.fromEmail ? { fromEmail: selectedMta.fromEmail, replyEmail: selectedMta.fromEmail } : {}),
      ...(selectedMta?.unsubscribeText ? { unsubscribeText: selectedMta.unsubscribeText } : {}),
      ...(selectedMta?.companyAddress ? { companyAddress: selectedMta.companyAddress } : {}),
    }));
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
                        <div className="flex-1 min-w-0">
                          <p className="font-medium">{mta.name}</p>
                          <p className="text-sm text-muted-foreground font-mono">
                            {mta.hostname}:{mta.port}
                          </p>
                          {mta.fromName && (
                            <p className="text-xs text-muted-foreground mt-1">
                              From: {mta.fromName} &lt;{mta.fromEmail}&gt;
                            </p>
                          )}
                        </div>
                        <div className="ml-auto flex items-center gap-2">
                          <MtaLowOpenWarning campaigns={mtaInsights?.[mta.id]?.lowOpen ?? []} mtaId={mta.id} />
                          {formData.mtaId === mta.id && (
                            <Check className="h-5 w-5 text-primary" />
                          )}
                        </div>
                      </div>
                      {formData.mtaId === mta.id && (
                        <MtaScheduledCampaigns
                          campaigns={mtaInsights?.[mta.id]?.scheduled ?? []}
                          excludeCampaignId={campaignId}
                          mtaId={mta.id}
                        />
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-8 text-muted-foreground">
                  <Server className="h-12 w-12 mx-auto mb-4 opacity-50" />
                  <p>No active sending servers available.</p>
                  <Button variant="ghost" onClick={() => navigate("/mtas")} data-testid="link-configure-mtas">
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

      case 2: {
        // Task #138: optional exclusion segment. The "+ Add exclusion segment"
        // button only REVEALS the second combobox — it must NOT pre-select
        // a segment, otherwise we'd silently apply an exclusion the user
        // never chose. `showExclusion` tracks visibility; `excludeSegmentId`
        // tracks the actual selection. The exclusion list filters out the
        // include id so the user can't pick the same segment on both sides
        // (also enforced server-side with a 400).
        const excludeOpen = showExclusion || !!formData.excludeSegmentId;
        const excludeChoices = (segments ?? []).filter((s) => s.id !== formData.segmentId);
        return (
          <div className="space-y-6">
            <div className="space-y-2">
              <Label>Select Segment *</Label>
              {loadingSegments ? (
                <Skeleton className="h-10 w-full" />
              ) : segments && segments.length > 0 ? (
                <SegmentCombobox
                  segments={segments}
                  value={formData.segmentId || ""}
                  onChange={(v) => {
                    updateField("segmentId", v);
                    // If the user picks the same segment as the exclusion,
                    // clear the exclusion to avoid an empty audience.
                    if (v && formData.excludeSegmentId === v) {
                      updateField("excludeSegmentId", "");
                    }
                  }}
                />
              ) : (
                <div className="text-center py-8 text-muted-foreground">
                  <Users className="h-12 w-12 mx-auto mb-4 opacity-50" />
                  <p>No segments available.</p>
                  <Button variant="ghost" onClick={() => navigate("/segments")} data-testid="link-create-segment">
                    Create Segment
                  </Button>
                </div>
              )}
            </div>

            {segments && segments.length > 1 && formData.segmentId && (
              <div className="space-y-2">
                {!excludeOpen ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setShowExclusion(true)}
                    data-testid="button-add-exclusion"
                  >
                    + Add exclusion segment
                  </Button>
                ) : (
                  <>
                    <div className="flex items-center justify-between">
                      <Label>Exclude subscribers in</Label>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setShowExclusion(false);
                          updateField("excludeSegmentId", "");
                        }}
                        data-testid="button-remove-exclusion"
                      >
                        <X className="h-4 w-4 mr-1" />
                        Remove
                      </Button>
                    </div>
                    <SegmentCombobox
                      segments={excludeChoices}
                      value={formData.excludeSegmentId || ""}
                      onChange={(v) => updateField("excludeSegmentId", v)}
                      placeholder="Select exclusion segment..."
                    />
                    <p className="text-xs text-muted-foreground">
                      Subscribers in this segment will be subtracted from the audience at send time.
                    </p>
                  </>
                )}
              </div>
            )}

            {subscriberCount !== null && (
              <Card>
                <CardContent className="flex items-center gap-4 p-4">
                  <Users className="h-8 w-8 text-primary" />
                  <div>
                    <p className="text-2xl font-bold" data-testid="text-subscriber-count">{subscriberCount.toLocaleString()}</p>
                    <p className="text-sm text-muted-foreground">
                      {excludeOpen ? "subscribers after exclusion" : "subscribers in this segment"}
                    </p>
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        );
      }

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
              {externalImageSrcs.length > 0 && (
                <Alert variant="destructive" data-testid="alert-external-images">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertTitle>External images — blocking</AlertTitle>
                  <AlertDescription className="space-y-2">
                    <p>
                      {externalImageSrcs.length} image{externalImageSrcs.length > 1 ? "s" : ""} use a URL not hosted on the selected MTA's domains. You cannot continue to the next step until they are fixed.
                    </p>
                    <ul className="list-disc list-inside text-xs font-mono break-all">
                      {externalImageHosts.slice(0, 8).map((h) => (
                        <li key={h} data-testid={`text-external-host-${h}`}>{h}</li>
                      ))}
                      {externalImageHosts.length > 8 && (
                        <li>…and {externalImageHosts.length - 8} more host(s)</li>
                      )}
                    </ul>
                    <p className="text-xs">
                      Tip: re-drop the HTML file in the upload zone to download &amp; host the images locally, or fix the URLs.
                    </p>
                  </AlertDescription>
                </Alert>
              )}
              {!htmlLoaded ? (
                <HtmlDropzone
                  isDragging={isDragging}
                  setIsDragging={setIsDragging}
                  onDrop={handleHtmlDrop}
                  onFileSelect={handleHtmlFileSelect}
                  processing={processingImages}
                  progress={imageProgress}
                  onCancel={cancelImageProcessing}
                />
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
                  {showPreview ? (
                    <div className="border rounded-md bg-[#fdfcf7] overflow-hidden">
                      <iframe
                        srcDoc={withBaseHref(formData.htmlContent)}
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
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        Sending...
                      </>
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
          </div>
        );

      case 4:
        return (
          <div className="space-y-6">
            <TagSuggestionsButton
              campaignName={formData.name}
              onApply={(tags) => setFormData((prev) => ({ ...prev, ...tags }))}
            />
            <Card>
              <CardContent className="p-4 space-y-4">
                <div className="flex items-center justify-between gap-2">
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
                <div className="flex items-center justify-between gap-2">
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
            <div className="space-y-2">
              <Label>Schedule (optional) - Paris Time</Label>
              <DateTimePicker
                value={formData.scheduledAt ? new Date(formData.scheduledAt) : null}
                onChange={(date) => updateField("scheduledAt", date ? date.toISOString() : null)}
              />
              <p className="text-xs text-muted-foreground">
                Leave empty to send immediately, or pick a date and time (Paris timezone)
              </p>
            </div>

            {/* Auto-resend to openers (Task #56). When enabled, after this
                campaign completes the system automatically schedules a
                follow-up that re-sends the same email only to subscribers who
                opened it — typically delivers another 60-80% engagement. */}
            <div className="space-y-3 rounded-lg border p-4">
              <div className="flex items-center justify-between gap-4">
                <div className="space-y-1">
                  <Label htmlFor="follow-up-enabled" className="text-base">Auto-resend to openers</Label>
                  <p className="text-xs text-muted-foreground">
                    Automatically re-send this campaign to people who opened it.
                  </p>
                </div>
                <Switch
                  id="follow-up-enabled"
                  checked={!!formData.followUpEnabled}
                  onCheckedChange={(v) => updateField("followUpEnabled", v)}
                  data-testid="switch-follow-up-enabled"
                />
              </div>
              {formData.followUpEnabled && (
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="follow-up-delay-hours">Delay (hours)</Label>
                    <Input
                      id="follow-up-delay-hours"
                      type="number"
                      min={1}
                      max={168}
                      value={formData.followUpDelayHours ?? 36}
                      onChange={(e) => updateField("followUpDelayHours", Number(e.target.value) || 36)}
                      className="w-32"
                      data-testid="input-follow-up-delay-hours"
                    />
                    <p className="text-xs text-muted-foreground">
                      Default 36 hours. Range 1-168 (7 days). Counted from when this campaign finishes sending.
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="follow-up-subject">Follow-up subject (optional)</Label>
                    <Input
                      id="follow-up-subject"
                      type="text"
                      placeholder={formData.subject ? `Defaults to: ${formData.subject}` : "Leave blank to reuse the original subject"}
                      maxLength={998}
                      value={formData.followUpSubject ?? ""}
                      onChange={(e) => updateField("followUpSubject", e.target.value || null)}
                      data-testid="input-follow-up-subject"
                    />
                    <p className="text-xs text-muted-foreground">
                      Override the subject line for the follow-up. Leave empty to reuse the original.
                    </p>
                  </div>
                </div>
              )}
            </div>

            {subscriberCount !== null && (
              <Card className="bg-primary/5 border-primary/20">
                <CardContent className="p-4">
                  <div className="flex items-center gap-4">
                    <Mail className="h-10 w-10 text-primary" />
                    <div>
                      <p className="text-sm text-muted-foreground">Ready to send to</p>
                      <p className="text-3xl font-bold" data-testid="text-send-subscriber-count">
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
        <Button variant="ghost" size="icon" onClick={() => navigate("/campaigns")} data-testid="button-back">
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div className="flex-1">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-3xl font-bold tracking-tight">Create Campaign</h1>
            {formData.segmentId ? (
              <Link href={`/segments/${formData.segmentId}`}>
                <Badge
                  variant="outline"
                  className="gap-1 cursor-pointer hover:bg-muted"
                  data-testid="badge-header-segment"
                >
                  <Filter className="h-3 w-3" />
                  {segments?.find((s) => s.id === formData.segmentId)?.name ?? "Segment"}
                </Badge>
              </Link>
            ) : (
              <Badge variant="outline" className="gap-1" data-testid="badge-header-segment">
                <Filter className="h-3 w-3" />
                All subscribers
              </Badge>
            )}
          </div>
          <p className="text-muted-foreground">
            Follow the steps to create a new email campaign
          </p>
        </div>
        {savedIndicator && (
          <div className="flex items-center gap-1 text-sm text-muted-foreground" data-testid="text-saved-indicator">
            <Check className="h-4 w-4" />
            Saved
          </div>
        )}
      </div>

      <div className="flex gap-2 overflow-x-auto pb-2">
        {steps.map((step) => (
          <div
            key={step.id}
            className={`flex items-center gap-2 px-4 py-2 rounded-md transition-colors whitespace-nowrap ${
              currentStep === step.id
                ? "bg-primary text-primary-foreground"
                : currentStep > step.id
                ? "bg-muted text-foreground cursor-pointer"
                : "bg-muted/50 text-muted-foreground"
            }`}
            onClick={() => step.id < currentStep && setCurrentStep(step.id)}
            data-testid={`step-${step.id}`}
          >
            {currentStep > step.id ? (
              <Check className="h-4 w-4" />
            ) : (
              <step.icon className="h-4 w-4" />
            )}
            <span className="text-sm font-medium">{step.title}</span>
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

      {brandBlock && (
        <Alert variant="destructive" data-testid="alert-brand-block">
          <AlertTitle>Limite de désabonnements atteinte</AlertTitle>
          <AlertDescription>{brandBlock}</AlertDescription>
        </Alert>
      )}
      {brandWarning && (
        <Alert data-testid="alert-brand-warning">
          <AlertTitle>Attention</AlertTitle>
          <AlertDescription>{brandWarning}</AlertDescription>
        </Alert>
      )}

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
            disabled={saveDraftMutation.isPending || processingImages}
            data-testid="button-save-draft"
          >
            {saveDraftMutation.isPending ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Saving...
              </>
            ) : (
              <>
                <Save className="h-4 w-4 mr-2" />
                Save Draft
              </>
            )}
          </Button>
          {currentStep < 5 ? (
            <Button
              onClick={nextStep}
              disabled={!isStepValid(currentStep) || processingImages || brandCheckPending}
              data-testid="button-next-step"
            >
              {brandCheckPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Checking...
                </>
              ) : (
                <>
                  Next
                  <ArrowRight className="h-4 w-4 ml-2" />
                </>
              )}
            </Button>
          ) : (
            <Button
              onClick={handleSend}
              disabled={sendMutation.isPending || processingImages}
              data-testid="button-send-campaign"
            >
              {sendMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Starting...
                </>
              ) : formData.scheduledAt ? (
                "Schedule Campaign"
              ) : (
                "Send Now"
              )}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
