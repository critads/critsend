import Redis from "ioredis";
import { logger } from "./logger";

const REDIS_URL = process.env.REDIS_URL;

export const isRedisConfigured = !!REDIS_URL;

function createConnection(name: string): Redis | null {
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

export const redisConnection = createConnection("main");
export const redisBullMQ = createConnection("bullmq");

export async function closeRedisConnections(): Promise<void> {
  await Promise.allSettled([
    redisConnection?.quit(),
    redisBullMQ?.quit(),
  ]);
  logger.info("[Redis] Connections closed");
}
