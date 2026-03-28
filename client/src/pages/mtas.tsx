import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Separator } from "@/components/ui/separator";
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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import {
  Server, Plus, MoreVertical, Trash2, Edit2, Eye, EyeOff,
  CheckCircle2, XCircle, FlaskConical, Wifi, WifiOff, Loader2,
  Lightbulb, ChevronDown, ChevronRight, Clock,
} from "lucide-react";
import type { Mta, InsertMta } from "@shared/schema";

interface SmtpTestResult {
  success: boolean;
  connectionTimeMs: number;
  stage?: string;
  errorCode?: string;
  errorMessage?: string;
  smtpCode?: number;
  suggestions?: string[];
  serverBanner?: string;
}

export default function MTAs() {
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [editingMta, setEditingMta] = useState<Mta | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<Mta | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [testingMta, setTestingMta] = useState<Mta | null>(null);
  const [testResult, setTestResult] = useState<SmtpTestResult | null>(null);
  const [showRawError, setShowRawError] = useState(false);
  const [formData, setFormData] = useState<Partial<InsertMta>>({
    name: "",
    fromName: "",
    fromEmail: "",
    hostname: "",
    port: 587,
    username: "",
    password: "",
    trackingDomain: "",
    openTrackingDomain: "",
    imageHostingDomain: "",
    isActive: true,
    mode: "real",
    simulatedLatencyMs: 0,
    failureRate: 0,
  });
  const { toast } = useToast();

  const { data: mtas, isLoading } = useQuery<Mta[]>({
    queryKey: ["/api/mtas"],
  });

  const createMutation = useMutation({
    mutationFn: (data: Partial<InsertMta>) => apiRequest("POST", "/api/mtas", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/mtas"] });
      resetForm();
      setIsCreateOpen(false);
      toast({
        title: "MTA created",
        description: "Your new sending server has been added.",
      });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to create MTA. Please try again.",
        variant: "destructive",
      });
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<InsertMta> }) =>
      apiRequest("PATCH", `/api/mtas/${id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/mtas"] });
      setEditingMta(null);
      resetForm();
      toast({
        title: "MTA updated",
        description: "Your sending server has been updated.",
      });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to update MTA. Please try again.",
        variant: "destructive",
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/mtas/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/mtas"] });
      setDeleteConfirm(null);
      toast({
        title: "MTA deleted",
        description: "The sending server has been removed.",
      });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to delete MTA. Please try again.",
        variant: "destructive",
      });
    },
  });

  const testMutation = useMutation({
    mutationFn: (id: string) => apiRequest("POST", `/api/mtas/${id}/test`),
    onSuccess: (data: SmtpTestResult) => {
      setTestResult(data);
      setShowRawError(false);
    },
    onError: () => {
      setTestResult({
        success: false,
        connectionTimeMs: 0,
        stage: "Request Error",
        errorMessage: "Could not reach the server to run the test.",
        suggestions: ["Check that the application server is running."],
      });
    },
  });

  const handleTestConnection = (mta: Mta) => {
    setTestingMta(mta);
    setTestResult(null);
    setShowRawError(false);
    testMutation.mutate(mta.id);
  };

  const resetForm = () => {
    setFormData({
      name: "",
      fromName: "",
      fromEmail: "",
      hostname: "",
      port: 587,
      username: "",
      password: "",
      trackingDomain: "",
      openTrackingDomain: "",
      imageHostingDomain: "",
      isActive: true,
      mode: "real",
      simulatedLatencyMs: 0,
      failureRate: 0,
    });
    setShowPassword(false);
  };

  const handleEditClick = (mta: Mta) => {
    setEditingMta(mta);
    setFormData({
      name: mta.name,
      fromName: mta.fromName || "",
      fromEmail: mta.fromEmail || "",
      hostname: mta.hostname,
      port: mta.port,
      username: mta.username,
      password: mta.password,
      trackingDomain: mta.trackingDomain || "",
      openTrackingDomain: mta.openTrackingDomain || "",
      imageHostingDomain: mta.imageHostingDomain || "",
      isActive: mta.isActive,
      mode: mta.mode || "real",
      simulatedLatencyMs: mta.simulatedLatencyMs ?? 0,
      failureRate: mta.failureRate ?? 0,
    });
  };

  const handleSubmit = () => {
    if (!formData.name?.trim()) {
      toast({
        title: "Validation Error",
        description: "Please provide a server name.",
        variant: "destructive",
      });
      return;
    }
    if (!formData.fromName?.trim()) {
      toast({
        title: "Validation Error",
        description: "Please provide a From Name.",
        variant: "destructive",
      });
      return;
    }
    if (!formData.fromEmail?.trim()) {
      toast({
        title: "Validation Error",
        description: "Please provide a From Email.",
        variant: "destructive",
      });
      return;
    }

    if (editingMta) {
      updateMutation.mutate({ id: editingMta.id, data: formData });
    } else {
      createMutation.mutate(formData);
    }
  };

  const mtaFormContent = (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="space-y-2 sm:col-span-2">
          <Label htmlFor="mta-name">Server Name *</Label>
          <Input
            id="mta-name"
            placeholder="e.g., Primary SMTP"
            value={formData.name}
            onChange={(e) => setFormData({ ...formData, name: e.target.value })}
            data-testid="input-mta-name"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="mta-from-name">From Name *</Label>
          <Input
            id="mta-from-name"
            placeholder="e.g., My Company"
            value={formData.fromName ?? ""}
            onChange={(e) => setFormData({ ...formData, fromName: e.target.value })}
            data-testid="input-mta-from-name"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="mta-from-email">From Email *</Label>
          <Input
            id="mta-from-email"
            type="email"
            placeholder="hello@company.com"
            value={formData.fromEmail ?? ""}
            onChange={(e) => setFormData({ ...formData, fromEmail: e.target.value })}
            data-testid="input-mta-from-email"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="mta-hostname">Hostname</Label>
          <Input
            id="mta-hostname"
            placeholder="smtp.example.com"
            value={formData.hostname ?? ""}
            onChange={(e) => setFormData({ ...formData, hostname: e.target.value })}
            className="font-mono text-sm"
            data-testid="input-mta-hostname"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="mta-port">Port *</Label>
          <Input
            id="mta-port"
            type="number"
            placeholder="587"
            value={formData.port}
            onChange={(e) => setFormData({ ...formData, port: parseInt(e.target.value) || 587 })}
            data-testid="input-mta-port"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="mta-username">SMTP User</Label>
          <Input
            id="mta-username"
            placeholder="smtp_user"
            value={formData.username ?? ""}
            onChange={(e) => setFormData({ ...formData, username: e.target.value })}
            className="font-mono text-sm"
            data-testid="input-mta-username"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="mta-password">Password</Label>
          <div className="relative">
            <Input
              id="mta-password"
              type={showPassword ? "text" : "password"}
              placeholder="••••••••"
              value={formData.password ?? ""}
              onChange={(e) => setFormData({ ...formData, password: e.target.value })}
              className="pr-10 font-mono text-sm"
              data-testid="input-mta-password"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="absolute right-0 top-0 h-full"
              onClick={() => setShowPassword(!showPassword)}
            >
              {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </Button>
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="mta-tracking-domain">Click Tracking Domain</Label>
          <Input
            id="mta-tracking-domain"
            placeholder="track.example.com"
            value={formData.trackingDomain ?? ""}
            onChange={(e) => setFormData({ ...formData, trackingDomain: e.target.value })}
            className="font-mono text-sm"
            data-testid="input-mta-tracking-domain"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="mta-open-tracking">Open Tracking Domain</Label>
          <Input
            id="mta-open-tracking"
            placeholder="open.example.com"
            value={formData.openTrackingDomain ?? ""}
            onChange={(e) => setFormData({ ...formData, openTrackingDomain: e.target.value })}
            className="font-mono text-sm"
            data-testid="input-mta-open-tracking"
          />
        </div>
        <div className="space-y-2 sm:col-span-2">
          <Label htmlFor="mta-image-hosting">Image Hosting Domain</Label>
          <Input
            id="mta-image-hosting"
            placeholder="https://images.example.com"
            value={formData.imageHostingDomain ?? ""}
            onChange={(e) => setFormData({ ...formData, imageHostingDomain: e.target.value })}
            className="font-mono text-sm"
            data-testid="input-mta-image-hosting"
          />
          <p className="text-xs text-muted-foreground">
            Domain to use for locally hosted email images (e.g., https://images.yourdomain.com)
          </p>
        </div>
        <div className="flex items-center justify-between sm:col-span-2 p-3 rounded-md bg-muted/50">
          <div>
            <Label htmlFor="mta-active">Active</Label>
            <p className="text-sm text-muted-foreground">Enable this server for sending</p>
          </div>
          <Switch
            id="mta-active"
            checked={formData.isActive}
            onCheckedChange={(checked) => setFormData({ ...formData, isActive: checked })}
            data-testid="switch-mta-active"
          />
        </div>
        <div className="sm:col-span-2 space-y-3 p-3 rounded-md bg-muted/50">
          <div>
            <Label>Mode</Label>
            <p className="text-sm text-muted-foreground">
              Choose how this MTA handles email delivery
            </p>
          </div>
          <RadioGroup
            value={formData.mode || "real"}
            onValueChange={(value) => setFormData({ ...formData, mode: value })}
            className="flex flex-col gap-3"
            data-testid="radio-mta-mode"
          >
            <div className="flex items-center space-x-3">
              <RadioGroupItem value="real" id="mode-real" data-testid="radio-mode-real" />
              <Label htmlFor="mode-real" className="font-normal cursor-pointer">
                <span className="font-medium">Real</span>
                <span className="text-muted-foreground ml-1">- Send emails via SMTP server</span>
              </Label>
            </div>
            <div className="flex items-center space-x-3">
              <RadioGroupItem value="nullsink" id="mode-nullsink" data-testid="radio-mode-nullsink" />
              <Label htmlFor="mode-nullsink" className="font-normal cursor-pointer">
                <span className="font-medium">Nullsink (Test Mode)</span>
                <span className="text-muted-foreground ml-1">- Capture emails without sending</span>
              </Label>
            </div>
          </RadioGroup>
        </div>
        {formData.mode === "nullsink" && (
          <>
            <div className="space-y-2">
              <Label htmlFor="mta-latency">Simulated Latency (ms)</Label>
              <Input
                id="mta-latency"
                type="number"
                min="0"
                placeholder="0"
                value={formData.simulatedLatencyMs ?? 0}
                onChange={(e) => setFormData({ ...formData, simulatedLatencyMs: parseInt(e.target.value) || 0 })}
                data-testid="input-mta-latency"
              />
              <p className="text-xs text-muted-foreground">
                Delay in milliseconds to simulate network latency
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="mta-failure-rate">Failure Rate (%)</Label>
              <Input
                id="mta-failure-rate"
                type="number"
                min="0"
                max="100"
                placeholder="0"
                value={formData.failureRate ?? 0}
                onChange={(e) => {
                  const value = parseInt(e.target.value) || 0;
                  setFormData({ ...formData, failureRate: Math.min(100, Math.max(0, value)) });
                }}
                data-testid="input-mta-failure-rate"
              />
              <p className="text-xs text-muted-foreground">
                Percentage of emails that will simulate delivery failure (0-100)
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  );

  return (
    <div className="p-6 lg:p-8 space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">MTAs</h1>
          <p className="text-muted-foreground">
            Configure your Mail Transfer Agents (sending servers)
          </p>
        </div>
        <Dialog open={isCreateOpen} onOpenChange={(open) => { setIsCreateOpen(open); if (!open) resetForm(); }}>
          <DialogTrigger asChild>
            <Button data-testid="button-add-mta">
              <Plus className="h-4 w-4 mr-2" />
              Add MTA
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-lg max-h-[90vh] flex flex-col">
            <DialogHeader>
              <DialogTitle>Add Sending Server</DialogTitle>
              <DialogDescription>
                Configure a new SMTP server for sending campaigns
              </DialogDescription>
            </DialogHeader>
            <div className="flex-1 overflow-y-auto pr-2">
              {mtaFormContent}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => { setIsCreateOpen(false); resetForm(); }}>
                Cancel
              </Button>
              <Button
                onClick={handleSubmit}
                disabled={createMutation.isPending}
                data-testid="button-submit-mta"
              >
                {createMutation.isPending ? "Adding..." : "Add Server"}
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
      ) : mtas && mtas.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {mtas.map((mta) => (
            <Card key={mta.id} data-testid={`mta-card-${mta.id}`}>
              <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0">
                <div className="flex items-start gap-3">
                  <div className="p-2 rounded-md bg-muted">
                    <Server className="h-5 w-5 text-muted-foreground" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <CardTitle className="text-lg truncate">{mta.name}</CardTitle>
                      {mta.isActive ? (
                        <Badge variant="secondary" className="gap-1">
                          <CheckCircle2 className="h-3 w-3" />
                          Active
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="gap-1">
                          <XCircle className="h-3 w-3" />
                          Inactive
                        </Badge>
                      )}
                      {mta.mode === "nullsink" && (
                        <Badge variant="outline" className="gap-1 text-amber-600 border-amber-600 dark:text-amber-500 dark:border-amber-500" data-testid={`badge-test-mode-${mta.id}`}>
                          <FlaskConical className="h-3 w-3" />
                          Test Mode
                        </Badge>
                      )}
                    </div>
                    <CardDescription className="font-mono text-xs mt-1">
                      {mta.hostname}:{mta.port}
                    </CardDescription>
                  </div>
                </div>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" data-testid={`button-mta-menu-${mta.id}`}>
                      <MoreVertical className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => handleEditClick(mta)}>
                      <Edit2 className="h-4 w-4 mr-2" />
                      Edit
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => handleTestConnection(mta)}
                      data-testid={`button-test-mta-${mta.id}`}
                    >
                      <Wifi className="h-4 w-4 mr-2" />
                      Test Connection
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      className="text-destructive"
                      onClick={() => setDeleteConfirm(mta)}
                    >
                      <Trash2 className="h-4 w-4 mr-2" />
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="text-sm">
                  <span className="text-muted-foreground">User:</span>{" "}
                  <span className="font-mono">{mta.username}</span>
                </div>
                {mta.fromName && (
                  <div className="text-sm">
                    <span className="text-muted-foreground">From:</span>{" "}
                    <span>{mta.fromName} &lt;{mta.fromEmail}&gt;</span>
                  </div>
                )}
                {mta.trackingDomain && (
                  <div className="text-sm">
                    <span className="text-muted-foreground">Click tracking:</span>{" "}
                    <span className="font-mono text-xs">{mta.trackingDomain}</span>
                  </div>
                )}
                {mta.openTrackingDomain && (
                  <div className="text-sm">
                    <span className="text-muted-foreground">Open tracking:</span>{" "}
                    <span className="font-mono text-xs">{mta.openTrackingDomain}</span>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <Server className="h-16 w-16 text-muted-foreground/50 mb-4" />
            <h3 className="text-lg font-semibold mb-2">No sending servers configured</h3>
            <p className="text-muted-foreground max-w-md mb-4">
              Add an SMTP server to start sending email campaigns.
            </p>
            <Button onClick={() => setIsCreateOpen(true)}>
              <Plus className="h-4 w-4 mr-2" />
              Add Your First MTA
            </Button>
          </CardContent>
        </Card>
      )}

      <Dialog open={!!editingMta} onOpenChange={() => { setEditingMta(null); resetForm(); }}>
        <DialogContent className="max-w-lg max-h-[90vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>Edit Sending Server</DialogTitle>
            <DialogDescription>
              Update the configuration for this SMTP server
            </DialogDescription>
          </DialogHeader>
          <div className="flex-1 overflow-y-auto pr-2">
            {mtaFormContent}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setEditingMta(null); resetForm(); }}>
              Cancel
            </Button>
            <Button
              onClick={handleSubmit}
              disabled={updateMutation.isPending}
              data-testid="button-update-mta"
            >
              {updateMutation.isPending ? "Saving..." : "Save Changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!deleteConfirm} onOpenChange={() => setDeleteConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete MTA</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete "{deleteConfirm?.name}"? This action cannot be undone.
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
              data-testid="button-confirm-delete-mta"
            >
              {deleteMutation.isPending ? "Deleting..." : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Test Connection Dialog */}
      <Dialog
        open={!!testingMta}
        onOpenChange={(open) => {
          if (!open) {
            setTestingMta(null);
            setTestResult(null);
            setShowRawError(false);
          }
        }}
      >
        <DialogContent className="max-w-lg" data-testid="dialog-test-mta">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Wifi className="h-5 w-5" />
              Test Connection
            </DialogTitle>
            <DialogDescription>
              Testing SMTP connectivity for <span className="font-medium text-foreground">{testingMta?.name}</span>
              <span className="font-mono text-xs ml-1 text-muted-foreground">
                ({testingMta?.hostname}:{testingMta?.port})
              </span>
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            {/* Loading state */}
            {testMutation.isPending && (
              <div className="flex flex-col items-center justify-center py-8 gap-3" data-testid="test-loading">
                <Loader2 className="h-10 w-10 animate-spin text-primary" />
                <p className="text-sm text-muted-foreground">Connecting to SMTP server…</p>
                <p className="text-xs text-muted-foreground">This may take up to 15 seconds</p>
              </div>
            )}

            {/* Success state */}
            {testResult?.success && (
              <div className="space-y-4" data-testid="test-success">
                <div className="flex items-center gap-3 p-4 rounded-lg bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-800">
                  <CheckCircle2 className="h-8 w-8 text-green-600 dark:text-green-400 shrink-0" />
                  <div>
                    <p className="font-semibold text-green-800 dark:text-green-300">Connection successful</p>
                    <p className="text-sm text-green-700 dark:text-green-400">
                      SMTP server accepted the connection and credentials.
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Clock className="h-4 w-4" />
                  <span>Connection established in <strong>{testResult.connectionTimeMs} ms</strong></span>
                </div>
                {testResult.serverBanner && (
                  <div className="p-3 rounded-md bg-muted text-xs font-mono break-all">
                    {testResult.serverBanner}
                  </div>
                )}
              </div>
            )}

            {/* Failure state */}
            {testResult && !testResult.success && (
              <div className="space-y-4" data-testid="test-failure">
                {/* Header */}
                <div className="flex items-center gap-3 p-4 rounded-lg bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800">
                  <WifiOff className="h-8 w-8 text-red-600 dark:text-red-400 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold text-red-800 dark:text-red-300">Connection failed</p>
                    {testResult.stage && (
                      <div className="flex items-center gap-2 mt-1">
                        <span className="text-xs text-red-700 dark:text-red-400">Failed at:</span>
                        <Badge variant="outline" className="text-xs border-red-400 text-red-700 dark:text-red-400">
                          {testResult.stage}
                        </Badge>
                        {testResult.smtpCode && (
                          <Badge variant="outline" className="text-xs border-red-400 text-red-700 dark:text-red-400">
                            SMTP {testResult.smtpCode}
                          </Badge>
                        )}
                      </div>
                    )}
                  </div>
                </div>

                {/* Timing */}
                {testResult.connectionTimeMs > 0 && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Clock className="h-4 w-4" />
                    <span>Failed after <strong>{testResult.connectionTimeMs} ms</strong></span>
                  </div>
                )}

                <Separator />

                {/* Suggestions */}
                {testResult.suggestions && testResult.suggestions.length > 0 && (
                  <div className="space-y-2">
                    <div className="flex items-center gap-1.5 text-sm font-medium">
                      <Lightbulb className="h-4 w-4 text-amber-500" />
                      What to check
                    </div>
                    <ul className="space-y-1.5 pl-1">
                      {testResult.suggestions.map((s, i) => (
                        <li key={i} className="flex items-start gap-2 text-sm text-muted-foreground">
                          <span className="mt-1 h-1.5 w-1.5 rounded-full bg-amber-400 shrink-0" />
                          {s}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Raw error */}
                {testResult.errorMessage && (
                  <div className="space-y-1.5">
                    <button
                      className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                      onClick={() => setShowRawError(!showRawError)}
                      data-testid="button-toggle-raw-error"
                    >
                      {showRawError
                        ? <ChevronDown className="h-3.5 w-3.5" />
                        : <ChevronRight className="h-3.5 w-3.5" />
                      }
                      Raw error details
                    </button>
                    {showRawError && (
                      <div className="p-3 rounded-md bg-muted text-xs font-mono break-all leading-relaxed" data-testid="raw-error-details">
                        {testResult.errorCode && (
                          <div><span className="text-muted-foreground">Code: </span>{testResult.errorCode}</div>
                        )}
                        <div><span className="text-muted-foreground">Message: </span>{testResult.errorMessage}</div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          <DialogFooter className="gap-2">
            {testResult && (
              <Button
                variant="outline"
                onClick={() => {
                  setTestResult(null);
                  setShowRawError(false);
                  testMutation.mutate(testingMta!.id);
                }}
                disabled={testMutation.isPending}
                data-testid="button-retest-mta"
              >
                Test Again
              </Button>
            )}
            <Button
              onClick={() => {
                setTestingMta(null);
                setTestResult(null);
                setShowRawError(false);
              }}
              data-testid="button-close-test-dialog"
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
