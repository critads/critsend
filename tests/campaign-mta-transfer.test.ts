import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile, access } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { campaignMtaTransferRequestSchema } from "@shared/campaign-mta-transfer";
import { proposeCampaignName, validateTargetMta } from "../server/services/campaign-mta-transfer";
import { cleanupPreparedTransferFiles, inspectCampaignMtaTransferImages } from "../server/services/campaign-mta-transfer-images";
import { mapWithConcurrency } from "../server/utils";

const mta = (name: string, hostname = `${name.toLowerCase()}.example`) => ({
  id: name,
  name,
  hostname,
  port: 587,
  username: "u",
  password: "p",
  trackingDomain: "https://track.example",
  openTrackingDomain: "https://open.example",
  imageHostingDomain: "https://images.example",
  fromName: name,
  fromEmail: `sender@${hostname}`,
  isActive: true,
  mode: "real",
  protocol: "STARTTLS",
});

describe("campaign MTA transfer contract", () => {
  it("keeps identifiers opaque and validates guarded decisions", () => {
    const parsed = campaignMtaTransferRequestSchema.parse({
      targetMtaId: "legacy.mta/opaque",
      expectedRevision: "a".repeat(64),
      identity: { from: "custom", replyTo: "empty" },
    });
    expect(parsed.targetMtaId).toBe("legacy.mta/opaque");
    expect(parsed.identity?.replyTo).toBe("empty");
  });

  it("only replaces a recognized final MTA suffix", () => {
    const source = mta("Alpha", "smtp.alpha.example");
    const target = mta("Beta", "smtp.beta.example");
    expect(proposeCampaignName("Brand - Alpha", source, target)).toMatchObject({
      proposed: "Brand - Beta",
      managedSuffix: true,
      requiresConfirmation: false,
    });
    expect(proposeCampaignName("Brand - ABC42", source, target)).toMatchObject({
      proposed: "Brand - ABC42 - Beta",
      managedSuffix: false,
      requiresConfirmation: true,
    });
    expect(proposeCampaignName("Brand - Alpha", source, target).proposed).not.toContain("Alpha - Beta -");
    expect(proposeCampaignName("Brand - Alpha Promo", source, target)).toMatchObject({
      managedSuffix: false,
      requiresConfirmation: true,
    });
    expect(proposeCampaignName("Brand - Alpha", source, { ...target, name: "T".repeat(500) }).proposed.length).toBeLessThanOrEqual(200);
  });

  it("rejects unsupported srcset and CSS instead of partial success", () => {
    expect(inspectCampaignMtaTransferImages(
      '<img src="https://cdn.example/a.png" srcset="https://cdn.example/a@2x.png 2x"><style>.x{background:url(https://cdn.example/x.png)}</style>',
    ).unsupported).toEqual(expect.arrayContaining(["img[srcset]", "CSS url()"]));
  });

  it("only treats absolute managed paths on the trusted source image origin as managed", () => {
    const html = [
      '<img src="https://source.example/campaigns/2026/01/a/x.png">',
      '<img src="https://attacker.example/campaigns/2026/01/a/x.png">',
      '<img src="/campaigns/2026/01/a/local.png">',
    ].join("");
    expect(inspectCampaignMtaTransferImages(html, "https://source.example")).toMatchObject({
      managedCount: 2,
      externalCount: 1,
    });
  });

  it("uses trackingDomain as the effective open-tracking domain", () => {
    const target = { ...mta("Beta"), openTrackingDomain: null };
    const campaign = {
      trackClicks: false,
      trackOpens: true,
      htmlContent: "<p>hello</p>",
    } as any;
    expect(() => validateTargetMta(target, campaign)).not.toThrow();
    expect(() => validateTargetMta({ ...target, trackingDomain: null }, campaign)).toThrow(/open-tracking/i);
  });

  it("cleans only this attempt's files after partial preparation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mta-transfer-test-"));
    const source = join(dir, "source.png");
    const prepared = join(dir, "mta-transfer-new.png");
    await writeFile(source, "source");
    await writeFile(prepared, "prepared");
    await cleanupPreparedTransferFiles([prepared]);
    await expect(access(source)).resolves.toBeUndefined();
    await expect(access(prepared)).rejects.toThrow();
  });

  it("waits for sibling workers before surfacing a preparation failure", async () => {
    let siblingFinished = false;
    await expect(mapWithConcurrency([0, 1], 2, async (item) => {
      if (item === 0) throw new Error("first download failed");
      await new Promise((resolve) => setTimeout(resolve, 15));
      siblingFinished = true;
      return item;
    })).rejects.toThrow("first download failed");
    expect(siblingFinished).toBe(true);
  });
});