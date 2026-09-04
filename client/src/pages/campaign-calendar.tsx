import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Filter,
  RefreshCw,
  Server,
} from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import {
  addCalendarDays as addDays,
  calendarDayKey as dayKey,
  campaignCalendarEnd as endAt,
  campaignCalendarStart as startAt,
  campaignOverlapsParisDay,
  layoutCampaignTimeline,
  parisCivilDate as parisCivil,
  startOfParisCalendarDay as startOfParis,
  type CalendarCampaignRecord as CalendarCampaign,
} from "@/lib/campaign-calendar";

interface CalendarMta {
  id: string;
  name: string;
}
interface CalendarResponse {
  campaigns: CalendarCampaign[];
  mtas: CalendarMta[];
  asOf: string;
}
type ViewMode = "week" | "day";

const colours: Record<string, string> = {
  scheduled: "border-sky-300 bg-sky-50 text-sky-900",
  sending: "border-amber-300 bg-amber-50 text-amber-950",
  completed: "border-emerald-300 bg-emerald-50 text-emerald-950",
  failed: "border-rose-300 bg-rose-50 text-rose-950",
  paused: "border-violet-300 bg-violet-50 text-violet-950",
  cancelled: "border-stone-300 bg-stone-100 text-stone-700",
};
const weekStart = (d: Date) =>
  addDays(d, d.getUTCDay() === 0 ? -6 : 1 - d.getUTCDay());
const time = (s: string | null) =>
  s
    ? new Intl.DateTimeFormat("fr-FR", {
        timeZone: "Europe/Paris",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(new Date(s))
    : "Non planifiée";
const dayLabel = (d: Date, long = false) =>
  new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Europe/Paris",
    weekday: long ? "long" : "short",
    day: "numeric",
    month: "short",
  }).format(d);

function CampaignCard({
  campaign,
  expanded = false,
}: {
  campaign: CalendarCampaign;
  expanded?: boolean;
}) {
  const status = campaign.status.replace(/_/g, " ");
  return (
    <Link
      href={`/campaigns/${campaign.id}`}
      className={`group block rounded-md border p-2 transition-all hover:-translate-y-px hover:border-stone-500 hover:shadow-sm focus:outline-none focus:ring-2 focus:ring-amber-500/70 ${colours[campaign.status] ?? "border-stone-200 bg-stone-50 text-stone-800"}`}
    >
      <div className="flex items-start gap-2">
        <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-current opacity-60" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-semibold">{campaign.name}</div>
          <div className="mt-1 flex items-center justify-between gap-2 text-[10px] opacity-70">
            <span>{time(startAt(campaign))}</span>
            {expanded && <span className="capitalize">{status}</span>}
          </div>
        </div>
      </div>
    </Link>
  );
}

function Timeline({
  day,
  campaigns,
  mtas,
  asOfMs,
}: {
  day: Date;
  campaigns: CalendarCampaign[];
  mtas: { id: string; name: string }[];
  asOfMs: number;
}) {
  const rows = mtas.length ? mtas : [{ id: "__empty__", name: "Aucun MTA" }];
  return (
    <div className="overflow-x-auto rounded-xl border border-stone-200 bg-[#fffdf7]">
      <div className="min-w-[760px]">
        <div className="flex border-b border-stone-200 bg-stone-50/70">
          <div className="w-16 shrink-0 border-r border-stone-200 px-2 py-3 text-[10px] font-bold uppercase tracking-wider text-stone-400">
            Heure
          </div>
          {rows.map((m) => (
            <div
              key={m.id}
              className="min-w-[220px] flex-1 border-r border-stone-200 px-3 py-3 text-xs font-semibold text-stone-700"
            >
              <Server className="mr-1 inline h-3 w-3 text-stone-400" />
              {m.name}
            </div>
          ))}
        </div>
        <div className="flex">
          <div className="relative h-[1152px] w-16 shrink-0 border-r border-stone-200 bg-stone-50/40">
            {Array.from({ length: 25 }, (_, h) => (
              <span
                key={h}
                className="absolute right-2 -translate-y-1/2 text-[10px] tabular-nums text-stone-400"
                style={{ top: `${h * 48}px` }}
              >
                {String(h).padStart(2, "0")}:00
              </span>
            ))}
          </div>
          {rows.map((mta) => {
            const items = campaigns
              .filter((c) => (c.mtaId ?? "__unknown__") === mta.id)
        .filter((c) => campaignOverlapsParisDay(c, day, asOfMs));
      const timelineItems = layoutCampaignTimeline(items, day, asOfMs);
            return (
              <div
                key={mta.id}
                className="relative h-[1152px] min-w-[220px] flex-1 border-r border-stone-200"
                style={{
                  backgroundImage:
                    "linear-gradient(to bottom, transparent 47px, rgba(120,113,108,.11) 48px)",
                  backgroundSize: "100% 48px",
                }}
              >
          {timelineItems.map(({ campaign, top, height, lane, laneCount }) => {
            const widthPercent = 100 / laneCount;
                  return (
                    <div
                key={campaign.id}
                className="absolute z-10 px-1"
                style={{
                  top,
                  height,
                  left: `${lane * widthPercent}%`,
                  width: `${widthPercent}%`,
                }}
                    >
                <CampaignCard campaign={campaign} expanded />
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function SkeletonCalendar() {
  return (
    <div className="rounded-2xl border border-stone-200 bg-[#fffdf7]/70 p-5">
      <div className="grid gap-3 md:grid-cols-7">
        {Array.from({ length: 7 }, (_, i) => (
          <div key={i} className="space-y-3">
            <Skeleton className="h-7 w-20" />
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        ))}
      </div>
    </div>
  );
}

export default function CampaignCalendar() {
  const [anchor, setAnchor] = useState(parisCivil(new Date()));
  const [view, setView] = useState<ViewMode>("week");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filterOpen, setFilterOpen] = useState(false);
  const start = view === "week" ? weekStart(anchor) : anchor;
  const end = addDays(start, view === "week" ? 7 : 1);
  const days = Array.from({ length: view === "week" ? 7 : 1 }, (_, i) =>
    addDays(start, i),
  );
  const from = startOfParis(start).toISOString(),
    to = startOfParis(end).toISOString();
  const query = useQuery<CalendarResponse>({
    queryKey: ["/api/campaigns/calendar", from, to],
    queryFn: async () =>
      (
        await apiRequest(
          "GET",
          `/api/campaigns/calendar?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
        )
      ).json(),
    staleTime: 30_000,
  });
  const campaigns = useMemo(
    () =>
      (query.data?.campaigns ?? []).filter(
        (c) => selected.size === 0 || selected.has(c.mtaId ?? "__unknown__"),
      ),
    [query.data?.campaigns, selected],
  );
  const asOfMs = query.data?.asOf
    ? new Date(query.data.asOf).getTime()
    : Date.now();
  const relevant = useMemo(
    () =>
      campaigns.filter((c) =>
        days.some((d) => campaignOverlapsParisDay(c, d, asOfMs)),
      ),
    [campaigns, days, asOfMs],
  );
  const mtas = useMemo(() => {
    const known = (query.data?.mtas ?? []).filter(
      (m) => selected.size === 0 || selected.has(m.id),
    );
    const hasUnknown = relevant.some((c) => !c.mtaId);
    return [
      ...known,
      ...(hasUnknown ? [{ id: "__unknown__", name: "MTA inconnu" }] : []),
    ];
  }, [query.data?.mtas, selected, relevant]);
  const label =
    view === "day"
      ? dayLabel(start, true)
      : `${dayLabel(start)} — ${dayLabel(addDays(end, -1))}`;
  const move = (n: number) =>
    setAnchor((d) => addDays(d, n * (view === "week" ? 7 : 1)));
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  return (
    <main className="mx-auto max-w-[1510px] pb-2" data-testid="campaign-calendar">
      <section className="rounded-[1.6rem] border border-stone-200/75 bg-[#fffdf7]/80 px-5 py-5 shadow-sm sm:px-7">
        <div className="flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
          <div>
            <div className="mb-2 flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.16em] text-amber-700">
              <CalendarDays className="h-3.5 w-3.5" /> Pilotage opérationnel
            </div>
            <h1 className="font-serif text-3xl font-semibold tracking-tight text-stone-900">
              Calendrier des campagnes
            </h1>
            <p className="mt-1 text-sm text-stone-500">
              Charge MTA planifiée et activité réelle, en heure de Paris.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex rounded-lg border border-stone-200 bg-stone-100/70 p-1">
              {(["week", "day"] as ViewMode[]).map((v) => (
                <button
                  key={v}
                  onClick={() => setView(v)}
                  className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${view === v ? "bg-stone-900 text-white" : "text-stone-600 hover:bg-white"}`}
                >
                  {v === "week" ? "Semaine" : "Jour"}
                </button>
              ))}
            </div>
            <Popover open={filterOpen} onOpenChange={setFilterOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  className="h-9 gap-2 border-stone-200 bg-[#fffdf7]"
                >
                  <Filter className="h-3.5 w-3.5" /> MTAs
                  {selected.size > 0 && (
                    <span className="rounded-full bg-stone-900 px-1.5 py-0.5 text-[10px] text-white">
                      {selected.size}
                    </span>
                  )}
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-64 bg-[#fffdf7]">
                <div className="mb-2 text-xs font-semibold">
                  Filtrer les MTAs
                </div>
                <button
                  onClick={() => setSelected(new Set())}
                  className="mb-1 w-full rounded p-2 text-left text-xs text-stone-500 hover:bg-stone-100"
                >
                  Afficher tous les MTAs
                </button>
                {(query.data?.mtas ?? []).map((m) => (
                  <label
                    key={m.id}
                    className="flex items-center gap-2 rounded p-2 text-sm hover:bg-stone-100"
                  >
                    <Checkbox
                      checked={selected.has(m.id)}
                      onCheckedChange={() => toggle(m.id)}
                    />
                    {m.name}
                  </label>
                ))}
                <label className="flex items-center gap-2 rounded p-2 text-sm hover:bg-stone-100">
                  <Checkbox
                    checked={selected.has("__unknown__")}
                    onCheckedChange={() => toggle("__unknown__")}
                  />
                  MTA inconnu
                </label>
              </PopoverContent>
            </Popover>
          </div>
        </div>
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-stone-200/80 pt-4">
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => move(-1)}
              aria-label="Période précédente"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => move(1)}
              aria-label="Période suivante"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setAnchor(parisCivil(new Date()))}
              className="ml-1 h-8"
            >
              Aujourd'hui
            </Button>
            <span className="ml-2 text-sm font-semibold text-stone-800">
              {label}
            </span>
          </div>
          <span className="text-xs text-stone-500">
            {relevant.length} campagne{relevant.length === 1 ? "" : "s"} ·
            Europe/Paris
          </span>
        </div>
      </section>
      <section className="mt-4">
        {query.isLoading ? (
          <SkeletonCalendar />
        ) : query.isError ? (
          <div className="flex min-h-64 flex-col items-center justify-center rounded-2xl border border-rose-200 bg-rose-50 text-center">
            <CircleAlert className="h-6 w-6 text-rose-600" />
            <h2 className="mt-3 font-semibold">
              Le calendrier est indisponible
            </h2>
            <p className="mt-1 text-sm text-stone-600">
              Impossible de charger la charge de travail.
            </p>
            <Button
              onClick={() => query.refetch()}
              className="mt-4 gap-2 bg-stone-900"
            >
              <RefreshCw className="h-3.5 w-3.5" /> Réessayer
            </Button>
          </div>
        ) : view === "day" ? (
          mtas.length ? (
            <Timeline
              day={start}
              campaigns={relevant}
              mtas={mtas}
              asOfMs={asOfMs}
            />
          ) : (
            <EmptyState text="Aucune campagne ou MTA sur cette journée." />
          )
        ) : (
          <div className="grid overflow-hidden rounded-2xl border border-stone-200 bg-[#fffdf7]/85 md:grid-cols-7">
            {days.map((d, i) => {
              const dayCampaigns = relevant.filter((c) =>
                campaignOverlapsParisDay(c, d, asOfMs),
              );
              const groups = mtas
                .map((m) => ({
                  ...m,
                  campaigns: dayCampaigns.filter(
                    (c) => (c.mtaId ?? "__unknown__") === m.id,
                  ),
                }))
                .filter((g) => g.campaigns.length);
              return (
                <div
                  key={dayKey(d)}
                  className={`min-h-[280px] border-stone-200 ${i < 6 ? "border-b md:border-b-0 md:border-r" : ""}`}
                >
                  <header className="border-b border-stone-100 bg-stone-50/60 px-3 py-3">
                    <div className="text-[10px] font-bold uppercase tracking-wider text-stone-500">
                      {dayLabel(d)}
                    </div>
                    <div className="text-xs text-stone-400">
                      {dayCampaigns.length} campagne
                      {dayCampaigns.length === 1 ? "" : "s"}
                    </div>
                  </header>
                  <div className="space-y-2 p-2">
                    {groups.length ? (
                      groups.map((g) => (
                        <div
                          key={g.id}
                          className="rounded-lg bg-stone-50/80 p-1.5"
                        >
                          <div className="mb-1 flex items-center gap-1 text-[9px] font-bold uppercase tracking-wider text-stone-500">
                            <Server className="h-2.5 w-2.5" />
                            {g.name}
                          </div>
                          <div className="space-y-1">
                            {g.campaigns.map((c) => (
                              <CampaignCard key={c.id} campaign={c} />
                            ))}
                          </div>
                        </div>
                      ))
                    ) : (
                      <div className="py-10 text-center text-xs text-stone-400">
                        Aucune activité
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </main>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="flex min-h-64 items-center justify-center rounded-2xl border border-stone-200 bg-[#fffdf7]/80 text-sm text-stone-500">
      {text}
    </div>
  );
}
