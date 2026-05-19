import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Link } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import {
  Users,
  Mail,
  MousePointer2,
  Eye,
  Plus,
  ArrowUpRight,
  CheckCircle2,
  AlertCircle,
  Send,
  UserPlus,
  Filter,
  Bell,
  Settings,
  ChevronDown,
  ChevronUp,
  Megaphone,
  UserMinus,
  Inbox,
  Activity,
} from "lucide-react";
import type { Segment } from "@shared/schema";
import {
  Bar,
  BarChart,
  ResponsiveContainer,
  XAxis,
  Tooltip,
  Cell,
} from "recharts";

interface DashboardStats {
  totalSubscribers: number;
  totalCampaigns: number;
  totalOpens: number;
  totalClicks: number;
  totalUnsubscribes: number;
  recentCampaigns: Array<{
    id: string;
    name: string;
    status: string;
    sentCount: number;
    scheduledAt: string | null;
    segmentId: string | null;
  }>;
  recentImports: Array<{
    id: string;
    filename: string;
    status: string;
    processedRows: number;
    totalRows: number;
  }>;
}

interface ChartPoint {
  name: string;
  opens: number;
  clicks: number;
}

function pct(num: number, den: number): number {
  if (!den || den <= 0) return 0;
  return Math.min(100, Math.round((num / den) * 100));
}

function statusDot(status: string): string {
  switch (status) {
    case "sending":
      return "bg-emerald-500";
    case "scheduled":
      return "bg-amber-400";
    case "completed":
      return "bg-stone-400";
    case "paused":
      return "bg-orange-400";
    case "failed":
      return "bg-red-500";
    default:
      return "bg-stone-300";
  }
}

export default function Dashboard() {
  const { user } = useAuth();

  const { data: stats, isLoading } = useQuery<DashboardStats>({
    queryKey: ["/api/dashboard/stats"],
    staleTime: 15_000,
  });

  const { data: chartData, isLoading: chartLoading } = useQuery<ChartPoint[]>({
    queryKey: ["/api/dashboard/chart"],
    staleTime: 60_000,
  });

  const { data: segments, isLoading: segmentsLoading } = useQuery<Segment[]>({
    queryKey: ["/api/segments"],
    staleTime: 5 * 60 * 1000,
  });

  const maxOpens = useMemo(
    () => Math.max(1, ...(chartData ?? []).map((d) => d.opens)),
    [chartData],
  );
  const hasChartData = (chartData ?? []).some((d) => d.opens > 0 || d.clicks > 0);

  const segmentNameById = new Map<string, string>(
    (segments ?? []).map((s) => [s.id, s.name]),
  );

  const totalSent = stats?.recentCampaigns?.reduce((s, c) => s + (c.sentCount ?? 0), 0) ?? 0;
  const openRate = pct(stats?.totalOpens ?? 0, totalSent);
  const clickRate = pct(stats?.totalClicks ?? 0, totalSent);
  const unsubRate = pct(stats?.totalUnsubscribes ?? 0, totalSent);

  const heroCampaign = stats?.recentCampaigns?.[0];
  const upcomingItems = (stats?.recentCampaigns ?? []).slice(0, 5);

  const username = user?.username ?? "there";
  const displayName = username.charAt(0).toUpperCase() + username.slice(1);

  return (
    <div className="min-h-screen bg-stone-200/60 dark:bg-zinc-900 p-4 lg:p-6">
      <div
        className="max-w-[1400px] mx-auto rounded-[2rem] p-6 lg:p-10 shadow-2xl"
        style={{
          background:
            "linear-gradient(135deg, #faf6ec 0%, #f5ecd0 55%, #f0e3b8 100%)",
        }}
      >
        {/* Top bar */}
        <div className="flex items-center justify-between mb-8">
          <div className="px-5 py-2 rounded-full bg-white/70 border border-stone-300/50 text-sm font-semibold text-stone-800 tracking-tight">
            Critsend
          </div>
          <div className="hidden md:flex items-center gap-1 px-2 py-1.5 rounded-full bg-white/60 border border-stone-300/40 text-sm">
            <span className="px-4 py-1.5 rounded-full bg-stone-900 text-white font-medium">Dashboard</span>
            <Link href="/campaigns">
              <span className="px-3 py-1.5 text-stone-700 hover:text-stone-900 cursor-pointer" data-testid="link-nav-campaigns">Campaigns</span>
            </Link>
            <Link href="/subscribers">
              <span className="px-3 py-1.5 text-stone-700 hover:text-stone-900 cursor-pointer" data-testid="link-nav-subscribers">Subscribers</span>
            </Link>
            <Link href="/segments">
              <span className="px-3 py-1.5 text-stone-700 hover:text-stone-900 cursor-pointer" data-testid="link-nav-segments">Segments</span>
            </Link>
            <Link href="/analytics">
              <span className="px-3 py-1.5 text-stone-700 hover:text-stone-900 cursor-pointer" data-testid="link-nav-analytics">Analytics</span>
            </Link>
            <Link href="/mtas">
              <span className="px-3 py-1.5 text-stone-700 hover:text-stone-900 cursor-pointer" data-testid="link-nav-mtas">MTAs</span>
            </Link>
            <Link href="/automation">
              <span className="px-3 py-1.5 text-stone-700 hover:text-stone-900 cursor-pointer" data-testid="link-nav-automation">Automation</span>
            </Link>
          </div>
          <div className="flex items-center gap-2">
            <Link href="/system-metrics">
              <button className="p-2 rounded-full bg-white/70 border border-stone-300/40 text-stone-700 hover:bg-white" data-testid="button-settings">
                <Settings className="h-4 w-4" />
              </button>
            </Link>
            <button className="p-2 rounded-full bg-white/70 border border-stone-300/40 text-stone-700 hover:bg-white relative" data-testid="button-notifications">
              <Bell className="h-4 w-4" />
              <span className="absolute top-1.5 right-1.5 w-1.5 h-1.5 rounded-full bg-amber-500" />
            </button>
            <div className="w-9 h-9 rounded-full bg-stone-900 text-white flex items-center justify-center text-sm font-semibold" data-testid="text-user-initial">
              {displayName.charAt(0)}
            </div>
          </div>
        </div>

        {/* Hero header */}
        <div className="flex flex-col lg:flex-row lg:items-end lg:justify-between gap-6 mb-8">
          <div className="flex-1 min-w-0">
            <h1
              className="text-4xl lg:text-5xl font-semibold tracking-tight text-stone-900"
              data-testid="text-welcome"
            >
              Welcome in, {displayName}
            </h1>

            {/* Engagement bar */}
            <div className="mt-6 max-w-2xl">
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-stone-600 mb-2">
                <span>Sent</span>
                <span>Opened</span>
                <span>Clicked</span>
                <span className="ml-auto hidden sm:inline">Unsubscribed</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="px-3 py-1 rounded-full bg-stone-900 text-white text-xs font-semibold" data-testid="badge-sent-rate">
                  {totalSent > 0 ? "100%" : "0%"}
                </div>
                <div className="px-3 py-1 rounded-full bg-amber-400 text-stone-900 text-xs font-semibold" data-testid="badge-open-rate">
                  {openRate}%
                </div>
                <div className="px-3 py-1 rounded-full bg-stone-300/70 text-stone-700 text-xs font-semibold" data-testid="badge-click-rate">
                  {clickRate}%
                </div>
                <div
                  className="flex-1 h-2 rounded-full bg-[repeating-linear-gradient(45deg,#d6cfa8_0_4px,transparent_4px_8px)]"
                  aria-hidden
                />
                <div className="px-3 py-1 rounded-full bg-white/80 border border-stone-300/50 text-stone-700 text-xs font-semibold" data-testid="badge-unsub-rate">
                  {unsubRate}%
                </div>
              </div>
            </div>
          </div>

          {/* Big numbers */}
          <div className="flex items-start gap-8">
            <BigStat
              value={stats?.totalSubscribers ?? 0}
              label="Subscribers"
              icon={Users}
              isLoading={isLoading}
              testId="stat-subscribers"
            />
            <BigStat
              value={stats?.totalCampaigns ?? 0}
              label="Campaigns"
              icon={Megaphone}
              isLoading={isLoading}
              testId="stat-campaigns"
            />
            <BigStat
              value={totalSent}
              label="Recent sent"
              icon={Send}
              isLoading={isLoading}
              testId="stat-sent"
            />
          </div>
        </div>

        {/* Main grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5 mb-5">
          {/* Hero campaign card (replaces person photo) */}
          <div className="md:col-span-2 lg:col-span-1 row-span-2 rounded-3xl bg-stone-900 text-white p-6 flex flex-col justify-between min-h-[320px] relative overflow-hidden">
            <div
              className="absolute inset-0 opacity-30"
              style={{
                background:
                  "radial-gradient(circle at 80% 20%, rgba(251,191,36,0.4), transparent 60%)",
              }}
              aria-hidden
            />
            <div className="relative z-10 flex items-start justify-between">
              <div className="p-2.5 rounded-2xl bg-white/10 backdrop-blur">
                <Mail className="h-5 w-5 text-amber-300" />
              </div>
              {heroCampaign && (
                <Link href={`/campaigns/${heroCampaign.id}`}>
                  <button className="p-2 rounded-full bg-white/10 hover:bg-white/20 backdrop-blur" data-testid={`link-hero-campaign-${heroCampaign.id}`}>
                    <ArrowUpRight className="h-4 w-4" />
                  </button>
                </Link>
              )}
            </div>
            <div className="relative z-10">
              <div className="text-xs text-stone-400 mb-2 uppercase tracking-wide">Latest campaign</div>
              {isLoading ? (
                <Skeleton className="h-7 w-3/4 bg-white/10" />
              ) : heroCampaign ? (
                <>
                  <div className="text-2xl font-semibold tracking-tight mb-3 line-clamp-2" data-testid="text-hero-campaign-name">
                    {heroCampaign.name}
                  </div>
                  <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/10 backdrop-blur text-sm">
                    <span className={`w-2 h-2 rounded-full ${statusDot(heroCampaign.status)}`} />
                    <span className="capitalize">{heroCampaign.status}</span>
                    <span className="text-stone-400">·</span>
                    <span className="font-semibold text-amber-300">{heroCampaign.sentCount.toLocaleString()}</span>
                    <span className="text-stone-400 text-xs">sent</span>
                  </div>
                </>
              ) : (
                <>
                  <div className="text-xl font-semibold mb-3">No campaigns yet</div>
                  <Link href="/campaigns/new">
                    <button className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-amber-400 text-stone-900 text-sm font-semibold" data-testid="button-create-first-campaign-hero">
                      <Plus className="h-3.5 w-3.5" />
                      Create one
                    </button>
                  </Link>
                </>
              )}
            </div>
          </div>

          {/* Engagement bars */}
          <div className="rounded-3xl bg-white/80 backdrop-blur p-6 border border-white/60">
            <div className="flex items-start justify-between mb-2">
              <div>
                <div className="text-sm text-stone-600">Engagement</div>
                <div className="flex items-baseline gap-2 mt-1">
                  <span className="text-3xl font-semibold tracking-tight text-stone-900" data-testid="text-opens-count">
                    {(stats?.totalOpens ?? 0).toLocaleString()}
                  </span>
                  <span className="text-xs text-stone-500">opens · 7d</span>
                </div>
              </div>
              <Link href="/analytics">
                <button className="p-1.5 rounded-full bg-stone-100 hover:bg-stone-200" data-testid="link-engagement-detail">
                  <ArrowUpRight className="h-3.5 w-3.5 text-stone-700" />
                </button>
              </Link>
            </div>
            <div className="h-[140px] mt-3" data-testid="chart-engagement">
              {chartLoading ? (
                <Skeleton className="h-full w-full" />
              ) : hasChartData ? (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chartData ?? []} margin={{ top: 8, right: 4, left: 4, bottom: 0 }}>
                    <XAxis
                      dataKey="name"
                      axisLine={false}
                      tickLine={false}
                      tick={{ fill: "#78716c", fontSize: 10 }}
                    />
                    <Tooltip
                      cursor={{ fill: "rgba(0,0,0,0.04)" }}
                      contentStyle={{
                        backgroundColor: "#1c1917",
                        border: "none",
                        borderRadius: "10px",
                        color: "#fff",
                        fontSize: 12,
                      }}
                      labelStyle={{ color: "#a8a29e" }}
                    />
                    <Bar dataKey="opens" radius={[6, 6, 6, 6]}>
                      {(chartData ?? []).map((d, i) => (
                        <Cell key={i} fill={d.opens === maxOpens && d.opens > 0 ? "#f59e0b" : "#e7e5e4"} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <div className="h-full flex items-center justify-center text-xs text-stone-500" data-testid="text-chart-empty">
                  No engagement data yet
                </div>
              )}
            </div>
          </div>

          {/* Open rate donut */}
          <div className="rounded-3xl bg-white/80 backdrop-blur p-6 border border-white/60 flex flex-col">
            <div className="flex items-start justify-between mb-2">
              <div className="text-sm text-stone-600">Open rate</div>
              <Link href="/analytics">
                <button className="p-1.5 rounded-full bg-stone-100 hover:bg-stone-200" data-testid="link-open-rate-detail">
                  <ArrowUpRight className="h-3.5 w-3.5 text-stone-700" />
                </button>
              </Link>
            </div>
            <div className="flex-1 flex items-center justify-center my-2">
              <div className="relative w-[140px] h-[140px]">
                <svg viewBox="0 0 120 120" className="w-full h-full -rotate-90">
                  <circle cx="60" cy="60" r="50" fill="none" stroke="#e7e5e4" strokeWidth="14" />
                  <circle
                    cx="60"
                    cy="60"
                    r="50"
                    fill="none"
                    stroke="#f59e0b"
                    strokeWidth="14"
                    strokeDasharray={`${(openRate / 100) * 314} 314`}
                    strokeLinecap="round"
                  />
                </svg>
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                  <span className="text-2xl font-semibold tracking-tight text-stone-900" data-testid="text-open-rate-value">
                    {openRate}%
                  </span>
                  <span className="text-[10px] text-stone-500 uppercase tracking-wide">Open</span>
                </div>
              </div>
            </div>
            <div className="flex items-center justify-around text-xs text-stone-600 pt-2 border-t border-stone-200">
              <div className="text-center">
                <div className="font-semibold text-stone-900" data-testid="text-click-rate-value">{clickRate}%</div>
                <div>Click</div>
              </div>
              <div className="text-center">
                <div className="font-semibold text-stone-900" data-testid="text-unsub-rate-value">{unsubRate}%</div>
                <div>Unsub</div>
              </div>
            </div>
          </div>

          {/* Reports / quick metrics */}
          <div className="rounded-3xl bg-white/80 backdrop-blur p-6 border border-white/60">
            <div className="flex items-start justify-between mb-4">
              <div>
                <div className="text-sm text-stone-600">Reports</div>
                <div className="text-2xl font-semibold tracking-tight text-stone-900 mt-1">
                  {openRate}<span className="text-base font-normal text-stone-500">%</span>
                </div>
              </div>
              <Link href="/advanced-analytics">
                <button className="p-1.5 rounded-full bg-stone-100 hover:bg-stone-200" data-testid="link-reports-detail">
                  <ArrowUpRight className="h-3.5 w-3.5 text-stone-700" />
                </button>
              </Link>
            </div>
            <div className="space-y-1.5">
              <MetricLine icon={Eye} label="Opened" value={stats?.totalOpens ?? 0} accent />
              <MetricLine icon={MousePointer2} label="Clicked" value={stats?.totalClicks ?? 0} />
              <MetricLine icon={UserMinus} label="Unsubscribed" value={stats?.totalUnsubscribes ?? 0} />
            </div>
          </div>

          {/* Quick actions on hero column row 2 */}
          <div className="md:col-span-2 lg:col-span-3 rounded-3xl bg-white/60 backdrop-blur p-6 border border-white/60 flex flex-wrap items-center gap-3">
            <div className="text-sm text-stone-600 mr-auto">Quick actions</div>
            <Link href="/campaigns/new">
              <Button className="rounded-full bg-stone-900 hover:bg-stone-800 text-white shadow-sm" data-testid="button-new-campaign">
                <Plus className="h-4 w-4 mr-2" />
                New Campaign
              </Button>
            </Link>
            <Link href="/import">
              <Button variant="outline" className="rounded-full bg-white border-stone-300 hover:bg-stone-50" data-testid="button-import">
                <UserPlus className="h-4 w-4 mr-2" />
                Import
              </Button>
            </Link>
            <Link href="/segments/new">
              <Button variant="outline" className="rounded-full bg-white border-stone-300 hover:bg-stone-50" data-testid="button-new-segment">
                <Filter className="h-4 w-4 mr-2" />
                New Segment
              </Button>
            </Link>
            <Link href="/mtas/new">
              <Button variant="outline" className="rounded-full bg-white border-stone-300 hover:bg-stone-50" data-testid="button-new-mta">
                <Send className="h-4 w-4 mr-2" />
                Add MTA
              </Button>
            </Link>
          </div>
        </div>

        {/* Bottom row */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
          {/* Left: list sections */}
          <div className="rounded-3xl bg-white/80 backdrop-blur p-6 border border-white/60 space-y-1">
            <SectionRow
              icon={Inbox}
              title="Recent imports"
              count={stats?.recentImports?.length ?? 0}
              href="/import"
              defaultOpen
              testId="section-imports"
            >
              {isLoading ? (
                <Skeleton className="h-12 w-full" />
              ) : stats?.recentImports && stats.recentImports.length > 0 ? (
                <div className="space-y-2 pl-1">
                  {stats.recentImports.slice(0, 3).map((job) => (
                    <div
                      key={job.id}
                      className="flex items-center justify-between text-sm py-1.5"
                      data-testid={`import-item-${job.id}`}
                    >
                      <span className="truncate text-stone-700 max-w-[180px]">{job.filename}</span>
                      <span className="text-xs text-stone-500">
                        {Math.min(job.processedRows, job.totalRows).toLocaleString()} / {job.totalRows.toLocaleString()}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-sm text-stone-500 py-2">No imports yet</div>
              )}
            </SectionRow>

            <SectionRow
              icon={Filter}
              title="Segments"
              count={segments?.length ?? 0}
              href="/segments"
              testId="section-segments"
            >
              {segmentsLoading ? (
                <div className="space-y-1.5 pl-1">
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="h-4 w-1/2" />
                </div>
              ) : segments && segments.length > 0 ? (
                <div className="space-y-1.5 pl-1">
                  {segments.slice(0, 3).map((s) => (
                    <Link key={s.id} href={`/segments/${s.id}`}>
                      <div className="text-sm text-stone-700 hover:text-stone-900 py-1 cursor-pointer truncate" data-testid={`segment-item-${s.id}`}>
                        {s.name}
                      </div>
                    </Link>
                  ))}
                </div>
              ) : (
                <div className="text-sm text-stone-500 py-2">No segments</div>
              )}
            </SectionRow>

            <SectionRow
              icon={Activity}
              title="System health"
              count={null}
              href="/system-metrics"
              testId="section-health"
            >
              <div className="text-sm text-stone-600 pl-1 py-1">Open metrics dashboard</div>
            </SectionRow>
          </div>

          {/* Right: dark recent campaigns */}
          <div className="lg:col-span-2 rounded-3xl bg-stone-900 text-white p-6 min-h-[320px]">
            <div className="flex items-center justify-between mb-5">
              <div>
                <div className="text-xs text-stone-400 uppercase tracking-wide">Recent campaigns</div>
                <div className="text-lg font-semibold mt-0.5">
                  Activity feed
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-2xl font-semibold tracking-tight text-amber-300" data-testid="text-recent-campaign-count">
                  {upcomingItems.length}
                </span>
                <span className="text-stone-400 text-sm">/{stats?.totalCampaigns ?? 0}</span>
              </div>
            </div>

            {isLoading ? (
              <div className="space-y-3">
                {[1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-14 w-full bg-white/5" />
                ))}
              </div>
            ) : upcomingItems.length > 0 ? (
              <div className="space-y-2">
                {upcomingItems.map((c) => (
                  <Link key={c.id} href={`/campaigns/${c.id}`}>
                    <div
                      className="flex items-center gap-4 p-3 rounded-2xl bg-white/5 hover:bg-white/10 transition-colors cursor-pointer"
                      data-testid={`campaign-item-${c.id}`}
                    >
                      <div className="p-2.5 rounded-xl bg-white/10">
                        {c.status === "completed" ? (
                          <CheckCircle2 className="h-4 w-4 text-amber-300" />
                        ) : c.status === "sending" ? (
                          <Send className="h-4 w-4 text-emerald-300" />
                        ) : c.status === "failed" ? (
                          <AlertCircle className="h-4 w-4 text-red-400" />
                        ) : (
                          <Mail className="h-4 w-4 text-stone-300" />
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="font-medium truncate" data-testid={`text-campaign-name-${c.id}`}>{c.name}</div>
                        <div className="flex items-center gap-2 text-xs text-stone-400 mt-0.5">
                          <span className={`w-1.5 h-1.5 rounded-full ${statusDot(c.status)}`} />
                          <span className="capitalize">{c.status}</span>
                          <span>·</span>
                          <span>{c.sentCount.toLocaleString()} sent</span>
                          {c.segmentId && (
                            <>
                              <span>·</span>
                              <span className="truncate max-w-[140px]" data-testid={`text-segment-${c.id}`}>
                                {segmentNameById.get(c.segmentId) ?? "Segment"}
                              </span>
                            </>
                          )}
                        </div>
                      </div>
                      <ArrowUpRight className="h-4 w-4 text-stone-500 shrink-0" />
                    </div>
                  </Link>
                ))}
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-10 text-center">
                <div className="p-3 rounded-full bg-white/5 mb-3">
                  <Mail className="h-6 w-6 text-stone-500" />
                </div>
                <p className="text-stone-400 mb-3 text-sm">No campaigns yet</p>
                <Link href="/campaigns/new">
                  <Button className="rounded-full bg-amber-400 text-stone-900 hover:bg-amber-300" data-testid="link-create-first-campaign">
                    Create your first campaign
                  </Button>
                </Link>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function BigStat({
  value,
  label,
  icon: Icon,
  isLoading,
  testId,
}: {
  value: number;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  isLoading: boolean;
  testId: string;
}) {
  return (
    <div className="flex flex-col items-end">
      {isLoading ? (
        <Skeleton className="h-10 w-20" />
      ) : (
        <span className="text-4xl lg:text-5xl font-semibold tracking-tight text-stone-900 tabular-nums" data-testid={testId}>
          {value.toLocaleString()}
        </span>
      )}
      <div className="flex items-center gap-1.5 text-xs text-stone-600 mt-1">
        <Icon className="h-3 w-3" />
        <span>{label}</span>
      </div>
    </div>
  );
}

function MetricLine({
  icon: Icon,
  label,
  value,
  accent,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: number;
  accent?: boolean;
}) {
  return (
    <div className="flex items-center justify-between py-1.5 border-b border-stone-200 last:border-b-0">
      <div className="flex items-center gap-2 text-sm text-stone-600">
        <Icon className="h-3.5 w-3.5" />
        <span>{label}</span>
      </div>
      <span
        className={`font-semibold tabular-nums ${accent ? "text-stone-900" : "text-stone-700"}`}
        data-testid={`metric-${label.toLowerCase()}`}
      >
        {value.toLocaleString()}
      </span>
    </div>
  );
}

function SectionRow({
  icon: Icon,
  title,
  count,
  href,
  testId,
  defaultOpen = false,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  count: number | null;
  href: string;
  testId: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-b border-stone-200 last:border-b-0 py-3" data-testid={testId}>
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex items-center gap-3 flex-1 min-w-0 group text-left"
          aria-expanded={open}
          data-testid={`${testId}-toggle`}
        >
          <div className="p-2 rounded-xl bg-stone-100 group-hover:bg-stone-200">
            <Icon className="h-4 w-4 text-stone-700" />
          </div>
          <span className="font-medium text-stone-800">{title}</span>
          {count !== null && (
            <span className="text-xs text-stone-500 bg-stone-100 px-2 py-0.5 rounded-full">{count}</span>
          )}
          {open ? (
            <ChevronUp className="h-4 w-4 text-stone-400 ml-auto" />
          ) : (
            <ChevronDown className="h-4 w-4 text-stone-400 ml-auto" />
          )}
        </button>
        <Link href={href}>
          <button
            type="button"
            className="p-1.5 rounded-full hover:bg-stone-100"
            aria-label={`Open ${title}`}
            data-testid={`${testId}-open`}
          >
            <ArrowUpRight className="h-3.5 w-3.5 text-stone-500" />
          </button>
        </Link>
      </div>
      {open && <div className="mt-2">{children}</div>}
    </div>
  );
}
