import { SMTPServer, SMTPServerSession, SMTPServerDataStream } from "smtp-server";
import { EventEmitter } from "events";
import { logger } from "./logger";

export interface NullsinkConfig {
  port: number;
  simulatedLatencyMs: number;
  failureRate: number; // 0-100 percentage
}

export interface CapturedEmail {
  from: string;
  to: string[];
  subject: string;
  messageSize: number;
  handshakeTimeMs: number;
  totalTimeMs: number;
  status: "captured" | "simulated_failure";
  timestamp: Date;
  campaignId?: string;
  subscriberId?: string;
  mtaId?: string;
}

export interface NullsinkMetrics {
  totalEmails: number;
  successfulEmails: number;
  failedEmails: number;
  averageTimeMs: number;
  emailsPerSecond: number;
  startTime: Date | null;
  isRunning: boolean;
}

class NullsinkSMTPServer extends EventEmitter {
  private server: SMTPServer | null = null;
  private config: NullsinkConfig;
  private metrics: NullsinkMetrics = {
    totalEmails: 0,
    successfulEmails: 0,
    failedEmails: 0,
    averageTimeMs: 0,
    emailsPerSecond: 0,
    startTime: null,
    isRunning: false,
  };
  private totalTimeMs: number = 0;
  private captures: CapturedEmail[] = [];
  private maxCaptures: number = 10000; // Keep last 10k for memory safety

  constructor(config: Partial<NullsinkConfig> = {}) {
    super();
    this.config = {
      port: config.port || 2525,
      simulatedLatencyMs: config.simulatedLatencyMs || 0,
      failureRate: config.failureRate || 0,
    };
  }

  private startInProgress = false;

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.server && this.metrics.isRunning) {
        resolve();
        return;
      }

      if (this.startInProgress) {
        reject(new Error("Nullsink SMTP server start already in progress"));
        return;
      }

      this.startInProgress = true;

      const cleanup = () => {
        this.startInProgress = false;
        clearTimeout(startTimeout);
      };

      const startTimeout = setTimeout(() => {
        logger.error(`Nullsink SMTP server start timed out on port ${this.config.port}`);
        if (this.server) {
          try { this.server.close(); } catch (_) {}
          this.server = null;
        }
        this.metrics.isRunning = false;
        cleanup();
        reject(new Error(`Nullsink SMTP server failed to start within 10 seconds on port ${this.config.port}`));
      }, 10000);

      this.server = new SMTPServer({
        secure: false,
        authOptional: true,
        disabledCommands: ["STARTTLS"],
        
        maxClients: 250,
        
        onConnect: (session: SMTPServerSession, callback: (err?: Error) => void) => {
          callback();
        },

        onMailFrom: (address: { address: string }, session: SMTPServerSession, callback: (err?: Error) => void) => {
          (session as any).mailFrom = address.address;
          (session as any).startTime = Date.now();
          callback();
        },

        onRcptTo: (address: { address: string }, session: SMTPServerSession, callback: (err?: Error) => void) => {
          if (!(session as any).rcptTo) {
            (session as any).rcptTo = [];
          }
          (session as any).rcptTo.push(address.address);
          callback();
        },

        onData: (stream: SMTPServerDataStream, session: SMTPServerSession, callback: (err?: Error) => void) => {
          const chunks: Buffer[] = [];
          let subject = "";
          
          stream.on("data", (chunk: Buffer) => {
            chunks.push(chunk);
            // Extract subject from headers
            const content = chunk.toString();
            const subjectMatch = content.match(/^Subject:\s*(.+)$/mi);
            if (subjectMatch) {
              subject = subjectMatch[1].trim();
            }
          });

          stream.on("end", async () => {
            const messageSize = Buffer.concat(chunks).length;
            const startTime = (session as any).startTime || Date.now();
            const handshakeTimeMs = Date.now() - startTime;
            
            // Apply simulated latency
            if (this.config.simulatedLatencyMs > 0) {
              await this.sleep(this.config.simulatedLatencyMs);
            }
            
            const totalTimeMs = Date.now() - startTime;
            
            // Check if we should simulate a failure
            const shouldFail = Math.random() * 100 < this.config.failureRate;
            
            const capture: CapturedEmail = {
              from: (session as any).mailFrom || "",
              to: (session as any).rcptTo || [],
              subject: subject || "(no subject)",
              messageSize,
              handshakeTimeMs,
              totalTimeMs,
              status: shouldFail ? "simulated_failure" : "captured",
              timestamp: new Date(),
            };
            
            // Update metrics
            this.metrics.totalEmails++;
            if (shouldFail) {
              this.metrics.failedEmails++;
            } else {
              this.metrics.successfulEmails++;
            }
            this.totalTimeMs += totalTimeMs;
            this.metrics.averageTimeMs = this.totalTimeMs / this.metrics.totalEmails;
            
            // Calculate emails per second
            if (this.metrics.startTime) {
              const elapsedSeconds = (Date.now() - this.metrics.startTime.getTime()) / 1000;
              this.metrics.emailsPerSecond = elapsedSeconds > 0 
                ? this.metrics.totalEmails / elapsedSeconds 
                : 0;
            }
            
            // Store capture (with rotation to prevent memory issues)
            this.captures.push(capture);
            if (this.captures.length > this.maxCaptures) {
              this.captures = this.captures.slice(-this.maxCaptures);
            }
            
            // Emit event for external handling
            this.emit("capture", capture);
            
            if (shouldFail) {
              callback(new Error("Simulated SMTP failure"));
            } else {
              callback();
            }
          });
        },
      });

      this.server.on("error", (err) => {
        logger.error('NULLSINK server error', { error: String(err) });
        if (this.server) {
          try { this.server.close(); } catch (_) {}
          this.server = null;
        }
        this.metrics.isRunning = false;
        this.emit("error", err);
        cleanup();
        reject(err);
      });

      this.server.listen(this.config.port, "0.0.0.0", () => {
        cleanup();
        logger.info('NULLSINK SMTP server listening', { port: this.config.port });
        this.metrics.startTime = new Date();
        this.metrics.isRunning = true;
        this.emit("started");
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      
      this.server.close(() => {
        logger.info('NULLSINK SMTP server stopped');
        this.server = null;
        this.metrics.isRunning = false;
        this.emit("stopped");
        resolve();
      });
    });
  }

  updateConfig(config: Partial<NullsinkConfig>): void {
    this.config = { ...this.config, ...config };
    logger.info('NULLSINK config updated', { latency: this.config.simulatedLatencyMs, failureRate: this.config.failureRate });
  }

  resetMetrics(): void {
    this.metrics = {
      totalEmails: 0,
      successfulEmails: 0,
      failedEmails: 0,
      averageTimeMs: 0,
      emailsPerSecond: 0,
      startTime: this.metrics.isRunning ? new Date() : null,
      isRunning: this.metrics.isRunning,
    };
    this.totalTimeMs = 0;
    this.captures = [];
    logger.info('NULLSINK metrics reset');
  }

  getMetrics(): NullsinkMetrics {
    // Recalculate emails per second
    if (this.metrics.startTime && this.metrics.isRunning) {
      const elapsedSeconds = (Date.now() - this.metrics.startTime.getTime()) / 1000;
      this.metrics.emailsPerSecond = elapsedSeconds > 0 
        ? this.metrics.totalEmails / elapsedSeconds 
        : 0;
    }
    return { ...this.metrics };
  }

  getCaptures(limit: number = 100, campaignId?: string): CapturedEmail[] {
    let filtered = this.captures;
    if (campaignId) {
      filtered = filtered.filter(c => c.campaignId === campaignId);
    }
    return filtered.slice(-limit);
  }

  getConfig(): NullsinkConfig {
    return { ...this.config };
  }

  isRunning(): boolean {
    return this.metrics.isRunning;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Singleton instance
let nullsinkServer: NullsinkSMTPServer | null = null;

export function getNullsinkServer(): NullsinkSMTPServer {
  if (!nullsinkServer) {
    nullsinkServer = new NullsinkSMTPServer({ port: 2525 });
  }
  return nullsinkServer;
}

export async function startNullsinkServer(config?: Partial<NullsinkConfig>): Promise<void> {
  const server = getNullsinkServer();
  if (config) {
    server.updateConfig(config);
  }
  await server.start();
}

export async function stopNullsinkServer(): Promise<void> {
  const server = getNullsinkServer();
  await server.stop();
}

export { NullsinkSMTPServer };
