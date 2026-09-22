import { useEffect, useMemo, useState, useRef } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertCircle, AlertTriangle, Check, ChevronDown, ChevronUp, Globe, Loader2, RefreshCw, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { apiRequest, queryClient } from "@/lib/queryClient";
import {
  clampComplaintCapPercent,
  complaintRateColor,
  defaultSimilarBrandRefs,
  formatSmartSegmentPercent,
  isTransientSimilarBrandsError,
  parseSmartSegmentApiError,
  validateManualSimilarRef,
} from "@/lib/smart-segment-ui";
import {
  DOMAIN_FAMILIES,
  RECENCY_BAND_LABELS,
  SMART_SEGMENT_MAX_SIMILAR_REFS,
  SMART_SEGMENT_PROPOSAL_KIND_LABELS,
  SMART_SEGMENT_STAGE_LABELS,
  normalizeSimilarRefs,
  type DomainFamilyId,
  type SmartSegmentAnalysisRequest,
  type SmartSegmentAnalysisView,
  type SmartSegmentFeatureStatus,
  type SmartSegmentMaterializeResponse,
  type SmartSegmentResolveResponse,
  type SmartSegmentSimilarBrandsResponse,
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
const recencyCalibrationLabel = (value: string) => ({ brand: "marque", vertical: "verticale", global: "toutes marques" }[value] ?? value);
const axisLabel = (value: string) => ({
  clicker_tier: "niveau de clic",
  ref_relation: "relation à la marque",
  family: "famille",
  recency: "Récence (dernière activité)",
  ref_recency: "Récence × relation aux refs",
}[value] ?? value);
const cohortLabel = (value: string) => {
  if (value in RECENCY_BAND_LABELS) return RECENCY_BAND_LABELS[value as keyof typeof RECENCY_BAND_LABELS];
  const [relation, band] = value.split("|");
  if (band && band in RECENCY_BAND_LABELS) return `${relation} · ${RECENCY_BAND_LABELS[band as keyof typeof RECENCY_BAND_LABELS]}`;
  return value;
};

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
  const [checkedSimilarRefs, setCheckedSimilarRefs] = useState<string[]>([]);
  const [manualSimilarRefs, setManualSimilarRefs] = useState<string[]>([]);
  const [manualSimilarInput, setManualSimilarInput] = useState("");
  const [manualSimilarError, setManualSimilarError] = useState<string | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedName(campaignName.trim()), 500);
    return () => window.clearTimeout(timer);
  }, [campaignName]);
  // A brand typed by hand describes ONE campaign name. When the name changes
  // the override is dropped, otherwise it would keep precedence over the
  // detection and the analysis would run with stale refs, unsubscribe tags
  // and brand history.
  const overrideForName = useRef(debouncedName);
  useEffect(() => {
    if (overrideForName.current === debouncedName) return;
    overrideForName.current = debouncedName;
    setBrandName("");
    setBrandRef("");
  }, [debouncedName]);

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
  const brand = resolveQuery.data?.brand;
  const coreRefs = brand?.detected ? normalizeSimilarRefs(brand.coreRefs) : [];
  const similarBrandName = brand?.detected ? (brand.brandName ?? "").trim() : "";
  const similarKey = `${similarBrandName}|${coreRefs.join(",")}`;
  // « Actualiser » is a distinct operation, not a flag on the next fetch: it
  // gets its own query key (nonce) so its retries stay refreshes and a failed
  // refresh never quietly shows the server's stored answer again.
  const [similarRefreshNonce, setSimilarRefreshNonce] = useState(0);
  useEffect(() => { setSimilarRefreshNonce(0); }, [similarKey]);
  const similarBrandsQuery = useQuery({
    queryKey: ["/api/smart-segments/similar-brands", similarKey, similarRefreshNonce],
    enabled: similarBrandName.length > 0,
    queryFn: async () => {
      const response = await apiRequest("POST", "/api/smart-segments/similar-brands", {
        brandName: similarBrandName,
        coreRefs,
        ...(similarRefreshNonce > 0 ? { refresh: true } : {}),
      });
      return response.json() as Promise<SmartSegmentSimilarBrandsResponse>;
    },
    // The lookup runs a web search (tens of seconds) and is billed: only an
    // input change, « Actualiser » or « Réessayer » may run it — never a
    // focus/reconnect refetch, which would also discard the operator's ticks.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchOnMount: false,
    // A gateway timeout or a busy model gets two quiet retries; the server
    // answers from its store once the first call has finished.
    retry: (failureCount, error) => failureCount < 2 && isTransientSimilarBrandsError(error),
    retryDelay: 5_000,
  });
  useEffect(() => {
    setCheckedSimilarRefs([]);
    setManualSimilarRefs([]);
    setManualSimilarInput("");
    setManualSimilarError(null);
  }, [similarKey]);
  // A new answer (first load or refresh) resets the ticks to the server's proposal.
  useEffect(() => {
    if (similarBrandsQuery.data) setCheckedSimilarRefs(defaultSimilarBrandRefs(similarBrandsQuery.data.brands));
  }, [similarBrandsQuery.data]);
  const refreshSimilarBrands = () => setSimilarRefreshNonce((nonce) => nonce + 1);
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
  const similarRefs = normalizeSimilarRefs([...checkedSimilarRefs, ...manualSimilarRefs]);
  const requestBody = useMemo<SmartSegmentAnalysisRequest>(() => ({
    campaignName: campaignName.trim(),
    campaignId,
    mtaId,
    family,
    targetClicks: Math.max(50, Math.round(targetClicks)),
    complaintCap: clampComplaintCapPercent(complaintCapPercent) / 100,
    brandOverride: override,
    ...(similarRefs.length > 0 ? { similarRefs } : {}),
  }), [campaignName, campaignId, mtaId, family, targetClicks, complaintCapPercent, override, similarRefs.join(",")]);
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
    onMutate: () => ({ key: currentRequestKey.current }),
    onError: (cause, _refresh, context) => {
      if (context?.key !== currentRequestKey.current) return; // inputs changed meanwhile: stale error
      setError(parseSmartSegmentApiError(cause).message);
    },
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
  const ownBrandRefs = normalizeSimilarRefs([...(brand?.coreRefs ?? []), ...(brand?.extensionRefs ?? [])]);
  const similarRefsAtCap = similarRefs.length >= SMART_SEGMENT_MAX_SIMILAR_REFS;
  // A brand is (un)checked as a whole: all of its refs enter or leave the
  // selection, and the cap counts the manual refs too — a brand that does
  // not fit entirely is refused rather than half-checked.
  const toggleSimilarBrand = (refs: string[], checked: boolean) => {
    const normalized = normalizeSimilarRefs(refs);
    if (!checked) {
      setCheckedSimilarRefs((current) => current.filter((value) => !normalized.includes(value)));
      setManualSimilarError(null);
      return;
    }
    const next = normalizeSimilarRefs([...checkedSimilarRefs, ...manualSimilarRefs, ...normalized]);
    if (next.length > SMART_SEGMENT_MAX_SIMILAR_REFS) {
      setManualSimilarError(`${SMART_SEGMENT_MAX_SIMILAR_REFS} refs maximum : décochez une marque ou retirez une ref ajoutée à la main.`);
      return;
    }
    setCheckedSimilarRefs((current) => normalizeSimilarRefs([...current, ...normalized]));
    setManualSimilarError(null);
  };
  const addManualSimilarRef = () => {
    const result = validateManualSimilarRef(manualSimilarInput, ownBrandRefs, similarRefs);
    if (!result.ref) {
      setManualSimilarError(result.error);
      return;
    }
    setManualSimilarRefs((current) => normalizeSimilarRefs([...current, result.ref!]));
    setManualSimilarInput("");
    setManualSimilarError(null);
  };

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
        {brand?.detected && brand.source !== "manual" ? (
          <div className="space-y-2 text-sm">
            <p><span className="font-medium">Marque détectée :</span> {brand.brandName}</p>
            <div className="flex flex-wrap gap-1">
              {[...brand.coreRefs, ...brand.extensionRefs].map((ref) => <Badge key={ref} variant="outline">{ref}</Badge>)}
              {brand.verticalLabel && <Badge variant="secondary">{brand.verticalLabel}</Badge>}
            </div>
          </div>
        ) : debouncedName ? (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-medium">
                {override ? "Marque saisie manuellement (modifiable)" : "Marque non reconnue — indiquez-la pour pouvoir analyser"}
              </p>
              {(brandName || brandRef) && (
                <Button type="button" variant="ghost" size="sm" onClick={() => { setBrandName(""); setBrandRef(""); }} data-testid="button-smart-segment-brand-clear">Effacer</Button>
              )}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div><Label htmlFor="smart-brand-name">Nom de la marque</Label><Input id="smart-brand-name" value={brandName} onChange={(e) => setBrandName(e.target.value)} data-testid="input-smart-segment-brand-name" /></div>
              <div><Label htmlFor="smart-brand-ref">Ref principale</Label><Input id="smart-brand-ref" value={brandRef} onChange={(e) => setBrandRef(e.target.value)} data-testid="input-smart-segment-brand-ref" /></div>
            </div>
            {brand?.detected && brand.source === "manual" && (
              <div className="flex flex-wrap gap-1 text-sm">
                {[...brand.coreRefs, ...brand.extensionRefs].map((ref) => <Badge key={ref} variant="outline">{ref}</Badge>)}
                {brand.verticalLabel && <Badge variant="secondary">{brand.verticalLabel}</Badge>}
              </div>
            )}
          </div>
        ) : null}

        {brand?.detected && similarBrandName.length > 0 && (
          <div className="space-y-3 rounded-md border bg-background p-3" data-testid="smart-segment-similar-brands">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <p className="text-sm font-medium">Marques similaires</p>
                <p className="text-xs text-muted-foreground">
                  Marques de l'annuaire (Brands + REF) que l'IA juge comparables à « {similarBrandName} » après une recherche web : même secteur, même cible. Cochées par défaut ; décochez pour les écarter. Cette sélection sert au segment « avec marques similaires ».
                </p>
              </div>
              {similarBrandsQuery.data && (
                <Button type="button" variant="ghost" size="sm" disabled={similarBrandsQuery.isFetching} onClick={refreshSimilarBrands} data-testid="button-smart-segment-similar-refresh">
                  <RefreshCw className={`mr-1 h-3.5 w-3.5 ${similarBrandsQuery.isFetching ? "animate-spin" : ""}`} />Actualiser
                </Button>
              )}
            </div>
            {similarBrandsQuery.isLoading || (similarBrandsQuery.isFetching && !similarBrandsQuery.data) ? (
              <div className="space-y-2">
                <Skeleton className="h-16 w-full" />
                <p className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" />Recherche web des marques similaires en cours (jusqu'à une minute)…</p>
              </div>
            ) : similarBrandsQuery.isError ? (
              <div className="space-y-2">
                <p className="flex items-center gap-2 text-sm text-destructive"><AlertCircle className="h-4 w-4 shrink-0" />Marques similaires indisponibles : {parseSmartSegmentApiError(similarBrandsQuery.error).message}</p>
                <Button type="button" variant="outline" size="sm" onClick={() => void similarBrandsQuery.refetch()} data-testid="button-smart-segment-similar-retry">Réessayer</Button>
              </div>
            ) : similarBrandsQuery.data ? (
              <div className="space-y-2">
                {similarBrandsQuery.data.sector && <p className="text-xs text-muted-foreground"><span className="font-medium">Lecture de la marque :</span> {similarBrandsQuery.data.sector}</p>}
                {similarBrandsQuery.data.brands.length ? similarBrandsQuery.data.brands.map((candidate) => {
                  const refs = normalizeSimilarRefs(candidate.refs);
                  const checkedCount = refs.filter((ref) => checkedSimilarRefs.includes(ref)).length;
                  const checked = checkedCount === refs.length ? true : checkedCount === 0 ? false : "indeterminate";
                  return (
                    <div key={candidate.name} className="flex items-start gap-2">
                      <Checkbox
                        id={`smart-similar-${candidate.name}`}
                        checked={checked}
                        disabled={checked !== true && similarRefsAtCap}
                        onCheckedChange={(value) => toggleSimilarBrand(refs, value === true)}
                        data-testid={`checkbox-smart-segment-similar-${refs[0] ?? candidate.name}`}
                      />
                      <Label htmlFor={`smart-similar-${candidate.name}`} className="min-w-0 flex-1 font-normal">
                        <span className="block">{candidate.name} · {refs.join(", ")}</span>
                        {candidate.reason && <span className="block text-xs text-muted-foreground">{candidate.reason}</span>}
                      </Label>
                    </div>
                  );
                }) : (
                  <p className="text-sm text-muted-foreground">Aucune marque comparable trouvée dans l'annuaire pour cette marque.</p>
                )}
                <p className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Globe className="h-3.5 w-3.5" />
                  {similarBrandsQuery.data.webSearchUsed
                    ? `${integer.format(similarBrandsQuery.data.webSearches)} recherche(s) web`
                    : "Sans recherche web (connaissances du modèle)"}
                  {" · "}{similarBrandsQuery.data.cached ? `résultat mémorisé du ${date(similarBrandsQuery.data.generatedAt)}` : "résultat frais"}
                </p>
              </div>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Input
                className="h-8 w-56"
                placeholder="Ajouter une ref, ex. 4TUI"
                value={manualSimilarInput}
                onChange={(event) => { setManualSimilarInput(event.target.value); setManualSimilarError(null); }}
                onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addManualSimilarRef(); } }}
                data-testid="input-smart-segment-similar-ref"
              />
              <Button type="button" variant="outline" size="sm" disabled={similarRefsAtCap} onClick={addManualSimilarRef}>Ajouter</Button>
            </div>
            {manualSimilarRefs.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {manualSimilarRefs.map((ref) => (
                  <Badge key={ref} variant="secondary" className="gap-1">
                    {ref}
                    <button type="button" className="rounded px-0.5 hover:bg-muted" aria-label={`Retirer ${ref}`} onClick={() => setManualSimilarRefs((current) => current.filter((value) => value !== ref))}>×</button>
                  </Badge>
                ))}
              </div>
            )}
            {manualSimilarError && <p className="text-xs text-destructive">{manualSimilarError}</p>}
            {similarRefsAtCap && <p className="text-xs text-muted-foreground">{SMART_SEGMENT_MAX_SIMILAR_REFS} refs maximum</p>}
            {similarBrandsQuery.data?.notes.map((note) => <p key={note} className="text-xs text-muted-foreground">{note}</p>)}
          </div>
        )}

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
            const kindLabel = segment.kind ? SMART_SEGMENT_PROPOSAL_KIND_LABELS[segment.kind] : null;
            return <div key={`${segment.name}-${index}`} className="rounded-lg border bg-background p-4 space-y-3" data-testid={`smart-segment-proposal-${index}`}>
              <div className="flex flex-wrap items-center gap-2">
                <h4 className="font-semibold">{segment.name}</h4>
                {kindLabel && <Badge variant={segment.kind === "similar_brands" ? "default" : "secondary"}>{kindLabel}</Badge>}
              </div>
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
          {analysis.proposal.segments.length >= 2 && createdIndexes.length === 0 && analysis.createdSegments.length === 0 && <Button type="button" variant="outline" disabled={materializeMutation.isPending || !analysisMatchesInputs} onClick={() => materializeMutation.mutate(analysis.proposal!.segments.map((_, index) => index))} data-testid="button-smart-segment-create-all">Créer les {analysis.proposal.segments.length === 2 ? "deux" : "trois"}</Button>}
          {successNames.map((name) => <p key={name} className="text-sm font-medium text-green-700">Segment créé : {name}</p>)}

          {evidence && <div className="rounded-lg border bg-background">
            <Button type="button" variant="ghost" className="w-full justify-between" onClick={() => setProofsOpen((open) => !open)}>Preuves {proofsOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}</Button>
            {proofsOpen && <div className="space-y-5 overflow-x-auto p-4 text-sm">
              {!!evidence.similarBrands?.length && <p><span className="font-medium">Marques similaires retenues :</span> {evidence.similarBrands.map((item) => `${item.brandName ?? item.ref} (${item.ref})`).join(", ")}</p>}
              {evidence.recencyCalibration && <p><span className="font-medium">Cohortes de récence :</span> calibrage {recencyCalibrationLabel(evidence.recencyCalibration.level)} sur {integer.format(evidence.recencyCalibration.campaignIds.length)} envoi(s)</p>}
              {evidence.recencyCalibration === null && <p className="text-muted-foreground">Blocs non actifs indisponibles (aucune cohorte de récence fiable)</p>}
              <div><h5 className="mb-2 font-medium">Envois de la marque</h5><Table><TableHeader><TableRow><TableHead>Nom / date</TableHead><TableHead>Livrés</TableHead><TableHead>CTR humain</TableHead><TableHead>Plaintes</TableHead><TableHead>Terminé / calibration</TableHead></TableRow></TableHeader><TableBody>{evidence.brandSends.map((send) => <TableRow key={send.campaignId}><TableCell>{send.name}<br /><span className="text-xs text-muted-foreground">{date(send.firstSendAt)}</span></TableCell><TableCell>{integer.format(send.delivered)}</TableCell><TableCell>{formatSmartSegmentPercent(send.humanCtr)} %</TableCell><TableCell>{formatSmartSegmentPercent(send.complaintRate)} %</TableCell><TableCell>{send.finished ? "Oui" : "Non"} / {send.usedForCalibration ? "Oui" : "Non"}</TableCell></TableRow>)}</TableBody></Table></div>
              {[...groupedCohorts.entries()].map(([axis, rows]) => <div key={axis}><h5 className="mb-2 font-medium">Cohortes — {axisLabel(axis)}</h5><Table><TableHeader><TableRow><TableHead>Cohorte</TableHead><TableHead>Livrés</TableHead><TableHead>CTR humain</TableHead><TableHead>Plaintes</TableHead></TableRow></TableHeader><TableBody>{rows.map((row) => <TableRow key={`${axis}-${row.cohort}`}><TableCell>{cohortLabel(row.cohort)}</TableCell><TableCell>{integer.format(row.delivered)}</TableCell><TableCell>{formatSmartSegmentPercent(row.humanCtr)} %</TableCell><TableCell>{formatSmartSegmentPercent(row.complaintRate)} %</TableCell></TableRow>)}</TableBody></Table></div>)}
              <div><h5 className="mb-2 font-medium">Blocs</h5><Table><TableHeader><TableRow><TableHead>Libellé</TableHead><TableHead>Disponible</TableHead><TableHead>CTR attendu</TableHead><TableHead>Clics projetés</TableHead><TableHead>Calibration / décote</TableHead></TableRow></TableHeader><TableBody>{evidence.blocks.map((block) => <TableRow key={block.id}><TableCell>{block.label}</TableCell><TableCell>{integer.format(block.available)}</TableCell><TableCell>{formatSmartSegmentPercent(block.expectedCtr)} %</TableCell><TableCell>{integer.format(block.projectedClicks.low)} – {integer.format(block.projectedClicks.high)}</TableCell><TableCell>{calibrationLabel(block.calibration.level)} / {formatSmartSegmentPercent(block.calibration.discount)} %</TableCell></TableRow>)}</TableBody></Table></div>
              {evidence.omittedBlocks?.map((block) => <p key={block.id} className="text-muted-foreground">Bloc non proposé : {block.label} — {block.reason}</p>)}
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