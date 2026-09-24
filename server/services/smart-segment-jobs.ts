// Task #304 — step 6: tracked asynchronous analysis job.
//
// One row per analysis in smart_segment_analyses (parameters, evidence,
// validated proposal, provenance, created segments). The job runs in-process:
// the route returns immediately and the wizard polls.
//
// Production runs several web instances (PM2 cluster), so every decision is
// taken in the database, never from process memory:
//   - admission (reuse of an identical fresh analysis, the concurrency cap) is
//     serialised by a transaction-scoped advisory lock;
//   - a running analysis proves it is alive with a heartbeat; rows whose
//     heartbeat went stale (crashed / restarted instance) are failed by a
//     periodic janitor on any instance;
//   - final status writes are guarded on status = 'running' so a swept row is
//     never resurrected by a late finish.
import crypto from "crypto";
import os from "os";
import type { PoolClient } from "pg";
import { pool } from "../db";
import { logger } from "../logger";
import type { SegmentRulesV2 } from "@shared/schema";
import {
  formatSmartSegmentName,
  type SmartSegmentAnalysisRequest,
  type SmartSegmentAnalysisView,
  type SmartSegmentCreatedSegment,
  type SmartSegmentEvidence,
  type SmartSegmentMaterializeResponse,
  type SmartSegmentProposal,
  type SmartSegmentStage,
  type SmartSegmentStatus,
  smartSegmentAnalysisIdentity,
  smartSegmentEvidenceIdentity,
} from "@shared/smart-segment";
import { getSmartSegmentConfig, SMART_SEGMENT_PROMPT_VERSION, type SmartSegmentConfig } from "../config/smart-segment";
import { resolveSmartSegmentBrand } from "./smart-segment-brand";
import { validateSimilarRefs, withSimilarRefs } from "./smart-segment-similar";
import {
  buildSmartSegmentEvidence,
  createTransactionRunner,
  measureAudienceWith,
  reuseSmartSegmentEvidence,
  SmartSegmentError,
} from "./smart-segment-evidence";
import { defaultModelCaller, generateSmartSegmentProposal, type ModelCaller } from "./smart-segment-proposal";
import type { AudienceMeasure } from "./smart-segment-projection";
import { extractCampaignBrand } from "./tag-suggestions";

type AnalysisRow = {
  id: string;
  fingerprint: string;
  status: SmartSegmentStatus;
  stage: SmartSegmentStage;
  progress: number;
  error: string | null;
  error_code: string | null;
  params: SmartSegmentAnalysisRequest;
  evidence: SmartSegmentEvidence | null;
  proposal: SmartSegmentProposal | null;
  created_segments: SmartSegmentCreatedSegment[] | null;
  created_at: Date | string;
  finished_at: Date | string | null;
};

const ROW_COLUMNS = `id, fingerprint, status, stage, progress, error, error_code, params, evidence, proposal,
  created_segments, created_at, finished_at`;

/** Identifies this process in the owner column (diagnostics only). */
export const SMART_SEGMENT_OWNER = `${os.hostname()}:${process.env.NODE_APP_INSTANCE ?? "x"}:${process.pid}`;
/** A live analysis refreshes heartbeat_at this often. */
export const HEARTBEAT_INTERVAL_MS = 10_000;
/** Queued/running rows older than this without a heartbeat are considered dead. */
export const STALE_HEARTBEAT_MS = 60_000;
/** Period of the janitor that fails dead rows (any instance may do it). */
export const JANITOR_INTERVAL_MS = 30_000;

const running = new Map<string, Promise<void>>();

export type JobDeps = {
  config?: SmartSegmentConfig;
  callModel?: ModelCaller;
  now?: () => Date;
};

export function analysisFingerprint(params: SmartSegmentAnalysisRequest): string {
  return crypto.createHash("sha256").update(smartSegmentAnalysisIdentity(params)).digest("hex");
}

function toView(row: AnalysisRow, reused: boolean): SmartSegmentAnalysisView {
  const created = Array.isArray(row.created_segments) ? row.created_segments : [];
  return {
    id: row.id,
    status: row.status,
    stage: row.stage,
    progress: Number(row.progress) || 0,
    error: row.error,
    errorCode: row.error_code,
    params: row.params,
    evidence: row.evidence,
    proposal: row.proposal,
    createdSegments: created,
    createdSegmentIds: created.map((entry) => entry.id),
    reused,
    createdAt: new Date(row.created_at).toISOString(),
    finishedAt: row.finished_at ? new Date(row.finished_at).toISOString() : null,
  };
}

async function fetchRow(id: string): Promise<AnalysisRow | null> {
  const result = await pool.query<AnalysisRow>(`SELECT ${ROW_COLUMNS} FROM smart_segment_analyses WHERE id = $1`, [id]);
  return result.rows[0] ?? null;
}

async function updateProgress(id: string, stage: SmartSegmentStage, progress: number): Promise<void> {
  await pool.query(
    `UPDATE smart_segment_analyses
        SET stage = $2, progress = $3, heartbeat_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND status = 'running'`,
    [id, stage, Math.max(0, Math.min(100, Math.round(progress)))],
  );
}

export async function getSmartSegmentAnalysis(id: string): Promise<SmartSegmentAnalysisView | null> {
  const row = await fetchRow(id);
  return row ? toView(row, false) : null;
}

/** Analyses driven by THIS process (diagnostics; admission is DB-wide). */
export function activeSmartSegmentAnalyses(): number {
  return running.size;
}

/**
 * Fails queued/running rows whose owner stopped heartbeating (crash, restart,
 * frozen instance). Safe to run on every instance, at startup and
 * periodically: a live analysis always has a fresh heartbeat.
 */
export async function sweepStaleSmartSegmentAnalyses(staleMs = STALE_HEARTBEAT_MS): Promise<number> {
  const result = await pool.query(
    `UPDATE smart_segment_analyses
        SET status = 'failed',
            error = COALESCE(error, 'Analyse interrompue (instance arrêtée ou redémarrée) : relancez-la.'),
            error_code = COALESCE(error_code, 'INTERRUPTED'),
            finished_at = COALESCE(finished_at, NOW()),
            updated_at = NOW()
      WHERE status IN ('queued', 'running')
        AND (heartbeat_at IS NULL OR heartbeat_at < NOW() - ($1::int * INTERVAL '1 millisecond'))`,
    [staleMs],
  );
  if (result.rowCount) logger.warn(`[SMART_SEGMENT] ${result.rowCount} analyses without heartbeat marked failed`);
  return result.rowCount ?? 0;
}

let janitor: NodeJS.Timeout | null = null;

/** Starts the periodic stale-row sweep (idempotent, never keeps the process alive). */
export function startSmartSegmentJanitor(intervalMs = JANITOR_INTERVAL_MS): void {
  if (janitor) return;
  janitor = setInterval(() => {
    sweepStaleSmartSegmentAnalyses().catch((error) => {
      logger.error("[SMART_SEGMENT] janitor sweep failed", { error: (error as Error)?.message });
    });
  }, intervalMs);
  janitor.unref();
}

export function stopSmartSegmentJanitor(): void {
  if (janitor) clearInterval(janitor);
  janitor = null;
}

async function measureAudienceIsolated(rules: SegmentRulesV2, config: SmartSegmentConfig): Promise<AudienceMeasure> {
  const transaction = createTransactionRunner(config);
  await transaction.open();
  try {
    return await measureAudienceWith(transaction.runner, rules);
  } finally {
    await transaction.close();
  }
}

/**
 * Most recent dossier of the same evidence identity, built within the reuse
 * window by another analysis (whatever its final status: a dossier is only
 * persisted once complete). Older rows carry no evidenceKey and never match.
 */
async function findReusableEvidence(evidenceKey: string, excludeId: string, config: SmartSegmentConfig): Promise<{ id: string; evidence: SmartSegmentEvidence } | null> {
  if (config.evidenceReuseWindowMs <= 0) return null;
  const result = await pool.query<{ id: string; evidence: SmartSegmentEvidence }>(
    `SELECT id, evidence FROM smart_segment_analyses
      WHERE evidence IS NOT NULL
        AND evidence->>'evidenceKey' = $1
        AND evidence->>'reusedFrom' IS NULL
        AND created_at >= NOW() - ($2::int * INTERVAL '1 millisecond')
        AND id <> $3
      ORDER BY created_at DESC
      LIMIT 1`,
    [evidenceKey, config.evidenceReuseWindowMs, excludeId],
  );
  const row = result.rows[0];
  return row?.evidence ? { id: row.id, evidence: row.evidence } : null;
}

function startHeartbeat(id: string): () => void {
  const timer = setInterval(() => {
    pool.query(
      `UPDATE smart_segment_analyses SET heartbeat_at = NOW() WHERE id = $1 AND status IN ('queued', 'running')`,
      [id],
    ).catch((error) => logger.warn("[SMART_SEGMENT] heartbeat failed", { id, error: (error as Error)?.message }));
  }, HEARTBEAT_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}

async function runAnalysis(id: string, params: SmartSegmentAnalysisRequest, deps: JobDeps): Promise<void> {
  const config = deps.config ?? getSmartSegmentConfig();
  const startedAt = Date.now();
  const stopHeartbeat = startHeartbeat(id);
  try {
    const claimed = await pool.query(
      `UPDATE smart_segment_analyses
          SET status = 'running', started_at = NOW(), heartbeat_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND status = 'queued'`,
      [id],
    );
    if (!claimed.rowCount) {
      logger.warn("[SMART_SEGMENT] analysis no longer queued at start; skipped", { id });
      return;
    }
    const resolved = await resolveSmartSegmentBrand({ campaignName: params.campaignName, brandOverride: params.brandOverride ?? null });
    // Selection already validated at start; re-validated here so a persisted
    // row can never smuggle the brand's own refs into the « similar » pool.
    const brand = withSimilarRefs(resolved, validateSimilarRefs(params.similarRefs, resolved).similarRefs);
    const evidenceInput = { campaignName: params.campaignName, excludeCampaignId: params.campaignId ?? null, brand, family: params.family, mtaId: params.mtaId ?? null };
    // Param-only re-runs (target / cap) reuse a fresh dossier of the same
    // evidence identity instead of scanning the calibration sends again;
    // « Actualiser » (refresh) always rebuilds.
    const evidenceKey = smartSegmentEvidenceIdentity(params);
    const reusable = params.refresh ? null : await findReusableEvidence(evidenceKey, id, config);
    let evidence: SmartSegmentEvidence;
    if (reusable) {
      await updateProgress(id, "reservoirs", 70);
      evidence = await reuseSmartSegmentEvidence(reusable.evidence, { analysisId: reusable.id }, evidenceInput, { config });
      logger.info("[SMART_SEGMENT] evidence reused", { id, from: reusable.id });
    } else {
      const built = await buildSmartSegmentEvidence(evidenceInput, (stage, progress) => updateProgress(id, stage, progress), { config });
      evidence = { ...built, evidenceKey };
    }
    await pool.query(
      `UPDATE smart_segment_analyses
          SET evidence = $2::jsonb, stage = 'ai_proposal', progress = 80, heartbeat_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND status = 'running'`,
      [id, JSON.stringify(evidence)],
    );
    const callModel = deps.callModel ?? defaultModelCaller(config);
    const proposal = await generateSmartSegmentProposal(
      evidence,
      params,
      { callModel, measureAudience: (rules) => measureAudienceIsolated(rules, config) },
      { model: config.model, onValidation: () => updateProgress(id, "validation", 90) },
    );
    const finished = await pool.query(
      `UPDATE smart_segment_analyses
          SET status = 'succeeded', stage = 'done', progress = 100, proposal = $2::jsonb,
              model = $3, prompt_version = $4, token_usage = $5::jsonb, finished_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND status = 'running'`,
      [id, JSON.stringify(proposal), proposal.model, proposal.promptVersion, proposal.tokenUsage ? JSON.stringify(proposal.tokenUsage) : null],
    );
    if (!finished.rowCount) {
      // Swept as stale (e.g. a frozen event loop) while we were finishing: the
      // wizard already saw a failure; do not overwrite it.
      logger.warn("[SMART_SEGMENT] analysis finished after being marked stale; result discarded", { id, elapsedMs: Date.now() - startedAt });
      return;
    }
    logger.info("[SMART_SEGMENT] analysis succeeded", {
      id,
      elapsedMs: Date.now() - startedAt,
      evidenceMs: evidence.budget.elapsedMs,
      queries: evidence.budget.queries,
      calibration: evidence.calibrationLevel,
      attempts: proposal.attempts,
      tokens: proposal.tokenUsage,
    });
  } catch (error) {
    const code = error instanceof SmartSegmentError ? error.code : "ANALYSIS_FAILED";
    const message = error instanceof SmartSegmentError
      ? error.message
      : `Analyse en échec : ${(error as Error)?.message ?? String(error)}`;
    logger.error("[SMART_SEGMENT] analysis failed", { id, code, message: message.slice(0, 500), elapsedMs: Date.now() - startedAt });
    await pool.query(
      `UPDATE smart_segment_analyses
          SET status = 'failed', error = $2, error_code = $3, finished_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND status = 'running'`,
      [id, message.slice(0, 2000), code.slice(0, 64)],
    ).catch((persistError) => logger.error("[SMART_SEGMENT] failed to persist analysis failure", { id, error: (persistError as Error)?.message }));
  } finally {
    stopHeartbeat();
  }
}

export async function startSmartSegmentAnalysis(
  params: SmartSegmentAnalysisRequest,
  userId: string | null,
  deps: JobDeps = {},
): Promise<{ view: SmartSegmentAnalysisView; created: boolean }> {
  const config = deps.config ?? getSmartSegmentConfig();
  if (!config.apiKey && !deps.callModel) {
    throw new SmartSegmentError("SMART_SEGMENT_NOT_CONFIGURED", "Smart segment indisponible : ANTHROPIC_API_KEY n'est pas configurée sur le serveur.", 503);
  }
  // The brand must be known before anything runs: without its refs there are
  // no brand blocks and no unsubscribe-tag exclusions, so the guardrails of
  // the proposal would be silently weaker. The wizard asks for a manual
  // name + ref when detection fails; the server does not trust the UI.
  const brand = await resolveSmartSegmentBrand({ campaignName: params.campaignName, brandOverride: params.brandOverride ?? null });
  if (!brand.detected) {
    throw new SmartSegmentError(
      "BRAND_UNRESOLVED",
      "Marque non reconnue dans le nom de campagne : indiquez le nom de la marque et sa ref principale avant d'analyser.",
      422,
    );
  }
  const similar = validateSimilarRefs(params.similarRefs, brand);
  if (similar.rejected.length) {
    throw new SmartSegmentError(
      "SIMILAR_REFS_INVALID",
      `Refs de marques similaires refusées : ${similar.rejected.join(", ")} (refs de la marque elle-même, DEL ou ref robot).`,
      422,
    );
  }
  const fingerprint = analysisFingerprint(params);
  const client = await pool.connect();
  let row: AnalysisRow | undefined;
  try {
    await client.query("BEGIN");
    // Serialises admission across every web instance (transaction-scoped:
    // released at COMMIT/ROLLBACK, PgBouncer-safe).
    await client.query("SELECT pg_advisory_xact_lock(hashtext('smart_segment_analyses_start'))");
    if (!params.refresh) {
      const recent = await client.query<AnalysisRow>(
        `SELECT ${ROW_COLUMNS} FROM smart_segment_analyses
          WHERE fingerprint = $1
            AND created_at >= NOW() - ($2::int * INTERVAL '1 millisecond')
            AND ((status = 'succeeded' AND proposal->>'promptVersion' = $4)
                 OR (status IN ('queued', 'running')
                     AND heartbeat_at >= NOW() - ($3::int * INTERVAL '1 millisecond')))
          ORDER BY created_at DESC
          LIMIT 1`,
        [fingerprint, config.reuseWindowMs, STALE_HEARTBEAT_MS, SMART_SEGMENT_PROMPT_VERSION],
      );
      if (recent.rows[0]) {
        await client.query("COMMIT");
        return { view: toView(recent.rows[0], true), created: false };
      }
    }
    const live = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM smart_segment_analyses
        WHERE status IN ('queued', 'running')
          AND heartbeat_at >= NOW() - ($1::int * INTERVAL '1 millisecond')`,
      [STALE_HEARTBEAT_MS],
    );
    if (Number(live.rows[0]?.count ?? 0) >= config.maxConcurrent) {
      await client.query("ROLLBACK");
      throw new SmartSegmentError("SMART_SEGMENT_BUSY", `${config.maxConcurrent} analyses sont déjà en cours. Réessayez dans quelques minutes.`, 409);
    }
    const inserted = await client.query<AnalysisRow>(
      `INSERT INTO smart_segment_analyses (fingerprint, status, stage, progress, params, created_by, owner, heartbeat_at)
       VALUES ($1, 'queued', 'brand_history', 0, $2::jsonb, $3, $4, NOW())
       RETURNING ${ROW_COLUMNS}`,
      [fingerprint, JSON.stringify({ ...params, refresh: undefined }), userId, SMART_SEGMENT_OWNER],
    );
    row = inserted.rows[0];
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  if (!row) throw new SmartSegmentError("ANALYSIS_FAILED", "L'analyse n'a pas pu être enregistrée.", 500);
  const created = row;
  const view = toView(created, false);
  const job = runAnalysis(created.id, params, deps).finally(() => running.delete(created.id));
  running.set(created.id, job);
  return { view, created: true };
}

/** Test/ops helper: resolves when the given analysis finishes in this process. */
export function waitForSmartSegmentAnalysis(id: string): Promise<void> {
  return running.get(id) ?? Promise.resolve();
}

function brandLabelFor(params: SmartSegmentAnalysisRequest, evidence: SmartSegmentEvidence | null): string {
  const fromEvidence = evidence?.brand.brandName?.trim();
  if (fromEvidence) return fromEvidence;
  const fromName = extractCampaignBrand(params.campaignName)?.label?.trim();
  return (fromName || params.campaignName.trim()).slice(0, 60);
}

/**
 * Attaches ONE segment of an analysis to a draft, exclusively: the other
 * segments created from the same analysis are nested audiences of the same
 * proposal (recommendation ⊂ « with similar brands »), so attaching two of
 * them would double the overlap for nothing — the previous choice is
 * detached. Returns null when the campaign is not a draft any more (a live
 * audience is never changed here).
 */
async function attachExclusively(
  client: PoolClient,
  campaignId: string,
  segmentId: string,
  siblings: SmartSegmentCreatedSegment[],
): Promise<{ detachedSegmentIds: string[] } | null> {
  // Row lock: the campaign cannot leave 'draft' while positions change.
  const campaign = await client.query<{ id: string; status: string }>(
    `SELECT id, status FROM campaigns WHERE id = $1 FOR UPDATE`,
    [campaignId],
  );
  if (!campaign.rows[0] || campaign.rows[0].status !== "draft") return null;
  const siblingIds = siblings.map((entry) => entry.id).filter((other) => other !== segmentId);
  const detached = siblingIds.length
    ? await client.query<{ segment_id: string }>(
      `DELETE FROM campaign_segments WHERE campaign_id = $1 AND segment_id = ANY($2::varchar[]) RETURNING segment_id`,
      [campaignId, siblingIds],
    )
    : null;
  const positions = await client.query<{ next: string }>(
    `SELECT COALESCE(MAX(position) + 1, 0)::text AS next FROM campaign_segments WHERE campaign_id = $1`,
    [campaignId],
  );
  await client.query(
    `INSERT INTO campaign_segments (campaign_id, segment_id, position)
     VALUES ($1, $2, $3)
     ON CONFLICT (campaign_id, segment_id) DO NOTHING`,
    [campaignId, segmentId, Number(positions.rows[0]?.next ?? 0)],
  );
  // The legacy single-segment column mirrors position 0 of the relation for
  // older readers; recomputed because the detached segment may have held it.
  await client.query(
    `UPDATE campaigns
        SET segment_id = (SELECT cs.segment_id FROM campaign_segments cs WHERE cs.campaign_id = $1 ORDER BY cs.position ASC LIMIT 1)
      WHERE id = $1`,
    [campaignId],
  );
  return { detachedSegmentIds: detached?.rows.map((row) => row.segment_id) ?? [] };
}

/**
 * Creates the segments of a validated proposal and, for an existing draft,
 * attaches the chosen one — all in ONE short transaction: the analysis row is
 * locked so two clicks (or two instances) cannot create the same proposal
 * twice, and the campaign is locked so it cannot start sending between the
 * status check and the attach. The segments are never left half-created.
 *
 * `attach` (default: true for a single index, false otherwise) binds at most
 * one proposal to the campaign; the other segments of the same analysis are
 * detached from it, since the proposals are nested audiences.
 */
export async function materializeSmartSegmentProposal(
  id: string,
  input: { campaignId?: string | null; proposalIndexes?: number[]; attach?: boolean },
  deps: { now?: () => Date } = {},
): Promise<SmartSegmentMaterializeResponse> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query<AnalysisRow>(
      `SELECT ${ROW_COLUMNS} FROM smart_segment_analyses WHERE id = $1 FOR UPDATE`,
      [id],
    );
    const row = locked.rows[0];
    if (!row) throw new SmartSegmentError("NOT_FOUND", "Analyse introuvable.", 404);
    if (row.status !== "succeeded" || !row.proposal) {
      throw new SmartSegmentError("NOT_READY", "L'analyse n'a pas de proposition validée à matérialiser.", 409);
    }
    const analysedCampaignId = row.params.campaignId ?? null;
    const requestedCampaignId = input.campaignId ?? null;
    if (analysedCampaignId && requestedCampaignId && analysedCampaignId !== requestedCampaignId) {
      // The exclusions were computed for another campaign (its own sends were
      // excluded from the history); attaching elsewhere would be wrong.
      throw new SmartSegmentError("CAMPAIGN_MISMATCH", "Cette analyse a été faite pour une autre campagne : relancez-la depuis la campagne courante.", 409);
    }
    // Direct attachment is strict: only an analysis computed FOR this very
    // campaign may be bound to it here. An analysis without campaign (draft
    // not saved yet) still produces the segments, but the wizard attaches
    // them through its own save path (attached: false) — nothing binds an
    // unbound analysis to whatever draft happens to be supplied.
    const bindable = analysedCampaignId !== null && analysedCampaignId === requestedCampaignId;
    const proposal = row.proposal;
    const requested = (input.proposalIndexes?.length ? input.proposalIndexes : proposal.segments.map((_, index) => index))
      .filter((index, position, all) => Number.isInteger(index) && index >= 0 && index < proposal.segments.length && all.indexOf(index) === position);
    if (!requested.length) throw new SmartSegmentError("BAD_INDEX", "Indice de proposition invalide.", 400);
    const attach = input.attach ?? requested.length === 1;
    if (attach && requested.length > 1) {
      throw new SmartSegmentError("ATTACH_ONE", "Une seule proposition peut être attachée à la campagne : les propositions d'une même analyse sont des audiences imbriquées.", 400);
    }

    const existing: SmartSegmentCreatedSegment[] = Array.isArray(row.created_segments) ? [...row.created_segments] : [];
    const created: SmartSegmentCreatedSegment[] = [];
    const now = deps.now ? deps.now() : new Date();
    const brandLabel = brandLabelFor(row.params, row.evidence);
    let changed = false;
    for (const index of requested) {
      const already = existing.find((entry) => entry.index === index);
      if (already) {
        created.push(already);
        continue;
      }
      const segmentProposal = proposal.segments[index];
      const baseName = formatSmartSegmentName(brandLabel, row.params.family, now);
      // The « with similar brands » proposal is named after its role so the
      // operator tells it apart from the recommendation in the segment list.
      const suffix = segmentProposal.kind === "similar_brands"
        ? "marques similaires"
        : requested.length > 1 || index > 0 ? String(index + 1) : null;
      const name = (suffix ? `${baseName} · ${suffix}` : baseName).slice(0, 200);
      const description = [
        segmentProposal.rationale,
        "",
        `Proposition Smart segment (${proposal.model}, ${proposal.promptVersion}) — analyse ${row.id}.`,
        `Projection : ${segmentProposal.projectedClicks.low.toLocaleString("fr-FR")} – ${segmentProposal.projectedClicks.high.toLocaleString("fr-FR")} clics humains, plaintes ≈ ${(segmentProposal.projectedComplaintRate * 100).toFixed(3)} %.`,
        proposal.disclaimer,
      ].join("\n").slice(0, 1000);
      const inserted = await client.query<{ id: string; name: string }>(
        `INSERT INTO segments (name, description, rules, cached_count)
         VALUES ($1, $2, $3::jsonb, $4)
         RETURNING id, name`,
        [name, description, JSON.stringify(segmentProposal.rules), segmentProposal.audienceCount],
      );
      const entry = { index, id: inserted.rows[0].id, name: inserted.rows[0].name };
      existing.push(entry);
      created.push(entry);
      changed = true;
    }
    if (changed) {
      await client.query(
        `UPDATE smart_segment_analyses SET created_segments = $2::jsonb, updated_at = NOW() WHERE id = $1`,
        [id, JSON.stringify(existing.sort((a, b) => a.index - b.index))],
      );
    }
    // Server-side attach only for an existing draft: appending positions to a
    // campaign that is sending would change a live audience. Other cases are
    // attached by the wizard through its normal save path.
    const attachment = attach && bindable ? await attachExclusively(client, analysedCampaignId, created[0].id, existing) : null;
    await client.query("COMMIT");
    return {
      segments: created,
      attached: attachment !== null,
      createdSegmentIds: created.map((entry) => entry.id),
      detachedSegmentIds: attachment?.detachedSegmentIds ?? [],
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (error instanceof SmartSegmentError) throw error;
    logger.error("[SMART_SEGMENT] materialize failed", { id, campaignId: input.campaignId ?? null, error: (error as Error)?.message });
    throw new SmartSegmentError("MATERIALIZE_FAILED", `Création des segments annulée : ${(error as Error)?.message}`, 500);
  } finally {
    client.release();
  }
}
