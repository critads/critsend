import { storage } from "../storage";
import {
  sendEmailBatchNullsink,
  precomputeBaseHtml,
  sendEmailWithNullsink,
  closeTransporter,
  verifyTransporter,
  preregisterCampaignLinks,
} from "../email-service";
import { logger } from "../logger";
import {
  campaignReconciliationDiscrepancy,
  finalizeBatchRetryTotal,
  finalizeFallbackTotal,
  finalizeFallbackRowsTotal,
  pressureGuardSenderDeferredRatio,
  pressureGuardSenderThrottledTotal,
} from "../metrics";
import type { InsertNullsinkCapture, Subscriber } from "@shared/schema";
import { jobEvents } from "../job-events";
import { messageQueue } from "../message-queue";
import { classifyDbError, SenderRetriesExhaustedError } from "../db-errors";
import { db } from "../db";
import { sql } from "drizzle-orm";

const MAX_AUTO_RETRIES = 3;
const SENDER_MAX_ATTEMPTS = 3;

// ── Snowball Auto-Throttle (Task #154) ────────────────────────────────
// When 10+ campaigns target overlapping audiences, the main sender keeps
// reserving fresh contacts that are immediately deferred behind their own
// 6h pressure window — faster than the drain worker can evacuate them.
// Constated 2026-05-15: 951k deferred sends, drain at 0/min, 99.6% blocked
// by their own freshly-bumped last_sent_at because the main sender kept
// stamping new windows on the same shared contacts in parallel.
//
// Mitigation: per-campaign auto-throttle. Before each fetch of a new
// audience batch, we compute the ratio
//     deferred_now / (deferred_now + sent + failed)
// using the per-campaign partial index `campaign_sends_pressure_campaign_eligible_idx`
// and the cached `campaigns.{sent_count,failed_count}` counters (no full
// scan). When the ratio exceeds PRESSURE_RATIO_THROTTLE_THRESHOLD AND the
// absolute deferred count exceeds PRESSURE_RATIO_THROTTLE_MIN_DEFERRED,
// the sender sleeps PRESSURE_RATIO_THROTTLE_SLEEP_MS, bumps the
// `pressureGuardSenderThrottledTotal` counter, and `continue`s the loop
// (which re-checks campaign status / heartbeat / shouldStop). The drain
// keeps working in the background; once the ratio recovers below the
// threshold, the sender resumes naturally.
//
// Disable by setting PRESSURE_RATIO_THROTTLE_DISABLED=true (operator
// override for incident debugging or workloads where overlap is impossible).
function envBoolDisabled(name: string): boolean {
  const raw = (process.env[name] || "").toLowerCase().trim();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}
function envFloat(name: string, defaultValue: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return defaultValue;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < min || v > max) return defaultValue;
  return v;
}
function envIntBounded(name: string, defaultValue: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return defaultValue;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < min || v > max) return defaultValue;
  return Math.floor(v);
}
const SNOWBALL_THROTTLE_DISABLED = envBoolDisabled("PRESSURE_RATIO_THROTTLE_DISABLED");
const SNOWBALL_THROTTLE_THRESHOLD = envFloat("PRESSURE_RATIO_THROTTLE_THRESHOLD", 0.5, 0.01, 0.99);
const SNOWBALL_THROTTLE_MIN_DEFERRED = envIntBounded("PRESSURE_RATIO_THROTTLE_MIN_DEFERRED", 1000, 1, 10_000_000);
const SNOWBALL_THROTTLE_SLEEP_MS = envIntBounded("PRESSURE_RATIO_THROTTLE_SLEEP_MS", 30_000, 1_000, 10 * 60_000);

// Exported snapshot for the UI/API (Task #156). Centralised here because
// these are the same values the running sender uses to make throttle
// decisions — exposing them ensures the campaign detail page shows the
// real, currently-configured threshold rather than a hard-coded duplicate
// that could drift from the sender behaviour.
export const SNOWBALL_THROTTLE_CONFIG = {
  disabled: SNOWBALL_THROTTLE_DISABLED,
  threshold: SNOWBALL_THROTTLE_THRESHOLD,
  minDeferred: SNOWBALL_THROTTLE_MIN_DEFERRED,
  sleepMs: SNOWBALL_THROTTLE_SLEEP_MS,
} as const;

async function retryDbOp<T>(fn: () => Promise<T>, label: string, maxAttempts = SENDER_MAX_ATTEMPTS): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      const classified = classifyDbError(err);
      if (!classified.transient || attempt >= maxAttempts) {
        if (classified.transient) {
          throw new SenderRetriesExhaustedError(err, classified, attempt);
        }
        throw err;
      }
      const delay = Math.pow(2, attempt - 1) * 1000;
      logger.warn(`${label} DB operation failed (attempt ${attempt}/${maxAttempts}, kind=${classified.kind}, code=${classified.code ?? 'n/a'}), retrying in ${delay}ms: ${classified.message}`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error('Unreachable');
}

const FALLBACK_CONCURRENCY = 5;
const BATCH_TIERS = [500, 100, 25];

async function tieredFinalizeFallback(
  campaignId: string,
  successBatch: string[],
  failedBatch: string[],
  logPrefix: string,
  initialError: Error,
): Promise<void> {
  let remaining = [
    ...successBatch.map(id => ({ id, success: true })),
    ...failedBatch.map(id => ({ id, success: false })),
  ];
  const originalTotal = remaining.length;

  for (let tierIdx = 0; tierIdx < BATCH_TIERS.length; tierIdx++) {
    const batchSize = BATCH_TIERS[tierIdx];
    if (batchSize >= remaining.length) continue;

    const level = String(tierIdx + 1);
    finalizeBatchRetryTotal.inc({ level });
    logger.warn(`${logPrefix} Tiered retry level ${level}: splitting ${remaining.length} rows into batches of ${batchSize} (original error: ${initialError.message})`);

    const stillPending: typeof remaining = [];
    let tierFailed = false;

    for (let i = 0; i < remaining.length; i += batchSize) {
      const chunk = remaining.slice(i, i + batchSize);
      const chunkSuccess = chunk.filter(c => c.success).map(c => c.id);
      const chunkFailed = chunk.filter(c => !c.success).map(c => c.id);
      try {
        await storage.bulkFinalizeSends(campaignId, chunkSuccess, chunkFailed);
      } catch (err: any) {
        tierFailed = true;
        stillPending.push(...chunk);
        logger.warn(`${logPrefix} Tiered retry level ${level} chunk failed (offset ${i}, size ${chunk.length}): ${err.message}`);
      }
    }

    if (!tierFailed) {
      logger.info(`${logPrefix} Tiered retry level ${level} succeeded (batch size ${batchSize}, ${remaining.length} rows)`);
      return;
    }

    remaining = stillPending;
    if (remaining.length === 0) {
      logger.info(`${logPrefix} Tiered retry level ${level}: all chunks resolved despite partial failures`);
      return;
    }
    logger.warn(`${logPrefix} Tiered retry level ${level}: ${remaining.length} rows still pending after partial failure`);
  }

  finalizeFallbackTotal.inc();
  logger.warn(`${logPrefix} All tiered retries exhausted, falling back to individual writes (${remaining.length}/${originalTotal} rows, concurrency ${FALLBACK_CONCURRENCY})`);

  let active = 0;
  let idx = 0;
  const errors: string[] = [];
  const items = remaining;

  await new Promise<void>((resolve) => {
    function next() {
      while (active < FALLBACK_CONCURRENCY && idx < items.length) {
        const item = items[idx++];
        active++;
        storage.finalizeSend(campaignId, item.id, item.success)
          .then(() => {
            finalizeFallbackRowsTotal.inc({ outcome: "ok" });
          })
          .catch(() =>
            storage.forceFailPendingSend(campaignId, item.id)
              .then(() => { finalizeFallbackRowsTotal.inc({ outcome: "force_failed" }); })
              .catch((err: Error) => {
                finalizeFallbackRowsTotal.inc({ outcome: "lost" });
                errors.push(`${item.id}: ${err.message}`);
              })
          )
          .finally(() => {
            active--;
            if (idx >= items.length && active === 0) {
              resolve();
            } else {
              next();
            }
          });
      }
    }
    if (items.length === 0) return resolve();
    next();
  });

  if (errors.length > 0) {
    logger.error(`${logPrefix} Individual fallback completed with ${errors.length} permanent failures: ${errors.slice(0, 5).join("; ")}${errors.length > 5 ? ` (+${errors.length - 5} more)` : ""}`);
  } else {
    logger.info(`${logPrefix} Individual fallback completed successfully (${items.length} rows)`);
  }
}

export const SPEED_CONFIG: Record<string, { emailsPerMinute: number; concurrency: number }> = {
  drip: { emailsPerMinute: 100, concurrency: 1 },
  very_slow: { emailsPerMinute: 250, concurrency: 3 },
  slow: { emailsPerMinute: 500, concurrency: 5 },
  medium: { emailsPerMinute: 2000, concurrency: 30 },
  fast: { emailsPerMinute: 5000, concurrency: 80 },
  godzilla: { emailsPerMinute: 60000, concurrency: 250 },
};

export async function processCampaignInternal(campaignId: string, jobId?: string) {
  const logPrefix = `[CAMPAIGN ${campaignId}${jobId ? ` job:${jobId.substring(0, 8)}` : ''}]`;

  logger.info(`${logPrefix} processCampaignInternal started`);

  const campaign = await storage.getCampaign(campaignId);
  if (!campaign) {
    logger.warn(`${logPrefix} Campaign not found - aborting`);
    return;
  }
  if (campaign.status !== "sending") {
    logger.warn(`${logPrefix} Campaign status is '${campaign.status}', expected 'sending' - aborting`);
    return;
  }

  const nowMs = Date.now();
  const isStaleRetryUntil = campaign.retryUntil && campaign.retryUntil.getTime() <= nowMs;
  if (!campaign.retryUntil || isStaleRetryUntil) {
    const retryDeadline = new Date(nowMs + 12 * 60 * 60 * 1000);
    await storage.updateCampaign(campaignId, { retryUntil: retryDeadline });
    campaign.retryUntil = retryDeadline;
    if (isStaleRetryUntil) {
      logger.info(`${logPrefix} Stale retryUntil detected (in the past) - reset to ${retryDeadline.toISOString()}`);
    } else {
      logger.info(`${logPrefix} Set retry deadline to ${retryDeadline.toISOString()}`);
    }
  }

  // Auto-resend (Task #56): a follow-up child has parentCampaignId set and
  // gets its audience from the parent's openers, NOT from a segment query.
  // Originals require a segmentId; children inherit segmentId from parent for
  // display only, so we don't strictly require it on the child but most will
  // still have it set.
  const isFollowUp = !!campaign.parentCampaignId;
  if (!isFollowUp && !campaign.segmentId) {
    logger.error(`${logPrefix} No segment assigned - marking as failed`);
    await storage.updateCampaignStatusAtomic(campaignId, "failed");
    return;
  }

  let mta: Awaited<ReturnType<typeof storage.getMta>> | null = null;
  if (campaign.mtaId) {
    mta = await storage.getMta(campaign.mtaId);
    if (!mta) {
      logger.error(`${logPrefix} MTA ${campaign.mtaId} not found - marking as failed`);
      await storage.updateCampaignStatusAtomic(campaignId, "failed");
      return;
    }

    const isNullsinkMta = (mta as any).mode === "nullsink";
    if (!isNullsinkMta) {
      logger.info(`${logPrefix} Verifying SMTP connection to MTA '${mta.name}'...`);
      const verifyResult = await verifyTransporter(mta);
      if (!verifyResult.success) {
        logger.error(`${logPrefix} SMTP verification failed: ${verifyResult.error} - pausing campaign`);
        closeTransporter(mta.id); // Evict stale pool entry so recovery checker uses a fresh connection
        await storage.updateCampaign(campaignId, { status: "paused", pauseReason: "mta_down" });
        return;
      }
      logger.info(`${logPrefix} SMTP verification OK`);
    } else {
      logger.info(`${logPrefix} Nullsink MTA '${mta.name}' - skipping SMTP verification (V3 in-memory)`);
    }
  } else {
    logger.error(`${logPrefix} No MTA assigned - marking as failed`);
    await storage.updateCampaignStatusAtomic(campaignId, "failed");
    return;
  }

  // Marketing Pressure Guard (Task #144): assert bootstrap readiness before
  // we issue the first reserve. If bootstrap is still pending or has
  // deferred (DDL failed / advisory lock contention), we re-throw so the
  // job-level handler requeues with backoff — the campaign stays in
  // 'sending' status, no rows are dispatched, and the 6h guard invariant
  // cannot be silently bypassed during a fragile startup window.
  const { getPressureGuardBootstrapState } = await import("./pressure-guard");
  const pgState = getPressureGuardBootstrapState();
  if (pgState !== "ready") {
    const msg = `Pressure-guard bootstrap not ready (state=${pgState}); requeuing campaign ${campaignId}`;
    logger.warn(`${logPrefix} ${msg}`);
    throw new Error(msg);
  }

  // FIFO ordering by campaigns.created_at (Task #153) is enforced at
  // three lower levels: (1) campaign_jobs.claimNextJob ORDER BY
  // campaigns.created_at, (2) per-subscriber pg_advisory_xact_lock at
  // CAS, (3) the `blocked_by_older` CTE inside
  // pressureGuardReserveSendSlots (also keyed on created_at). We
  // intentionally do NOT serialize all newer campaigns at the sender
  // entry point — campaigns are only contended on shared subscribers,
  // and per-subscriber serialization is sufficient. Global serialization
  // would needlessly stall newer campaigns whose audiences don't overlap
  // with older ones.
  const recovered = await storage.recoverOrphanedPendingSends(campaignId, 2);
  if (recovered > 0) {
    logger.info(`${logPrefix} Recovered ${recovered} orphaned pending sends`);
  }

  // Audience size: openers-of-parent for follow-up children, segment count
  // for everything else.
  const total = isFollowUp
    ? await storage.countOpenersForParentCampaign(campaign.parentCampaignId!)
    : await storage.countSubscribersForSegment(campaign.segmentId!, campaign.excludeSegmentId ?? undefined);
  if (isFollowUp) {
    logger.info(`${logPrefix} Follow-up of parent '${campaign.parentCampaignId}' — ${total} openers eligible`);
  } else if (campaign.excludeSegmentId) {
    logger.info(`${logPrefix} Segment '${campaign.segmentId}' minus exclusion '${campaign.excludeSegmentId}' — ${total} subscribers eligible`);
  } else {
    logger.info(`${logPrefix} Segment '${campaign.segmentId}' has ${total} subscribers`);
  }

  if (total === 0) {
    logger.warn(`${logPrefix} Segment has 0 subscribers - marking as completed`);
    await storage.updateCampaignStatusAtomic(campaignId, "completed", "sending");
    await storage.updateCampaign(campaignId, { completedAt: new Date(), pendingCount: 0 });
    return;
  }

  // Task #152/#153 NOTE: this rewrites campaigns.started_at on every
  // (re)launch, including auto-resume after a PM2 restart. Multiple
  // campaigns resumed in parallel will all get a started_at clustered in
  // the same minute, which would destroy the FIFO order for any consumer
  // that ranks campaigns by started_at. As of Task #153, ALL FIFO
  // consumers (pressure-guard drain in server/workers/pressure-guard-
  // worker.ts, the main job claimer in server/repositories/job-repository.ts
  // claimNextJob, and the `blocked_by_older` CTE in
  // server/services/pressure-guard.ts) order by campaigns.created_at
  // instead. If you add another FIFO consumer, key it on created_at too —
  // never on started_at.
  await storage.updateCampaign(campaignId, {
    pendingCount: total,
    startedAt: new Date(),
  });

  const speedKey = campaign.sendingSpeed || "medium";
  const speedConfig = SPEED_CONFIG[speedKey] || SPEED_CONFIG.medium;
  const { emailsPerMinute, concurrency } = speedConfig;
  const isNullsink = mta && (mta as any).mode === "nullsink";

  const BATCH_SIZE = isNullsink ? 15000 : 10000;
  const FLUSH_THRESHOLD = 500;
  const FLUSH_INTERVAL_MS = isNullsink ? 5000 : 3000;
  const HEARTBEAT_INTERVAL = 30000;
  const STATUS_CHECK_INTERVAL = 10000;
  const MAX_CONSECUTIVE_FAILURES = 10;

  logger.info(`${logPrefix} Starting V3 engine - Speed: ${speedKey}, Rate: ${emailsPerMinute}/min, Concurrency: ${concurrency}, Mode: ${isNullsink ? 'nullsink-batch' : 'smtp'}, BatchSize: ${BATCH_SIZE}, FlushAt: ${FLUSH_THRESHOLD}`);

  let cursorId: string | undefined = undefined;
  let processedCount = 0;
  let totalSent = 0;
  let totalFailed = 0;
  let consecutiveSmtpFailures = 0;
  const startTime = Date.now();
  let shouldStop = false;

  const defaultHeaders = await storage.getDefaultHeaders();
  const customHeadersMap: Record<string, string> = {};
  for (const header of defaultHeaders) {
    customHeadersMap[header.name] = header.value;
  }

  const trackingOpts: {
    trackOpens: boolean;
    trackClicks: boolean;
    trackingDomain?: string | null;
    openTrackingDomain?: string | null;
    openTag?: string | null;
    clickTag?: string | null;
    linkMap: Map<string, string>;
    batchClickTokens?: Map<string, Map<string, string>>;
    batchUnsubTokens?: Map<string, string>;
  } = {
    trackOpens: campaign.trackOpens,
    trackClicks: campaign.trackClicks,
    trackingDomain: mta?.trackingDomain,
    openTrackingDomain: mta?.openTrackingDomain,
    openTag: campaign.openTag,
    clickTag: campaign.clickTag,
    linkMap: new Map<string, string>(),
  };

  // Pre-register all unique destination URLs once per campaign so every subscriber
  // gets an opaque ?lid= token in their click tracking links (no URL exposed).
  if (campaign.trackClicks && mta?.trackingDomain) {
    try {
      trackingOpts.linkMap = await preregisterCampaignLinks(
        campaign.htmlContent,
        campaignId,
        storage.batchGetOrCreateCampaignLinks.bind(storage)
      );
      logger.info(`${logPrefix} Pre-registered ${trackingOpts.linkMap.size} click tracking link(s)`);
    } catch (err: any) {
      logger.warn(`${logPrefix} preregisterCampaignLinks failed, falling back to legacy url= format: ${err.message}`);
    }
  }

  let precomputedHtml: string | undefined;
  if (isNullsink && mta) {
    precomputedHtml = precomputeBaseHtml(campaign, mta);
  }

  const pendingSuccessIds: string[] = [];
  const pendingFailedIds: string[] = [];
  const pendingCaptures: InsertNullsinkCapture[] = [];
  let lastFlushTime = Date.now();
  let flushPromise: Promise<void> | null = null;

  async function flushBuffer(): Promise<void> {
    if (flushPromise) {
      await flushPromise;
    }
    if (pendingSuccessIds.length === 0 && pendingFailedIds.length === 0) return;

    const successBatch = pendingSuccessIds.splice(0);
    const failedBatch = pendingFailedIds.splice(0);
    const captureBatch = pendingCaptures.splice(0);

    const doFlush = async () => {
      try {
        const flushOps: Promise<void>[] = [
          retryDbOp(() => storage.bulkFinalizeSends(campaignId, successBatch, failedBatch), `${logPrefix} flushBuffer`),
        ];
        if (captureBatch.length > 0) {
          flushOps.push(storage.bulkCreateNullsinkCaptures(captureBatch).catch((e: any) => {
            logger.error(`${logPrefix} Bulk nullsink capture insert failed: ${e.message}`);
          }));
        }
        await Promise.all(flushOps);
      } catch (err: any) {
        logger.error(`${logPrefix} Bulk finalize failed, entering tiered fallback: ${err.message}`);
        await tieredFinalizeFallback(campaignId, successBatch, failedBatch, logPrefix, err);
      }
      lastFlushTime = Date.now();
    };

    flushPromise = doFlush();
    await flushPromise;
    flushPromise = null;
  }

  async function flushBufferAsync(): Promise<void> {
    if (flushPromise) return;
    if (pendingSuccessIds.length === 0 && pendingFailedIds.length === 0) return;

    const successBatch = pendingSuccessIds.splice(0);
    const failedBatch = pendingFailedIds.splice(0);
    const captureBatch = pendingCaptures.splice(0);

    flushPromise = (async () => {
      try {
        const flushOps: Promise<void>[] = [
          retryDbOp(() => storage.bulkFinalizeSends(campaignId, successBatch, failedBatch), `${logPrefix} flushBufferAsync`),
        ];
        if (captureBatch.length > 0) {
          flushOps.push(storage.bulkCreateNullsinkCaptures(captureBatch).catch((e: any) => {
            logger.error(`${logPrefix} Bulk nullsink capture insert failed: ${e.message}`);
          }));
        }
        await Promise.all(flushOps);
      } catch (err: any) {
        logger.error(`${logPrefix} Async flush failed, entering tiered fallback: ${err.message}`);
        await tieredFinalizeFallback(campaignId, successBatch, failedBatch, logPrefix, err);
      }
      lastFlushTime = Date.now();
      flushPromise = null;
    })();
  }

  function shouldFlush(): boolean {
    const bufferSize = pendingSuccessIds.length + pendingFailedIds.length;
    return bufferSize >= FLUSH_THRESHOLD || (bufferSize > 0 && Date.now() - lastFlushTime >= FLUSH_INTERVAL_MS);
  }

  let cachedStatus: string = "sending";
  let lastStatusCheck = Date.now();
  let lastHeartbeat = Date.now();

  async function checkStatusAndHeartbeat(): Promise<void> {
    const now = Date.now();
    if (jobId && now - lastHeartbeat >= HEARTBEAT_INTERVAL) {
      await retryDbOp(() => storage.heartbeatJob(jobId!), `${logPrefix} heartbeat`);
      lastHeartbeat = now;
    }
    if (now - lastStatusCheck >= STATUS_CHECK_INTERVAL) {
      cachedStatus = (await retryDbOp(() => storage.getCampaignStatus(campaignId), `${logPrefix} statusCheck`)) || "cancelled";
      lastStatusCheck = now;
      if (cachedStatus !== "sending") {
        logger.info(`${logPrefix} Status changed to '${cachedStatus}' - stopping send loop`);
        shouldStop = true;
      }
    }
  }

  let prefetchPromise: Promise<Subscriber[]> | null = null;

  // Audience iterator: openers-of-parent for follow-ups, segment cursor
  // otherwise. Both share the (subscriber.id ASC, afterId cursor) contract so
  // the rest of the loop is unchanged.
  function fetchAudienceBatch(cursor: string | undefined): Promise<Subscriber[]> {
    if (isFollowUp) {
      return storage.getOpenersForParentCampaignCursor(campaign!.parentCampaignId!, BATCH_SIZE, cursor);
    }
    return storage.getSubscribersForSegmentCursor(campaign!.segmentId!, BATCH_SIZE, cursor, campaign!.excludeSegmentId ?? undefined);
  }

  function startPrefetch(cursor: string | undefined): void {
    prefetchPromise = fetchAudienceBatch(cursor);
  }

  async function getNextBatch(cursor: string | undefined): Promise<Subscriber[]> {
    if (prefetchPromise) {
      try {
        const batch = await prefetchPromise;
        prefetchPromise = null;
        return batch;
      } catch (err) {
        prefetchPromise = null;
        throw err;
      }
    }
    return fetchAudienceBatch(cursor);
  }

  let batchNumber = 0;

  try {
    while (!shouldStop) {
      await checkStatusAndHeartbeat();
      if (shouldStop) break;

      // Snowball auto-throttle (Task #154): if this campaign's currently-
      // deferred backlog dominates its already-processed work, pause
      // briefly to let the drain catch up before reserving more contacts
      // (which would just deepen the same backlog).
      if (!SNOWBALL_THROTTLE_DISABLED) {
        try {
          const ratioRow = await retryDbOp(
            () => db.execute(sql`
              SELECT
                (SELECT COUNT(*)::bigint
                   FROM campaign_sends
                   WHERE campaign_id = ${campaignId}
                     AND status = 'pending'
                     AND eligible_at IS NOT NULL) AS deferred,
                (SELECT COALESCE(sent_count, 0) + COALESCE(failed_count, 0)
                   FROM campaigns WHERE id = ${campaignId}) AS processed
            `),
            `${logPrefix} snowballRatioCheck`,
          );
          const row = ratioRow.rows[0] as { deferred?: string | number; processed?: string | number } | undefined;
          const deferredNow = Number(row?.deferred ?? 0);
          const processedNow = Number(row?.processed ?? 0);
          const denom = deferredNow + processedNow;
          const ratio = denom > 0 ? deferredNow / denom : 0;
          pressureGuardSenderDeferredRatio.set({ campaign_id: campaignId }, ratio);

          if (deferredNow >= SNOWBALL_THROTTLE_MIN_DEFERRED && ratio > SNOWBALL_THROTTLE_THRESHOLD) {
            pressureGuardSenderThrottledTotal.inc({ campaign_id: campaignId });
            // Persist the engagement on the campaign row so the UI can
            // render "Throttled N times" even after a process restart
            // (Prometheus counters are in-memory and reset on pm2 reload).
            // Best-effort: failure to persist must not abort the throttle.
            db.execute(sql`UPDATE campaigns SET snowball_throttled_count = snowball_throttled_count + 1 WHERE id = ${campaignId}`)
              .catch((e: any) => logger.warn(`${logPrefix} snowball counter UPDATE failed (non-fatal): ${e?.message || e}`));
            logger.warn(
              `${logPrefix} Snowball auto-throttle engaged: deferred=${deferredNow}, processed=${processedNow}, ratio=${ratio.toFixed(3)} > ${SNOWBALL_THROTTLE_THRESHOLD} — sleeping ${SNOWBALL_THROTTLE_SLEEP_MS}ms to let pressure-guard drain catch up`,
            );
            const sleepUntil = Date.now() + SNOWBALL_THROTTLE_SLEEP_MS;
            while (Date.now() < sleepUntil && !shouldStop) {
              const wait = Math.min(5_000, sleepUntil - Date.now());
              await new Promise(r => setTimeout(r, wait));
              await checkStatusAndHeartbeat();
            }
            continue;
          }
        } catch (err: any) {
          // Non-fatal: if we can't compute the ratio, fall through and let
          // the regular send loop proceed. The drain worker is still
          // running independently, so the worst case is we don't throttle
          // this iteration.
          logger.warn(`${logPrefix} Snowball ratio check failed (non-fatal, proceeding): ${err?.message || err}`);
        }
      }

      if (consecutiveSmtpFailures >= MAX_CONSECUTIVE_FAILURES && mta) {
        logger.error(`${logPrefix} ${consecutiveSmtpFailures} consecutive SMTP failures - pausing`);
        await storage.updateCampaign(campaignId, { status: "paused", pauseReason: "mta_down" });
        closeTransporter(mta.id);
        await storage.logError({ type: "campaign_paused", severity: "warning", message: `Campaign auto-paused after ${consecutiveSmtpFailures} consecutive SMTP failures`, campaignId, details: `MTA: ${mta.name}, sent: ${totalSent}, failed: ${totalFailed}` }).catch((err: any) => {
          logger.warn(`${logPrefix} logError DB write failed: ${err.message}`);
        });
        shouldStop = true;
        break;
      }

      const batch = await retryDbOp(() => getNextBatch(cursorId), `${logPrefix} getNextBatch`);
      if (batch.length === 0) {
        logger.info(`${logPrefix} No more subscribers to process (batchNumber: ${batchNumber})`);
        break;
      }
      batchNumber++;
      cursorId = batch[batch.length - 1].id;

      // Serialize prefetch with the previous batch's background finalize so a
      // single campaign never holds two main-pool connections at the same time.
      // This is what lets WORKER_PG_POOL_MAX cover MAX_CONCURRENT_CAMPAIGNS
      // 1:1 instead of needing 2× headroom.
      if (flushPromise) {
        try { await flushPromise; } catch { /* swallowed; doFlush already logs */ }
      }
      startPrefetch(cursorId);

      const subscriberIds = batch.map(s => s.id);
      // Marketing Pressure Guard (Task #144): atomic CAS on
      // subscribers.last_sent_at filters contacts who received an email
      // from any other campaign within the past 6h. Losers are inserted
      // as deferred pending rows for the pressure-guard-worker to drain.
      //
      // No bypass: if the reserve query fails we re-throw so the
      // job-level handler requeues with exponential backoff. We will NOT
      // fall back to the legacy reserveSendSlot path — that would let
      // sends slip past the 6h guard exactly when the system is fragile.
      // Bootstrap readiness is asserted before the first batch (see the
      // call site at the top of sendCampaignWithJob).
      const reservedIds: string[] = await retryDbOp(
        () => storage.pressureGuardReserveSendSlots(campaignId, subscriberIds),
        `${logPrefix} pressureGuardReserve`,
      );

      const reservedSet = new Set(reservedIds);
      const subscribersToSend = batch.filter(s => reservedSet.has(s.id));
      const skippedCount = batch.length - subscribersToSend.length;
      processedCount += skippedCount;

      if (subscribersToSend.length === 0) {
        logger.info(`${logPrefix} Batch ${batchNumber}: All ${batch.length} subscribers already processed, skipping`);
        continue;
      }

      logger.info(`${logPrefix} Batch ${batchNumber}: ${subscribersToSend.length} to send (${skippedCount} skipped)`);

      // ── Generate short tracking tokens for this batch ───────────────────
      if (mta?.trackingDomain) {
        const batchSubIds = subscribersToSend.map(s => s.id);
        const linkIds = [...trackingOpts.linkMap.values()];
        try {
          const [clickTokens, unsubTokens] = await Promise.all([
            linkIds.length > 0 && campaign.trackClicks
              ? storage.batchCreateClickTokens(campaignId, batchSubIds, linkIds)
              : Promise.resolve(new Map<string, Map<string, string>>()),
            storage.batchCreateUnsubscribeTokens(campaignId, batchSubIds),
          ]);
          trackingOpts.batchClickTokens = clickTokens;
          trackingOpts.batchUnsubTokens = unsubTokens;
        } catch (err: any) {
          logger.warn(`${logPrefix} Batch ${batchNumber}: token generation failed, falling back to HMAC links: ${err.message}`);
          trackingOpts.batchClickTokens = undefined;
          trackingOpts.batchUnsubTokens = undefined;
        }
      }

      if (isNullsink && mta) {
        const SUB_BATCH = 2500;
        for (let i = 0; i < subscribersToSend.length; i += SUB_BATCH) {
          if (shouldStop) break;

          const subBatch = subscribersToSend.slice(i, i + SUB_BATCH);
          const results = sendEmailBatchNullsink(mta, subBatch, campaign, trackingOpts, customHeadersMap, precomputedHtml);

          for (const r of results) {
            processedCount++;
            if (r.success) {
              totalSent++;
              pendingSuccessIds.push(r.subscriberId);
              consecutiveSmtpFailures = 0;
            } else {
              totalFailed++;
              pendingFailedIds.push(r.subscriberId);
              consecutiveSmtpFailures++;
            }
            if (r.capture) {
              pendingCaptures.push(r.capture);
            }
          }

          if (shouldFlush()) {
            await flushBufferAsync();
          }

          if (i > 0 && i % (SUB_BATCH * 4) === 0) {
            await checkStatusAndHeartbeat();
          }
        }
      }
      else if (mta) {
        const batchDelayMs = Math.max(0, Math.floor((concurrency / emailsPerMinute) * 60000));

        for (let i = 0; i < subscribersToSend.length; i += concurrency) {
          if (shouldStop) break;

          const chunk = subscribersToSend.slice(i, i + concurrency);

          await retryDbOp(
            () => storage.bulkInsertCampaignSendAttempts(campaignId, chunk.map(s => s.id)),
            `${logPrefix} markAttempting`
          );

          const results = await Promise.allSettled(
            chunk.map(subscriber => {
              return (async () => {
                try {
                  const result = await sendEmailWithNullsink(mta, subscriber, campaign, trackingOpts, customHeadersMap);
                  return { success: result.success, subscriberId: subscriber.id, email: subscriber.email, error: result.error };
                } catch (error: any) {
                  return { success: false, subscriberId: subscriber.id, email: subscriber.email, error: error.message };
                }
              })();
            })
          );

          for (let j = 0; j < results.length; j++) {
            processedCount++;
            const result = results[j];
            if (result.status === "fulfilled") {
              if (result.value.success) {
                totalSent++;
                pendingSuccessIds.push(result.value.subscriberId);
                consecutiveSmtpFailures = 0;
              } else {
                totalFailed++;
                pendingFailedIds.push(result.value.subscriberId);
                consecutiveSmtpFailures++;
                storage.logError({ type: "send_failed", severity: "error", message: `Failed: ${result.value.error}`, email: result.value.email, campaignId, subscriberId: result.value.subscriberId }).catch((err: any) => {
                  logger.warn(`${logPrefix} logError DB write failed: ${err.message}`);
                });
              }
            } else {
              totalFailed++;
              pendingFailedIds.push(chunk[j].id);
              consecutiveSmtpFailures++;
            }
          }

          if (shouldFlush()) {
            await flushBufferAsync();
          }

          if (batchDelayMs > 0 && i + concurrency < subscribersToSend.length) {
            await new Promise(resolve => setTimeout(resolve, batchDelayMs));
          }

          if (i > 0 && i % (concurrency * 10) === 0) {
            await checkStatusAndHeartbeat();
          }
        }
      }

      if (flushPromise) {
        await flushPromise;
      }
      await flushBuffer();

      const elapsed = (Date.now() - startTime) / 1000;
      const rate = processedCount / elapsed * 60;
      logger.info(`${logPrefix} Progress ${processedCount}/${total} (${rate.toFixed(0)}/min) - Sent: ${totalSent}, Failed: ${totalFailed}`);

      jobEvents.emitProgress({
        jobType: "campaign",
        jobId: campaignId,
        campaignId,
        status: "processing",
        processedRows: processedCount,
        totalRows: total,
        sentCount: totalSent,
        failedCount: totalFailed,
        pendingCount: total - processedCount,
      });
    }
  } catch (error: any) {
    logger.error(`${logPrefix} Fatal error in send loop: ${error.message}`, { stack: error.stack });

    try {
      if (flushPromise) await flushPromise;
      await flushBuffer();
    } catch (flushErr: any) {
      logger.error(`${logPrefix} Emergency flush failed: ${flushErr.message}`);
    }

    // NOTE: do NOT call closeTransporter(mta.id) here. The transporterPool is
    // a process-wide cache shared by all concurrent campaigns sending via the
    // same MTA. Closing it on a fatal error in this campaign yanks the pool
    // out from under every other campaign mid-sendMail() and produces a
    // cascade of "Cannot use a pool after calling end on the pool" errors,
    // marking 10+ campaigns failed in the same millisecond. Same reasoning
    // for closeNullsinkTransporter(). Nodemailer's socketTimeout handles
    // idle connection cleanup; on process exit pools die with the process.

    const fatalClassified = (error as any)?.senderRetriesExhausted
      ? (error as any).classification
      : classifyDbError(error);
    if (fatalClassified.transient) {
      logger.warn(`${logPrefix} Transient DB error — re-throwing for job-level requeue (sent: ${totalSent}, failed: ${totalFailed}, processed: ${processedCount}/${total}) [kind=${fatalClassified.kind}, code=${fatalClassified.code ?? 'n/a'}]`);
    } else {
      await storage.updateCampaignStatusAtomic(campaignId, "failed", "sending").catch((err: any) => {
        logger.warn(`${logPrefix} Failed to mark campaign as failed: ${err.message}`);
      });
      await storage.logError({
        type: "campaign_fatal",
        severity: "error",
        message: `Campaign send failed: ${error.message}`,
        campaignId,
        details: `sent: ${totalSent}, failed: ${totalFailed}, processed: ${processedCount}/${total}`,
      }).catch((err: any) => {
        logger.warn(`${logPrefix} logError DB write failed: ${err.message}`);
      });
    }

    jobEvents.emitProgress({
      jobType: "campaign",
      jobId: campaignId,
      campaignId,
      status: "failed",
      processedRows: processedCount,
      totalRows: total,
      sentCount: totalSent,
      failedCount: totalFailed,
      errorMessage: error.message || "Unknown error",
    });

    throw error;
  }

  if (flushPromise) {
    await flushPromise;
  }
  await flushBuffer();

  // NOTE: do NOT call closeTransporter(mta.id) here on normal completion.
  // See the long comment in the catch block above — the transporterPool is a
  // process-wide cache shared by all concurrent campaigns on this MTA, so
  // closing it on success kills any peer campaign mid-sendMail().

  // After flushBuffer() all current-run sends are finalized (sent/failed).
  // Any remaining 'pending' rows must be carry-overs from the retry-failed
  // endpoint, which resets failed rows to 'pending' before re-queuing.
  // We recover them here (threshold=0 → any age) and add them to totalFailed
  // so the retry phase below will pick them up via getFailedSendsForRetry.
  try {
    const carryOverPending = await storage.recoverOrphanedPendingSends(campaignId, 0);
    if (carryOverPending > 0) {
      totalFailed += carryOverPending;
      logger.info(`${logPrefix} Recovered ${carryOverPending} carry-over pending send(s) for retry phase`);
    }
  } catch (recoveryErr: unknown) {
    const msg = recoveryErr instanceof Error ? recoveryErr.message : String(recoveryErr);
    logger.warn(`${logPrefix} Carry-over pending recovery failed (non-fatal): ${msg}`);
  }

  try {
    const dbCounts = await retryDbOp(
      () => storage.getCampaignSendCounts(campaignId),
      `${logPrefix} syncTotalFailed`
    );
    if (dbCounts.failed > totalFailed) {
      logger.info(`${logPrefix} Syncing totalFailed: in-memory=${totalFailed}, DB=${dbCounts.failed} (carry-over from previous crashed passes)`);
      totalFailed = dbCounts.failed;
    }
  } catch (syncErr: unknown) {
    const msg = syncErr instanceof Error ? syncErr.message : String(syncErr);
    logger.warn(`${logPrefix} Failed-count DB sync failed (non-fatal): ${msg}`);
  }

  const RETRY_WINDOW_MS = 12 * 60 * 60 * 1000;
  const retryDeadline = campaign.retryUntil ? campaign.retryUntil.getTime() : Date.now() + RETRY_WINDOW_MS;

  if (totalFailed > 0 && !shouldStop && Date.now() < retryDeadline) {
    logger.info(`${logPrefix} Starting retry phase for ${totalFailed} failed emails (deadline: ${new Date(retryDeadline).toISOString()})`);

    let retryPass = 0;

    while (!shouldStop && Date.now() < retryDeadline) {
      const failedSends = await retryDbOp(
        () => storage.getFailedSendsForRetry(campaignId, BATCH_SIZE),
        `${logPrefix} getFailedSendsForRetry`
      );

      if (failedSends.length === 0) {
        logger.info(`${logPrefix} Retry phase complete - all failed sends recovered`);
        break;
      }

      retryPass++;
      logger.info(`${logPrefix} Retry pass ${retryPass}: ${failedSends.length} failed sends to retry`);

      const retrySubIds = failedSends.map(s => s.subscriberId);
      const markedCount = await retryDbOp(
        () => storage.bulkMarkSendsForRetry(campaignId, retrySubIds),
        `${logPrefix} bulkMarkSendsForRetry`
      );
      logger.info(`${logPrefix} Retry pass ${retryPass}: Marked ${markedCount} sends for retry`);

      for (let i = 0; i < failedSends.length; i += concurrency) {
        if (shouldStop) break;

        const chunk = failedSends.slice(i, i + concurrency);

        if (isNullsink && mta) {
          const subscriberObjects = await Promise.all(
            chunk.map(async (s) => {
              const sub = await storage.getSubscriber(s.subscriberId);
              return sub;
            })
          );
          const validSubs = subscriberObjects.filter((s): s is NonNullable<typeof s> => s != null);

          if (validSubs.length > 0) {
            const results = sendEmailBatchNullsink(mta, validSubs, campaign, trackingOpts, customHeadersMap, precomputedHtml);
            for (const r of results) {
              if (r.success) {
                totalSent++;
                totalFailed--;
                pendingSuccessIds.push(r.subscriberId);
              } else {
                pendingFailedIds.push(r.subscriberId);
              }
              if (r.capture) pendingCaptures.push(r.capture);
            }
          }
        } else if (mta) {
          await retryDbOp(
            () => storage.bulkInsertCampaignSendAttempts(campaignId, chunk.map(s => s.subscriberId)),
            `${logPrefix} retryMarkAttempting`
          );

          const results = await Promise.allSettled(
            chunk.map(async (s) => {
              const sub = await storage.getSubscriber(s.subscriberId);
              if (!sub) return { success: false, subscriberId: s.subscriberId, email: s.email, error: 'Subscriber not found' };
              try {
                const result = await sendEmailWithNullsink(mta, sub, campaign, trackingOpts, customHeadersMap);
                return { success: result.success, subscriberId: sub.id, email: sub.email, error: result.error };
              } catch (error: any) {
                return { success: false, subscriberId: sub.id, email: sub.email, error: error.message };
              }
            })
          );

          for (const result of results) {
            if (result.status === 'fulfilled') {
              if (result.value.success) {
                totalSent++;
                totalFailed--;
                pendingSuccessIds.push(result.value.subscriberId);
              } else {
                pendingFailedIds.push(result.value.subscriberId);
              }
            }
          }
        }

        if (shouldFlush()) {
          await flushBufferAsync();
        }
      }

      if (flushPromise) await flushPromise;
      await flushBuffer();

      await checkStatusAndHeartbeat();
      if (shouldStop) break;

      const backoffMs = Math.min(30000 * Math.pow(2, retryPass - 1), 15 * 60 * 1000);
      logger.info(`${logPrefix} Retry pass ${retryPass} done. Waiting ${Math.round(backoffMs / 1000)}s before next pass`);

      const backoffEnd = Date.now() + backoffMs;
      while (Date.now() < backoffEnd && !shouldStop) {
        const waitTime = Math.min(HEARTBEAT_INTERVAL, backoffEnd - Date.now());
        await new Promise(r => setTimeout(r, waitTime));
        await checkStatusAndHeartbeat();
      }
    }

    if (Date.now() >= retryDeadline) {
      logger.info(`${logPrefix} Retry window expired after 12 hours`);
    }
  }

  // ── Auto-requeue: if failed sends remain and the campaign wasn't manually
  //    stopped, automatically re-enqueue up to MAX_AUTO_RETRIES times so the
  //    operator doesn't have to click "Retry Failed Sends" by hand.
  if (totalFailed > 0 && !shouldStop) {
    try {
      const freshCampaign = await storage.getCampaign(campaignId);
      const currentAutoRetries = freshCampaign?.autoRetryCount ?? 0;
      if (currentAutoRetries < MAX_AUTO_RETRIES) {
        const newCount = currentAutoRetries + 1;
        logger.info(`${logPrefix} Auto-retry ${newCount}/${MAX_AUTO_RETRIES}: requeueing ${totalFailed} failed send(s)`);
        const requeued = await storage.autoRequeueCampaignFailed(campaignId, newCount);
        if (requeued) {
          await messageQueue.notify("campaign_jobs", { campaignId });
          logger.info(`${logPrefix} Auto-retry job enqueued (attempt ${newCount}/${MAX_AUTO_RETRIES})`);
          return;
        }
      } else {
        logger.warn(`${logPrefix} Auto-retry limit reached (${MAX_AUTO_RETRIES}/${MAX_AUTO_RETRIES}). ${totalFailed} send(s) remain permanently failed.`);
      }
    } catch (autoRetryErr: unknown) {
      const msg = autoRetryErr instanceof Error ? autoRetryErr.message : String(autoRetryErr);
      logger.error(`${logPrefix} Auto-requeue failed (non-fatal, will mark completed): ${msg}`);
    }
  }

  if (!shouldStop) {
    try {
      const sendCounts = await storage.getCampaignSendCounts(campaignId);
      const expectedTotal = total;
      const actualTotal = sendCounts.total;
      const discrepancy = expectedTotal - actualTotal;
      const discrepancyPct = expectedTotal > 0 ? Math.abs(discrepancy) / expectedTotal * 100 : 0;

      logger.info(`${logPrefix} RECONCILIATION: expected=${expectedTotal}, actual=${actualTotal} (sent=${sendCounts.sent}, failed=${sendCounts.failed}, pending=${sendCounts.pending}, attempting=${sendCounts.attempting}), discrepancy=${discrepancy} (${discrepancyPct.toFixed(2)}%)`);
      campaignReconciliationDiscrepancy.set({ campaign_id: campaignId }, discrepancyPct);

      if (discrepancyPct > 1 && Math.abs(discrepancy) > 10) {
        logger.warn(`${logPrefix} RECONCILIATION MISMATCH: ${discrepancyPct.toFixed(2)}% discrepancy (${Math.abs(discrepancy)} recipients). Expected ${expectedTotal} from segment, but campaign_sends has ${actualTotal} records.`);
      }
      if (sendCounts.pending > 0) {
        logger.warn(`${logPrefix} RECONCILIATION: ${sendCounts.pending} sends still in pending/reserved status after completion`);
      }
      if (sendCounts.attempting > 0) {
        logger.warn(`${logPrefix} RECONCILIATION: Campaign ${campaignId} completed with ${sendCounts.attempting} sends stuck in 'attempting' state — possible crash during send. Manual review recommended.`);
      }
    } catch (err: any) {
      logger.warn(`${logPrefix} Reconciliation check failed: ${err.message}`);
    }

    // Pressure-guard gate (Task #144): if there are still deferred rows
    // (status='pending' AND eligible_at IS NOT NULL) the campaign is NOT
    // truly done — the pressure-guard worker still owes those subscribers
    // a send attempt. Leaving status='sending' lets the worker keep
    // draining and the existing post-deferred completion path
    // (job-poll re-trigger or worker-completion handler) will mark
    // 'completed' once the deferred queue empties.
    const deferredCheck = await db.execute(sql`
      SELECT COUNT(*)::int AS n FROM campaign_sends
      WHERE campaign_id = ${campaignId}
        AND status = 'pending' AND eligible_at IS NOT NULL
    `);
    const deferredRemaining = Number((deferredCheck.rows[0] as { n?: number } | undefined)?.n ?? 0);
    if (deferredRemaining > 0) {
      logger.info(`${logPrefix} Holding 'sending' status: ${deferredRemaining} deferred send(s) still queued by pressure guard`);
      jobEvents.emitProgress({
        jobType: "campaign",
        jobId: campaignId,
        campaignId,
        status: "sending",
        processedRows: processedCount,
        totalRows: total,
        sentCount: totalSent,
        failedCount: totalFailed,
        pendingCount: deferredRemaining,
      });
      return;
    }

    const wasCompleted = await storage.updateCampaignStatusAtomic(campaignId, "completed", "sending");
    if (wasCompleted) {
      await storage.updateCampaign(campaignId, { completedAt: new Date(), pendingCount: 0 });
      const finalCampaign = await storage.getCampaign(campaignId);
      logger.info(`${logPrefix} COMPLETED: ${finalCampaign?.sentCount} sent, ${finalCampaign?.failedCount} failed`);
      // Auto-resend (Task #56): an ORIGINAL parent that has follow-up enabled
      // gets followUpScheduledAt stamped at completion. The spawner worker
      // (server/workers.ts pollFollowUpCampaigns) will pick it up after the
      // configured delay. Children skip this branch (parentCampaignId set).
      if (!isFollowUp && campaign.followUpEnabled) {
        try {
          await storage.markFollowUpScheduled(campaignId, campaign.followUpDelayHours ?? 36);
          logger.info(`${logPrefix} Follow-up scheduled in ${campaign.followUpDelayHours ?? 36}h`);
        } catch (err: any) {
          logger.warn(`${logPrefix} markFollowUpScheduled failed (non-fatal): ${err?.message || err}`);
        }
      }
      jobEvents.emitProgress({
        jobType: "campaign",
        jobId: campaignId,
        campaignId,
        status: "completed",
        processedRows: processedCount,
        totalRows: total,
        sentCount: finalCampaign?.sentCount || totalSent,
        failedCount: finalCampaign?.failedCount || totalFailed,
        pendingCount: 0,
      });
    } else {
      logger.warn(`${logPrefix} Failed to atomically set status to 'completed' - campaign may have been paused/cancelled`);
    }
  } else {
    logger.info(`${logPrefix} Stopped at ${processedCount} processed, sent: ${totalSent}, failed: ${totalFailed}`);
    jobEvents.emitProgress({
      jobType: "campaign",
      jobId: campaignId,
      campaignId,
      status: "cancelled",
      processedRows: processedCount,
      totalRows: total,
      sentCount: totalSent,
      failedCount: totalFailed,
      pendingCount: total - processedCount,
    });
  }
}
