import { EventEmitter } from "events";
import type Redis from "ioredis";

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
  phase?: string;
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

/**
 * Bridges Redis pub/sub → in-process EventEmitter for the web server.
 * The subscriber connection must be dedicated — Redis subscriptions block
 * the connection for any other commands.
 *
 * Call from server/index.ts once Redis is available.
 */
export function startRedisProgressBridge(redisSubscriber: Redis): void {
  redisSubscriber.subscribe("job-progress");
  redisSubscriber.on("message", (channel, message) => {
    if (channel === "job-progress") {
      try {
        const data = JSON.parse(message) as JobProgressEvent;
        jobEvents.emitProgress(data);
      } catch {
        // Ignore malformed messages
      }
    }
  });
}
