import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import * as fs from "fs";
import { Readable } from "stream";
import { logger } from "../logger";

/**
 * Hetzner Object Storage backend for CSV import payloads.
 *
 * Hetzner Object Storage is S3-compatible. We use the AWS SDK v3 with
 * `forcePathStyle: true` (Hetzner requires path-style addressing, not
 * virtual-hosted-style).
 *
 * Path convention (matches the Replit backend in
 * `server/replit_integrations/object_storage/objectStorage.ts`):
 *
 *   uploadLocalFile()  returns  "/objects/imports/{jobId}.csv"
 *   {get,delete}*Object accept   "/objects/imports/{jobId}.csv"
 *
 * Internally the S3 key is `imports/{jobId}.csv` (no leading slash). The
 * `/objects/` prefix is what `csvFilePath.startsWith("/objects/")` checks
 * for in import-processor.ts / import-worker.ts to route between local-fs
 * and object-storage code paths — so as long as we keep that prefix
 * convention, ZERO downstream code needs to change.
 *
 * Required env vars (all five must be set together):
 *   HETZNER_S3_ENDPOINT     e.g. https://fsn1.your-objectstorage.com
 *   HETZNER_S3_REGION       e.g. fsn1
 *   HETZNER_S3_BUCKET       e.g. critsend-imports
 *   HETZNER_S3_ACCESS_KEY   Access Key ID
 *   HETZNER_S3_SECRET_KEY   Secret Access Key
 *
 * Activated by setting STORAGE_BACKEND=hetzner (or "s3") in .env. See
 * server/storage-backends/index.ts for the factory.
 */

const OBJECT_PATH_PREFIX = "/objects/imports/";
const KEY_PREFIX = "imports/";

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
        `Hetzner S3 backend selected (STORAGE_BACKEND=hetzner) but missing env vars: ${missing.join(", ")}. ` +
        `Add them to /home/ubuntu/critsend/.env and pm2 reload.`
      );
    }

    this.bucket = bucket!;
    this.client = new S3Client({
      endpoint,
      region,
      credentials: { accessKeyId: accessKeyId!, secretAccessKey: secretAccessKey! },
      forcePathStyle: true,
    });

    logger.info(`[HETZNER_S3] Initialized: endpoint=${endpoint}, region=${region}, bucket=${bucket}`);
  }

  /** Convert "/objects/imports/{x}" → "imports/{x}" (the S3 key). */
  private pathToKey(objectPath: string): string | null {
    if (!objectPath.startsWith(OBJECT_PATH_PREFIX)) return null;
    return KEY_PREFIX + objectPath.slice(OBJECT_PATH_PREFIX.length);
  }

  /**
   * Upload a local file to Hetzner S3 and return the canonical storage path
   * (with `/objects/` prefix so downstream `startsWith` checks route to
   * object-storage code paths).
   */
  async uploadLocalFile(localFilePath: string, objectName: string): Promise<string> {
    const key = KEY_PREFIX + objectName;
    const stat = fs.statSync(localFilePath);
    const body = fs.createReadStream(localFilePath);
    try {
      await this.client.send(new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: "text/csv",
        ContentLength: stat.size,
      }));
    } finally {
      // best-effort close; the SDK consumes the stream but we destroy in
      // case of throw before consumption.
      try { body.destroy(); } catch {}
    }
    logger.info(`[HETZNER_S3] Uploaded ${stat.size} bytes → s3://${this.bucket}/${key}`);
    return "/objects/" + key;
  }

  async deleteStorageObject(objectPath: string): Promise<boolean> {
    const key = this.pathToKey(objectPath);
    if (!key) {
      logger.warn(`[HETZNER_S3] Refusing to delete non-/objects/ path: ${objectPath}`);
      return false;
    }
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (err: any) {
      logger.error(`[HETZNER_S3] Delete failed for ${key}: ${err?.name || err}`);
      return false;
    }
  }

  async objectExists(objectPath: string): Promise<boolean> {
    const key = this.pathToKey(objectPath);
    if (!key) return false;
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (err: any) {
      const code = err?.$metadata?.httpStatusCode;
      if (code === 404 || err?.name === "NotFound" || err?.name === "NoSuchKey") return false;
      logger.error(`[HETZNER_S3] HEAD failed for ${key}: ${err?.name || err} (http ${code})`);
      return false;
    }
  }

  async getObjectStream(objectPath: string): Promise<NodeJS.ReadableStream> {
    const key = this.pathToKey(objectPath);
    if (!key) throw new Error(`Invalid object path (must start with ${OBJECT_PATH_PREFIX}): ${objectPath}`);
    const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!response.Body) throw new Error(`Empty body in S3 GET response for ${key}`);
    return response.Body as Readable;
  }
}
