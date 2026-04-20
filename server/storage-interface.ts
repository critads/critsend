import type {
  Subscriber,
  InsertSubscriber,
  Segment,
  InsertSegment,
  Mta,
  InsertMta,
  EmailHeader,
  InsertEmailHeader,
  Campaign,
  InsertCampaign,
  CampaignStat,
  CampaignSend,
  ImportJob,
  InsertImportJob,
  CampaignJob,
  CampaignJobStatus,
  ImportJobQueueItem,
  ImportJobQueueStatus,
  ErrorLog,
  InsertErrorLog,
  NullsinkCapture,
  InsertNullsinkCapture,
  FlushJob,
  DbMaintenanceRule,
  InsertDbMaintenanceRule,
  DbMaintenanceLog,
} from "@shared/schema";
import type { SegmentRulesV2 } from "@shared/schema";

export interface IStorage {
  // ═══════════════════════════════════════════════════════════════
  // SUBSCRIBER MANAGEMENT
  // ═══════════════════════════════════════════════════════════════
  getSubscribers(page: number, limit: number, search?: string): Promise<{ subscribers: Subscriber[]; total: number }>;
  getSubscriber(id: string): Promise<Subscriber | undefined>;
  getSubscriberByEmail(email: string): Promise<Subscriber | undefined>;
  getSubscribersByEmails(emails: string[]): Promise<Map<string, Subscriber>>;
  createSubscriber(data: InsertSubscriber): Promise<Subscriber>;
  updateSubscriber(id: string, data: Partial<InsertSubscriber>): Promise<Subscriber | undefined>;
  setSuppressedUntil(subscriberId: string): Promise<void>;
  deleteSubscriber(id: string): Promise<void>;
  deleteAllSubscribers(): Promise<number>;
  bulkDeleteByEmails(emails: string[]): Promise<{ deleted: number; notFound: number }>;
  countByEmails(emails: string[]): Promise<number>;

  // ═══════════════════════════════════════════════════════════════
  // SEGMENT OPERATIONS
  // ═══════════════════════════════════════════════════════════════
  getSubscribersForSegment(segmentId: string, limit?: number, offset?: number): Promise<Subscriber[]>;
  getSubscribersForSegmentCursor(segmentId: string, limit: number, afterId?: string): Promise<Subscriber[]>;
  countSubscribersForSegment(segmentId: string): Promise<number>;
  countSubscribersForRules(rules: any[]): Promise<number>;
  getSegments(): Promise<Segment[]>;
  getSegment(id: string): Promise<Segment | undefined>;
  createSegment(data: InsertSegment): Promise<Segment>;
  updateSegment(id: string, data: Partial<InsertSegment>): Promise<Segment | undefined>;
  deleteSegment(id: string): Promise<void>;
  getSegmentSubscriberCountCached(segmentId: string): Promise<number>;
  invalidateSegmentCountCache(segmentId?: string): Promise<void>;
  previewSegmentRules(rules: SegmentRulesV2, sampleLimit?: number): Promise<{ count: number; sample: Subscriber[] }>;
  duplicateSegment(id: string): Promise<Segment | undefined>;

  // ═══════════════════════════════════════════════════════════════
  // MTA MANAGEMENT
  // ═══════════════════════════════════════════════════════════════
  getMtas(): Promise<Mta[]>;
  getMta(id: string): Promise<Mta | undefined>;
  createMta(data: InsertMta): Promise<Mta>;
  updateMta(id: string, data: Partial<InsertMta>): Promise<Mta | undefined>;
  deleteMta(id: string): Promise<void>;

  // ═══════════════════════════════════════════════════════════════
  // EMAIL HEADERS
  // ═══════════════════════════════════════════════════════════════
  getHeaders(): Promise<EmailHeader[]>;
  getDefaultHeaders(): Promise<EmailHeader[]>;
  getHeader(id: string): Promise<EmailHeader | undefined>;
  createHeader(data: InsertEmailHeader): Promise<EmailHeader>;
  updateHeader(id: string, data: Partial<InsertEmailHeader>): Promise<EmailHeader | undefined>;
  deleteHeader(id: string): Promise<void>;

  // ═══════════════════════════════════════════════════════════════
  // CAMPAIGN MANAGEMENT
  // ═══════════════════════════════════════════════════════════════
  getCampaigns(): Promise<Campaign[]>;
  getCampaign(id: string): Promise<Campaign | undefined>;
  getCampaignStatus(id: string): Promise<string | null>;
  createCampaign(data: InsertCampaign): Promise<Campaign>;
  updateCampaign(id: string, data: Partial<Campaign>): Promise<Campaign | undefined>;
  deleteCampaign(id: string): Promise<void>;
  copyCampaign(id: string): Promise<Campaign | undefined>;

  // ═══════════════════════════════════════════════════════════════
  // CAMPAIGN SENDING & TRACKING
  // ═══════════════════════════════════════════════════════════════
  addCampaignStat(campaignId: string, subscriberId: string, type: string, link?: string, ctx?: import('./repositories/campaign-repository').TrackingContext): Promise<void>;
  getCampaignStats(campaignId: string): Promise<CampaignStat[]>;
  recordCampaignSend(campaignId: string, subscriberId: string, status?: string): Promise<boolean>;
  wasEmailSent(campaignId: string, subscriberId: string): Promise<boolean>;
  getCampaignSendCount(campaignId: string): Promise<number>;
  incrementCampaignSentCount(campaignId: string, increment?: number): Promise<void>;
  incrementCampaignFailedCount(campaignId: string, increment?: number): Promise<void>;
  decrementCampaignPendingCount(campaignId: string, decrement?: number): Promise<void>;
  updateCampaignStatusAtomic(campaignId: string, newStatus: string, expectedStatus?: string): Promise<boolean>;
  reserveSendSlot(campaignId: string, subscriberId: string): Promise<boolean>;
  finalizeSend(campaignId: string, subscriberId: string, success: boolean): Promise<void>;
  recordSendAndUpdateCounters(campaignId: string, subscriberId: string, success: boolean): Promise<boolean>;
  recoverOrphanedPendingSends(campaignId: string, maxAgeMinutes?: number): Promise<number>;
  resetOrphanedFailedSends(campaignId: string): Promise<number>;
  autoRequeueCampaignFailed(campaignId: string, newAutoRetryCount: number): Promise<boolean>;
  forceFailPendingSend(campaignId: string, subscriberId: string): Promise<boolean>;
  bulkReserveSendSlots(campaignId: string, subscriberIds: string[]): Promise<string[]>;
  bulkFinalizeSends(campaignId: string, successIds: string[], failedIds: string[]): Promise<void>;
  heartbeatJob(jobId: string): Promise<void>;
  recordFirstOpen(campaignId: string, subscriberId: string): Promise<boolean>;
  recordFirstClick(campaignId: string, subscriberId: string): Promise<boolean>;
  getCampaignSend(campaignId: string, subscriberId: string): Promise<CampaignSend | undefined>;
  getUniqueOpenCount(campaignId: string): Promise<number>;
  getUniqueClickCount(campaignId: string): Promise<number>;

  // ═══════════════════════════════════════════════════════════════
  // CAMPAIGN LINKS
  // ═══════════════════════════════════════════════════════════════
  batchGetOrCreateCampaignLinks(campaignId: string, urls: string[]): Promise<Map<string, string>>;
  getCampaignLinkDestination(linkId: string): Promise<string | null>;

  // ═══════════════════════════════════════════════════════════════
  // TRACKING TOKENS  (/c/ click tokens + /u/ unsubscribe tokens)
  // ═══════════════════════════════════════════════════════════════
  batchCreateClickTokens(campaignId: string, subscriberIds: string[], linkIds: string[]): Promise<Map<string, Map<string, string>>>;
  batchCreateUnsubscribeTokens(campaignId: string, subscriberIds: string[]): Promise<Map<string, string>>;
  resolveTrackingToken(token: string): Promise<{ type: string; campaignId: string; subscriberId: string; linkId: string | null } | null>;

  // ═══════════════════════════════════════════════════════════════
  // CAMPAIGN JOB QUEUE
  // ═══════════════════════════════════════════════════════════════
  enqueueCampaignJob(campaignId: string): Promise<CampaignJob>;
  enqueueCampaignJobWithRetry(campaignId: string, retryCount: number, delaySeconds: number): Promise<any>;
  claimNextJob(workerId: string): Promise<CampaignJob | null>;
  completeJob(jobId: string, status: "completed" | "failed", errorMessage?: string): Promise<void>;
  clearStuckJobsForCampaign(campaignId: string): Promise<number>;
  getJobStatus(campaignId: string): Promise<CampaignJobStatus | null>;
  getActiveJobs(): Promise<CampaignJob[]>;
  cleanupStaleJobs(maxAgeMinutes?: number): Promise<number>;
  getFailedSendsForRetry(campaignId: string, limit: number): Promise<Array<{subscriberId: string, email: string, retryCount: number}>>;
  markSendForRetry(campaignId: string, subscriberId: string): Promise<void>;
  bulkMarkSendsForRetry(campaignId: string, subscriberIds: string[]): Promise<number>;
  bulkInsertCampaignSendAttempts(campaignId: string, subscriberIds: string[]): Promise<void>;
  getCampaignSendCounts(campaignId: string): Promise<{total: number, sent: number, failed: number, pending: number, attempting: number}>;

  // ═══════════════════════════════════════════════════════════════
  // IMPORT JOB MANAGEMENT
  // ═══════════════════════════════════════════════════════════════
  getImportJobs(): Promise<ImportJob[]>;
  getImportJob(id: string): Promise<ImportJob | undefined>;
  createImportJob(data: InsertImportJob): Promise<ImportJob>;
  updateImportJob(id: string, data: Partial<ImportJob>): Promise<ImportJob | undefined>;
  enqueueImportJob(importJobId: string, csvFilePath: string, totalLines: number, fileSizeBytes?: number): Promise<ImportJobQueueItem>;
  claimNextImportJob(workerId: string): Promise<ImportJobQueueItem | null>;
  updateImportQueueProgress(queueId: string, processedLines: number): Promise<void>;
  updateImportQueueProgressWithCheckpoint(queueId: string, processedLines: number, processedBytes: number, lastCheckpointLine: number): Promise<void>;
  updateImportQueueHeartbeat(queueId: string): Promise<void>;
  getImportQueueItem(queueId: string): Promise<ImportJobQueueItem | null>;
  completeImportQueueJob(jobId: string, status: "completed" | "failed", errorMessage?: string): Promise<void>;
  getImportJobQueueStatus(importJobId: string): Promise<ImportJobQueueStatus | null>;
  cleanupStaleImportJobs(maxAgeMinutes?: number): Promise<number>;
  recoverStuckImportJobs(): Promise<number>;
  cancelImportJob(importJobId: string): Promise<boolean>;

  // ═══════════════════════════════════════════════════════════════
  // SEGMENT IMPORT (REFS) OPERATIONS
  // ═══════════════════════════════════════════════════════════════
  detectImportRefs(jobId: string): Promise<string[]>;
  countAffectedSubscribers(refs: string[]): Promise<number>;
  countBckProtectedSubscribers(refs: string[]): Promise<number>;
  cleanExistingRefs(refs: string[]): Promise<number>;
  deleteSubscribersByRefs(refs: string[]): Promise<{ deleted: number; bckProtected: number }>;
  confirmImportJob(jobId: string, cleanExistingRefs: boolean, deleteExistingRefs?: boolean): Promise<ImportJob | undefined>;
  expireAbandonedImports(): Promise<number>;

  // ═══════════════════════════════════════════════════════════════
  // DATABASE INDEX MANAGEMENT
  // ═══════════════════════════════════════════════════════════════
  dropSubscriberGinIndexes(): Promise<void>;
  recreateSubscriberGinIndexes(): Promise<void>;
  areGinIndexesPresent(): Promise<boolean>;
  ensureTrigramIndex(): Promise<void>;

  // ═══════════════════════════════════════════════════════════════
  // TAG OPERATIONS
  // ═══════════════════════════════════════════════════════════════
  enqueueTagOperation(subscriberId: string, tagValue: string, eventType: "open" | "click" | "unsubscribe", campaignId?: string): Promise<void>;
  claimPendingTagOperations(limit?: number): Promise<Array<{ id: string; subscriberId: string; tagValue: string; eventType: string; retryCount: number }>>;
  completeTagOperation(operationId: string): Promise<void>;
  failTagOperation(operationId: string, error: string): Promise<void>;
  getTagQueueStats(): Promise<{ pending: number; processing: number; completed: number; failed: number }>;
  cleanupCompletedTagOperations(olderThanDays?: number): Promise<number>;
  addTagToSubscriber(subscriberId: string, tagValue: string): Promise<boolean>;
  bulkAddTagToSubscribers(subscriberIds: string[], tagValue: string): Promise<number>;
  bulkAddTags(subscriberIds: string[], tags: string[]): Promise<void>;

  // ═══════════════════════════════════════════════════════════════
  // NULLSINK
  // ═══════════════════════════════════════════════════════════════
  createNullsinkCapture(data: InsertNullsinkCapture): Promise<NullsinkCapture>;
  bulkCreateNullsinkCaptures(data: InsertNullsinkCapture[]): Promise<void>;
  getNullsinkCaptures(options?: { campaignId?: string; limit?: number; offset?: number }): Promise<{ captures: NullsinkCapture[]; total: number }>;
  getNullsinkMetrics(campaignId?: string): Promise<{
    totalEmails: number; successfulEmails: number; failedEmails: number;
    avgHandshakeTimeMs: number; avgTotalTimeMs: number; emailsPerSecond: number;
  }>;
  clearNullsinkCaptures(campaignId?: string): Promise<number>;

  // ═══════════════════════════════════════════════════════════════
  // FLUSH JOBS
  // ═══════════════════════════════════════════════════════════════
  createFlushJob(totalRows: number): Promise<FlushJob>;
  getFlushJob(id: string): Promise<FlushJob | undefined>;
  claimFlushJob(workerId: string): Promise<FlushJob | null>;
  updateFlushJobProgress(jobId: string, processedRows: number): Promise<void>;
  completeFlushJob(jobId: string, status: "completed" | "failed" | "cancelled", errorMessage?: string, processedRows?: number): Promise<void>;
  cancelFlushJob(jobId: string): Promise<boolean>;
  countSubscriberDependencies(): Promise<number>;
  clearSubscriberDependencies(onProgress?: (deletedInBatch: number) => void): Promise<number>;
  truncateSubscribers(): Promise<void>;
  deleteSubscriberBatch(batchSize: number): Promise<number>;
  deleteSubscriberBatchByCtid(batchSize: number): Promise<number>;
  countAllSubscribers(): Promise<number>;
  updateFlushJobTotalRows(jobId: string, totalRows: number): Promise<void>;

  // ═══════════════════════════════════════════════════════════════
  // ERROR LOGGING
  // ═══════════════════════════════════════════════════════════════
  logError(data: InsertErrorLog): Promise<ErrorLog>;
  getErrorLogs(options?: { page?: number; limit?: number; type?: string; severity?: string; campaignId?: string; importJobId?: string }): Promise<{ logs: ErrorLog[]; total: number }>;
  getErrorLogStats(): Promise<{ total: number; byType: Record<string, number>; bySeverity: Record<string, number>; last24Hours: number }>;
  clearErrorLogs(beforeDate?: Date): Promise<number>;

  // ═══════════════════════════════════════════════════════════════
  // USERS
  // ═══════════════════════════════════════════════════════════════
  createUser(data: { username: string; password: string }): Promise<any>;
  getUserByUsername(username: string): Promise<any | null>;
  getUserById(id: string): Promise<any | null>;
  getUserCount(): Promise<number>;
  updateUserPassword(userId: string, hashedPassword: string): Promise<void>;

  // ═══════════════════════════════════════════════════════════════
  // DATABASE MAINTENANCE
  // ═══════════════════════════════════════════════════════════════
  getMaintenanceRules(): Promise<DbMaintenanceRule[]>;
  getMaintenanceRule(id: string): Promise<DbMaintenanceRule | undefined>;
  upsertMaintenanceRule(data: InsertDbMaintenanceRule): Promise<DbMaintenanceRule>;
  updateMaintenanceRule(id: string, data: Partial<InsertDbMaintenanceRule>): Promise<DbMaintenanceRule | undefined>;
  deleteMaintenanceRule(id: string): Promise<void>;
  getMaintenanceLogs(limit?: number): Promise<DbMaintenanceLog[]>;
  createMaintenanceLog(data: Omit<DbMaintenanceLog, 'id' | 'executedAt'>): Promise<DbMaintenanceLog>;
  getTableStats(): Promise<Array<{tableName: string; rowCount: number; sizeBytes: number; sizePretty: string}>>;
  seedDefaultMaintenanceRules(): Promise<void>;

  // ═══════════════════════════════════════════════════════════════
  // DASHBOARD & ANALYTICS
  // ═══════════════════════════════════════════════════════════════
  healthCheck(): Promise<boolean>;
  getDashboardStats(): Promise<{
    totalSubscribers: number; totalCampaigns: number; totalOpens: number; totalClicks: number;
    recentCampaigns: Campaign[]; recentImports: ImportJob[];
  }>;
  getOverallAnalytics(): Promise<{
    totalOpens: number; totalClicks: number; totalCampaigns: number;
    avgOpenRate: number; avgClickRate: number;
    recentCampaigns: Array<{ id: string; name: string; openRate: number; clickRate: number; sentCount: number }>;
  }>;
  getCampaignClickHeatmap(campaignId: string): Promise<{
    htmlContent: string;
    links: Array<{ url: string; clicks: number; uniqueClickers: number; pct: number }>;
    totalClicks: number;
  } | null>;
  getCampaignDeviceStats(campaignId: string): Promise<{
    deviceTypes: Array<{ value: string; count: number }>;
    browsers: Array<{ value: string; count: number }>;
    operatingSystems: Array<{ value: string; count: number }>;
  }>;
  getCampaignProviderOpenRates(campaignId: string): Promise<Array<{
    provider: string; recipients: number; uniqueOpeners: number; openRate: number;
  }>>;
  getCampaignAnalytics(campaignId: string): Promise<{
    campaign: Campaign; totalOpens: number; uniqueOpens: number; totalClicks: number; uniqueClicks: number;
    openRate: number; clickRate: number;
    topLinks: Array<{ url: string; clicks: number; uniqueClickers: number }>;
    recentActivity: Array<{ email: string; type: string; timestamp: string; link?: string }>;
  } | undefined>;
  getCampaignBatchOpenStats(campaignId: string, batchSize?: number): Promise<Array<{
    batchNum: number;
    sent: number;
    opened: number;
    openRate: number;
    batchStart: string;
    batchEnd: string;
  }>>;
}
