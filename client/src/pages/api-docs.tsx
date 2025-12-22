import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { useToast } from "@/hooks/use-toast";
import { Copy, Check, FileCode, Key, BookOpen } from "lucide-react";

const endpoints = [
  {
    category: "Subscribers",
    items: [
      {
        method: "GET",
        path: "/api/subscribers",
        description: "List all subscribers with pagination",
        params: [
          { name: "page", type: "number", description: "Page number (default: 1)" },
          { name: "limit", type: "number", description: "Items per page (default: 20)" },
          { name: "search", type: "string", description: "Search by email or tag" },
        ],
        response: `{
  "subscribers": [...],
  "total": 1000000,
  "page": 1,
  "limit": 20,
  "totalPages": 50000
}`,
      },
      {
        method: "GET",
        path: "/api/subscribers/:id",
        description: "Get a single subscriber by ID",
        response: `{
  "id": "uuid",
  "email": "john@example.com",
  "tags": ["VIP", "NEWSLETTER"],
  "ipAddress": "192.168.1.1",
  "importDate": "2024-01-01T00:00:00Z"
}`,
      },
      {
        method: "POST",
        path: "/api/subscribers",
        description: "Create a new subscriber",
        body: `{
  "email": "john@example.com",
  "tags": ["VIP"],
  "ipAddress": "192.168.1.1"
}`,
        response: `{ "id": "uuid", ... }`,
      },
      {
        method: "PATCH",
        path: "/api/subscribers/:id",
        description: "Update subscriber tags",
        body: `{ "tags": ["VIP", "PREMIUM"] }`,
      },
      {
        method: "DELETE",
        path: "/api/subscribers/:id",
        description: "Delete a subscriber",
      },
    ],
  },
  {
    category: "Segments",
    items: [
      {
        method: "GET",
        path: "/api/segments",
        description: "List all segments",
      },
      {
        method: "POST",
        path: "/api/segments",
        description: "Create a new segment",
        body: `{
  "name": "VIP Customers",
  "description": "High-value customers",
  "rules": [
    { "field": "tags", "operator": "contains", "value": "VIP" }
  ]
}`,
      },
      {
        method: "GET",
        path: "/api/segments/:id/count",
        description: "Get subscriber count for a segment",
        response: `{ "count": 15000 }`,
      },
      {
        method: "DELETE",
        path: "/api/segments/:id",
        description: "Delete a segment",
      },
    ],
  },
  {
    category: "Campaigns",
    items: [
      {
        method: "GET",
        path: "/api/campaigns",
        description: "List all campaigns",
      },
      {
        method: "POST",
        path: "/api/campaigns",
        description: "Create a new campaign",
        body: `{
  "name": "March Newsletter",
  "mtaId": "uuid",
  "segmentId": "uuid",
  "fromName": "Company",
  "fromEmail": "hello@company.com",
  "subject": "Hello!",
  "htmlContent": "<html>...</html>",
  "sendingSpeed": "medium",
  "status": "draft"
}`,
      },
      {
        method: "POST",
        path: "/api/campaigns/:id/pause",
        description: "Pause a sending campaign",
      },
      {
        method: "POST",
        path: "/api/campaigns/:id/resume",
        description: "Resume a paused campaign",
      },
      {
        method: "POST",
        path: "/api/campaigns/:id/copy",
        description: "Create a copy of a campaign",
      },
      {
        method: "DELETE",
        path: "/api/campaigns/:id",
        description: "Delete a campaign",
      },
    ],
  },
  {
    category: "MTAs",
    items: [
      {
        method: "GET",
        path: "/api/mtas",
        description: "List all sending servers",
      },
      {
        method: "POST",
        path: "/api/mtas",
        description: "Add a new MTA",
        body: `{
  "name": "Primary SMTP",
  "hostname": "smtp.example.com",
  "port": 587,
  "username": "user",
  "password": "pass",
  "trackingDomain": "track.example.com",
  "isActive": true
}`,
      },
      {
        method: "PATCH",
        path: "/api/mtas/:id",
        description: "Update MTA settings",
      },
      {
        method: "DELETE",
        path: "/api/mtas/:id",
        description: "Remove an MTA",
      },
    ],
  },
  {
    category: "Import / Export",
    items: [
      {
        method: "POST",
        path: "/api/import",
        description: "Import subscribers from CSV (multipart/form-data)",
        body: "file: CSV file",
      },
      {
        method: "GET",
        path: "/api/import-jobs",
        description: "List all import jobs",
      },
      {
        method: "GET",
        path: "/api/export",
        description: "Export all subscribers as CSV",
        params: [
          { name: "fields", type: "string", description: "Comma-separated field names" },
        ],
      },
    ],
  },
  {
    category: "Analytics",
    items: [
      {
        method: "GET",
        path: "/api/analytics/overall",
        description: "Get overall analytics summary",
      },
      {
        method: "GET",
        path: "/api/analytics/campaign/:id",
        description: "Get detailed analytics for a campaign",
      },
    ],
  },
];

function MethodBadge({ method }: { method: string }) {
  const colors: Record<string, string> = {
    GET: "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300",
    POST: "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300",
    PATCH: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300",
    PUT: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300",
    DELETE: "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300",
  };
  return (
    <Badge className={`font-mono text-xs ${colors[method] || ""}`}>
      {method}
    </Badge>
  );
}

function CodeBlock({ code, language = "json" }: { code: string; language?: string }) {
  const [copied, setCopied] = useState(false);
  const { toast } = useToast();

  const handleCopy = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    toast({ title: "Copied to clipboard" });
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="relative">
      <pre className="bg-muted p-4 rounded-md overflow-x-auto text-sm font-mono">
        <code>{code}</code>
      </pre>
      <Button
        variant="ghost"
        size="icon"
        className="absolute top-2 right-2"
        onClick={handleCopy}
      >
        {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
      </Button>
    </div>
  );
}

export default function ApiDocs() {
  return (
    <div className="p-6 lg:p-8 space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">API Documentation</h1>
        <p className="text-muted-foreground">
          Complete REST API reference for Critsend
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Key className="h-5 w-5" />
            Authentication
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            All API requests require authentication. Include your API key in the Authorization header:
          </p>
          <CodeBlock
            code={`Authorization: Bearer YOUR_API_KEY`}
            language="http"
          />
          <p className="text-sm text-muted-foreground">
            Contact your administrator to obtain an API key.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <BookOpen className="h-5 w-5" />
            Base URL
          </CardTitle>
        </CardHeader>
        <CardContent>
          <CodeBlock code={`${window.location.origin}/api`} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileCode className="h-5 w-5" />
            Endpoints
          </CardTitle>
          <CardDescription>
            Click on an endpoint to see details
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue={endpoints[0].category} className="w-full">
            <TabsList className="flex flex-wrap gap-1 h-auto mb-4">
              {endpoints.map((cat) => (
                <TabsTrigger key={cat.category} value={cat.category} className="text-xs">
                  {cat.category}
                </TabsTrigger>
              ))}
            </TabsList>
            {endpoints.map((cat) => (
              <TabsContent key={cat.category} value={cat.category}>
                <Accordion type="single" collapsible className="w-full">
                  {cat.items.map((endpoint, index) => (
                    <AccordionItem
                      key={index}
                      value={`item-${index}`}
                      data-testid={`endpoint-${endpoint.method}-${endpoint.path.replace(/[/:]/g, '-')}`}
                    >
                      <AccordionTrigger className="hover:no-underline">
                        <div className="flex items-center gap-3">
                          <MethodBadge method={endpoint.method} />
                          <span className="font-mono text-sm">{endpoint.path}</span>
                        </div>
                      </AccordionTrigger>
                      <AccordionContent className="space-y-4 pt-2">
                        <p className="text-sm text-muted-foreground">
                          {endpoint.description}
                        </p>

                        {endpoint.params && endpoint.params.length > 0 && (
                          <div>
                            <h4 className="text-sm font-medium mb-2">Query Parameters</h4>
                            <div className="space-y-2">
                              {endpoint.params.map((param, i) => (
                                <div key={i} className="flex items-start gap-2 text-sm">
                                  <code className="bg-muted px-1 rounded font-mono">
                                    {param.name}
                                  </code>
                                  <Badge variant="outline" className="text-xs">
                                    {param.type}
                                  </Badge>
                                  <span className="text-muted-foreground">
                                    {param.description}
                                  </span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {endpoint.body && (
                          <div>
                            <h4 className="text-sm font-medium mb-2">Request Body</h4>
                            <CodeBlock code={endpoint.body} />
                          </div>
                        )}

                        {endpoint.response && (
                          <div>
                            <h4 className="text-sm font-medium mb-2">Response</h4>
                            <CodeBlock code={endpoint.response} />
                          </div>
                        )}
                      </AccordionContent>
                    </AccordionItem>
                  ))}
                </Accordion>
              </TabsContent>
            ))}
          </Tabs>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Rate Limiting</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            API requests are limited to 1000 requests per minute per API key.
            Rate limit headers are included in all responses:
          </p>
          <CodeBlock
            code={`X-RateLimit-Limit: 1000
X-RateLimit-Remaining: 999
X-RateLimit-Reset: 1640000000`}
          />
        </CardContent>
      </Card>
    </div>
  );
}
