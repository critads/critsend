import multer from "multer";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { ObjectStorageService } from "./replit_integrations/object_storage";

// Object storage service for persistent file storage (survives deployments)
const objectStorageService = new ObjectStorageService();

/**
 * Resolve the directory where uploaded import CSVs are persisted between
 * the upload step and the worker that processes them.
 *
 * Priority:
 *   1. IMPORT_UPLOAD_DIR env var (recommended in production: a path OUTSIDE
 *      the application directory so deploys / PM2 restarts don't wipe queued
 *      imports — e.g. `/var/lib/critsend/uploads/imports`).
 *   2. Default `<cwd>/uploads/imports` (fine for dev; risky in prod because
 *      `git pull` / atomic deploys can blow it away).
 *
 * The companion startup guard in server/index.ts logs a loud ERROR when
 * NODE_ENV=production and the resolved path still lives inside process.cwd().
 */
function resolveImportUploadDir(): string {
  const fromEnv = process.env.IMPORT_UPLOAD_DIR?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  return path.join(process.cwd(), "uploads", "imports");
}

function resolveImportChunksDir(): string {
  const fromEnv = process.env.IMPORT_CHUNKS_DIR?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  // Default: sibling directory next to uploads/imports so both share the
  // same persistent volume in production.
  return path.join(path.dirname(resolveImportUploadDir()), "chunks");
}

const UPLOADS_DIR_BASE = resolveImportUploadDir();
const CHUNKS_DIR_BASE = resolveImportChunksDir();

/**
 * Status of an upload directory after the boot-time provisioning attempt.
 * Consumed by routes (to short-circuit with HTTP 503) and by the startup
 * guard in server/index.ts (to surface a loud, actionable error log).
 */
export type UploadDirStatus = {
  path: string;
  ready: boolean;
  error?: string;
  errorCode?: string;
};

/**
 * Try to ensure a directory exists AND is writable by the current process.
 * On failure, returns a structured error instead of throwing — callers can
 * decide how to degrade. We deliberately do NOT crash the process here:
 * a missing/unwritable upload dir should disable uploads only, not take
 * down the whole web tier (login, sending, tracking, dashboards).
 */
function ensureWritableDir(dir: string): UploadDirStatus {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err: any) {
    return {
      path: dir,
      ready: false,
      error: err?.message ?? String(err),
      errorCode: err?.code,
    };
  }
  // mkdirSync succeeded (or dir already existed) — verify writability with a
  // probe file. fs.accessSync(W_OK) lies on some filesystems / when running
  // as root, so the probe write is the authoritative check.
  const probe = path.join(dir, `.write-probe-${process.pid}-${Date.now()}`);
  try {
    fs.writeFileSync(probe, "");
    fs.unlinkSync(probe);
  } catch (err: any) {
    return {
      path: dir,
      ready: false,
      error: err?.message ?? String(err),
      errorCode: err?.code,
    };
  }
  return { path: dir, ready: true };
}

const UPLOADS_DIR_STATUS: UploadDirStatus = ensureWritableDir(UPLOADS_DIR_BASE);
const CHUNKS_DIR_STATUS: UploadDirStatus = ensureWritableDir(CHUNKS_DIR_BASE);

/**
 * Format a human-actionable error line for operators. Includes the failing
 * path, errno code, the username the process runs as, and the exact
 * `sudo chown` command to run to recover. Logged at boot AND surfaced via
 * the upload route's 503 response so the cause is obvious in both places.
 */
export function formatUploadDirError(status: UploadDirStatus): string {
  const user = (() => {
    try { return os.userInfo().username; } catch { return process.env.USER || "app-user"; }
  })();
  // `chown -R user:user <parent>` because the failure is almost always a
  // root-owned parent dir (e.g. /var/lib/critsend) blocking creation /
  // writes inside it. Chowning the parent fixes both create and write.
  const parent = path.dirname(status.path);
  return (
    `[UPLOAD] Import upload dir not usable: ${status.path} ` +
    `(code=${status.errorCode || "UNKNOWN"}, error=${status.error || "unknown"}). ` +
    `Process runs as user "${user}". CSV imports are DISABLED until fixed. ` +
    `Recovery: sudo mkdir -p ${status.path} && sudo chown -R ${user}:${user} ${parent} && sudo chmod -R u+rwX ${parent}`
  );
}

// Emit a single boot-time ERROR per failing dir so operators see it in
// web-err.log without the noise of an uncaught exception / crash loop.
// The startup guard in server/index.ts ALSO surfaces this via the
// in-app system_errors store so it shows up in the admin UI.
if (!UPLOADS_DIR_STATUS.ready) {
  // eslint-disable-next-line no-console
  console.error(formatUploadDirError(UPLOADS_DIR_STATUS));
}
if (!CHUNKS_DIR_STATUS.ready) {
  // eslint-disable-next-line no-console
  console.error(formatUploadDirError(CHUNKS_DIR_STATUS));
}

/**
 * Convenience accessor used by the upload routes to short-circuit with
 * HTTP 503 + a clear message when the on-disk dirs are unusable, instead
 * of letting multer fail mid-request with a generic ENOENT/EACCES.
 */
export function getUploadDirStatus(): {
  uploads: UploadDirStatus;
  chunks: UploadDirStatus;
  ready: boolean;
} {
  return {
    uploads: UPLOADS_DIR_STATUS,
    chunks: CHUNKS_DIR_STATUS,
    ready: UPLOADS_DIR_STATUS.ready && CHUNKS_DIR_STATUS.ready,
  };
}

// Use disk storage for imports to avoid memory issues with large files (300MB+)
const importDiskStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, UPLOADS_DIR_BASE);
  },
  filename: (_req, _file, cb) => {
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1E9)}`;
    cb(null, `import-${uniqueSuffix}.csv`);
  }
});

const uploadToDisk = multer({ 
  storage: importDiskStorage,
  limits: { fileSize: 1024 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowedMimes = ['text/csv', 'text/plain', 'application/csv', 'application/vnd.ms-excel'];
    const allowedExts = ['.csv', '.txt'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowedMimes.includes(file.mimetype) || allowedExts.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only CSV files are allowed for import'));
    }
  },
});

// Disk storage for chunk uploads (no file type filter - chunks are raw binary).
// Writes to CHUNKS_DIR_BASE so the temp chunk file and the final
// `${uploadId}_${index}` chunk path land on the same volume — avoids EXDEV
// errors during renameSync when IMPORT_CHUNKS_DIR is on a different mount
// than IMPORT_UPLOAD_DIR.
const chunkDiskStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, CHUNKS_DIR_BASE);
  },
  filename: (_req, _file, cb) => {
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1E9)}`;
    cb(null, `chunk-${uniqueSuffix}.bin`);
  }
});

const uploadChunkToDisk = multer({
  storage: chunkDiskStorage,
  limits: { fileSize: 30 * 1024 * 1024 },
});

// Memory storage for small file uploads (images, etc.)
const upload = multer({ storage: multer.memoryStorage() });

export {
  uploadToDisk,
  uploadChunkToDisk,
  upload,
  objectStorageService,
  UPLOADS_DIR_BASE,
  CHUNKS_DIR_BASE,
};
