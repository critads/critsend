import multer from "multer";
import * as path from "path";
import * as fs from "fs";
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

if (!fs.existsSync(UPLOADS_DIR_BASE)) {
  fs.mkdirSync(UPLOADS_DIR_BASE, { recursive: true });
}
if (!fs.existsSync(CHUNKS_DIR_BASE)) {
  fs.mkdirSync(CHUNKS_DIR_BASE, { recursive: true });
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
