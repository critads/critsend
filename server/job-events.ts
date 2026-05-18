import { EventEmitter } from "events";
import type Redis from "ioredis";
import { redisConnection, isRedisConfigured } from "./redis";
import { logger } from "./logger";

export interface JobProgressEvent {
  jobType: "import" | "flush" | "campaign";
  jobId: string;
  status: "pending" | "processing" | "completed" | "failed" | "cancelled" | "awaiting_confirmation" | "queued" | "sending" | "paused";
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
  deferredCount?: number;
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
 * Publishes a job progress event.
 * When Redis is available (split-process mode), publishes to the
 * "job-progress" Redis channel so the web server's SSE bridge can forward
 * it to connected clients. Falls back to a direct in-process emit when
 * Redis is not configured (monolith mode).
 *
 * Centralised here so background workers (campaign sender, drain worker,
 * import worker, …) can all reach the SSE pipe without each importing
 * Redis directly.
 */
export function publishJobProgress(event: JobProgressEvent): void {
  if (isRedisConfigured && redisConnection) {
    redisConnection.publish("job-progress", JSON.stringify(event)).catch((err: any) => {
      logger.warn("[JOB_EVENTS] Redis publish failed, falling back to direct emit", { error: err?.message });
      jobEvents.emitProgress(event);
    });
  } else {
    jobEvents.emitProgress(event);
  }
}

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
