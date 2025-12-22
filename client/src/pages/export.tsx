import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { Download, FileDown, Loader2, AlertCircle } from "lucide-react";

export default function Export() {
  const [includeFields, setIncludeFields] = useState({
    email: true,
    tags: true,
    ipAddress: true,
    importDate: true,
  });
  const { toast } = useToast();

  const exportMutation = useMutation({
    mutationFn: async () => {
      const fields = Object.entries(includeFields)
        .filter(([_, include]) => include)
        .map(([field]) => field);
      
      const response = await fetch(`/api/export?fields=${fields.join(",")}`);
      if (!response.ok) {
        throw new Error("Export failed");
      }
      
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `critsend-export-${new Date().toISOString().split("T")[0]}.csv`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    },
    onSuccess: () => {
      toast({
        title: "Export complete",
        description: "Your subscriber data has been downloaded.",
      });
    },
    onError: () => {
      toast({
        title: "Export failed",
        description: "Failed to export data. Please try again.",
        variant: "destructive",
      });
    },
  });

  const fieldOptions = [
    { key: "email", label: "Email Address", required: true },
    { key: "tags", label: "Tags" },
    { key: "ipAddress", label: "IP Address" },
    { key: "importDate", label: "Import Date" },
  ];

  return (
    <div className="p-6 lg:p-8 space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Export Subscribers</h1>
        <p className="text-muted-foreground">
          Download your entire subscriber database as a CSV file
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Download className="h-5 w-5" />
            Export Options
          </CardTitle>
          <CardDescription>
            Select which fields to include in the export
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-4">
            {fieldOptions.map((field) => (
              <div key={field.key} className="flex items-center space-x-3">
                <Checkbox
                  id={field.key}
                  checked={includeFields[field.key as keyof typeof includeFields]}
                  onCheckedChange={(checked) =>
                    setIncludeFields((prev) => ({ ...prev, [field.key]: checked }))
                  }
                  disabled={field.required}
                  data-testid={`checkbox-${field.key}`}
                />
                <Label
                  htmlFor={field.key}
                  className={field.required ? "text-muted-foreground" : ""}
                >
                  {field.label}
                  {field.required && (
                    <span className="text-xs text-muted-foreground ml-2">(required)</span>
                  )}
                </Label>
              </div>
            ))}
          </div>

          <div className="rounded-md bg-muted/50 p-4">
            <div className="flex items-start gap-3">
              <AlertCircle className="h-5 w-5 text-muted-foreground mt-0.5" />
              <div>
                <p className="font-medium text-sm">Large Database Notice</p>
                <p className="text-sm text-muted-foreground">
                  If you have millions of subscribers, the export may take a few minutes.
                  The file will be downloaded automatically when ready.
                </p>
              </div>
            </div>
          </div>

          <Button
            onClick={() => exportMutation.mutate()}
            disabled={exportMutation.isPending}
            className="w-full sm:w-auto"
            data-testid="button-export"
          >
            {exportMutation.isPending ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Exporting...
              </>
            ) : (
              <>
                <FileDown className="h-4 w-4 mr-2" />
                Export to CSV
              </>
            )}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
