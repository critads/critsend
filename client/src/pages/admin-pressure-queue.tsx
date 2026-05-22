import { useState } from "react";
import { Link } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Clock, History, Users, TrendingUp, Send, AlertTriangle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, AreaChart, Area } from "recharts";

// Task #178: every admin endpoint can return its last cached payload
// with `stale: true` + the original `generatedAt` when the live query
// times out under pool pressure. The page renders a small "stale (Xs
// ago)" badge instead of going blank.
interface StaleMeta {
  stale?: boolean;
  generatedAt?: string;
}

interface AdminQueueResponse extends StaleMeta {
  windowHours: number;
  // Task #169: aging cap context — surfaced so the page can label and
  // colour the "oldest age" + "near aging" columns correctly even if the
  // operator has tuned PRESSURE_MAX_DEFER_HOURS away from the 72h default.
  maxDeferHours?: number;
  nearAgingHours?: number;
  totals: {
    pending_deferred: string;
    due_now: string;
    distinct_contacts_in_cooldown?: string;
    oldest_deferred_age_hours?: string | number | null;
    near_aging_count?: string | number | null;
  };
  campaigns: Array<{
    campaign_id: string;
    campaign_name: string;
    started_at: string | null;
    lifetime_defers: number;
    pending_deferred: string;
    due_now: string;
    next_eligible_at: string | null;
    oldest_deferred_age_hours?: string | number | null;
    near_aging_count?: string | number | null;
    aged_forced_count?: number | null;
  }>;
}

// Format an age in fractional hours as "Nh Mm" — keeps the column narrow
// while still being precise enough to distinguish "approaching cap" from
// "way over". Returns "—" for null/undefined/<=0 so empty queues render
// cleanly.
// Task #178: small muted indicator rendered next to any card whose
// payload came back with `stale: true`. Shows seconds-since the cached
// payload was generated so operators can tell at a glance how out-of-
// date the values are. Returns null when payload is fresh.
function StaleBadge({ payload, testId }: { payload: StaleMeta | undefined; testId: string }) {
  if (!payload?.stale || !payload?.generatedAt) return null;
  const ageMs = Date.now() - new Date(payload.generatedAt).getTime();
  const ageSec = Math.max(0, Math.round(ageMs / 1000));
  const label = ageSec < 60 ? `${ageSec}s ago` : `${Math.round(ageSec / 60)}m ago`;
  return (
    <Badge variant="outline" className="text-[10px] font-normal text-muted-foreground border-muted-foreground/30" data-testid={testId}>
      stale ({label})
    </Badge>
  );
}

function formatAgeHours(v: string | number | null | undefined): string {
  if (v == null) return "—";
  const h = typeof v === "string" ? parseFloat(v) : v;
  if (!Number.isFinite(h) || h <= 0) return "—";
  const whole = Math.floor(h);
  const mins = Math.round((h - whole) * 60);
  return mins === 0 ? `${whole}h` : `${whole}h ${mins}m`;
}
interface CurveResponse extends StaleMeta {
  defers: Array<{ day: string; n: string }>;
  flushes: Array<{ day: string; n: string }>;
}
interface TopContactsResponse extends StaleMeta {
  rows: Array<{
    subscriber_id: string;
    email: string;
    last_sent_at: string | null;
    deferred_rows: string;
    next_eligible_at: string | null;
  }>;
}
interface ThroughputResponse extends StaleMeta {
  currentMailsPerMin: number;
  sentLast1Min?: number;
  sentLast5Min: number;
  series: Array<{ minute: string; sent: number }>;
  generatedAt: string;
}
interface HistoryResponse extends StaleMeta {
  rows: Array<{
    id: string;
    created_at: string;
    scope: string;
    count: number;
    reason: string;
    user_id: string | null;
    user_name: string | null;
    campaign_id: string | null;
    campaign_name: string | null;
  }>;
}

export default function AdminPressureQueue() {
  const [reason, setReason] = useState("");
  const { toast } = useToast();
  const { data, isLoading } = useQuery<AdminQueueResponse>({
    queryKey: ["/api/admin/pressure-queue"],
    refetchInterval: 15_000,
  });
  const { data: curve } = useQuery<CurveResponse>({
    queryKey: ["/api/admin/pressure-queue/curve"],
    refetchInterval: 60_000,
  });
  const { data: top } = useQuery<TopContactsResponse>({
    queryKey: ["/api/admin/pressure-queue/top-contacts"],
    refetchInterval: 30_000,
  });
  const { data: history } = useQuery<HistoryResponse>({
    queryKey: ["/api/admin/pressure-queue/history"],
    refetchInterval: 30_000,
  });
  const { data: throughput } = useQuery<ThroughputResponse>({
    queryKey: ["/api/admin/pressure-queue/throughput"],
    refetchInterval: 15_000,
  });

  const flushAll = useMutation({
    mutationFn: async () => apiRequest("POST", "/api/admin/pressure-queue/flush", { reason }),
    onSuccess: async (res: any) => {
      const json = await res.json();
      toast({ title: "Global reprogram done", description: `${json.reprogrammed ?? json.flushed} deferred send(s) advanced to NOW().` });
      setReason("");
      queryClient.invalidateQueries({ queryKey: ["/api/admin/pressure-queue"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/pressure-queue/history"] });
    },
    onError: (e: any) => toast({ title: "Flush failed", description: e?.message ?? "Error", variant: "destructive" }),
  });

  // Merge defers + flushes by day for the line chart
  const days = new Map<string, { day: string; defers: number; flushes: number }>();
  (curve?.defers ?? []).forEach((d) => {
    const k = new Date(d.day).toISOString().slice(0, 10);
    days.set(k, { day: k, defers: Number(d.n), flushes: days.get(k)?.flushes ?? 0 });
  });
  (curve?.flushes ?? []).forEach((d) => {
    const k = new Date(d.day).toISOString().slice(0, 10);
    days.set(k, { day: k, defers: days.get(k)?.defers ?? 0, flushes: Number(d.n) });
  });
  const series = Array.from(days.values()).sort((a, b) => a.day.localeCompare(b.day));

  return (
    <div className="container mx-auto p-6 space-y-6">
      <Card>
        <CardHeader>
          <CardTitle data-testid="text-admin-queue-title" className="flex items-center gap-2">
            Pressure queue (all campaigns)
            <StaleBadge payload={data} testId="badge-stale-queue" />
          </CardTitle>
          <CardDescription>
            FIFO drain order: oldest created_at first. Window: {data?.windowHours ?? 6}h.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Stat label="Pending deferred (total)" value={data?.totals?.pending_deferred ?? "0"} testId="stat-total-pending" />
          <Stat label="Due now (drainable)" value={data?.totals?.due_now ?? "0"} testId="stat-total-due" />
          <Stat label="Distinct contacts in cooldown" value={data?.totals?.distinct_contacts_in_cooldown ?? "0"} testId="stat-distinct-contacts" />
          <Stat
            label="Purge throughput (mails/min, last min)"
            value={throughput ? throughput.currentMailsPerMin.toLocaleString() : "—"}
            testId="stat-purge-throughput"
            accent
          />
          {/* Task #169: aging cap totals — at-a-glance "how close to 72h?"
              and "how many about to be force-dispatched?". */}
          <Stat
            label={`Oldest deferred (cap ${data?.maxDeferHours ?? 72}h)`}
            value={formatAgeHours(data?.totals?.oldest_deferred_age_hours)}
            testId="stat-oldest-deferred-age"
          />
          <Stat
            label={`Near aging (≥${data?.nearAgingHours ?? 48}h)`}
            value={String(data?.totals?.near_aging_count ?? "0")}
            testId="stat-near-aging"
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Send className="h-4 w-4" /> Live purge throughput (last 30 min)
            <StaleBadge payload={throughput} testId="badge-stale-throughput" />
          </CardTitle>
          <CardDescription>
            Sends per minute across the cluster.
            {throughput?.sentLast5Min !== undefined ? ` ${throughput.sentLast5Min.toLocaleString()} sent in the last 5 min.` : ""}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!throughput ? (
            <Skeleton className="h-32 w-full" />
          ) : throughput.series.length === 0 ? (
            <div className="text-sm text-muted-foreground py-8 text-center" data-testid="text-empty-throughput">
              No sends in the last 30 minutes.
            </div>
          ) : (
            <div style={{ width: "100%", height: 160 }} data-testid="chart-throughput">
              <ResponsiveContainer>
                <AreaChart data={throughput.series.map((p) => ({
                  t: new Date(p.minute).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
                  sent: p.sent,
                }))} margin={{ top: 8, right: 12, left: 0, bottom: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                  <XAxis dataKey="t" tick={{ fontSize: 10 }} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 10 }} />
                  <Tooltip />
                  <Area type="monotone" dataKey="sent" stroke="hsl(var(--primary))" fill="hsl(var(--primary))" fillOpacity={0.2} strokeWidth={2} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <TrendingUp className="h-4 w-4" /> 7-day curve
            <StaleBadge payload={curve} testId="badge-stale-curve" />
          </CardTitle>
          <CardDescription>Daily defer events vs flush events.</CardDescription>
        </CardHeader>
        <CardContent>
          {!curve ? (
            <Skeleton className="h-48 w-full" />
          ) : series.length === 0 ? (
            <div className="text-sm text-muted-foreground py-8 text-center" data-testid="text-empty-curve">No activity in the last 7 days.</div>
          ) : (
            <div style={{ width: "100%", height: 220 }} data-testid="chart-curve">
              <ResponsiveContainer>
                <LineChart data={series} margin={{ top: 8, right: 12, left: 0, bottom: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                  <XAxis dataKey="day" tick={{ fontSize: 10 }} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 10 }} />
                  <Tooltip />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Line type="monotone" dataKey="defers" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="flushes" stroke="hsl(var(--destructive))" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
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
                    {/* Task #169 columns */}
                    <th className="p-2 text-right">Oldest age</th>
                    <th className="p-2 text-right">Near aging</th>
                    <th className="p-2 text-right">Aged force-sent</th>
                    <th className="p-2">Next eligible</th>
                    <th className="p-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {(data?.campaigns ?? []).map((c) => {
                    // Task #169: age-based colour cues. Red ≥ cap, amber ≥
                    // near-aging threshold. Falls back gracefully when the
                    // backend hasn't returned the aging fields yet.
                    const oldestNum = c.oldest_deferred_age_hours == null
                      ? null
                      : (typeof c.oldest_deferred_age_hours === "string"
                          ? parseFloat(c.oldest_deferred_age_hours)
                          : c.oldest_deferred_age_hours);
                    const cap = data?.maxDeferHours ?? 72;
                    const near = data?.nearAgingHours ?? 48;
                    const ageClass = oldestNum == null || !Number.isFinite(oldestNum)
                      ? "text-muted-foreground"
                      : oldestNum >= cap
                        ? "text-destructive font-semibold"
                        : oldestNum >= near
                          ? "text-amber-600 dark:text-amber-400 font-medium"
                          : "";
                    const nearAging = Number(c.near_aging_count ?? 0);
                    const agedForced = Number(c.aged_forced_count ?? 0);
                    return (
                      <tr key={c.campaign_id} className="border-b hover-elevate" data-testid={`row-campaign-${c.campaign_id}`}>
                        <td className="p-2 font-medium" data-testid={`text-campaign-name-${c.campaign_id}`}>{c.campaign_name}</td>
                        <td className="p-2 text-xs">{c.started_at ? new Date(c.started_at).toLocaleString() : "—"}</td>
                        <td className="p-2 text-right tabular-nums">{c.pending_deferred}</td>
                        <td className="p-2 text-right tabular-nums">{c.due_now}</td>
                        <td className="p-2 text-right tabular-nums">{c.lifetime_defers}</td>
                        <td className={`p-2 text-right tabular-nums ${ageClass}`} data-testid={`text-oldest-age-${c.campaign_id}`}>
                          <span className="inline-flex items-center gap-1 justify-end">
                            {oldestNum != null && Number.isFinite(oldestNum) && oldestNum >= near && (
                              <AlertTriangle className="h-3 w-3" />
                            )}
                            {formatAgeHours(c.oldest_deferred_age_hours)}
                          </span>
                        </td>
                        <td className={`p-2 text-right tabular-nums ${nearAging > 0 ? "text-amber-600 dark:text-amber-400 font-medium" : "text-muted-foreground"}`} data-testid={`text-near-aging-${c.campaign_id}`}>
                          {nearAging}
                        </td>
                        <td className={`p-2 text-right tabular-nums ${agedForced > 0 ? "text-destructive font-medium" : "text-muted-foreground"}`} data-testid={`text-aged-forced-${c.campaign_id}`}>
                          {agedForced}
                        </td>
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
                    );
                  })}
                  {(data?.campaigns ?? []).length === 0 && (
                    <tr><td colSpan={10} className="p-6 text-center text-muted-foreground">No deferred sends pending</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Users className="h-4 w-4" /> Top 20 most-deferred contacts
            <StaleBadge payload={top} testId="badge-stale-top" />
          </CardTitle>
          <CardDescription>Across all campaigns, currently pending.</CardDescription>
        </CardHeader>
        <CardContent>
          {!top ? (
            <div className="space-y-2">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-8 w-full" />)}</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="p-2">Contact</th>
                    <th className="p-2 text-right">Deferred rows</th>
                    <th className="p-2">Next eligible</th>
                    <th className="p-2">Last sent</th>
                  </tr>
                </thead>
                <tbody>
                  {(top.rows ?? []).map((r) => (
                    <tr key={r.subscriber_id} className="border-b hover-elevate" data-testid={`row-top-${r.subscriber_id}`}>
                      <td className="p-2 font-mono text-xs" data-testid={`text-top-email-${r.subscriber_id}`}>{r.email}</td>
                      <td className="p-2 text-right tabular-nums">
                        <Badge variant="secondary">{r.deferred_rows}</Badge>
                      </td>
                      <td className="p-2 text-xs">{r.next_eligible_at ? new Date(r.next_eligible_at).toLocaleString() : "—"}</td>
                      <td className="p-2 text-xs">{r.last_sent_at ? new Date(r.last_sent_at).toLocaleString() : "—"}</td>
                    </tr>
                  ))}
                  {(top.rows ?? []).length === 0 && (
                    <tr><td colSpan={4} className="p-6 text-center text-muted-foreground">No contacts currently in queue</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <History className="h-4 w-4" /> Flush history
            <StaleBadge payload={history} testId="badge-stale-history" />
          </CardTitle>
          <CardDescription>Latest 50 manual reprogram operations.</CardDescription>
        </CardHeader>
        <CardContent>
          {!history ? (
            <div className="space-y-2">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-8 w-full" />)}</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="p-2">When</th>
                    <th className="p-2">By</th>
                    <th className="p-2">Scope</th>
                    <th className="p-2">Campaign</th>
                    <th className="p-2 text-right">Rows</th>
                    <th className="p-2">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {(history.rows ?? []).map((r) => (
                    <tr key={r.id} className="border-b" data-testid={`row-history-${r.id}`}>
                      <td className="p-2 text-xs">{new Date(r.created_at).toLocaleString()}</td>
                      <td className="p-2 text-xs">{r.user_name ?? r.user_id ?? "—"}</td>
                      <td className="p-2"><Badge variant="outline">{r.scope}</Badge></td>
                      <td className="p-2 text-xs">{r.campaign_name ?? "—"}</td>
                      <td className="p-2 text-right tabular-nums">{r.count}</td>
                      <td className="p-2 text-xs max-w-[280px] truncate" title={r.reason}>{r.reason}</td>
                    </tr>
                  ))}
                  {(history.rows ?? []).length === 0 && (
                    <tr><td colSpan={6} className="p-6 text-center text-muted-foreground">No flush events yet</td></tr>
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

function Stat({ label, value, testId, accent }: { label: string; value: string | number; testId: string; accent?: boolean }) {
  return (
    <div className={`rounded-md border p-3 ${accent ? "bg-primary/5 border-primary/40" : ""}`}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`text-2xl font-semibold tabular-nums ${accent ? "text-primary" : ""}`} data-testid={testId}>{value}</div>
    </div>
  );
}
