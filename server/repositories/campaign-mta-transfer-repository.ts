import crypto from "crypto";
import { pool } from "../db";

export type TransferMtaSnapshot = {
  id: string;
  name: string;
  hostname: string | null;
  port: number;
  username: string | null;
  password: string | null;
  trackingDomain: string | null;
  openTrackingDomain: string | null;
  imageHostingDomain: string | null;
  fromName: string;
  fromEmail: string;
  isActive: boolean;
  mode: string;
  protocol: string;
};

export type TransferCampaignSnapshot = {
  id: string;
  userId: string | null;
  name: string;
  mtaId: string | null;
  fromName: string;
  fromEmail: string;
  replyEmail: string | null;
  subject: string;
  preheader: string | null;
  htmlContent: string;
  trackClicks: boolean;
  trackOpens: boolean;
  unsubscribeText: string | null;
  companyAddress: string | null;
  sendingSpeed: string;
  scheduledAt: Date;
  status: string;
  startedAt: Date | null;
  firstSendAt: Date | null;
  sentCount: number;
  pendingCount: number;
  failedCount: number;
  createdAt: Date;
  sourceMta: TransferMtaSnapshot | null;
  targetMta: TransferMtaSnapshot | null;
  revision: string;
};

const CAMPAIGN_COLUMNS = `
  c.id, c.user_id, c.name, c.mta_id, c.from_name, c.from_email,
  c.reply_email, c.subject, c.preheader, c.html_content, c.track_clicks,
  c.track_opens, c.unsubscribe_text, c.company_address, c.sending_speed,
  c.scheduled_at, c.status, c.started_at, c.first_send_at, c.sent_count,
  c.pending_count, c.failed_count, c.created_at
`;

const MTA_COLUMNS = `
  id, name, hostname, port, username, password, tracking_domain,
  open_tracking_domain, image_hosting_domain, from_name, from_email,
  is_active, mode, protocol
`;

function mapMta(row: any, prefix = ""): TransferMtaSnapshot | null {
  if (!row?.[`${prefix}id`]) return null;
  return {
    id: row[`${prefix}id`],
    name: row[`${prefix}name`],
    hostname: row[`${prefix}hostname`] ?? null,
    port: Number(row[`${prefix}port`] ?? 587),
    username: row[`${prefix}username`] ?? null,
    password: row[`${prefix}password`] ?? null,
    trackingDomain: row[`${prefix}tracking_domain`] ?? null,
    openTrackingDomain: row[`${prefix}open_tracking_domain`] ?? null,
    imageHostingDomain: row[`${prefix}image_hosting_domain`] ?? null,
    fromName: row[`${prefix}from_name`] ?? "",
    fromEmail: row[`${prefix}from_email`] ?? "",
    isActive: row[`${prefix}is_active`] === true,
    mode: row[`${prefix}mode`] ?? "real",
    protocol: row[`${prefix}protocol`] ?? "STARTTLS",
  };
}

function revisionInput(campaign: Omit<TransferCampaignSnapshot, "revision">): unknown {
  const date = (value: Date | null) => value?.toISOString() ?? null;
  return {
    id: campaign.id,
    userId: campaign.userId,
    name: campaign.name,
    mtaId: campaign.mtaId,
    fromName: campaign.fromName,
    fromEmail: campaign.fromEmail,
    replyEmail: campaign.replyEmail,
    subject: campaign.subject,
    preheader: campaign.preheader,
    htmlContent: campaign.htmlContent,
    trackClicks: campaign.trackClicks,
    trackOpens: campaign.trackOpens,
    unsubscribeText: campaign.unsubscribeText,
    companyAddress: campaign.companyAddress,
    sendingSpeed: campaign.sendingSpeed,
    scheduledAt: date(campaign.scheduledAt),
    status: campaign.status,
    startedAt: date(campaign.startedAt),
    firstSendAt: date(campaign.firstSendAt),
    sentCount: campaign.sentCount,
    pendingCount: campaign.pendingCount,
    failedCount: campaign.failedCount,
    createdAt: date(campaign.createdAt),
    sourceMta: campaign.sourceMta,
    targetMta: campaign.targetMta,
  };
}

export function fingerprintTransferSnapshot(campaign: Omit<TransferCampaignSnapshot, "revision">): string {
  return crypto.createHash("sha256").update(JSON.stringify(revisionInput(campaign))).digest("hex");
}

function mapCampaign(row: any, target: TransferMtaSnapshot | null): TransferCampaignSnapshot {
  const campaign = {
    id: row.id,
    userId: row.user_id ?? null,
    name: row.name,
    mtaId: row.mta_id ?? null,
    fromName: row.from_name,
    fromEmail: row.from_email,
    replyEmail: row.reply_email ?? null,
    subject: row.subject,
    preheader: row.preheader ?? null,
    htmlContent: row.html_content,
    trackClicks: row.track_clicks === true,
    trackOpens: row.track_opens === true,
    unsubscribeText: row.unsubscribe_text ?? null,
    companyAddress: row.company_address ?? null,
    sendingSpeed: row.sending_speed,
    scheduledAt: new Date(row.scheduled_at),
    status: row.status,
    startedAt: row.started_at ? new Date(row.started_at) : null,
    firstSendAt: row.first_send_at ? new Date(row.first_send_at) : null,
    sentCount: Number(row.sent_count ?? 0),
    pendingCount: Number(row.pending_count ?? 0),
    failedCount: Number(row.failed_count ?? 0),
    createdAt: new Date(row.created_at),
    sourceMta: mapMta(row, "source_"),
    targetMta: target,
  };
  return { ...campaign, revision: fingerprintTransferSnapshot(campaign) };
}

async function loadTarget(client: { query: Function }, targetMtaId: string, lock: boolean): Promise<TransferMtaSnapshot | null> {
  const result = await client.query(
    `SELECT ${MTA_COLUMNS} FROM mtas WHERE id = $1 ${lock ? "FOR UPDATE" : ""}`,
    [targetMtaId],
  );
  return result.rows[0] ? mapMta(result.rows[0]) : null;
}

async function loadSnapshotWithClient(client: { query: Function }, campaignId: string, targetMtaId: string, lock: boolean): Promise<TransferCampaignSnapshot | null> {
  const result = await client.query(
    `SELECT ${CAMPAIGN_COLUMNS},
       sm.id AS source_id, sm.name AS source_name, sm.hostname AS source_hostname,
       sm.port AS source_port, sm.username AS source_username, sm.password AS source_password,
       sm.tracking_domain AS source_tracking_domain,
       sm.open_tracking_domain AS source_open_tracking_domain,
       sm.image_hosting_domain AS source_image_hosting_domain,
       sm.from_name AS source_from_name, sm.from_email AS source_from_email,
       sm.is_active AS source_is_active, sm.mode AS source_mode, sm.protocol AS source_protocol
     FROM campaigns c
     LEFT JOIN mtas sm ON sm.id = c.mta_id
     WHERE c.id = $1 ${lock ? "FOR UPDATE OF c" : ""}`,
    [campaignId],
  );
  if (!result.rows[0]) return null;
  const target = await loadTarget(client, targetMtaId, lock);
  return mapCampaign(result.rows[0], target);
}

export async function getCampaignMtaTransferSnapshot(campaignId: string, targetMtaId: string): Promise<TransferCampaignSnapshot | null> {
  const client = await pool.connect();
  try {
    return await loadSnapshotWithClient(client, campaignId, targetMtaId, false);
  } finally {
    client.release();
  }
}

export type TransferCommitResult =
  | { ok: true; campaign: TransferCampaignSnapshot }
  | { ok: false; reason: "not_found" | "conflict" | "unsafe_status" | "same_mta" };

/**
 * The transaction locks the campaign row only after image preparation has
 * completed.  The revision comparison is the no-migration CAS/fence: a
 * concurrent edit, schedule move, MTA edit, or scheduled→sending promotion
 * makes the final update fail before any transfer field is published.
 */
export async function commitCampaignMtaTransfer(input: {
  campaignId: string;
  targetMtaId: string;
  expectedRevision: string;
  name: string;
  fromName: string;
  fromEmail: string;
  replyEmail: string | null;
  htmlContent: string;
}): Promise<TransferCommitResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // This transaction only locks a single campaign/MTA row. Downloads happen
    // before BEGIN, so a blocked or wedged database cannot hold the transfer
    // lock indefinitely against the schedule poller.
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query("SET LOCAL statement_timeout = '8s'");
    const current = await loadSnapshotWithClient(client, input.campaignId, input.targetMtaId, true);
    if (!current) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "not_found" };
    }
    if (current.status !== "scheduled" || !current.scheduledAt ||
        !Number.isFinite(current.scheduledAt.getTime()) || current.scheduledAt.getTime() <= Date.now()) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "unsafe_status" };
    }
    const started = await client.query(
      `SELECT EXISTS (SELECT 1 FROM campaign_sends WHERE campaign_id = $1)
          OR EXISTS (SELECT 1 FROM campaign_jobs WHERE campaign_id = $1 AND status = 'processing') AS started`,
      [input.campaignId],
    );
    if (started.rows[0]?.started === true || current.startedAt || current.firstSendAt ||
        current.sentCount > 0 || current.pendingCount > 0 || current.failedCount > 0) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "unsafe_status" };
    }
    if (current.mtaId === input.targetMtaId) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "same_mta" };
    }
    if (current.revision !== input.expectedRevision) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "conflict" };
    }
    const updated = await client.query(
      `UPDATE campaigns
          SET mta_id = $2, name = $3, from_name = $4, from_email = $5,
              reply_email = $6, html_content = $7
        WHERE id = $1 AND status = 'scheduled'
        RETURNING ${CAMPAIGN_COLUMNS.replace(/\bc\./g, "")}`,
      [input.campaignId, input.targetMtaId, input.name, input.fromName, input.fromEmail, input.replyEmail, input.htmlContent],
    );
    if (!updated.rows[0]) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "conflict" };
    }
    await client.query("COMMIT");
    // Reconstruct the response from the locked pre-update row while swapping
    // only fields this transfer owns.  This avoids a second unlocked read.
    const resultRow = { ...updated.rows[0], mta_id: input.targetMtaId, name: input.name, from_name: input.fromName, from_email: input.fromEmail, reply_email: input.replyEmail, html_content: input.htmlContent };
    const responseCampaign = mapCampaign(resultRow, current.targetMta);
    responseCampaign.sourceMta = current.sourceMta;
    responseCampaign.revision = fingerprintTransferSnapshot(responseCampaign);
    return { ok: true, campaign: responseCampaign };
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* preserve original error */ }
    throw error;
  } finally {
    client.release();
  }
}

export async function hasStartedCampaignTraces(campaignId: string): Promise<boolean> {
  const result = await pool.query(
    `SELECT EXISTS (
       SELECT 1 FROM campaign_sends WHERE campaign_id = $1
     ) OR EXISTS (
       SELECT 1 FROM campaign_jobs WHERE campaign_id = $1 AND status = 'processing'
     ) AS started`,
    [campaignId],
  );
  return result.rows[0]?.started === true;
}