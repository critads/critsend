import React, { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import type { CampaignMtaTransferPreview } from "@shared/campaign-mta-transfer";
import type { TransferDialogValues } from "@/lib/campaign-mta-transfer";
import type { CalendarCampaignRecord } from "@/lib/campaign-calendar";

export type TransferIdentityChoice = "target" | "custom" | "empty";

export interface TransferMta {
  id: string;
  name: string;
}

export interface TransferRequest {
  campaign: CalendarCampaignRecord;
  target: TransferMta;
}

const time = (value: string | null) =>
  value
    ? new Intl.DateTimeFormat("fr-FR", {
        timeZone: "Europe/Paris",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(new Date(value))
    : "Non planifiée";

function TransferDetail({
  label,
  value,
}: {
  label: string;
  value: string | null | undefined;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-semibold uppercase tracking-wide text-stone-400">
        {label}
      </dt>
      <dd className="truncate text-sm text-stone-800">{value || "Non renseigné"}</dd>
    </div>
  );
}

export function CampaignMtaTransferDialog({
  request,
  preview,
  loading,
  previewError,
  submitting,
  onOpenChange,
  onConfirm,
}: {
  request: TransferRequest | null;
  preview: CampaignMtaTransferPreview | null;
  loading: boolean;
  previewError: string | null;
  submitting: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (values: TransferDialogValues) => void;
}) {
  const [name, setName] = useState("");
  const [from, setFrom] = useState<TransferIdentityChoice>("custom");
  const [replyTo, setReplyTo] = useState<TransferIdentityChoice>("custom");

  useEffect(() => {
    if (!request) return;
    setName(preview?.name.proposed || request.campaign.name);
    setFrom(
      preview?.identity.from.currentIsCustom
        ? "custom"
        : preview?.identity.from.proposed
          ? "target"
          : "custom",
    );
    setReplyTo(
      preview?.identity.replyTo.current === null
        ? "empty"
        : preview?.identity.replyTo.currentIsCustom
          ? "custom"
          : preview?.identity.replyTo.proposed
            ? "target"
            : "custom",
    );
  }, [request, preview]);

  const targetCapabilities = preview?.targetCapabilities;
  const sourceCapabilities = preview?.sourceCapabilities;
  const nameNeedsConfirmation = Boolean(preview?.name.requiresConfirmation);
  const canConfirm = Boolean(request && preview && name.trim()) && !loading && !previewError;

  return (
    <Dialog open={Boolean(request)} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto bg-[#fffdf7] sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Confirmer le changement de MTA</DialogTitle>
          <DialogDescription>
            L&apos;horaire, l&apos;audience et les paramètres de la campagne restent inchangés.
          </DialogDescription>
        </DialogHeader>
        {request && (
          <div className="space-y-5">
            <dl className="grid gap-3 rounded-lg border border-stone-200 bg-stone-50/60 p-3 sm:grid-cols-2">
              <TransferDetail label="MTA source" value={request.campaign.mtaName || "Sans MTA identifiable"} />
              <TransferDetail label="MTA cible" value={request.target.name} />
              <TransferDetail label="Horaire conservé" value={time(request.campaign.scheduledAt)} />
              <TransferDetail label="Domaine de tracking source" value={sourceCapabilities?.trackingDomain} />
              <TransferDetail label="Domaine de tracking cible" value={targetCapabilities?.trackingDomain} />
              <TransferDetail label="Domaine d'ouverture source" value={sourceCapabilities?.openTrackingDomain} />
              <TransferDetail label="Domaine d'ouverture cible" value={targetCapabilities?.openTrackingDomain} />
              <TransferDetail label="Domaine images source" value={sourceCapabilities?.imageHostingDomain} />
              <TransferDetail label="Domaine images cible" value={targetCapabilities?.imageHostingDomain} />
              <TransferDetail label="Identité source" value={preview?.identity.from.sourceMta} />
              <TransferDetail label="Identité cible proposée" value={preview?.identity.from.targetMta} />
              <TransferDetail label="Reply-To source" value={preview?.identity.replyTo.sourceMta} />
              <TransferDetail label="Reply-To cible proposée" value={preview?.identity.replyTo.targetMta} />
              <TransferDetail label="Cadence cible" value={targetCapabilities?.sendingSpeed} />
            </dl>

            {preview?.images.unsupported.length ? (
              <p role="alert" className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
                Le contenu contient des images non prises en charge par le MTA cible. Le transfert est indisponible.
              </p>
            ) : null}

            <div className="space-y-2">
              <Label htmlFor="campaign-transfer-name">Nom proposé</Label>
              <Input
                id="campaign-transfer-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                disabled={submitting}
                maxLength={200}
                aria-describedby="campaign-transfer-name-help"
                data-testid="campaign-transfer-name"
              />
              <p id="campaign-transfer-name-help" className="text-xs text-stone-500">
                {nameNeedsConfirmation
                  ? "Le suffixe MTA n'est pas reconnu. Vérifiez et confirmez le nom manuellement."
                  : "Seul le suffixe MTA géré est remplacé ; les autres mots du nom restent inchangés."}
              </p>
            </div>

            <fieldset className="space-y-2">
              <legend className="text-sm font-semibold text-stone-900">Identité expéditeur</legend>
              <RadioGroup value={from} onValueChange={(value) => setFrom(value as TransferIdentityChoice)} className="gap-2" disabled={submitting}>
                <label className="flex items-start gap-2 rounded-md border border-stone-200 p-2 text-sm">
                  <RadioGroupItem value="target" aria-label="Utiliser l'identité du MTA cible" />
                  <span><span className="font-medium">Utiliser le MTA cible</span><br /><span className="text-xs text-stone-500">{preview?.identity.from.targetMta || "Identité configurée du MTA cible"}</span></span>
                </label>
                <label className="flex items-start gap-2 rounded-md border border-stone-200 p-2 text-sm">
                  <RadioGroupItem value="custom" aria-label="Conserver l'identité actuelle" />
                  <span><span className="font-medium">Conserver l&apos;identité actuelle</span><br /><span className="text-xs text-stone-500">{preview?.identity.from.current || "Valeur actuelle de la campagne"}</span></span>
                </label>
              </RadioGroup>
            </fieldset>

            <fieldset className="space-y-2">
              <legend className="text-sm font-semibold text-stone-900">Reply-To</legend>
              <RadioGroup value={replyTo} onValueChange={(value) => setReplyTo(value as TransferIdentityChoice)} className="gap-2" disabled={submitting}>
                <label className="flex items-start gap-2 rounded-md border border-stone-200 p-2 text-sm">
                  <RadioGroupItem value="target" aria-label="Utiliser le Reply-To du MTA cible" />
                  <span><span className="font-medium">Utiliser le MTA cible</span><br /><span className="text-xs text-stone-500">{preview?.identity.replyTo.targetMta || "Reply-To configuré du MTA cible"}</span></span>
                </label>
                <label className="flex items-start gap-2 rounded-md border border-stone-200 p-2 text-sm">
                  <RadioGroupItem value="custom" aria-label="Conserver le Reply-To actuel" />
                  <span><span className="font-medium">Conserver la valeur actuelle</span><br /><span className="text-xs text-stone-500">{preview?.identity.replyTo.current || "Valeur actuelle de la campagne"}</span></span>
                </label>
                <label className="flex items-start gap-2 rounded-md border border-stone-200 p-2 text-sm">
                  <RadioGroupItem value="empty" aria-label="Conserver un Reply-To vide" />
                  <span><span className="font-medium">Laisser vide</span><br /><span className="text-xs text-stone-500">Conserve le repli configuré par la campagne.</span></span>
                </label>
              </RadioGroup>
            </fieldset>

            {loading && (
              <div className="space-y-2" role="status">
                <p className="text-sm text-stone-600">Préparation du récapitulatif…</p>
                <Progress value={35} aria-label="Chargement du récapitulatif" />
              </div>
            )}
            {submitting && (
              <div className="space-y-2" role="status">
                <p className="text-sm text-stone-600">Transfert et validation des images…</p>
                <Progress value={70} aria-label="Transfert en cours" />
              </div>
            )}
            {previewError && (
              <p role="alert" className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
                {previewError}
              </p>
            )}
          </div>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={submitting} data-testid="campaign-transfer-cancel">
            Annuler
          </Button>
          <Button
            type="button"
            onClick={() => onConfirm({ name: name.trim(), from, replyTo })}
            disabled={!canConfirm || submitting || Boolean(preview?.images.unsupported.length)}
            className="gap-2 bg-stone-900"
            data-testid="campaign-transfer-confirm"
          >
            {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
            {submitting ? "Transfert en cours…" : "Confirmer le transfert"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}