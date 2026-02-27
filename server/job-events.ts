import { EventEmitter } from "events";

export interface JobProgressEvent {
  jobType: "import" | "flush" | "campaign";
  jobId: string;
  status: "pending" | "processing" | "completed" | "failed" | "cancelled" | "awaiting_confirmation" | "queued";
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

class JobEventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(100);
  }

  emitProgress(event: JobProgressEvent): void {
    this.emit("progress", event);
  }
}

export const jobEvents = new JobEventBus();
