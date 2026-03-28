import { useState } from "react";
import { useLocation } from "wouter";
import { useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { ArrowLeft, Server } from "lucide-react";
import { MtaForm } from "@/components/mta-form";
import type { MtaFormData } from "@/components/mta-form";

const EMPTY_FORM: MtaFormData = {
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
  protocol: "STARTTLS",
  simulatedLatencyMs: 0,
  failureRate: 0,
};

export default function MtaNew() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const [formData, setFormData] = useState<MtaFormData>(EMPTY_FORM);
  const [showPassword, setShowPassword] = useState(false);

  const createMutation = useMutation({
    mutationFn: (data: MtaFormData) => apiRequest("POST", "/api/mtas", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/mtas"] });
      toast({ title: "MTA created", description: "Your new sending server has been added." });
      navigate("/mtas");
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to create MTA. Please try again.",
        variant: "destructive",
      });
    },
  });

  const handleSubmit = () => {
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
    createMutation.mutate(formData);
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
            <h1 className="text-2xl font-bold tracking-tight">Add Sending Server</h1>
            <p className="text-sm text-muted-foreground">Configure a new SMTP server for sending campaigns</p>
          </div>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Server Configuration</CardTitle>
          <CardDescription>
            Enter the connection details and sending options for your SMTP server.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <MtaForm
            formData={formData}
            onChange={setFormData}
            showPassword={showPassword}
            setShowPassword={setShowPassword}
          />
        </CardContent>
      </Card>

      <div className="flex items-center justify-end gap-3">
        <Button variant="outline" onClick={() => navigate("/mtas")}>
          Cancel
        </Button>
        <Button
          onClick={handleSubmit}
          disabled={createMutation.isPending}
          data-testid="button-submit-mta"
        >
          {createMutation.isPending ? "Adding…" : "Add Server"}
        </Button>
      </div>
    </div>
  );
}
