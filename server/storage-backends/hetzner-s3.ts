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
 * for in import-processor.ts / import-worker.ts to route between local-fs
 * and object-storage code paths — keeping this prefix means ZERO downstream
 * code changes for the routing logic.
 *
 * Required env vars: HETZNER_S3_{ENDPOINT,REGION,BUCKET,ACCESS_KEY,SECRET_KEY}.
 * Activated by STORAGE_BACKEND=hetzner (or "s3"). See ./index.ts factory.
 *
 * Reliability features (Hetzner audit 2026-05-25):
 * - **Multipart uploads** via @aws-sdk/lib-storage `Upload` class: 8MB parts,
 *   4 parts in parallel, automatic per-part retry. Single multi-GB uploads
 *   no longer fail on a single network hiccup.
 * - **Bounded timeouts** via NodeHttpHandler: connect 5s, socket 120s per
 *   request. Defaults are 0 (infinite) which let stuck sockets hang the
 *   worker loop indefinitely.
 * - **Capped retries**: maxAttempts=4 (3 retries) for non-upload commands.
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

// Retry budget for non-upload commands (HEAD/GET/DELETE). The Upload class
// has its own per-part retry, so this only governs simple commands.
const MAX_ATTEMPTS = 4;

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
      requestHandler: new NodeHttpHandler({
        connectionTimeout: CONNECTION_TIMEOUT_MS,
        socketTimeout: SOCKET_TIMEOUT_MS,
      }),
    });

    logger.info(
      `[HETZNER_S3] Initialized: endpoint=${endpoint}, region=${region}, bucket=${bucket}, ` +
      `partSize=${MULTIPART_PART_SIZE / 1024 / 1024}MB, queueSize=${MULTIPART_QUEUE_SIZE}, ` +
      `connectTimeout=${CONNECTION_TIMEOUT_MS}ms, socketTimeout=${SOCKET_TIMEOUT_MS}ms, maxAttempts=${MAX_ATTEMPTS}`
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
    const body = fs.createReadStream(localFilePath);
    const start = Date.now();
    let partsUploaded = 0;

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
      throw classifyS3Error(err, "PUT", key);
    } finally {
      // Safety net: if the SDK threw before/while consuming the stream, the
      // read fd would leak. destroy() is a no-op if already consumed/closed.
      try { body.destroy(); } catch {}
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
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
      logger.debug(`[HETZNER_S3] Deleted s3://${this.bucket}/${key}`);
      return true;
    } catch (err: any) {
      const classified = classifyS3Error(err, "DELETE", key);
      if (classified instanceof ObjectStorageNotFound) {
        // Idempotent: object already gone, treat as success.
        logger.debug(`[HETZNER_S3] Delete: ${key} already gone (idempotent)`);
        return true;
      }
      throw classified;
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
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (err: any) {
      const classified = classifyS3Error(err, "HEAD", key);
      if (classified instanceof ObjectStorageNotFound) return false;
      logger.warn(`[HETZNER_S3] HEAD non-404 error for ${key}: ${classified.message}`);
      throw classified;
    }
  }

  /**
   * Open a read stream on the object body. Throws ObjectStorageNotFound on
   * 404 (worker treats as permanent failure), Access/Transient on others.
   */
  async getObjectStream(objectPath: string): Promise<NodeJS.ReadableStream> {
    const key = this.pathToKey(objectPath);
    let response;
    try {
      response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (err) {
      throw classifyS3Error(err, "GET", key);
    }
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
