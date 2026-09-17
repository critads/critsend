import {
  campaignCalendarColumnId,
  UNIDENTIFIED_MTA_COLUMN_ID,
  type CalendarCampaignRecord,
} from "./campaign-calendar";
import type {
  CampaignMtaTransferPreview,
  CampaignMtaTransferRequest,
} from "@shared/campaign-mta-transfer";

export type TransferApiRequester = (
  method: string,
  url: string,
  data?: unknown,
) => Promise<Response>;

export type TransferDialogValues = {
  name: string;
  from: "target" | "custom" | "empty";
  replyTo: "target" | "custom" | "empty";
};

export async function previewCampaignMtaTransfer(
  request: TransferApiRequester,
  campaignId: string,
  targetMtaId: string,
): Promise<CampaignMtaTransferPreview> {
  const response = await request(
    "POST",
    `/api/campaigns/${encodeURIComponent(campaignId)}/mta-transfer/preview`,
    { targetMtaId },
  );
  return response.json() as Promise<CampaignMtaTransferPreview>;
}

export async function commitCampaignMtaTransfer(
  request: TransferApiRequester,
  campaignId: string,
  targetMtaId: string,
  preview: CampaignMtaTransferPreview,
  values: TransferDialogValues,
): Promise<Response> {
  const payload: CampaignMtaTransferRequest & { name?: string } = {
    targetMtaId,
    expectedRevision: preview.revision,
    identity: {
      from: values.from === "empty" ? "custom" : values.from,
      replyTo: values.replyTo,
    },
    // The confirmation action is the explicit acknowledgement required for
    // manual names. This must remain true even when the operator restores the
    // proposed/current name before submitting.
    acceptName: true,
    name: values.name,
  };
  return request(
    "POST",
    `/api/campaigns/${encodeURIComponent(campaignId)}/mta-transfer`,
    payload,
  );
}

/**
 * A transfer is never allowed to target the synthetic unknown-MTA column.
 * Keeping this decision in one pure function also makes drag/drop behavior
 * testable without a browser and prevents menu and DnD paths diverging.
 */
export function isCrossMtaDrop(
  campaign: Pick<CalendarCampaignRecord, "mtaId" | "status">,
  targetMtaId: string,
  knownMtaIds: ReadonlySet<string>,
): boolean {
  return (
    campaign.status === "scheduled" &&
    targetMtaId !== UNIDENTIFIED_MTA_COLUMN_ID &&
    campaignCalendarColumnId(campaign, knownMtaIds) !== targetMtaId
  );
}

export function createTransferSubmitGate() {
  let inFlight = false;
  return {
    get pending() {
      return inFlight;
    },
    async run<T>(operation: () => Promise<T>): Promise<T | undefined> {
      if (inFlight) return undefined;
      inFlight = true;
      try {
        return await operation();
      } finally {
        inFlight = false;
      }
    },
  };
}

export function transferFailureMessage(error: unknown): string {
  const message =
    typeof error === "object" &&
    error !== null &&
    "body" in error &&
    typeof (error as { body?: unknown }).body === "object" &&
    (error as { body?: { error?: unknown } }).body?.error
      ? String((error as { body: { error: unknown } }).body.error)
      : "Le résultat du transfert est incertain.";
  return `${message} Rechargez le calendrier avant de réessayer.`;
}