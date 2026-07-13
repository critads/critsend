import {
  S3Client,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import * as fs from "fs";
import { Readable } from "stream";
import { logger } from "../logger";
import {
  ObjectStorageNotFound,
  ObjectStorageInvalidPath,
  ObjectStorageTransientError,
  classifyS3Error,
} from "./errors";

/**
 * Hetzner Object Storage backend for CSV import payloads. S3-compatible via
 * AWS SDK v3 with `forcePathStyle: true` (Hetzner requires path-style).
 *
 * Path convention (matches the Replit backend in
 * `server/replit_integrations/object_storage/objectStorage.ts`):
 *   uploadLocalFile()  returns  "/objects/imports/{jobId}.csv"
 *   {get,head,delete}*Object accept the same form.
 * The `/objects/` prefix is what `csvFilePath.startsWith("/objects/")` checks
 * for in import-processor.ts to route between local-fs
 * and object-storage code paths — keeping this prefix means ZERO downstream
 * code changes for the routing logic.
 *
 * Required env vars: HETZNER_S3_{ENDPOINT,REGION,BUCKET,ACCESS_KEY,SECRET_KEY}.
 * Activated by STORAGE_BACKEND=hetzner (or "s3"). See ./index.ts factory.
 *
 * Reliability features (Hetzner audit 2026-05-25; throttle hardening 2026-05-31):
 * - **Multipart uploads** via @aws-sdk/lib-storage `Upload` class: 8MB parts,
 *   4 parts in parallel, automatic per-part retry. Single multi-GB uploads
 *   no longer fail on a single network hiccup.
 * - **Bounded timeouts** via NodeHttpHandler: connect 5s, socket 120s per
 *   request. Defaults are 0 (infinite) which let stuck sockets hang the
 *   worker loop indefinitely.
 * - **Adaptive SDK retry** (2026-05-31): `retryMode: "adaptive"` adds a
 *   client-side rate limiter (token bucket) that proactively backs off when
 *   Hetzner returns `503 SlowDown` / throttling, on top of exponential
 *   backoff+jitter. `maxAttempts` raised to 8 (env HETZNER_S3_MAX_ATTEMPTS).
 *   This is the primary fix for the production incident where a SlowDown storm
 *   failed every import: the SYNCHRONOUS upload path (POST /api/import and the
 *   chunked-complete handler) is NOT in the worker job loop, so the typed-error
 *   requeue mechanism never got a chance — 4 standard attempts exhausted in
 *   ~seconds and the job was marked permanently `failed`.
 * - **App-level transient retry** (2026-05-31): `withTransientRetry` wraps
 *   every op (upload/HEAD/GET/DELETE) with bounded exponential backoff+jitter
 *   (env HETZNER_S3_RETRY_ROUNDS, default 3) that retries ONLY the typed
 *   `ObjectStorageTransientError` (5xx/throttle/timeout/network). Belt-and-
 *   suspenders for a sustained storm that outlasts the SDK budget — the upload
 *   recovers without the user having to re-upload. NotFound/Access errors are
 *   deterministic and pass through immediately (never retried).
 * - **Typed errors**: see ./errors.ts. The four methods distinguish
 *   NotFound / AccessError / TransientError so callers can correctly decide
 *   "permafail vs requeue with backoff" — fixes the original bug where ANY
 *   error became "csv missing" and the user got stuck in a Requeue loop.
 */

const OBJECT_PATH_PREFIX = "/objects/imports/";
const KEY_PREFIX = "imports/";

// 8MB parts — Hetzner's MultipartUpload minimum is 5MB. 8MB is a sweet spot:
// big enough to amortize per-request overhead, small enough that a failed
// part retry is cheap. 4 parts in parallel ≈ 32MB in flight per upload.
const MULTIPART_PART_SIZE = 8 * 1024 * 1024;
const MULTIPART_QUEUE_SIZE = 4;

// Per-request timeouts. Socket timeout = max gap between two bytes; for a
// big PUT part this is the part-upload deadline. 120s is generous (≥1 Mbps
// per part), and the SDK retries on socket timeout per maxAttempts.
const CONNECTION_TIMEOUT_MS = 5_000;
const SOCKET_TIMEOUT_MS = 120_000;

// SDK retry budget per request. Raised from 4→8 (2026-05-31 throttle incident)
// so the adaptive rate limiter has room to ride out a sustained Hetzner
// `503 SlowDown` storm with exponential backoff before giving up. Governs both
// non-upload commands (HEAD/GET/DELETE) and each multipart part PUT.
const MAX_ATTEMPTS = Math.max(1, parseInt(process.env.HETZNER_S3_MAX_ATTEMPTS || "8", 10) || 8);

// App-level transient retry (on top of the SDK's own retry). Retries ONLY the
// typed ObjectStorageTransientError (5xx / throttle / timeout / network). Total
// extra attempts = RETRY_ROUNDS, with exponential backoff RETRY_BASE_MS * 2^n
// capped at RETRY_MAX_MS, plus jitter. Bounded so the synchronous import-setup
// HTTP handler can't hang indefinitely.
const RETRY_ROUNDS = Math.max(0, parseInt(process.env.HETZNER_S3_RETRY_ROUNDS || "3", 10) || 0);
const RETRY_BASE_MS = Math.max(50, parseInt(process.env.HETZNER_S3_RETRY_BASE_MS || "500", 10) || 500);
const RETRY_MAX_MS = Math.max(RETRY_BASE_MS, parseInt(process.env.HETZNER_S3_RETRY_MAX_MS || "8000", 10) || 8000);

export class HetznerS3Service {
  private client: S3Client;
  private bucket: string;

  constructor() {
    const endpoint = process.env.HETZNER_S3_ENDPOINT?.trim();
    const region = process.env.HETZNER_S3_REGION?.trim();
    const bucket = process.env.HETZNER_S3_BUCKET?.trim();
    const accessKeyId = process.env.HETZNER_S3_ACCESS_KEY?.trim();
    const secretAccessKey = process.env.HETZNER_S3_SECRET_KEY?.trim();

    const missing: string[] = [];
    if (!endpoint) missing.push("HETZNER_S3_ENDPOINT");
    if (!region) missing.push("HETZNER_S3_REGION");
    if (!bucket) missing.push("HETZNER_S3_BUCKET");
    if (!accessKeyId) missing.push("HETZNER_S3_ACCESS_KEY");
    if (!secretAccessKey) missing.push("HETZNER_S3_SECRET_KEY");
    if (missing.length > 0) {
      throw new Error(
        `Hetzner S3 backend selected but missing env vars: ${missing.join(", ")}. ` +
        `Add them to /home/ubuntu/critsend/.env and pm2 reload.`
      );
    }

    this.bucket = bucket!;
    this.client = new S3Client({
      endpoint,
      region,
      credentials: { accessKeyId: accessKeyId!, secretAccessKey: secretAccessKey! },
      forcePathStyle: true,
      maxAttempts: MAX_ATTEMPTS,
      // "adaptive" adds a client-side rate limiter that proactively throttles
      // outbound requests when it observes `503 SlowDown` / throttling responses
      // — the correct posture for Hetzner Object Storage, which SlowDowns under
      // bursts of concurrent multipart PUTs. Combined with the higher maxAttempts
      // and the app-level withTransientRetry below, this is the permanent fix for
      // the 2026-05-31 "all imports crashing" incident.
      retryMode: "adaptive",
      requestHandler: new NodeHttpHandler({
        connectionTimeout: CONNECTION_TIMEOUT_MS,
        socketTimeout: SOCKET_TIMEOUT_MS,
      }),
    });

    logger.info(
      `[HETZNER_S3] Initialized: endpoint=${endpoint}, region=${region}, bucket=${bucket}, ` +
      `partSize=${MULTIPART_PART_SIZE / 1024 / 1024}MB, queueSize=${MULTIPART_QUEUE_SIZE}, ` +
      `connectTimeout=${CONNECTION_TIMEOUT_MS}ms, socketTimeout=${SOCKET_TIMEOUT_MS}ms, ` +
      `maxAttempts=${MAX_ATTEMPTS}, retryMode=adaptive, appRetryRounds=${RETRY_ROUNDS}`
    );
  }

  /** Convert "/objects/imports/{x}" → "imports/{x}" (the S3 key). */
  private pathToKey(objectPath: string): string {
    if (!objectPath.startsWith(OBJECT_PATH_PREFIX)) {
      throw new ObjectStorageInvalidPath(
        `Path must start with ${OBJECT_PATH_PREFIX}, got: ${objectPath}`
      );
    }
    return KEY_PREFIX + objectPath.slice(OBJECT_PATH_PREFIX.length);
  }

  /**
   * Run `op` with bounded exponential-backoff retry, but ONLY for the typed
   * `ObjectStorageTransientError` (5xx / `503 SlowDown` / throttle / timeout /
   * network). NotFound / Access / InvalidPath are deterministic and re-thrown
   * immediately — retrying them is futile.
   *
   * `op` MUST classify raw SDK errors via classifyS3Error() before throwing so
   * we can branch on the typed hierarchy here. For the multipart upload, `op`
   * also recreates the read stream each round (a consumed stream can't be
   * replayed). This runs on top of the SDK's own per-request retry — it exists
   * to survive a SlowDown storm that outlasts the SDK budget.
   */
  private async withTransientRetry<T>(op: () => Promise<T>, label: string): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await op();
      } catch (err) {
        const isTransient = err instanceof ObjectStorageTransientError;
        if (!isTransient || attempt >= RETRY_ROUNDS) throw err;
        const backoff = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** attempt);
        const delay = backoff + Math.floor(Math.random() * (backoff / 2));
        logger.warn(
          `[HETZNER_S3] ${label} transient error (app retry ${attempt + 1}/${RETRY_ROUNDS}, waiting ${delay}ms): ${(err as Error).message}`
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  /**
   * Upload a local file to Hetzner S3 via multipart upload and return the
   * canonical `/objects/imports/...` storage path.
   *
   * Uses @aws-sdk/lib-storage `Upload` which:
   *   - splits the file into parts of MULTIPART_PART_SIZE,
   *   - uploads QUEUE_SIZE parts in parallel,
   *   - retries failed parts individually (NOT the whole file),
   *   - aborts the multipart upload on any unrecoverable error
   *     (`leavePartsOnError: false`) so Hetzner won't accumulate orphan
   *     part fragments and bill us for them.
   *
   * Logs structured size + duration for the upcoming Prometheus dashboard.
   */
  async uploadLocalFile(localFilePath: string, objectName: string): Promise<string> {
    const key = KEY_PREFIX + objectName;
    const stat = fs.statSync(localFilePath);
    const start = Date.now();
    let partsUploaded = 0;

    try {
      // withTransientRetry re-invokes this op on a SlowDown storm. A consumed
      // read stream can't be replayed, so the stream + uploader are recreated
      // inside the op on every round. classifyS3Error() runs here so the
      // wrapper can branch on the typed hierarchy (only transient is retried).
      await this.withTransientRetry(async () => {
        partsUploaded = 0;
        const body = fs.createReadStream(localFilePath);
        try {
          const uploader = new Upload({
            client: this.client,
            params: {
              Bucket: this.bucket,
              Key: key,
              Body: body,
              ContentType: "text/csv",
              ContentLength: stat.size,
            },
            partSize: MULTIPART_PART_SIZE,
            queueSize: MULTIPART_QUEUE_SIZE,
            leavePartsOnError: false,
          });

          uploader.on("httpUploadProgress", (progress) => {
            if (progress.part && progress.part > partsUploaded) {
              partsUploaded = progress.part;
            }
          });

          await uploader.done();
        } catch (err) {
          throw classifyS3Error(err, "PUT", key);
        } finally {
          // Safety net: if the SDK threw before/while consuming the stream, the
          // read fd would leak. destroy() is a no-op if already consumed/closed.
          try { body.destroy(); } catch {}
        }
      }, `PUT ${key}`);

      const durationMs = Date.now() - start;
      const mbps = stat.size > 0 ? ((stat.size / 1024 / 1024) / (durationMs / 1000)).toFixed(2) : "0";
      logger.info(
        `[HETZNER_S3] Uploaded size_bytes=${stat.size} duration_ms=${durationMs} mbps=${mbps} parts=${partsUploaded} → s3://${this.bucket}/${key}`
      );
      return "/objects/" + key;
    } catch (err) {
      const durationMs = Date.now() - start;
      logger.error(
        `[HETZNER_S3] Upload FAILED size_bytes=${stat.size} duration_ms=${durationMs} parts_completed=${partsUploaded} key=${key}: ${(err as any)?.name || err}`
      );
      // Already classified inside the retry op.
      throw err;
    }
  }

  /**
   * Delete an object from S3. Idempotent: a 404 means "already gone, all
   * good" and resolves with `true`. Throws ObjectStorageAccessError /
   * ObjectStorageTransientError for everything else so the caller can
   * distinguish a real cleanup failure from a benign no-op.
   *
   * Returns `Promise<boolean>` (always true on success) for signature
   * compatibility with the Replit ObjectStorageService union type. All
   * existing callers wrap the call in try/catch, so a thrown typed error
   * gets logged at the cleanup site without breaking the import flow.
   */
  async deleteStorageObject(objectPath: string): Promise<boolean> {
    const key = this.pathToKey(objectPath);
    try {
      await this.withTransientRetry(async () => {
        try {
          await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
        } catch (err) {
          throw classifyS3Error(err, "DELETE", key);
        }
      }, `DELETE ${key}`);
      logger.debug(`[HETZNER_S3] Deleted s3://${this.bucket}/${key}`);
      return true;
    } catch (err: any) {
      if (err instanceof ObjectStorageNotFound) {
        // Idempotent: object already gone, treat as success.
        logger.debug(`[HETZNER_S3] Delete: ${key} already gone (idempotent)`);
        return true;
      }
      throw err;
    }
  }

  /**
   * Returns true if the object exists, false on confirmed 404.
   * Throws ObjectStorageAccessError on 403/auth issues, throws
   * ObjectStorageTransientError on 5xx/timeout — caller (worker job loop)
   * should requeue with backoff rather than mark the job failed.
   *
   * This is the critical fix: the previous version returned `false` for ALL
   * errors, indistinguishable from a real NotFound — which caused users to
   * be stuck in a Requeue loop on transient infra issues.
   */
  async objectExists(objectPath: string): Promise<boolean> {
    const key = this.pathToKey(objectPath);
    try {
      await this.withTransientRetry(async () => {
        try {
          await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
        } catch (err) {
          throw classifyS3Error(err, "HEAD", key);
        }
      }, `HEAD ${key}`);
      return true;
    } catch (err: any) {
      if (err instanceof ObjectStorageNotFound) return false;
      logger.warn(`[HETZNER_S3] HEAD non-404 error for ${key}: ${(err as Error).message}`);
      throw err;
    }
  }

  /**
   * Open a read stream on the object body. Throws ObjectStorageNotFound on
   * 404 (worker treats as permanent failure), Access/Transient on others.
   */
  async getObjectStream(objectPath: string): Promise<NodeJS.ReadableStream> {
    const key = this.pathToKey(objectPath);
    const response = await this.withTransientRetry(async () => {
      try {
        return await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      } catch (err) {
        throw classifyS3Error(err, "GET", key);
      }
    }, `GET ${key}`);
    if (!response.Body) {
      // Per AWS SDK docs this only happens on truly empty responses, which
      // for S3 GetObject on an existing key means a 0-byte object. The CSV
      // import pipeline rejects empty CSVs upstream (lineCount < 2) so this
      // should be unreachable, but treat as NotFound to avoid silent corruption.
      throw new ObjectStorageNotFound(`[GET] ${key} returned empty body (0-byte object?)`);
    }
    return response.Body as Readable;
  }
}
