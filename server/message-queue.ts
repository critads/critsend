import { pool } from "./db";
import { logger } from "./logger";
import pg from "pg";
import crypto from "crypto";

export type QueueChannel = "campaign_jobs" | "import_jobs" | "tag_operations" | "flush_jobs";

const ALL_CHANNELS: QueueChannel[] = ["campaign_jobs", "import_jobs", "tag_operations", "flush_jobs"];

type MessageHandler = (payload: string) => void;

// FALLBACK POLLING ARCHITECTURE
//
// The LISTEN/NOTIFY mechanism is an optimization that reduces job pickup latency.
// It does NOT replace the polling loops in server/routes.ts — those run on fixed
// intervals (setInterval) regardless of whether LISTEN is connected:
//
//   - pollForJobs:        every 2 s   (campaign_jobs)
//   - pollForImportJobs:  every 2 s   (import_jobs)
//   - processTagQueue:    every 500 ms (tag_operations)
//   - pollForFlushJobs:   every 1 s   (flush_jobs)
//
// When the LISTEN connection drops, jobs are never stuck because the polling
// intervals continue independently. The `isFallbackPolling` getter returns true
// when the LISTEN connection has been down for >60 seconds, which consumers can
// check via `messageQueue.isFallbackPolling` for monitoring / alerting purposes.
//
// On successful reconnection, all channels are re-LISTENed and `isFallbackPolling`
// resets to false.

class NotifyQueue {
  private client: pg.Client | null = null;
  private handlers: Map<QueueChannel, MessageHandler[]> = new Map();
  private isConnected = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private isShuttingDown = false;
  private reconnectAttempts = 0;
  private fallbackPoll = false;
  private fallbackPollTimer: NodeJS.Timeout | null = null;
  private firstDisconnectTime: number | null = null;

  async initialize(): Promise<void> {
    if (this.isConnected) {
      logger.warn("NotifyQueue already initialized");
      return;
    }

    if (!process.env.NEON_DATABASE_URL && !process.env.DATABASE_URL) {
      logger.error("NEON_DATABASE_URL or DATABASE_URL not set, cannot initialize NotifyQueue");
      return;
    }

    await this.connect();
  }

  private async connect(): Promise<void> {
    if (this.isShuttingDown) return;

    try {
      const connString = process.env.NEON_DATABASE_URL || process.env.DATABASE_URL!;
      const useSSL = connString.includes("neon.tech") || process.env.DB_SSL === "true";
      this.client = new pg.Client({
        connectionString: connString,
        application_name: "notify_queue_listener",
        ...(useSSL ? { ssl: { rejectUnauthorized: false } } : {}),
      });

      this.client.on("error", (err) => {
        logger.error("NotifyQueue LISTEN client error", { error: err.message });
        this.handleDisconnect();
      });

      this.client.on("end", () => {
        if (!this.isShuttingDown) {
          logger.warn("NotifyQueue LISTEN client disconnected unexpectedly");
          this.handleDisconnect();
        }
      });

      this.client.on("notification", (msg) => {
        const channel = msg.channel as QueueChannel;
        const payload = msg.payload || "";
        const handlers = this.handlers.get(channel);
        if (handlers && handlers.length > 0) {
          for (const handler of handlers) {
            try {
              handler(payload);
            } catch (err) {
              logger.error("Error in NotifyQueue message handler", {
                channel,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
        }
      });

      await this.client.connect();
      
      if (connString.includes("neon.tech") || useSSL) {
        await this.client.query("SET search_path TO public").catch(() => {});
      }

      for (const channel of ALL_CHANNELS) {
        await this.client.query(`LISTEN ${channel}`);
      }

      this.isConnected = true;
      this.reconnectAttempts = 0;
      this.firstDisconnectTime = null;

      if (this.fallbackPoll) {
        this.fallbackPoll = false;
        if (this.fallbackPollTimer) {
          clearInterval(this.fallbackPollTimer);
          this.fallbackPollTimer = null;
        }
        logger.info("NotifyQueue LISTEN connection restored, disabling fallback polling");
      }

      logger.info("NotifyQueue initialized, listening on channels", {
        channels: ALL_CHANNELS,
      });
    } catch (err) {
      logger.error("Failed to connect NotifyQueue LISTEN client", {
        error: err instanceof Error ? err.message : String(err),
      });
      this.isConnected = false;
      this.client = null;
      this.handleDisconnect();
    }
  }

  private handleDisconnect(): void {
    this.isConnected = false;
    this.client = null;

    if (this.firstDisconnectTime === null) {
      this.firstDisconnectTime = Date.now();
    }

    const disconnectedDuration = Date.now() - this.firstDisconnectTime;
    if (disconnectedDuration > 60000 && !this.fallbackPoll) {
      this.fallbackPoll = true;
      logger.warn("NotifyQueue LISTEN connection failed for >60s, enabling fallback polling");
    }

    if (!this.isShuttingDown) {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.isShuttingDown) return;

    const baseDelay = 1000;
    const maxDelay = 30000;
    const delay = Math.min(baseDelay * Math.pow(2, this.reconnectAttempts), maxDelay);
    this.reconnectAttempts++;

    logger.info(`NotifyQueue scheduling reconnect in ${delay}ms (attempt ${this.reconnectAttempts})`);

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      await this.connect();
    }, delay);
  }

  async notify(channel: QueueChannel, payload?: Record<string, any>): Promise<void> {
    try {
      const payloadStr = payload ? JSON.stringify(payload) : "";
      await pool.query(`SELECT pg_notify($1, $2)`, [channel, payloadStr]);
    } catch (err) {
      logger.error("Failed to send NOTIFY", {
        channel,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  onMessage(channel: QueueChannel, handler: MessageHandler): void {
    const existing = this.handlers.get(channel) || [];
    existing.push(handler);
    this.handlers.set(channel, existing);
  }

  async shutdown(): Promise<void> {
    this.isShuttingDown = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.fallbackPollTimer) {
      clearInterval(this.fallbackPollTimer);
      this.fallbackPollTimer = null;
    }

    if (this.client) {
      try {
        await this.client.query("UNLISTEN *");
        await this.client.end();
      } catch (err) {
        logger.error("Error during NotifyQueue shutdown", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      this.client = null;
    }

    this.isConnected = false;
    this.handlers.clear();
    logger.info("NotifyQueue shut down");
  }

  get isFallbackPolling(): boolean {
    return this.fallbackPoll;
  }

  get connected(): boolean {
    return this.isConnected;
  }

  static jobIdToLockId(jobId: string): string {
    const hash = crypto.createHash("md5").update(jobId).digest();
    const num = hash.readBigInt64BE(0);
    return num.toString();
  }

  static async tryAcquireAdvisoryLock(lockId: string): Promise<boolean> {
    const result = await pool.query(
      `SELECT pg_try_advisory_lock($1) as acquired`,
      [lockId]
    );
    return result.rows[0]?.acquired === true;
  }

  static async releaseAdvisoryLock(lockId: string): Promise<void> {
    await pool.query(`SELECT pg_advisory_unlock($1)`, [lockId]);
  }
}

export const messageQueue = new NotifyQueue();
