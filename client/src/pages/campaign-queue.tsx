import { useState } from "react";
import { useRoute, Link } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeft, Clock, Filter, Send, ShieldAlert } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid } from "recharts";

interface QueueResponse {
  campaign: { id: string; name: string; deferred_count: number; sent_count: number; pending_count: number; failed_count: number };
  windowHours: number;
  counts: { sent: string; failed: string; deferred: string; deferred_due: string; pending: string; attempting: string };
  page: number;
  limit: number;
  rows: Array<{
    id: string;
    subscriber_id: string;
    email: string;
    status: string;
    sent_at: string | null;
    eligible_at: string | null;
    last_sent_at: string | null;
    blocked_by_campaign_id: string | null;
    blocked_by_campaign_name: string | null;
  }>;
  bucket?: Array<{ bucket_at: string; n: string }>;
}

export default function CampaignQueue() {
  const [, params] = useRoute("/campaigns/:id/queue");
  const id = params?.id ?? "";
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<string>("deferred");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [reason, setReason] = useState("");
  const { toast } = useToast();

  const { data, isLoading } = useQuery<QueueResponse>({
    queryKey: ["/api/campaigns", id, "queue", page, status],
    queryFn: async () => {
      const r = await fetch(`/api/campaigns/${id}/queue?page=${page}&limit=50&status=${status}&bucket=true`, { credentials: "include" });
      if (!r.ok) throw new Error("Failed");
      return r.json();
    },
    enabled: !!id,
    refetchInterval: 10_000,
  });

  const flush = useMutation({
    mutationFn: async (body: { scope: "selected" | "all"; subscriberIds?: string[]; reason: string }) =>
      apiRequest("POST", `/api/campaigns/${id}/queue/flush`, body),
    onSuccess: async (res: any) => {
      const json = await res.json();
      toast({ title: "Reprogrammed", description: `${json.reprogrammed ?? json.flushed} deferred send(s) advanced to NOW(). The 6h gap is still re-checked at dispatch.` });
      setSelected(new Set());
      setReason("");
      queryClient.invalidateQueries({ queryKey: ["/api/campaigns", id, "queue"] });
    },
    onError: (e: any) => toast({ title: "Flush failed", description: e?.message ?? "Error", variant: "destructive" }),
  });

  const counts = data?.counts;
  const bucketData = (data?.bucket ?? []).map((b) => ({
    label: new Date(b.bucket_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit" }),
    count: Number(b.n),
  }));

  return (
    <div className="container mx-auto p-6 space-y-6">
      <Link href={`/campaigns/${id}`}>
        <Button variant="ghost" size="sm" data-testid="link-back-campaign">
          <ArrowLeft className="h-4 w-4 mr-2" /> Back to campaign
        </Button>
      </Link>

      <Card>
        <CardHeader>
          <CardTitle data-testid="text-queue-title">Send queue · {data?.campaign?.name ?? ""}</CardTitle>
          <CardDescription>
            Pressure window: {data?.windowHours ?? 6}h · Cumulative defer events: {data?.campaign?.deferred_count ?? 0}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-2 md:grid-cols-6 gap-3">
          <Stat label="Sent" value={counts?.sent ?? "0"} testId="stat-sent" />
          <Stat label="Failed" value={counts?.failed ?? "0"} testId="stat-failed" />
          <Stat label="Pending" value={counts?.pending ?? "0"} testId="stat-pending" />
          <Stat label="Deferred" value={counts?.deferred ?? "0"} testId="stat-deferred" />
          <Stat label="Due now" value={counts?.deferred_due ?? "0"} testId="stat-due" />
          <Stat label="Attempting" value={counts?.attempting ?? "0"} testId="stat-attempting" />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Upcoming deferred load (next 72h, by hour)</CardTitle>
          <CardDescription>Each bar = number of contacts becoming eligible in that hour bucket.</CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-48 w-full" />
          ) : bucketData.length === 0 ? (
            <div className="text-sm text-muted-foreground py-8 text-center" data-testid="text-empty-histogram">No upcoming deferred load.</div>
          ) : (
            <div style={{ width: "100%", height: 200 }} data-testid="chart-histogram">
              <ResponsiveContainer>
                <BarChart data={bucketData} margin={{ top: 8, right: 12, left: 0, bottom: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                  <XAxis dataKey="label" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
                  <YAxis allowDecimals={false} tick={{ fontSize: 10 }} />
                  <Tooltip />
                  <Bar dataKey="count" fill="hsl(var(--primary))" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Filter className="h-4 w-4" />
            <Select value={status} onValueChange={(v) => { setPage(1); setStatus(v); }}>
              <SelectTrigger className="w-[160px]" data-testid="select-status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="deferred">Deferred</SelectItem>
                <SelectItem value="pending">Pending</SelectItem>
                <SelectItem value="sent">Sent</SelectItem>
                <SelectItem value="failed">Failed</SelectItem>
                <SelectItem value="all">All</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2">
            <Input
              placeholder="Reason (audited, ≥3 chars)"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="w-[280px]"
              data-testid="input-flush-reason"
            />
            <Button
              variant="destructive"
              size="sm"
              disabled={selected.size === 0 || reason.trim().length < 3 || flush.isPending}
              onClick={() => flush.mutate({ scope: "selected", subscriberIds: Array.from(selected), reason })}
              data-testid="button-flush-selected"
            >
              <Send className="h-3 w-3 mr-1" /> Reprogram selected ({selected.size})
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={reason.trim().length < 3 || flush.isPending}
              onClick={() => flush.mutate({ scope: "all", reason })}
              data-testid="button-flush-all"
            >
              Reprogram all deferred
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-2">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="p-2 w-8"></th>
                    <th className="p-2">Email</th>
                    <th className="p-2">Status</th>
                    <th className="p-2">Eligible at</th>
                    <th className="p-2">Blocked by</th>
                    <th className="p-2">Last sent (any campaign)</th>
                  </tr>
                </thead>
                <tbody>
                  {(data?.rows ?? []).map((r) => (
                    <tr key={r.id} className="border-b hover-elevate" data-testid={`row-queue-${r.subscriber_id}`}>
                      <td className="p-2">
                        <input
                          type="checkbox"
                          checked={selected.has(r.subscriber_id)}
                          onChange={(e) => {
                            const next = new Set(selected);
                            if (e.target.checked) next.add(r.subscriber_id); else next.delete(r.subscriber_id);
                            setSelected(next);
                          }}
                          data-testid={`checkbox-row-${r.subscriber_id}`}
                        />
                      </td>
                      <td className="p-2 font-mono text-xs" data-testid={`text-email-${r.subscriber_id}`}>{r.email}</td>
                      <td className="p-2">
                        <Badge variant={r.status === "sent" ? "secondary" : r.status === "failed" ? "destructive" : "outline"}>{r.status}</Badge>
                      </td>
                      <td className="p-2 text-xs">
                        {r.eligible_at ? (
                          <span className="inline-flex items-center gap-1" data-testid={`text-eligible-${r.subscriber_id}`}>
                            <Clock className="h-3 w-3" /> {new Date(r.eligible_at).toLocaleString()}
                          </span>
                        ) : "—"}
                      </td>
                      <td className="p-2 text-xs">
                        {r.blocked_by_campaign_id ? (
                          <Link href={`/campaigns/${r.blocked_by_campaign_id}/queue`}>
                            <span className="inline-flex items-center gap-1 underline-offset-2 hover:underline" data-testid={`link-blocker-${r.subscriber_id}`}>
                              <ShieldAlert className="h-3 w-3" />
                              {r.blocked_by_campaign_name ?? r.blocked_by_campaign_id.slice(0, 8)}
                            </span>
                          </Link>
                        ) : "—"}
                      </td>
                      <td className="p-2 text-xs">{r.last_sent_at ? new Date(r.last_sent_at).toLocaleString() : "—"}</td>
                    </tr>
                  ))}
                  {(data?.rows ?? []).length === 0 && (
                    <tr><td colSpan={6} className="p-6 text-center text-muted-foreground">No rows</td></tr>
                  )}
                </tbody>
              </table>
              <div className="flex items-center justify-between pt-3">
                <Button size="sm" variant="outline" disabled={page === 1} onClick={() => setPage(page - 1)} data-testid="button-prev-page">Previous</Button>
                <span className="text-xs text-muted-foreground">Page {page}</span>
                <Button size="sm" variant="outline" disabled={(data?.rows ?? []).length < 50} onClick={() => setPage(page + 1)} data-testid="button-next-page">Next</Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Stat({ label, value, testId }: { label: string; value: string | number; testId: string }) {
  return (
    <div className="rounded-md border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-2xl font-semibold tabular-nums" data-testid={testId}>{value}</div>
    </div>
  );
}
