import { useState } from "react";
import { Link } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Clock } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface AdminQueueResponse {
  windowHours: number;
  totals: { pending_deferred: string; due_now: string };
  campaigns: Array<{
    campaign_id: string;
    campaign_name: string;
    started_at: string | null;
    lifetime_defers: number;
    pending_deferred: string;
    due_now: string;
    next_eligible_at: string | null;
  }>;
}

export default function AdminPressureQueue() {
  const [reason, setReason] = useState("");
  const { toast } = useToast();
  const { data, isLoading } = useQuery<AdminQueueResponse>({
    queryKey: ["/api/admin/pressure-queue"],
    refetchInterval: 15_000,
  });

  const flushAll = useMutation({
    mutationFn: async () => apiRequest("POST", "/api/admin/pressure-queue/flush", { reason }),
    onSuccess: async (res: any) => {
      const json = await res.json();
      toast({ title: "Global reprogram done", description: `${json.reprogrammed ?? json.flushed} deferred send(s) advanced to NOW().` });
      setReason("");
      queryClient.invalidateQueries({ queryKey: ["/api/admin/pressure-queue"] });
    },
    onError: (e: any) => toast({ title: "Flush failed", description: e?.message ?? "Error", variant: "destructive" }),
  });

  return (
    <div className="container mx-auto p-6 space-y-6">
      <Card>
        <CardHeader>
          <CardTitle data-testid="text-admin-queue-title">Pressure queue (all campaigns)</CardTitle>
          <CardDescription>
            FIFO drain order: oldest started_at first. Window: {data?.windowHours ?? 6}h.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3">
          <Stat label="Pending deferred (total)" value={data?.totals?.pending_deferred ?? "0"} testId="stat-total-pending" />
          <Stat label="Due now (drainable)" value={data?.totals?.due_now ?? "0"} testId="stat-total-due" />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <CardTitle className="text-base">Per-campaign breakdown</CardTitle>
          <div className="flex items-center gap-2">
            <Input
              placeholder="Reason (audited, ≥3 chars)"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="w-[260px]"
              data-testid="input-admin-flush-reason"
            />
            <Button
              variant="destructive"
              size="sm"
              disabled={reason.trim().length < 3 || flushAll.isPending}
              onClick={() => flushAll.mutate()}
              data-testid="button-admin-flush-all"
            >
              Reprogram ALL deferred (everywhere)
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
                    <th className="p-2">Campaign</th>
                    <th className="p-2">Started</th>
                    <th className="p-2 text-right">Pending deferred</th>
                    <th className="p-2 text-right">Due now</th>
                    <th className="p-2 text-right">Lifetime defers</th>
                    <th className="p-2">Next eligible</th>
                    <th className="p-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {(data?.campaigns ?? []).map((c) => (
                    <tr key={c.campaign_id} className="border-b hover-elevate" data-testid={`row-campaign-${c.campaign_id}`}>
                      <td className="p-2 font-medium" data-testid={`text-campaign-name-${c.campaign_id}`}>{c.campaign_name}</td>
                      <td className="p-2 text-xs">{c.started_at ? new Date(c.started_at).toLocaleString() : "—"}</td>
                      <td className="p-2 text-right tabular-nums">{c.pending_deferred}</td>
                      <td className="p-2 text-right tabular-nums">{c.due_now}</td>
                      <td className="p-2 text-right tabular-nums">{c.lifetime_defers}</td>
                      <td className="p-2 text-xs">
                        {c.next_eligible_at ? (
                          <span className="inline-flex items-center gap-1"><Clock className="h-3 w-3" />{new Date(c.next_eligible_at).toLocaleString()}</span>
                        ) : "—"}
                      </td>
                      <td className="p-2">
                        <Link href={`/campaigns/${c.campaign_id}/queue`}>
                          <Button size="sm" variant="outline" data-testid={`link-open-queue-${c.campaign_id}`}>Open</Button>
                        </Link>
                      </td>
                    </tr>
                  ))}
                  {(data?.campaigns ?? []).length === 0 && (
                    <tr><td colSpan={7} className="p-6 text-center text-muted-foreground">No deferred sends pending</td></tr>
                  )}
                </tbody>
              </table>
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
