import { useEffect, useMemo, useState, useRef } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertCircle, AlertTriangle, Check, ChevronDown, ChevronUp, Loader2, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { apiRequest, queryClient } from "@/lib/queryClient";
import {
  clampComplaintCapPercent,
  complaintRateColor,
  formatSmartSegmentPercent,
  parseSmartSegmentApiError,
} from "@/lib/smart-segment-ui";
import {
  DOMAIN_FAMILIES,
  SMART_SEGMENT_STAGE_LABELS,
  type DomainFamilyId,
  type SmartSegmentAnalysisRequest,
  type SmartSegmentAnalysisView,
  type SmartSegmentFeatureStatus,
  type SmartSegmentMaterializeResponse,
  type SmartSegmentResolveResponse,
  smartSegmentAnalysisIdentity,
} from "@shared/smart-segment";

type Props = {
  campaignName: string;
  campaignId: string | null;
  mtaId: string | null;
  selectedSegmentIds: string[];
  onSegmentsCreated: (segments: Array<{ id: string; name: string }>) => void;
};

type BrandOverride = { name: string; ref: string };
type MaterializeResponse = SmartSegmentMaterializeResponse;

const stages = ["brand_history", "cohorts", "reservoirs", "ai_proposal", "validation"] as const;
const analysisIdentity = smartSegmentAnalysisIdentity;
const integer = new Intl.NumberFormat("fr-FR");
const date = (value: string) => new Intl.DateTimeFormat("fr-FR").format(new Date(value));
const calibrationLabel = (value: string) => ({ brand: "marque", vertical: "verticale", global: "globale" }[value] ?? value);
const axisLabel = (value: string) => ({ clicker_tier: "niveau de clic", ref_relation: "relation à la marque", family: "famille" }[value] ?? value);

export function SmartSegmentAssistant({
  campaignName,
  campaignId,
  mtaId,
  selectedSegmentIds: _selectedSegmentIds,
  onSegmentsCreated,
}: Props) {
  const [debouncedName, setDebouncedName] = useState("");
  const [family, setFamily] = useState<DomainFamilyId>("fai_fr");
  const [familyChosen, setFamilyChosen] = useState(false);
  const [targetClicks, setTargetClicks] = useState(1000);
  const [complaintCapPercent, setComplaintCapPercent] = useState(0.45);
  const [brandName, setBrandName] = useState("");
  const [brandRef, setBrandRef] = useState("");
  const [analysisId, setAnalysisId] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<SmartSegmentAnalysisView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [proofsOpen, setProofsOpen] = useState(false);
  const [createdIndexes, setCreatedIndexes] = useState<number[]>([]);
  const [successNames, setSuccessNames] = useState<string[]>([]);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedName(campaignName.trim()), 500);
    return () => window.clearTimeout(timer);
  }, [campaignName]);

  const statusQuery = useQuery({
    queryKey: ["/api/smart-segments/status"],
    queryFn: async () => (await apiRequest("GET", "/api/smart-segments/status")).json() as Promise<SmartSegmentFeatureStatus>,
  });
  const configured = statusQuery.data?.configured === true;
  const override = brandName.trim() && brandRef.trim() ? { name: brandName.trim(), ref: brandRef.trim() } : null;
  const resolveQuery = useQuery({
    queryKey: ["/api/smart-segments/resolve", debouncedName, mtaId, override],
    enabled: configured && debouncedName.length > 0,
    queryFn: async () => {
      const response = await apiRequest("POST", "/api/smart-segments/resolve", {
        campaignName: debouncedName,
        mtaId,
        brandOverride: override,
      });
      return response.json() as Promise<SmartSegmentResolveResponse>;
    },
  });
  useEffect(() => {
    if (!familyChosen && resolveQuery.data?.suggestedFamily) setFamily(resolveQuery.data.suggestedFamily);
  }, [resolveQuery.data?.suggestedFamily, familyChosen]);

  const pollQuery = useQuery({
    queryKey: ["/api/smart-segments/analyses/", analysisId],
    enabled: !!analysisId,
    queryFn: async () => {
      const response = await apiRequest("GET", `/api/smart-segments/analyses/${analysisId}`);
      return response.json() as Promise<SmartSegmentAnalysisView>;
    },
    refetchInterval: (query) => {
      const value = query.state.data as SmartSegmentAnalysisView | undefined;
      return !value || value.status === "queued" || value.status === "running" ? 2_000 : false;
    },
  });
  useEffect(() => {
    if (pollQuery.data) setAnalysis(pollQuery.data);
  }, [pollQuery.data]);

  // The exact request "Analyser" would send right now. Every input that
  // changes the analysis is part of it (immediate name — not the debounced
  // one —, campaign, MTA, family, target, cap, brand override).
  const requestBody = useMemo<SmartSegmentAnalysisRequest>(() => ({
    campaignName: campaignName.trim(),
    campaignId,
    mtaId,
    family,
    targetClicks: Math.max(50, Math.round(targetClicks)),
    complaintCap: clampComplaintCapPercent(complaintCapPercent) / 100,
    brandOverride: override,
  }), [campaignName, campaignId, mtaId, family, targetClicks, complaintCapPercent, override]);
  const requestKey = analysisIdentity(requestBody);
  // The displayed analysis belongs to one exact request. When any input
  // changes, the projection on screen no longer describes what "Analyser"
  // would compute: drop it instead of letting a stale proposal be
  // materialised for the new parameters. Responses of requests started under
  // a previous identity are discarded (fence), never re-applied after a reset.
  const currentRequestKey = useRef(requestKey);
  currentRequestKey.current = requestKey;
  const lastRequestKey = useRef(requestKey);
  useEffect(() => {
    if (lastRequestKey.current === requestKey) return;
    lastRequestKey.current = requestKey;
    setAnalysisId(null);
    setAnalysis(null);
    setCreatedIndexes([]);
    setSuccessNames([]);
    setError(null);
    setProofsOpen(false);
  }, [requestKey]);

  const analysisMutation = useMutation({
    mutationFn: async (refresh: boolean) => {
      const key = currentRequestKey.current;
      const body: SmartSegmentAnalysisRequest = { ...requestBody, ...(refresh ? { refresh: true } : {}) };
      const response = await apiRequest("POST", "/api/smart-segments/analyses", body);
      return { view: await response.json() as SmartSegmentAnalysisView, key };
    },
    onSuccess: ({ view, key }) => {
      if (key !== currentRequestKey.current) return; // inputs changed meanwhile: stale
      setError(null);
      setAnalysis(view);
      setAnalysisId(view.id);
      setCreatedIndexes(view.createdSegments.map((segment) => segment.index));
    },
    onError: (cause) => setError(parseSmartSegmentApiError(cause).message),
  });

  // A proposal may only be materialised while it still describes the current
  // inputs exactly (a reused analysis carries the params it was computed with).
  const analysisMatchesInputs = !!analysis && analysisIdentity(analysis.params) === requestKey;

  const materializeMutation = useMutation({
    mutationFn: async (proposalIndexes: number[]) => {
      if (!analysis) throw new Error("Aucune analyse disponible.");
      if (analysisIdentity(analysis.params) !== currentRequestKey.current) {
        throw new Error("Les paramètres ont changé depuis l'analyse : relancez l'analyse avant de créer le segment.");
      }
      const response = await apiRequest("POST", `/api/smart-segments/analyses/${analysis.id}/materialize`, {
        campaignId,
        proposalIndexes,
      });
      return { data: await response.json() as MaterializeResponse, proposalIndexes };
    },
    onSuccess: ({ data, proposalIndexes }) => {
      onSegmentsCreated(data.segments);
      queryClient.invalidateQueries({ queryKey: ["/api/segments"] });
      setCreatedIndexes((current) => [...new Set([...current, ...proposalIndexes])]);
      setSuccessNames((current) => [...new Set([...current, ...data.segments.map((segment) => segment.name)])]);
      setError(null);
    },
    onError: (cause) => setError(parseSmartSegmentApiError(cause).message),
  });

  const brand = resolveQuery.data?.brand;
  // Without a resolved brand (detected or entered manually) the server refuses
  // the analysis (BRAND_UNRESOLVED): keep the button consistent with it.
  const brandReady = brand?.detected === true || override !== null;
  const disabled = !configured || !campaignName.trim() || debouncedName !== campaignName.trim() || resolveQuery.isLoading || !brandReady;
  const currentStageIndex = analysis ? stages.indexOf(analysis.stage as typeof stages[number]) : -1;
  const evidence = analysis?.evidence;
  const groupedCohorts = useMemo(() => {
    const groups = new Map<string, NonNullable<typeof evidence>["cohortRates"]>();
    for (const row of evidence?.cohortRates ?? []) groups.set(row.axis, [...(groups.get(row.axis) ?? []), row]);
    return groups;
  }, [evidence]);

  return (
    <div className="rounded-lg border bg-muted/30 p-4 space-y-4" data-testid="smart-segment-assistant">
      <div className="flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-primary" />
        <p className="font-medium">Smart segment (IA)</p>
        {statusQuery.data?.model && <Badge variant="secondary">{statusQuery.data.model}</Badge>}
      </div>
      {statusQuery.isLoading ? <Skeleton className="h-20 w-full" /> : !configured ? (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          Cette fonctionnalité nécessite la variable serveur ANTHROPIC_API_KEY (et, facultativement,
          SMART_SEGMENT_MODEL). {statusQuery.isError ? parseSmartSegmentApiError(statusQuery.error).message : statusQuery.data?.reason}
        </div>
      ) : null}

      <fieldset disabled={!configured} className="space-y-4 disabled:opacity-60">
        {resolveQuery.isLoading && <Skeleton className="h-8 w-full" />}
        {resolveQuery.isError && <p className="flex items-center gap-2 text-sm text-destructive"><AlertCircle className="h-4 w-4" />{parseSmartSegmentApiError(resolveQuery.error).message}</p>}
        {brand?.detected ? (
          <div className="space-y-2 text-sm">
            <p><span className="font-medium">Marque détectée :</span> {brand.brandName}</p>
            <div className="flex flex-wrap gap-1">
              {[...brand.coreRefs, ...brand.extensionRefs].map((ref) => <Badge key={ref} variant="outline">{ref}</Badge>)}
              {brand.verticalLabel && <Badge variant="secondary">{brand.verticalLabel}</Badge>}
            </div>
          </div>
        ) : debouncedName ? (
          <div className="space-y-2">
            <p className="text-sm font-medium">Marque non reconnue — indiquez-la pour pouvoir analyser</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div><Label htmlFor="smart-brand-name">Nom de la marque</Label><Input id="smart-brand-name" value={brandName} onChange={(e) => setBrandName(e.target.value)} data-testid="input-smart-segment-brand-name" /></div>
              <div><Label htmlFor="smart-brand-ref">Ref principale</Label><Input id="smart-brand-ref" value={brandRef} onChange={(e) => setBrandRef(e.target.value)} data-testid="input-smart-segment-brand-ref" /></div>
            </div>
          </div>
        ) : null}

        <div className="grid gap-3 md:grid-cols-3">
          <div className="space-y-1"><Label>Famille de domaines</Label>
            <Select value={family} onValueChange={(value: DomainFamilyId) => { setFamily(value); setFamilyChosen(true); }} disabled={!configured}>
              <SelectTrigger data-testid="select-smart-segment-family"><SelectValue /></SelectTrigger>
              <SelectContent>{Object.entries(DOMAIN_FAMILIES).map(([id, item]) => <SelectItem key={id} value={id}>{item.label}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-1"><Label htmlFor="smart-target">Objectif de clics</Label><Input id="smart-target" type="number" min={50} value={targetClicks} onChange={(e) => setTargetClicks(Number(e.target.value))} data-testid="input-smart-segment-target" /></div>
          <div className="space-y-1"><Label htmlFor="smart-cap">Plafond de plaintes en %</Label><Input id="smart-cap" type="number" min={0.05} max={0.6} step={0.01} value={complaintCapPercent} onChange={(e) => setComplaintCapPercent(clampComplaintCapPercent(Number(e.target.value)))} data-testid="input-smart-segment-cap" /><p className="text-xs text-muted-foreground">0,6 % max, non dépassable</p></div>
        </div>
        <Button type="button" disabled={disabled || analysisMutation.isPending} onClick={() => analysisMutation.mutate(false)} data-testid="button-smart-segment-analyze">
          {analysisMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Analyser
        </Button>
      </fieldset>

      {error && <p className="flex items-center gap-2 text-sm font-medium text-destructive"><AlertCircle className="h-4 w-4" />{error}</p>}
      {analysis?.reused && <Badge variant="secondary">analyse réutilisée (moins de 6 h)</Badge>}
      {analysis && (analysis.status === "queued" || analysis.status === "running") && (
        <div className="space-y-2">
          <p className="text-sm font-medium">Progression : {analysis.progress} %</p>
          {stages.map((stage, index) => <div key={stage} className={`flex items-center gap-2 text-sm ${index === currentStageIndex ? "font-semibold text-primary" : index < currentStageIndex ? "text-muted-foreground" : ""}`}><Check className={`h-3.5 w-3.5 ${index > currentStageIndex ? "opacity-20" : ""}`} />{SMART_SEGMENT_STAGE_LABELS[stage]}</div>)}
        </div>
      )}
      {analysis?.status === "failed" && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3">
          <p className="font-medium text-destructive">{analysis.error || "L’analyse a échoué."}</p>
          <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => analysisMutation.mutate(true)}>Réessayer</Button>
        </div>
      )}

      {analysis?.status === "succeeded" && analysis.proposal && (
        <div className="space-y-4">
          {analysis.proposal.segments.map((segment, index) => {
            const created = createdIndexes.includes(index) || analysis.createdSegments.some((entry) => entry.index === index);
            return <div key={`${segment.name}-${index}`} className="rounded-lg border bg-background p-4 space-y-3">
              <h4 className="font-semibold">{segment.name}</h4>
              <pre className="whitespace-pre-wrap font-sans text-sm">{segment.readableRules.join("\n")}</pre>
              <div className="grid gap-1 text-sm sm:grid-cols-3">
                <p><span className="font-medium">Effectif réel :</span> {integer.format(segment.audienceCount)}</p>
                <p><span className="font-medium">Clics humains projetés :</span> {integer.format(segment.projectedClicks.low)} – {integer.format(segment.projectedClicks.high)}</p>
                <p className={complaintRateColor(segment.projectedComplaintRate)}><span className="font-medium">Taux de plaintes projeté :</span> {formatSmartSegmentPercent(segment.projectedComplaintRate)} %</p>
              </div>
              <div className="flex flex-wrap gap-1">{segment.blocksUsed.map((block) => <Badge key={block} variant="outline">{block}</Badge>)}</div>
              <p className="text-sm whitespace-pre-line">{segment.rationale}</p>
              {segment.warnings.length > 0 && <ul className="space-y-1 text-sm text-amber-700">{segment.warnings.map((warning) => <li key={warning} className="flex gap-2"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />{warning}</li>)}</ul>}
              {segment.injectedExclusions.length > 0 && <p className="text-sm"><span className="font-medium">Exclusions ajoutées par le serveur :</span> {segment.injectedExclusions.join(", ")}</p>}
              {created ? <p className="text-sm font-medium text-green-700">Segment créé : {segment.name}</p> : (
                <Button type="button" size="sm" disabled={materializeMutation.isPending || !analysisMatchesInputs} onClick={() => materializeMutation.mutate([index])} data-testid={index === 0 ? "button-smart-segment-create" : `button-smart-segment-create-${index}`}>Créer ce segment et l&apos;attacher</Button>
              )}
            </div>;
          })}
          {analysis.proposal.segments.length === 2 && createdIndexes.length === 0 && analysis.createdSegments.length === 0 && <Button type="button" variant="outline" disabled={materializeMutation.isPending || !analysisMatchesInputs} onClick={() => materializeMutation.mutate([0, 1])} data-testid="button-smart-segment-create-all">Créer les deux</Button>}
          {successNames.map((name) => <p key={name} className="text-sm font-medium text-green-700">Segment créé : {name}</p>)}

          {evidence && <div className="rounded-lg border bg-background">
            <Button type="button" variant="ghost" className="w-full justify-between" onClick={() => setProofsOpen((open) => !open)}>Preuves {proofsOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}</Button>
            {proofsOpen && <div className="space-y-5 overflow-x-auto p-4 text-sm">
              <div><h5 className="mb-2 font-medium">Envois de la marque</h5><Table><TableHeader><TableRow><TableHead>Nom / date</TableHead><TableHead>Livrés</TableHead><TableHead>CTR humain</TableHead><TableHead>Plaintes</TableHead><TableHead>Terminé / calibration</TableHead></TableRow></TableHeader><TableBody>{evidence.brandSends.map((send) => <TableRow key={send.campaignId}><TableCell>{send.name}<br /><span className="text-xs text-muted-foreground">{date(send.firstSendAt)}</span></TableCell><TableCell>{integer.format(send.delivered)}</TableCell><TableCell>{formatSmartSegmentPercent(send.humanCtr)} %</TableCell><TableCell>{formatSmartSegmentPercent(send.complaintRate)} %</TableCell><TableCell>{send.finished ? "Oui" : "Non"} / {send.usedForCalibration ? "Oui" : "Non"}</TableCell></TableRow>)}</TableBody></Table></div>
              {[...groupedCohorts.entries()].map(([axis, rows]) => <div key={axis}><h5 className="mb-2 font-medium">Cohortes — {axisLabel(axis)}</h5><Table><TableHeader><TableRow><TableHead>Cohorte</TableHead><TableHead>Livrés</TableHead><TableHead>CTR humain</TableHead><TableHead>Plaintes</TableHead></TableRow></TableHeader><TableBody>{rows.map((row) => <TableRow key={`${axis}-${row.cohort}`}><TableCell>{row.cohort}</TableCell><TableCell>{integer.format(row.delivered)}</TableCell><TableCell>{formatSmartSegmentPercent(row.humanCtr)} %</TableCell><TableCell>{formatSmartSegmentPercent(row.complaintRate)} %</TableCell></TableRow>)}</TableBody></Table></div>)}
              <div><h5 className="mb-2 font-medium">Blocs</h5><Table><TableHeader><TableRow><TableHead>Libellé</TableHead><TableHead>Disponible</TableHead><TableHead>CTR attendu</TableHead><TableHead>Clics projetés</TableHead><TableHead>Calibration / décote</TableHead></TableRow></TableHeader><TableBody>{evidence.blocks.map((block) => <TableRow key={block.id}><TableCell>{block.label}</TableCell><TableCell>{integer.format(block.available)}</TableCell><TableCell>{formatSmartSegmentPercent(block.expectedCtr)} %</TableCell><TableCell>{integer.format(block.projectedClicks.low)} – {integer.format(block.projectedClicks.high)}</TableCell><TableCell>{calibrationLabel(block.calibration.level)} / {formatSmartSegmentPercent(block.calibration.discount)} %</TableCell></TableRow>)}</TableBody></Table></div>
              <p><span className="font-medium">Niveau de calibration :</span> {calibrationLabel(evidence.calibrationLevel)}</p>
              {evidence.notes.length > 0 && <ul className="list-disc space-y-1 pl-5">{evidence.notes.map((note) => <li key={note}>{note}</li>)}</ul>}
            </div>}
          </div>}
          <p className="text-sm italic text-muted-foreground">{analysis.proposal.disclaimer}</p>
        </div>
      )}
    </div>
  );
}