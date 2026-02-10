import { storage } from "../storage";
import {
  sendEmailBatchNullsink,
  precomputeBaseHtml,
  sendEmailWithNullsink,
  closeTransporter,
  closeNullsinkTransporter,
  verifyTransporter,
} from "../email-service";
import { logger } from "../logger";
import type { InsertNullsinkCapture, Subscriber } from "@shared/schema";

export const SPEED_CONFIG: Record<string, { emailsPerMinute: number; concurrency: number }> = {
  slow: { emailsPerMinute: 500, concurrency: 5 },
  medium: { emailsPerMinute: 2000, concurrency: 30 },
  fast: { emailsPerMinute: 5000, concurrency: 80 },
  godzilla: { emailsPerMinute: 60000, concurrency: 250 },
};

export async function processCampaignInternal(campaignId: string, jobId?: string) {
  const campaign = await storage.getCampaign(campaignId);
  if (!campaign || campaign.status !== "sending") return;
  
  if (!campaign.segmentId) {
    await storage.updateCampaignStatusAtomic(campaignId, "failed");
    return;
  }
  
  let mta: Awaited<ReturnType<typeof storage.getMta>> | null = null;
  if (campaign.mtaId) {
    mta = await storage.getMta(campaign.mtaId);
    if (!mta) {
      logger.error(`Campaign ${campaignId}: MTA ${campaign.mtaId} not found`);
      await storage.updateCampaignStatusAtomic(campaignId, "failed");
      return;
    }
    
    const isNullsinkMta = (mta as any).mode === "nullsink";
    if (!isNullsinkMta) {
      const verifyResult = await verifyTransporter(mta);
      if (!verifyResult.success) {
        logger.error(`Campaign ${campaignId}: SMTP verification failed: ${verifyResult.error}`);
        await storage.updateCampaign(campaignId, { status: "paused", pauseReason: "mta_down" });
        logger.info(`Campaign ${campaignId}: Paused due to MTA unavailable - will auto-resume when MTA is back`);
        return;
      }
    } else {
      logger.info(`Campaign ${campaignId}: Nullsink MTA detected - skipping SMTP verification (V3 processes in-memory)`);
    }
  }
  
  const recovered = await storage.recoverOrphanedPendingSends(campaignId, 2);
  if (recovered > 0) {
    logger.info(`Campaign ${campaignId}: Recovered ${recovered} orphaned pending sends before processing`);
  }
  
  const total = await storage.countSubscribersForSegment(campaign.segmentId);
  
  await storage.updateCampaign(campaignId, {
    pendingCount: total,
    startedAt: new Date(),
  });
  
  const speedKey = campaign.sendingSpeed || "medium";
  const speedConfig = SPEED_CONFIG[speedKey] || SPEED_CONFIG.medium;
  const { emailsPerMinute, concurrency } = speedConfig;
  const isNullsink = mta && (mta as any).mode === "nullsink";

  const BATCH_SIZE = isNullsink ? 15000 : 10000;
  const FLUSH_THRESHOLD = isNullsink ? 5000 : 2500;
  const FLUSH_INTERVAL_MS = isNullsink ? 5000 : 3000;
  const HEARTBEAT_INTERVAL = 30000;
  const STATUS_CHECK_INTERVAL = 10000;
  const MAX_CONSECUTIVE_FAILURES = 10;

  logger.info(`[CAMPAIGN] ${campaignId}: Starting send engine V3 - Speed: ${speedKey}, Concurrency: ${concurrency}, Rate: ${emailsPerMinute}/min, Mode: ${isNullsink ? 'nullsink-batch' : 'smtp'}, BatchSize: ${BATCH_SIZE}, FlushAt: ${FLUSH_THRESHOLD}`);

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

  const trackingOpts = {
    trackOpens: campaign.trackOpens,
    trackClicks: campaign.trackClicks,
    trackingDomain: mta?.trackingDomain,
    openTrackingDomain: mta?.openTrackingDomain,
    openTag: campaign.openTag,
    clickTag: campaign.clickTag,
  };

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
          storage.bulkFinalizeSends(campaignId, successBatch, failedBatch),
        ];
        if (captureBatch.length > 0) {
          flushOps.push(storage.bulkCreateNullsinkCaptures(captureBatch).catch(() => {}));
        }
        await Promise.all(flushOps);
      } catch (err: any) {
        logger.error(`[CAMPAIGN] ${campaignId}: Bulk finalize failed, falling back: ${err.message}`);
        for (const sid of successBatch) {
          try { await storage.finalizeSend(campaignId, sid, true); } catch (e) {
            await storage.forceFailPendingSend(campaignId, sid).catch(() => {});
          }
        }
        for (const sid of failedBatch) {
          try { await storage.finalizeSend(campaignId, sid, false); } catch (e) {
            await storage.forceFailPendingSend(campaignId, sid).catch(() => {});
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
          storage.bulkFinalizeSends(campaignId, successBatch, failedBatch),
        ];
        if (captureBatch.length > 0) {
          flushOps.push(storage.bulkCreateNullsinkCaptures(captureBatch).catch(() => {}));
        }
        await Promise.all(flushOps);
      } catch (err: any) {
        logger.error(`[CAMPAIGN] ${campaignId}: Async flush failed: ${err.message}`);
        for (const sid of successBatch) {
          try { await storage.finalizeSend(campaignId, sid, true); } catch (e) {
            await storage.forceFailPendingSend(campaignId, sid).catch(() => {});
          }
        }
        for (const sid of failedBatch) {
          try { await storage.finalizeSend(campaignId, sid, false); } catch (e) {
            await storage.forceFailPendingSend(campaignId, sid).catch(() => {});
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
      await storage.heartbeatJob(jobId);
      lastHeartbeat = now;
    }
    if (now - lastStatusCheck >= STATUS_CHECK_INTERVAL) {
      cachedStatus = (await storage.getCampaignStatus(campaignId)) || "cancelled";
      lastStatusCheck = now;
      if (cachedStatus !== "sending") {
        shouldStop = true;
      }
    }
  }

  let prefetchedBatch: Subscriber[] | null = null;
  let prefetchPromise: Promise<Subscriber[]> | null = null;

  function startPrefetch(segmentId: string, cursor: string | undefined): void {
    prefetchPromise = storage.getSubscribersForSegmentCursor(segmentId, BATCH_SIZE, cursor);
  }

  async function getNextBatch(segmentId: string, cursor: string | undefined): Promise<Subscriber[]> {
    if (prefetchPromise) {
      const batch = await prefetchPromise;
      prefetchPromise = null;
      return batch;
    }
    return storage.getSubscribersForSegmentCursor(segmentId, BATCH_SIZE, cursor);
  }

  while (!shouldStop) {
    await checkStatusAndHeartbeat();
    if (shouldStop) break;

    if (consecutiveSmtpFailures >= MAX_CONSECUTIVE_FAILURES && mta) {
      logger.error(`[CAMPAIGN] ${campaignId}: ${consecutiveSmtpFailures} consecutive SMTP failures - pausing`);
      await storage.updateCampaign(campaignId, { status: "paused", pauseReason: "mta_down" });
      closeTransporter(mta.id);
      await storage.logError({ type: "campaign_paused", severity: "warning", message: `Campaign auto-paused after ${consecutiveSmtpFailures} consecutive SMTP failures`, campaignId, details: `MTA: ${mta.name}, sent: ${totalSent}, failed: ${totalFailed}` }).catch(() => {});
      shouldStop = true;
      break;
    }

    const batch = await getNextBatch(campaign.segmentId, cursorId);
    if (batch.length === 0) break;
    cursorId = batch[batch.length - 1].id;

    startPrefetch(campaign.segmentId, cursorId);

    const subscriberIds = batch.map(s => s.id);
    let reservedIds: string[];
    try {
      reservedIds = await storage.bulkReserveSendSlots(campaignId, subscriberIds);
    } catch (err: any) {
      logger.error(`[CAMPAIGN] ${campaignId}: Bulk reserve failed, falling back: ${err.message}`);
      reservedIds = [];
      for (const sub of batch) {
        const ok = await storage.reserveSendSlot(campaignId, sub.id);
        if (ok) reservedIds.push(sub.id);
      }
    }

    const reservedSet = new Set(reservedIds);
    const subscribersToSend = batch.filter(s => reservedSet.has(s.id));
    processedCount += batch.length - subscribersToSend.length;

    if (subscribersToSend.length === 0) continue;

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
              storage.logError({ type: "send_failed", severity: "error", message: `Failed: ${result.value.error}`, email: result.value.email, campaignId, subscriberId: result.value.subscriberId }).catch(() => {});
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
    logger.info(`[CAMPAIGN] ${campaignId}: Progress ${processedCount}/${total} (${rate.toFixed(0)}/min, ${(rate/60).toFixed(1)}/s) - Sent: ${totalSent}, Failed: ${totalFailed}`);
  }

  if (flushPromise) {
    await flushPromise;
  }
  await flushBuffer();

  if (mta) {
    closeTransporter(mta.id);
  }
  closeNullsinkTransporter();

  if (!shouldStop) {
    const wasCompleted = await storage.updateCampaignStatusAtomic(campaignId, "completed", "sending");
    if (wasCompleted) {
      await storage.updateCampaign(campaignId, { completedAt: new Date(), pendingCount: 0 });
      const finalCampaign = await storage.getCampaign(campaignId);
      logger.info(`Campaign ${campaignId} completed: ${finalCampaign?.sentCount} sent, ${finalCampaign?.failedCount} failed`);
    }
  } else {
    logger.info(`[CAMPAIGN] ${campaignId}: Stopped at ${processedCount} processed, sent: ${totalSent}, failed: ${totalFailed}`);
  }
}
