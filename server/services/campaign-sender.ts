import { storage } from "../storage";
import {
  sendEmailBatchNullsink,
  precomputeBaseHtml,
  sendEmailWithNullsink,
  closeTransporter,
  closeNullsinkTransporter,
  verifyTransporter,
  preregisterCampaignLinks,
} from "../email-service";
import { logger } from "../logger";
import { campaignReconciliationDiscrepancy } from "../metrics";
import type { InsertNullsinkCapture, Subscriber } from "@shared/schema";
import { jobEvents } from "../job-events";

async function retryDbOp<T>(fn: () => Promise<T>, label: string, maxRetries = 3): Promise<T> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      const msg = err.message || '';
      const isTransient = /connection timeout|Connection terminated|connection refused|ECONNRESET|unexpected eof|Client has encountered a connection error|server closed the connection unexpectedly|terminating connection|connection reset by peer/i.test(msg);
      if (!isTransient || attempt >= maxRetries) {
        throw err;
      }
      const delay = Math.pow(2, attempt - 1) * 1000;
      logger.warn(`${label} DB operation failed (attempt ${attempt}/${maxRetries}), retrying in ${delay}ms: ${msg}`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error('Unreachable');
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

  if (!campaign.retryUntil) {
    const retryDeadline = new Date(Date.now() + 12 * 60 * 60 * 1000);
    await storage.updateCampaign(campaignId, { retryUntil: retryDeadline });
    campaign.retryUntil = retryDeadline;
    logger.info(`${logPrefix} Set retry deadline to ${retryDeadline.toISOString()}`);
  }

  if (!campaign.segmentId) {
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

  const recovered = await storage.recoverOrphanedPendingSends(campaignId, 2);
  if (recovered > 0) {
    logger.info(`${logPrefix} Recovered ${recovered} orphaned pending sends`);
  }

  const total = await storage.countSubscribersForSegment(campaign.segmentId);
  logger.info(`${logPrefix} Segment '${campaign.segmentId}' has ${total} subscribers`);

  if (total === 0) {
    logger.warn(`${logPrefix} Segment has 0 subscribers - marking as completed`);
    await storage.updateCampaignStatusAtomic(campaignId, "completed", "sending");
    await storage.updateCampaign(campaignId, { completedAt: new Date(), pendingCount: 0 });
    return;
  }

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
        logger.error(`${logPrefix} Bulk finalize failed, falling back: ${err.message}`);
        for (const sid of successBatch) {
          try { await storage.finalizeSend(campaignId, sid, true); } catch (e) {
            await storage.forceFailPendingSend(campaignId, sid).catch((err: any) => {
              logger.warn(`${logPrefix} forceFailPendingSend failed for ${sid}: ${err.message}`);
            });
          }
        }
        for (const sid of failedBatch) {
          try { await storage.finalizeSend(campaignId, sid, false); } catch (e) {
            await storage.forceFailPendingSend(campaignId, sid).catch((err: any) => {
              logger.warn(`${logPrefix} forceFailPendingSend failed for ${sid}: ${err.message}`);
            });
          }
        }
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
        logger.error(`${logPrefix} Async flush failed: ${err.message}`);
        for (const sid of successBatch) {
          try { await storage.finalizeSend(campaignId, sid, true); } catch (e) {
            await storage.forceFailPendingSend(campaignId, sid).catch((err: any) => {
              logger.warn(`${logPrefix} forceFailPendingSend failed for ${sid}: ${err.message}`);
            });
          }
        }
        for (const sid of failedBatch) {
          try { await storage.finalizeSend(campaignId, sid, false); } catch (e) {
            await storage.forceFailPendingSend(campaignId, sid).catch((err: any) => {
              logger.warn(`${logPrefix} forceFailPendingSend failed for ${sid}: ${err.message}`);
            });
          }
        }
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

  function startPrefetch(segmentId: string, cursor: string | undefined): void {
    prefetchPromise = storage.getSubscribersForSegmentCursor(segmentId, BATCH_SIZE, cursor);
  }

  async function getNextBatch(segmentId: string, cursor: string | undefined): Promise<Subscriber[]> {
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
    return storage.getSubscribersForSegmentCursor(segmentId, BATCH_SIZE, cursor);
  }

  let batchNumber = 0;

  try {
    while (!shouldStop) {
      await checkStatusAndHeartbeat();
      if (shouldStop) break;

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

      const batch = await retryDbOp(() => getNextBatch(campaign.segmentId!, cursorId), `${logPrefix} getNextBatch`);
      if (batch.length === 0) {
        logger.info(`${logPrefix} No more subscribers to process (batchNumber: ${batchNumber})`);
        break;
      }
      batchNumber++;
      cursorId = batch[batch.length - 1].id;

      startPrefetch(campaign.segmentId, cursorId);

      const subscriberIds = batch.map(s => s.id);
      let reservedIds: string[];
      try {
        reservedIds = await retryDbOp(() => storage.bulkReserveSendSlots(campaignId, subscriberIds), `${logPrefix} bulkReserve`);
      } catch (err: any) {
        logger.error(`${logPrefix} Bulk reserve failed, falling back: ${err.message}`);
        reservedIds = [];
        for (const sub of batch) {
          const ok = await storage.reserveSendSlot(campaignId, sub.id);
          if (ok) reservedIds.push(sub.id);
        }
      }

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

    if (mta) closeTransporter(mta.id);
    closeNullsinkTransporter();

    const fatalMsg = error.message || '';
    const isTransientDb = /connection timeout|Connection terminated|connection refused|ECONNRESET|unexpected eof|Client has encountered a connection error|server closed the connection unexpectedly|terminating connection|connection reset by peer/i.test(fatalMsg);
    if (isTransientDb) {
      await storage.updateCampaign(campaignId, { status: "paused", pauseReason: "db_connection_error" }).catch((err: any) => {
        logger.warn(`${logPrefix} Failed to pause campaign on DB error: ${err.message}`);
      });
      await storage.logError({
        type: "campaign_paused",
        severity: "warning",
        message: `Campaign paused due to transient DB error: ${error.message}`,
        campaignId,
        details: `sent: ${totalSent}, failed: ${totalFailed}, processed: ${processedCount}/${total}`,
      }).catch((err: any) => {
        logger.warn(`${logPrefix} logError DB write failed: ${err.message}`);
      });
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

  if (mta) {
    closeTransporter(mta.id);
  }
  closeNullsinkTransporter();

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

    const wasCompleted = await storage.updateCampaignStatusAtomic(campaignId, "completed", "sending");
    if (wasCompleted) {
      await storage.updateCampaign(campaignId, { completedAt: new Date(), pendingCount: 0 });
      const finalCampaign = await storage.getCampaign(campaignId);
      logger.info(`${logPrefix} COMPLETED: ${finalCampaign?.sentCount} sent, ${finalCampaign?.failedCount} failed`);
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
