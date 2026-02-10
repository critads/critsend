import multer from "multer";
import * as path from "path";
import * as fs from "fs";
import { ObjectStorageService } from "./replit_integrations/object_storage";

// Object storage service for persistent file storage (survives deployments)
const objectStorageService = new ObjectStorageService();

// Ensure uploads directory exists for disk storage
const UPLOADS_DIR_BASE = path.join(process.cwd(), "uploads", "imports");
if (!fs.existsSync(UPLOADS_DIR_BASE)) {
  fs.mkdirSync(UPLOADS_DIR_BASE, { recursive: true });
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

// Disk storage for chunk uploads (no file type filter - chunks are raw binary)
const chunkDiskStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, UPLOADS_DIR_BASE);
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

export { uploadToDisk, uploadChunkToDisk, upload, objectStorageService, UPLOADS_DIR_BASE };
