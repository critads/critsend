import { ObjectStorageService } from "../replit_integrations/object_storage/objectStorage";
import { HetznerS3Service } from "./hetzner-s3";
import { logger } from "../logger";

/**
 * Storage backend factory for CSV import payloads.
 *
 * Backends:
 *   - "local"   (default): keep CSV on disk in IMPORT_UPLOAD_DIR. Cheapest,
 *                          but vulnerable to "file disappeared" failures on
 *                          dedicated servers (see 2026-05-25 audit).
 *   - "replit":            Replit Object Storage (only works inside Replit
 *                          deployments — needs sidecar at 127.0.0.1:1106).
 *   - "hetzner" / "s3":    Hetzner Object Storage (S3-compatible). Works on
 *                          any self-hosted server. Needs HETZNER_S3_* env vars.
 *
 * Selection is via STORAGE_BACKEND env var. Falls back to "local" if unset
 * or unknown, EXCEPT when STORAGE_BACKEND is set to a non-local value with
 * missing credentials — in that case the backend constructor throws a loud
 * error at boot so the operator catches the misconfig immediately.
 *
 * Returns the SAME interface as the existing Replit ObjectStorageService for
 * the 4 methods used by the import pipeline:
 *   - uploadLocalFile(localPath, objectName) → "/objects/imports/{x}"
 *   - objectExists(path) → boolean
 *   - getObjectStream(path) → ReadableStream
 *   - deleteStorageObject(path) → boolean
 */

export type ObjectStorageBackend = ObjectStorageService | HetznerS3Service;

let singleton: ObjectStorageBackend | null = null;

export function getObjectStorageService(): ObjectStorageBackend {
  if (singleton) return singleton;
  const backend = (process.env.STORAGE_BACKEND || "").toLowerCase().trim();
  if (backend === "hetzner" || backend === "s3") {
    logger.info(`[STORAGE] Using Hetzner S3 backend (STORAGE_BACKEND=${backend})`);
    singleton = new HetznerS3Service();
  } else if (backend === "replit") {
    logger.info(`[STORAGE] Using Replit Object Storage backend`);
    singleton = new ObjectStorageService();
  } else {
    // Local disk — return Replit instance as a stub (it's never actually
    // called when STORAGE_BACKEND is unset because useObjectStorageForImports()
    // returns false). We instantiate Replit to keep the type union simple and
    // because its constructor is side-effect-free.
    singleton = new ObjectStorageService();
  }
  return singleton;
}

/**
 * Returns true when the CSV import pipeline should upload to object storage
 * instead of keeping the file on local disk. Used in the upload route handler
 * and chunked-complete handler to gate the upload-and-delete-local step.
 */
export function useObjectStorageForImports(): boolean {
  const backend = (process.env.STORAGE_BACKEND || "").toLowerCase().trim();
  return backend === "replit" || backend === "hetzner" || backend === "s3";
}
