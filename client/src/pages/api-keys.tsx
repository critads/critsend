import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { Key, Copy, Check, Trash2, Plus } from "lucide-react";

interface ApiKeyRow {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export default function ApiKeysPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [newName, setNewName] = useState("");
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const { data: keys = [], isLoading } = useQuery<ApiKeyRow[]>({
    queryKey: ["/api/api-keys"],
  });

  const createMutation = useMutation({
    mutationFn: async (name: string) => {
      const res = await apiRequest("POST", "/api/api-keys", { name });
      return res.json();
    },
    onSuccess: (data: any) => {
      setCreatedKey(data.key);
      setCopied(false);
      setNewName("");
      queryClient.invalidateQueries({ queryKey: ["/api/api-keys"] });
    },
    onError: () => toast({ title: "Failed to create API key", variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => apiRequest("DELETE", `/api/api-keys/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/api-keys"] });
      toast({ title: "API key deleted" });
    },
    onError: () => toast({ title: "Failed to delete API key", variant: "destructive" }),
  });

  const copyKey = async () => {
    if (!createdKey) return;
    await navigator.clipboard.writeText(createdKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const curlExample = `curl -X POST https://YOUR-DOMAIN/api/v1/campaigns \\
  -H "X-Api-Key: csk_..." \\
  -H "Content-Type: application/json" \\
  -d '{"name": "My campaign", "subject": "Hello", "html": "<html>...</html>"}'`;

  return (
    <div className="space-y-6 p-6 max-w-4xl mx-auto" data-testid="page-api-keys">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Key className="w-6 h-6" /> API Keys
        </h1>
        <p className="text-muted-foreground">
          Keys for the external API (e.g. creating campaigns from another system).
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Create a key</CardTitle>
          <CardDescription>The key is shown only once — copy it right away.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-2">
            <Input
              placeholder="Key name (e.g. Zapier, CRM sync)"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              maxLength={100}
              data-testid="input-key-name"
            />
            <Button
              onClick={() => newName.trim() && createMutation.mutate(newName.trim())}
              disabled={!newName.trim() || createMutation.isPending}
              data-testid="button-create-key"
            >
              <Plus className="w-4 h-4 mr-1" /> Create
            </Button>
          </div>

          {createdKey && (
            <Alert data-testid="alert-created-key">
              <AlertTitle>Your new API key</AlertTitle>
              <AlertDescription>
                <div className="flex items-center gap-2 mt-2">
                  <code className="bg-muted px-2 py-1 rounded text-sm break-all">{createdKey}</code>
                  <Button size="sm" variant="outline" onClick={copyKey} data-testid="button-copy-key">
                    {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground mt-2">
                  Store it somewhere safe — it cannot be displayed again.
                </p>
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Existing keys</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-muted-foreground">Loading…</p>
          ) : keys.length === 0 ? (
            <p className="text-muted-foreground">No API keys yet.</p>
          ) : (
            <div className="divide-y">
              {keys.map((k) => (
                <div key={k.id} className="flex items-center justify-between py-3" data-testid={`row-key-${k.id}`}>
                  <div>
                    <p className="font-medium">{k.name}</p>
                    <p className="text-sm text-muted-foreground">
                      <code>{k.prefix}…</code> · created {new Date(k.createdAt).toLocaleDateString()}
                      {k.lastUsedAt ? ` · last used ${new Date(k.lastUsedAt).toLocaleString()}` : " · never used"}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      if (confirm(`Delete key "${k.name}"? Systems using it will stop working.`)) {
                        deleteMutation.mutate(k.id);
                      }
                    }}
                    data-testid={`button-delete-${k.id}`}
                  >
                    <Trash2 className="w-4 h-4 text-destructive" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Usage</CardTitle>
          <CardDescription>
            POST <code>/api/v1/campaigns</code> creates a draft campaign (name, subject, HTML).
            Finish the setup (sender, audience, schedule) in the app.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <pre className="bg-muted p-4 rounded text-sm overflow-x-auto">{curlExample}</pre>
        </CardContent>
      </Card>
    </div>
  );
}
