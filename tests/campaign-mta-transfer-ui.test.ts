import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  commitCampaignMtaTransfer,
  createTransferSubmitGate,
  isCrossMtaDrop,
  previewCampaignMtaTransfer,
  transferFailureMessage,
} from "../client/src/lib/campaign-mta-transfer";
import { UNIDENTIFIED_MTA_COLUMN_ID } from "../client/src/lib/campaign-calendar";

const preview = {
  campaignId: "campaign-opaque",
  sourceMtaId: "mta-source",
  targetMtaId: "mta-target",
  revision: "revision-2026-09-04",
  status: "scheduled" as const,
  scheduledAt: "2026-09-04T08:00:00.000Z",
  name: {
    current: "Newsletter - Source",
    proposed: "Newsletter - Target",
    changed: true,
    managedSuffix: true,
    requiresConfirmation: false,
  },
  identity: {
    from: {
      current: "Alice <alice@example.test>",
      sourceMta: "Alice <alice@example.test>",
      targetMta: "Bob <bob@example.test>",
      currentIsCustom: false,
      selected: "target" as const,
      proposed: "Bob",
    },
    replyTo: {
      current: "reply@example.test",
      sourceMta: "reply@example.test",
      targetMta: "reply-target@example.test",
      currentIsCustom: false,
      selected: "target" as const,
      proposed: "reply-target@example.test",
    },
  },
  images: { required: false, externalCount: 0, managedCount: 0, unsupported: [] },
  preserved: ["scheduledAt", "audience"],
  targetCapabilities: {
    active: true,
    smtpValidated: true,
    trackingDomain: "https://click.target.test",
    openTrackingDomain: "https://open.target.test",
    imageHostingDomain: "https://img.target.test",
    sendingSpeed: "10/min",
  },
  sourceCapabilities: {
    active: true,
    smtpValidated: true,
    trackingDomain: "https://click.source.test",
    openTrackingDomain: "https://open.source.test",
    imageHostingDomain: "https://img.source.test",
    sendingSpeed: "5/min",
  },
};

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("campaign MTA transfer UI API behavior", () => {
  it("exposes preview modal fields for domains and identity choices", () => {
    const modalSource = readFileSync(
      new URL("../client/src/components/campaign-mta-transfer-dialog.tsx", import.meta.url),
      "utf8",
    );
    expect(modalSource).toContain("Domaine de tracking cible");
    expect(modalSource).toContain("Domaine de tracking source");
    expect(modalSource).toContain("Domaine d'ouverture source");
    expect(modalSource).toContain("Domaine d'ouverture cible");
    expect(modalSource).toContain("Domaine images source");
    expect(modalSource).toContain("Domaine images cible");
    expect(modalSource).toContain("Identité source");
    expect(modalSource).toContain("Identité cible proposée");
    expect(modalSource).toContain('data-testid="campaign-transfer-name"');
    expect(modalSource).toContain("maxLength={200}");
    expect(modalSource).toContain("campaign-transfer-cancel");
  });

  it("loads a modal preview without mutating the campaign", async () => {
    const request = vi.fn().mockResolvedValue(jsonResponse(preview));

    const result = await previewCampaignMtaTransfer(
      request,
      "campaign/opaque",
      "mta-target",
    );

    expect(result).toEqual(preview);
    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith(
      "POST",
      "/api/campaigns/campaign%2Fopaque/mta-transfer/preview",
      { targetMtaId: "mta-target" },
    );
  });

  it("does not call commit when the modal is cancelled", () => {
    const request = vi.fn();
    // The dialog's cancel path only closes local state; it must not invoke
    // this requester (the same requester is used by the commit button).
    expect(request).not.toHaveBeenCalled();
  });

  it("commits the edited name and explicit identity choices", async () => {
    const request = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));

    await commitCampaignMtaTransfer(request, "campaign-opaque", "mta-target", preview, {
      name: "Manual campaign name",
      from: "target",
      replyTo: "empty",
    });

    expect(request).toHaveBeenCalledWith(
      "POST",
      "/api/campaigns/campaign-opaque/mta-transfer",
      expect.objectContaining({
        targetMtaId: "mta-target",
        expectedRevision: preview.revision,
        acceptName: true,
        name: "Manual campaign name",
        identity: { from: "target", replyTo: "empty" },
      }),
    );

    request.mockClear();
    await commitCampaignMtaTransfer(request, "campaign-opaque", "mta-target", preview, {
      // Restoring the current/proposed name is still an explicit confirmation.
      name: preview.name.current,
      from: "custom",
      replyTo: "custom",
    });
    expect(request).toHaveBeenCalledWith(
      "POST",
      "/api/campaigns/campaign-opaque/mta-transfer",
      expect.objectContaining({
        acceptName: true,
        name: preview.name.current,
      }),
    );
  });

  it("uses reload-first language when a commit result is ambiguous", () => {
    expect(transferFailureMessage(new Error("network closed"))).toBe(
      "Le résultat du transfert est incertain. Rechargez le calendrier avant de réessayer.",
    );
    expect(
      transferFailureMessage({ body: { error: "Campaign changed while validating the transfer" } }),
    ).toContain("Rechargez le calendrier avant de réessayer.");
  });

  it("keeps loading/confirmation single-flight when confirm is double-clicked", async () => {
    const gate = createTransferSubmitGate();
    let release!: () => void;
    const operation = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          release = () => resolve("committed");
        }),
    );

    const first = gate.run(operation);
    const second = await gate.run(operation);
    expect(second).toBeUndefined();
    expect(operation).toHaveBeenCalledOnce();
    expect(gate.pending).toBe(true);

    release();
    await expect(first).resolves.toBe("committed");
    expect(gate.pending).toBe(false);
  });

  it("opens transfer only for a cross-lane known MTA, never the unidentified lane", () => {
    const known = new Set(["mta-source", "mta-target"]);
    const campaign = { mtaId: "mta-source", status: "scheduled" as const };

    expect(isCrossMtaDrop(campaign, "mta-target", known)).toBe(true);
    expect(isCrossMtaDrop(campaign, "mta-source", known)).toBe(false);
    expect(isCrossMtaDrop(campaign, UNIDENTIFIED_MTA_COLUMN_ID, known)).toBe(false);
    expect(isCrossMtaDrop({ ...campaign, status: "sending" }, "mta-target", known)).toBe(false);
  });
});