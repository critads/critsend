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
import { Server, Plus, MoreVertical, Trash2, Edit2, Eye, EyeOff, CheckCircle2, XCircle, FlaskConical } from "lucide-react";
import type { Mta, InsertMta } from "@shared/schema";

export default function MTAs() {
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [editingMta, setEditingMta] = useState<Mta | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<Mta | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [formData, setFormData] = useState<Partial<InsertMta>>({
    name: "",
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

  const resetForm = () => {
    setFormData({
      name: "",
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
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Add Sending Server</DialogTitle>
              <DialogDescription>
                Configure a new SMTP server for sending campaigns
              </DialogDescription>
            </DialogHeader>
            {mtaFormContent}
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
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit Sending Server</DialogTitle>
            <DialogDescription>
              Update the configuration for this SMTP server
            </DialogDescription>
          </DialogHeader>
          {mtaFormContent}
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
    </div>
  );
}
