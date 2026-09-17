import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Filter,
  GripVertical,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Server,
} from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuPortal, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import {
  commitCampaignMtaTransfer,
  isCrossMtaDrop,
  previewCampaignMtaTransfer,
  transferFailureMessage,
  type TransferDialogValues,
} from "@/lib/campaign-mta-transfer";
import {
  CampaignMtaTransferDialog,
  type TransferRequest,
} from "@/components/campaign-mta-transfer-dialog";
import {
  addCalendarDays as addDays,
  calendarDropInstant,
  campaignCalendarColumnId,
  campaignScheduledForParisDay,
  layoutCampaignTimeline,
  parisCivilDate as parisCivil,
  startOfParisCalendarDay as startOfParis,
  TIMELINE_PIXELS_PER_MINUTE,
  UNIDENTIFIED_MTA_COLUMN_ID,
  type CalendarCampaignRecord as CalendarCampaign,
} from "@/lib/campaign-calendar";
import type { CampaignMtaTransferPreview } from "@shared/campaign-mta-transfer";

interface CalendarMta {
  id: string;
  name: string;
}
interface CalendarResponse {
  campaigns: CalendarCampaign[];
  mtas: CalendarMta[];
}

const colours: Record<string, string> = {
  scheduled: "border-sky-300 bg-sky-50 text-sky-900",
  sending: "border-amber-300 bg-amber-50 text-amber-950",
  completed: "border-emerald-300 bg-emerald-50 text-emerald-950",
  failed: "border-rose-300 bg-rose-50 text-rose-950",
  paused: "border-violet-300 bg-violet-50 text-violet-950",
  cancelled: "border-stone-300 bg-stone-100 text-stone-700",
};
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
  rescheduling = false,
  mtas = [],
  currentMtaId,
  onDragStart,
  onDragEnd,
  onRequestTransfer,
}: {
  campaign: CalendarCampaign;
  expanded?: boolean;
  rescheduling?: boolean;
  mtas?: CalendarMta[];
  currentMtaId?: string;
  onDragStart?: (event: DragEvent<HTMLDivElement>, campaign: CalendarCampaign) => void;
  onDragEnd?: () => void;
  onRequestTransfer?: (campaign: CalendarCampaign, target: CalendarMta) => void;
}) {
  const status = campaign.status.replace(/_/g, " ");
  const canDrag = campaign.status === "scheduled" && !rescheduling;
  const transferTargets = mtas.filter(
    (mta) => mta.id !== UNIDENTIFIED_MTA_COLUMN_ID && mta.id !== currentMtaId,
  );
  return (
    <div
      className={`group relative h-full rounded-md border transition-all hover:-translate-y-px hover:border-stone-500 hover:shadow-sm ${
        canDrag ? "cursor-grab active:cursor-grabbing" : ""
      } ${rescheduling ? "opacity-60" : ""} ${colours[campaign.status] ?? "border-stone-200 bg-stone-50 text-stone-800"}`}
      draggable={canDrag}
      onDragStart={(event) => onDragStart?.(event, campaign)}
      onDragEnd={onDragEnd}
      data-testid={`calendar-campaign-${campaign.id}`}
    >
      <Link
        href={`/campaigns/${campaign.id}`}
        className="block h-full rounded-md p-2 pr-8 focus:outline-none focus:ring-2 focus:ring-amber-500/70"
      >
        <div className="flex items-start gap-2">
          {canDrag ? (
            <GripVertical className="mt-0.5 h-3 w-3 shrink-0 opacity-45" />
          ) : (
            <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-current opacity-60" />
          )}
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-semibold">{campaign.name}</div>
            <div className="mt-1 flex items-center justify-between gap-2 text-[10px] opacity-70">
              <span>{time(campaign.scheduledAt)}</span>
              {expanded && <span className="capitalize">{status}</span>}
            </div>
          </div>
        </div>
      </Link>
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="absolute right-1 top-1 z-20 flex h-6 w-6 items-center justify-center rounded-full bg-white/70 text-current shadow-sm ring-1 ring-black/10 hover:bg-white focus:outline-none focus:ring-2 focus:ring-amber-500"
            aria-label={`Afficher les segments de ${campaign.name}`}
            title="Afficher les segments"
            draggable={false}
            onClick={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            onDragStart={(event) => event.preventDefault()}
            data-testid={`calendar-campaign-segments-${campaign.id}`}
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="w-72 bg-[#fffdf7] p-3"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="text-xs font-semibold text-stone-900">
            Segments programmés
          </div>
          {(campaign.segments ?? []).length > 0 ? (
            <ul className="mt-2 max-h-56 space-y-1 overflow-y-auto">
              {(campaign.segments ?? []).map((segment) => (
                <li
                  key={segment.id}
                  className="rounded bg-stone-100 px-2 py-1.5 text-xs text-stone-700"
                >
                  {segment.name}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-xs text-stone-500">
              Aucun segment associé.
            </p>
          )}
        </PopoverContent>
      </Popover>
      {canDrag && transferTargets.length > 0 && onRequestTransfer && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="absolute right-8 top-1 z-20 flex h-6 w-6 items-center justify-center rounded-full bg-white/70 text-current shadow-sm ring-1 ring-black/10 hover:bg-white focus:outline-none focus:ring-2 focus:ring-amber-500"
              aria-label={`Actions pour ${campaign.name}`}
              title="Actions"
              draggable={false}
              onClick={(event) => event.stopPropagation()}
              onPointerDown={(event) => event.stopPropagation()}
              onDragStart={(event) => event.preventDefault()}
              data-testid={`calendar-campaign-menu-${campaign.id}`}
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" onClick={(event) => event.stopPropagation()}>
            <DropdownMenuLabel>Actions</DropdownMenuLabel>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>Changer de MTA</DropdownMenuSubTrigger>
              <DropdownMenuPortal>
                <DropdownMenuSubContent>
                  {transferTargets.map((target) => (
                    <DropdownMenuItem
                      key={target.id}
                      onSelect={() => onRequestTransfer(campaign, target)}
                    >
                      {target.name}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuPortal>
            </DropdownMenuSub>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

function Timeline({
  day,
  campaigns,
  mtas,
  knownMtaIds,
  draggedCampaignId,
  reschedulingCampaignId,
  onDragStart,
  onDragEnd,
  onReschedule,
  onRequestTransfer,
  transferCampaignId,
}: {
  day: Date;
  campaigns: CalendarCampaign[];
  mtas: { id: string; name: string }[];
  knownMtaIds: ReadonlySet<string>;
  draggedCampaignId: string | null;
  reschedulingCampaignId: string | null;
  onDragStart: (event: DragEvent<HTMLDivElement>, campaign: CalendarCampaign) => void;
  onDragEnd: () => void;
  onReschedule: (campaignId: string, scheduledAt: Date) => void;
  onRequestTransfer: (campaign: CalendarCampaign, target: CalendarMta) => void;
  transferCampaignId: string | null;
}) {
  const draggedCampaign = campaigns.find(
    (campaign) => campaign.id === draggedCampaignId,
  );
  return (
    <div className="overflow-x-auto rounded-xl border border-stone-200 bg-[#fffdf7]">
      <div className="min-w-[760px]">
        <div className="flex border-b border-stone-200 bg-stone-50/70">
          <div className="w-16 shrink-0 border-r border-stone-200 px-2 py-3 text-[10px] font-bold uppercase tracking-wider text-stone-400">
            Heure
          </div>
          {mtas.map((m) => (
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
          {mtas.map((mta) => {
            const items = campaigns.filter(
              (campaign) =>
                campaignCalendarColumnId(campaign, knownMtaIds) === mta.id,
            );
            const timelineItems = layoutCampaignTimeline(items, day);
            const acceptsDrop =
              draggedCampaign?.status === "scheduled" &&
              mta.id !== UNIDENTIFIED_MTA_COLUMN_ID;
            const crossMta = draggedCampaign
              ? isCrossMtaDrop(draggedCampaign, mta.id, knownMtaIds)
              : false;
            return (
              <div
                key={mta.id}
                className={`relative h-[1152px] min-w-[220px] flex-1 border-r border-stone-200 transition-colors ${
                  acceptsDrop ? "bg-amber-50/60" : ""
                }`}
                onDragOver={(event) => {
                  if (!acceptsDrop) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                }}
                onDrop={(event) => {
                  if (!acceptsDrop) return;
                  event.preventDefault();
                  const campaignId =
                    event.dataTransfer.getData("application/x-critsend-campaign") ||
                    event.dataTransfer.getData("text/plain");
                  if (!campaignId || campaignId !== draggedCampaignId) return;
                   if (!draggedCampaign) return;
                   if (crossMta) {
                     onRequestTransfer(draggedCampaign, mta);
                     return;
                   }
                   if (campaignCalendarColumnId(draggedCampaign, knownMtaIds) !== mta.id) return;
                  const rect = event.currentTarget.getBoundingClientRect();
                  const rawMinute =
                    (event.clientY - rect.top) / TIMELINE_PIXELS_PER_MINUTE;
                  const snappedMinute = Math.max(
                    0,
                    Math.min(23 * 60 + 45, Math.round(rawMinute / 15) * 15),
                  );
                  const instant = calendarDropInstant(day, snappedMinute);
                  if (instant) onReschedule(campaignId, instant);
                }}
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
                      <CampaignCard
                        campaign={campaign}
                        expanded
                        rescheduling={
                          reschedulingCampaignId === campaign.id ||
                          transferCampaignId === campaign.id
                        }
                        onDragStart={onDragStart}
                        onDragEnd={onDragEnd}
                        mtas={mtas}
                        currentMtaId={campaignCalendarColumnId(campaign, knownMtaIds)}
                        onRequestTransfer={onRequestTransfer}
                      />
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
      <div className="grid gap-3 md:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
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
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filterOpen, setFilterOpen] = useState(false);
  const [draggedCampaignId, setDraggedCampaignId] = useState<string | null>(null);
  const [reschedulingCampaignId, setReschedulingCampaignId] = useState<string | null>(null);
  const [transferRequest, setTransferRequest] = useState<TransferRequest | null>(null);
  const [transferPreview, setTransferPreview] = useState<CampaignMtaTransferPreview | null>(null);
  const [transferPreviewLoading, setTransferPreviewLoading] = useState(false);
  const [transferPreviewError, setTransferPreviewError] = useState<string | null>(null);
  const [transferSubmitting, setTransferSubmitting] = useState(false);
  const transferInFlight = useRef(false);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const from = startOfParis(anchor).toISOString();
  const to = startOfParis(addDays(anchor, 1)).toISOString();
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
  const scheduledCampaigns = useMemo(
    () =>
      (query.data?.campaigns ?? []).filter((campaign) =>
        campaignScheduledForParisDay(campaign, anchor),
      ),
    [query.data?.campaigns, anchor],
  );
  const knownMtaIds = useMemo(
    () => new Set((query.data?.mtas ?? []).map((mta) => mta.id)),
    [query.data?.mtas],
  );
  const mtas = useMemo(() => {
    const known = (query.data?.mtas ?? []).filter(
      (m) => selected.size === 0 || selected.has(m.id),
    );
    return [
      ...known,
      ...(selected.size === 0 || selected.has(UNIDENTIFIED_MTA_COLUMN_ID)
        ? [{ id: UNIDENTIFIED_MTA_COLUMN_ID, name: "Sans MTA identifiable" }]
        : []),
    ];
  }, [query.data?.mtas, selected]);
  const visibleCampaigns = useMemo(() => {
    const visibleColumnIds = new Set(mtas.map((mta) => mta.id));
    return scheduledCampaigns.filter((campaign) =>
      visibleColumnIds.has(campaignCalendarColumnId(campaign, knownMtaIds)),
    );
  }, [scheduledCampaigns, mtas, knownMtaIds]);
  const label = dayLabel(anchor, true);
  const move = (n: number) => setAnchor((day) => addDays(day, n));
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  const requestTransfer = (campaign: CalendarCampaign, target: CalendarMta) => {
    if (
      campaign.status !== "scheduled"
      || target.id === UNIDENTIFIED_MTA_COLUMN_ID
      || target.id === campaign.mtaId
      || transferSubmitting
    ) {
      return;
    }
    setDraggedCampaignId(null);
    setTransferPreview(null);
    setTransferPreviewError(null);
    setTransferRequest({ campaign, target });
  };
  useEffect(() => {
    if (!transferRequest) return;
    let cancelled = false;
    setTransferPreviewLoading(true);
    void previewCampaignMtaTransfer(
      apiRequest,
      transferRequest.campaign.id,
      transferRequest.target.id,
    )
      .then((preview) => {
        if (!cancelled) setTransferPreview(preview);
      })
      .catch((error: any) => {
        if (!cancelled) {
          setTransferPreviewError(
            error?.body?.error ||
              "Impossible de préparer le transfert. Aucun changement n'a été effectué.",
          );
        }
      })
      .finally(() => {
        if (!cancelled) setTransferPreviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [transferRequest]);
  const closeTransfer = (open: boolean) => {
    if (open || transferSubmitting) return;
    setTransferRequest(null);
    setTransferPreview(null);
    setTransferPreviewError(null);
  };
  const confirmTransfer = async (values: TransferDialogValues) => {
    if (
      !transferRequest
      || !transferPreview
      || transferSubmitting
      || transferInFlight.current
      || !values.name
    ) {
      return;
    }
    transferInFlight.current = true;
    setTransferSubmitting(true);
    const request = transferRequest;
    const queryKey = ["/api/campaigns/calendar", from, to] as const;
    const previous = queryClient.getQueryData<CalendarResponse>(queryKey);
    queryClient.setQueryData<CalendarResponse>(queryKey, (current) =>
      current
        ? {
            ...current,
            campaigns: current.campaigns.map((item) =>
              item.id === request.campaign.id
                ? {
                    ...item,
                    name: values.name,
                    mtaId: request.target.id,
                    mtaName: request.target.name,
                  }
                : item,
            ),
          }
        : current,
    );
    try {
      await commitCampaignMtaTransfer(
        apiRequest,
        request.campaign.id,
        request.target.id,
        transferPreview,
        values,
      );
      toast({
        title: "MTA modifié",
        description: `${request.campaign.name} utilise maintenant ${request.target.name}.`,
      });
      setTransferRequest(null);
      setTransferPreview(null);
      setTransferPreviewError(null);
    } catch (error: any) {
      if (previous) queryClient.setQueryData(queryKey, previous);
      toast({
        title: "Transfert impossible",
        description: transferFailureMessage(error),
        variant: "destructive",
      });
    } finally {
      setTransferSubmitting(false);
      transferInFlight.current = false;
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["/api/campaigns/calendar"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/campaigns", request.campaign.id] }),
        queryClient.invalidateQueries({ queryKey: ["/api/campaigns"] }),
      ]);
    }
  };
  const handleDragStart = (
    event: DragEvent<HTMLDivElement>,
    campaign: CalendarCampaign,
  ) => {
    if (campaign.status !== "scheduled") {
      event.preventDefault();
      return;
    }
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("application/x-critsend-campaign", campaign.id);
    event.dataTransfer.setData("text/plain", campaign.id);
    setDraggedCampaignId(campaign.id);
  };
  const handleReschedule = async (campaignId: string, scheduledAt: Date) => {
    const campaign = query.data?.campaigns.find((item) => item.id === campaignId);
    if (!campaign?.scheduledAt || campaign.status !== "scheduled") return;
    if (scheduledAt.getTime() <= Date.now()) {
      toast({
        title: "Créneau invalide",
        description: "Une campagne ne peut pas être déplacée dans le passé.",
        variant: "destructive",
      });
      setDraggedCampaignId(null);
      return;
    }

    const queryKey = ["/api/campaigns/calendar", from, to] as const;
    const previous = queryClient.getQueryData<CalendarResponse>(queryKey);
    queryClient.setQueryData<CalendarResponse>(queryKey, (current) =>
      current
        ? {
            ...current,
            campaigns: current.campaigns.map((item) =>
              item.id === campaignId
                ? { ...item, scheduledAt: scheduledAt.toISOString() }
                : item,
            ),
          }
        : current,
    );
    setDraggedCampaignId(null);
    setReschedulingCampaignId(campaignId);
    try {
      await apiRequest("PATCH", `/api/campaigns/${campaignId}/schedule`, {
        scheduledAt: scheduledAt.toISOString(),
        expectedScheduledAt: campaign.scheduledAt,
      });
      toast({
        title: "Campagne reprogrammée",
        description: `Nouvel horaire : ${time(scheduledAt.toISOString())}.`,
      });
    } catch (error: any) {
      if (previous) queryClient.setQueryData(queryKey, previous);
      toast({
        title: "Déplacement impossible",
        description:
          error?.body?.error ||
          "La campagne a peut-être déjà commencé à être envoyée.",
        variant: "destructive",
      });
    } finally {
      setReschedulingCampaignId(null);
      await queryClient.invalidateQueries({
        queryKey: ["/api/campaigns/calendar"],
      });
    }
  };
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
              Campagnes programmées par MTA, en heure de Paris.
            </p>
            <p className="mt-1 text-xs text-stone-400">
              Glissez une campagne planifiée verticalement pour modifier son horaire par pas de 15 minutes.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
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
                    checked={selected.has(UNIDENTIFIED_MTA_COLUMN_ID)}
                    onCheckedChange={() => toggle(UNIDENTIFIED_MTA_COLUMN_ID)}
                  />
                  Sans MTA identifiable
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
              aria-label="Jour précédent"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => move(1)}
              aria-label="Jour suivant"
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
            {visibleCampaigns.length} campagne{visibleCampaigns.length === 1 ? "" : "s"} ·
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
        ) : visibleCampaigns.length > 0 && mtas.length > 0 ? (
          <Timeline
            day={anchor}
            campaigns={visibleCampaigns}
            mtas={mtas}
            knownMtaIds={knownMtaIds}
            draggedCampaignId={draggedCampaignId}
            reschedulingCampaignId={reschedulingCampaignId}
            onDragStart={handleDragStart}
            onDragEnd={() => setDraggedCampaignId(null)}
            onReschedule={handleReschedule}
            onRequestTransfer={requestTransfer}
            transferCampaignId={transferRequest?.campaign.id ?? null}
          />
        ) : (
          <EmptyState text="Aucune campagne programmée pour cette journée." />
        )}
      </section>
      <CampaignMtaTransferDialog
        request={transferRequest}
        preview={transferPreview}
        loading={transferPreviewLoading}
        previewError={transferPreviewError}
        submitting={transferSubmitting}
        onOpenChange={closeTransfer}
        onConfirm={confirmTransfer}
      />
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
