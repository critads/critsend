import { useEffect } from "react";
import { queryClient } from "@/lib/queryClient";
import type { ImportJob } from "@shared/schema";

export interface JobProgressEvent {
  jobType: "import" | "flush" | "campaign";
  jobId: string;
  status: string;
  processedRows: number;
  totalRows: number;
  newSubscribers?: number;
  updatedSubscribers?: number;
  failedRows?: number;
  duplicatesInFile?: number;
  failureReasons?: Record<string, number>;
  skippedRows?: number;
  sentCount?: number;
  failedCount?: number;
  pendingCount?: number;
  errorMessage?: string;
  phase?: string;
  campaignId?: string;
}

let activeEs: EventSource | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let retryCount = 0;
let refCount = 0;
let sseConnected = false;

export function isSSEConnected(): boolean {
  return sseConnected;
}

function connect() {
  if (activeEs) {
    activeEs.close();
  }

  const es = new EventSource("/api/jobs/stream", { withCredentials: true });
  activeEs = es;

  es.onopen = () => {
    retryCount = 0;
    sseConnected = true;
  };

  es.onmessage = (event) => {
    try {
      const data: JobProgressEvent = JSON.parse(event.data);
      handleEvent(data);
    } catch (_) {}
  };

  es.onerror = () => {
    es.close();
    activeEs = null;
    sseConnected = false;
    if (refCount > 0) {
      const delay = Math.min(1000 * Math.pow(2, retryCount), 30000);
      retryCount++;
      reconnectTimer = setTimeout(connect, delay);
    }
  };
}

function disconnect() {
  if (activeEs) {
    activeEs.close();
    activeEs = null;
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  retryCount = 0;
  sseConnected = false;
}

export function useJobStream() {
  useEffect(() => {
    refCount++;
    if (refCount === 1) {
      connect();
    }

    return () => {
      refCount--;
      if (refCount <= 0) {
        refCount = 0;
        disconnect();
      }
    };
  }, []);
}

function handleEvent(event: JobProgressEvent) {
  switch (event.jobType) {
    case "import":
      handleImportEvent(event);
      break;
    case "flush":
      handleFlushEvent(event);
      break;
    case "campaign":
      handleCampaignEvent(event);
      break;
  }
}

function handleImportEvent(event: JobProgressEvent) {
  const isTerminal = event.status === "completed" || event.status === "failed";
  const sseTimestamp = Date.now();

  queryClient.setQueryData<ImportJob[]>(["/api/import-jobs"], (old) => {
    if (!old) {
      return [{
        id: event.jobId,
        filename: "",
        totalRows: event.totalRows,
        processedRows: event.processedRows,
        newSubscribers: event.newSubscribers ?? 0,
        updatedSubscribers: event.updatedSubscribers ?? 0,
        failedRows: event.failedRows ?? 0,
        status: event.status as ImportJob["status"],
        tagMode: "merge",
        importTarget: "refs",
        detectedRefs: [],
        cleanExistingRefs: false,
        deleteExistingRefs: false,
        errorMessage: event.errorMessage ?? null,
        failureReasons: event.failureReasons ?? null,
        skippedRows: event.skippedRows ?? 0,
        createdAt: new Date(),
        startedAt: new Date(),
        completedAt: null,
        _sseTimestamp: sseTimestamp,
      } as any];
    }

    const found = old.some((j) => j.id === event.jobId);
    if (!found) {
      return [{
        id: event.jobId,
        filename: "",
        totalRows: event.totalRows,
        processedRows: event.processedRows,
        newSubscribers: event.newSubscribers ?? 0,
        updatedSubscribers: event.updatedSubscribers ?? 0,
        failedRows: event.failedRows ?? 0,
        status: event.status as ImportJob["status"],
        tagMode: "merge",
        importTarget: "refs",
        detectedRefs: [],
        cleanExistingRefs: false,
        deleteExistingRefs: false,
        errorMessage: event.errorMessage ?? null,
        failureReasons: event.failureReasons ?? null,
        skippedRows: event.skippedRows ?? 0,
        createdAt: new Date(),
        startedAt: new Date(),
        completedAt: null,
        _sseTimestamp: sseTimestamp,
      } as any, ...old];
    }

    return old.map((job) => {
      if (job.id !== event.jobId) return job;
      const isTerminal = event.status === "completed" || event.status === "failed";
      return {
        ...job,
        status: event.status as ImportJob["status"],
        processedRows: isTerminal ? event.processedRows : Math.max(event.processedRows, job.processedRows || 0),
        newSubscribers: isTerminal ? (event.newSubscribers ?? job.newSubscribers) : Math.max(event.newSubscribers ?? 0, job.newSubscribers || 0),
        updatedSubscribers: isTerminal ? (event.updatedSubscribers ?? job.updatedSubscribers) : Math.max(event.updatedSubscribers ?? 0, job.updatedSubscribers || 0),
        failedRows: isTerminal ? (event.failedRows ?? job.failedRows) : Math.max(event.failedRows ?? 0, job.failedRows || 0),
        duplicatesInFile: event.duplicatesInFile ?? (job as any).duplicatesInFile,
        failureReasons: event.failureReasons ?? job.failureReasons,
        skippedRows: event.skippedRows ?? (job as any).skippedRows,
        errorMessage: event.errorMessage ?? job.errorMessage,
        _sseTimestamp: sseTimestamp,
      };
    });
  });

  if (isTerminal) {
    setTimeout(() => {
      queryClient.invalidateQueries({ queryKey: ["/api/import-jobs"] });
    }, 500);
    queryClient.invalidateQueries({ queryKey: ["/api/subscribers"] });
  }
}

function handleFlushEvent(event: JobProgressEvent) {
  const isTerminal = event.status === "completed" || event.status === "failed";

  queryClient.setQueryData(["/api/subscribers/flush", event.jobId], (old: any) => {
    const base = old || {
      id: event.jobId,
      status: "processing",
      processedRows: 0,
      totalRows: 0,
      errorMessage: null,
    };
    return {
      ...base,
      status: event.status,
      processedRows: event.processedRows,
      totalRows: event.totalRows,
      errorMessage: event.errorMessage ?? base.errorMessage,
      phase: event.phase ?? base.phase,
    };
  });

  if (isTerminal) {
    queryClient.invalidateQueries({ queryKey: ["/api/subscribers"] });
  }
}

function handleCampaignEvent(event: JobProgressEvent) {
  const isTerminal = event.status === "completed" || event.status === "failed" || event.status === "cancelled";

  queryClient.setQueryData<any[]>(["/api/campaigns"], (old) => {
    if (!old) return old;
    return old.map((c) => {
      if (c.id !== event.campaignId) return c;
      return {
        ...c,
        status: isTerminal ? event.status : c.status,
        sentCount: event.sentCount ?? c.sentCount,
        failedCount: event.failedCount ?? c.failedCount,
        pendingCount: event.pendingCount ?? c.pendingCount,
      };
    });
  });

  if (event.campaignId) {
    queryClient.setQueryData(["/api/campaigns", event.campaignId], (old: any) => {
      if (!old) return old;
      return {
        ...old,
        status: isTerminal ? event.status : old.status,
        sentCount: event.sentCount ?? old.sentCount,
        failedCount: event.failedCount ?? old.failedCount,
        pendingCount: event.pendingCount ?? old.pendingCount,
      };
    });
  }

  if (isTerminal) {
    queryClient.invalidateQueries({ queryKey: ["/api/campaigns"] });
    if (event.campaignId) {
      queryClient.invalidateQueries({ queryKey: ["/api/campaigns", event.campaignId] });
    }
  }
}
