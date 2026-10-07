import Redis from "ioredis";
import { logger } from "./logger";

const REDIS_URL = process.env.REDIS_URL;

export const isRedisConfigured = !!REDIS_URL;

// BullMQ is opt-in (USE_BULLMQ=true) AND needs Redis. When it is off, campaign /
// import / flush jobs flow through the PostgreSQL job tables + LISTEN/NOTIFY,
// and automations rely on their periodic poller. Redis itself stays in use for
// the worker heartbeat, the shared count cache and the job-progress pub/sub.
// Before this flag existed, the 4 BullMQ Workers (plus their Queue objects and
// a dedicated connection) started whenever REDIS_URL was set: with the flag
// off they polled empty queues forever, generated most of the Redis traffic
// and all of the error spam during the 2026-10-07 Upstash rate-limit outage.
export const isBullMQEnabled = isRedisConfigured && process.env.USE_BULLMQ === "true";

export function createRedisConnection(name: string): Redis | null {
  if (!REDIS_URL) return null;
  const client = new Redis(REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    lazyConnect: false,
  });
  client.on("error", (err) =>
    logger.warn(`[Redis/${name}] Connection error: ${err.message}`)
  );
  client.on("connect", () => logger.info(`[Redis/${name}] Connected`));
  client.on("reconnecting", () =>
    logger.warn(`[Redis/${name}] Reconnecting...`)
  );
  return client;
}

export const redisConnection = createRedisConnection("main");
// Dedicated BullMQ connection (BullMQ needs maxRetriesPerRequest=null and
// blocks on it) — only opened when BullMQ is actually enabled.
export const redisBullMQ = isBullMQEnabled ? createRedisConnection("bullmq") : null;

export async function closeRedisConnections(): Promise<void> {
  await Promise.allSettled([
    redisConnection?.quit(),
    redisBullMQ?.quit(),
  ]);
  logger.info("[Redis] Connections closed");
}
