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

  queryClient.setQueryData<ImportJob[]>(["/api/import-jobs"], (old) => {
    if (!old) return old;
    return old.map((job) => {
      if (job.id !== event.jobId) return job;
      const sseTimestamp = Date.now();
      return {
        ...job,
        status: event.status as ImportJob["status"],
        processedRows: event.processedRows,
        newSubscribers: event.newSubscribers ?? job.newSubscribers,
        updatedSubscribers: event.updatedSubscribers ?? job.updatedSubscribers,
        failedRows: event.failedRows ?? job.failedRows,
        duplicatesInFile: event.duplicatesInFile ?? (job as any).duplicatesInFile,
        failureReasons: event.failureReasons ?? job.failureReasons,
        skippedRows: event.skippedRows ?? (job as any).skippedRows,
        errorMessage: event.errorMessage ?? job.errorMessage,
        _sseTimestamp: sseTimestamp,
      };
    });
  });

  if (isTerminal) {
    queryClient.invalidateQueries({ queryKey: ["/api/import-jobs"] });
    queryClient.invalidateQueries({ queryKey: ["/api/subscribers"] });
  }
}

function handleFlushEvent(event: JobProgressEvent) {
  const isTerminal = event.status === "completed" || event.status === "failed";

  queryClient.setQueryData(["/api/subscribers/flush", event.jobId], (old: any) => {
    if (!old) return old;
    return {
      ...old,
      status: event.status,
      processedRows: event.processedRows,
      totalRows: event.totalRows,
      errorMessage: event.errorMessage ?? old.errorMessage,
    };
  });

  if (isTerminal) {
    queryClient.invalidateQueries({ queryKey: ["/api/subscribers/flush", event.jobId] });
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
