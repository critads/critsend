import { useState, useEffect } from "react";
import { useLocation, useParams } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { ArrowLeft, Server } from "lucide-react";
import { MtaForm } from "@/components/mta-form";
import type { MtaFormData } from "@/components/mta-form";
import type { Mta } from "@shared/schema";

export default function MtaEdit() {
  const { id } = useParams<{ id: string }>();
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const [formData, setFormData] = useState<MtaFormData | null>(null);
  const [showPassword, setShowPassword] = useState(false);

  const { data: mta, isLoading } = useQuery<Mta>({
    queryKey: ["/api/mtas", id],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/mtas/${id}`);
      return res.json();
    },
    enabled: !!id,
  });

  useEffect(() => {
    if (mta && !formData) {
      setFormData({
        name: mta.name,
        fromName: mta.fromName ?? "",
        fromEmail: mta.fromEmail ?? "",
        hostname: mta.hostname,
        port: mta.port,
        username: mta.username,
        password: mta.password,
        trackingDomain: mta.trackingDomain ?? "",
        openTrackingDomain: mta.openTrackingDomain ?? "",
        imageHostingDomain: mta.imageHostingDomain ?? "",
        isActive: mta.isActive,
        mode: mta.mode ?? "real",
        protocol: (mta as any).protocol ?? "STARTTLS",
        simulatedLatencyMs: mta.simulatedLatencyMs ?? 0,
        failureRate: mta.failureRate ?? 0,
      });
    }
  }, [mta]);

  const updateMutation = useMutation({
    mutationFn: (data: MtaFormData) => apiRequest("PATCH", `/api/mtas/${id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/mtas"] });
      toast({ title: "MTA updated", description: "Your sending server has been updated." });
      navigate("/mtas");
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to update MTA. Please try again.",
        variant: "destructive",
      });
    },
  });

  const handleSubmit = () => {
    if (!formData) return;
    if (!formData.name?.trim()) {
      toast({ title: "Validation Error", description: "Please provide a server name.", variant: "destructive" });
      return;
    }
    if (!formData.fromName?.trim()) {
      toast({ title: "Validation Error", description: "Please provide a From Name.", variant: "destructive" });
      return;
    }
    if (!formData.fromEmail?.trim()) {
      toast({ title: "Validation Error", description: "Please provide a From Email.", variant: "destructive" });
      return;
    }
    updateMutation.mutate(formData);
  };

  return (
    <div className="p-6 lg:p-8 max-w-2xl mx-auto space-y-6">
      <div className="flex items-center gap-4">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => navigate("/mtas")}
          data-testid="button-back-mtas"
        >
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-md bg-muted">
            <Server className="h-5 w-5 text-muted-foreground" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">
              {isLoading ? "Loading…" : `Edit ${mta?.name ?? "Server"}`}
            </h1>
            <p className="text-sm text-muted-foreground">Update the configuration for this SMTP server</p>
          </div>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Server Configuration</CardTitle>
          <CardDescription>
            Update the connection details and sending options for this SMTP server.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading || !formData ? (
            <div className="space-y-4">
              {[1, 2, 3, 4, 5].map((i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : (
            <MtaForm
              formData={formData}
              onChange={setFormData}
              showPassword={showPassword}
              setShowPassword={setShowPassword}
            />
          )}
        </CardContent>
      </Card>

      <div className="flex items-center justify-end gap-3">
        <Button variant="outline" onClick={() => navigate("/mtas")}>
          Cancel
        </Button>
        <Button
          onClick={handleSubmit}
          disabled={updateMutation.isPending || isLoading || !formData}
          data-testid="button-update-mta"
        >
          {updateMutation.isPending ? "Saving…" : "Save Changes"}
        </Button>
      </div>
    </div>
  );
}
