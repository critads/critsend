import { type Express, type Request, type Response } from "express";
import { storage } from "../storage";
import { logger } from "../logger";
import { db } from "../db";
import { sql, eq } from "drizzle-orm";
import { importJobs, importJobQueue } from "@shared/schema";
import * as fs from "fs";
import * as path from "path";
import { uploadToDisk, uploadChunkToDisk, objectStorageService, UPLOADS_DIR_BASE } from "../upload";
import { sanitizeCsvValue } from "../utils";
import { isMemoryPressure } from "../workers";
import { jobEvents, type JobProgressEvent } from "../job-events";

function countLines(filePath: string): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    let lineCount = 0;
    let prevChar = '';
    const stream = fs.createReadStream(filePath, { encoding: 'utf-8', highWaterMark: 64 * 1024 });
    stream.on('data', (chunk: string | Buffer) => {
      const str = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
      for (let i = 0; i < str.length; i++) {
        const ch = str[i];
        if (ch === '\n') {
          lineCount++;
        } else if (prevChar === '\r') {
          lineCount++;
        }
        prevChar = ch;
      }
    });
    stream.on('end', () => {
      if (prevChar && prevChar !== '\n' && prevChar !== '\r') {
        lineCount++;
      } else if (prevChar === '\r') {
        lineCount++;
      }
      resolve(lineCount);
    });
    stream.on('error', reject);
  });
}

// Bootstrap: add forced_tags/forced_refs columns if upgrading from older schema.
// Called explicitly from server startup and awaited before routes are registered.
// Throws on genuine DB errors (no permissions, connection failure) to surface
// misconfigurations immediately rather than allowing silent runtime breakage.
export async function runImportBootstrapMigrations(): Promise<void> {
  try {
    await db.execute(sql`ALTER TABLE import_jobs ADD COLUMN IF NOT EXISTS forced_tags text[] NOT NULL DEFAULT ARRAY[]::text[]`);
    await db.execute(sql`ALTER TABLE import_jobs ADD COLUMN IF NOT EXISTS forced_refs text[] NOT NULL DEFAULT ARRAY[]::text[]`);
    logger.info("[IMPORT] Bootstrap migration: forced_tags/forced_refs columns ready");
  } catch (err: any) {
    logger.error(`[IMPORT] Bootstrap migration FAILED (forced_tags/forced_refs): ${err?.message || err}`);
    throw err;
  }
}

function parseCommaSeparated(raw: unknown): string[] {
  if (!raw || typeof raw !== "string") return [];
  return [...new Set(raw.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean))];
}

export function registerImportExportRoutes(app: Express, helpers: {
  validateId: (id: string) => boolean;
}) {
  const { validateId } = helpers;

  const CHUNKS_DIR = path.join(process.cwd(), "uploads", "chunks");
  if (!fs.existsSync(CHUNKS_DIR)) {
    fs.mkdirSync(CHUNKS_DIR, { recursive: true });
  }

  const chunkedUploads = new Map<string, {
    filename: string;
    tagMode: "merge" | "override";
    importTarget: "auto" | "refs" | "tags";
    forcedTags: string[];
    forcedRefs: string[];
    totalChunks: number;
    totalSize: number;
    receivedChunks: Set<number>;
    createdAt: Date;
  }>();

  setInterval(() => {
    const now = Date.now();
    for (const [uploadId, upload] of chunkedUploads.entries()) {
      if (now - upload.createdAt.getTime() > 60 * 60 * 1000) {
        for (let i = 0; i < upload.totalChunks; i++) {
          const chunkPath = path.join(CHUNKS_DIR, `${uploadId}_${i}`);
          try { fs.unlinkSync(chunkPath); } catch {}
        }
        chunkedUploads.delete(uploadId);
        logger.info(`[CHUNKED] Cleaned up stale upload: ${uploadId}`);
      }
    }
  }, 5 * 60 * 1000);

  app.post("/api/import", uploadToDisk.single("file"), async (req: Request, res: Response) => {
    if (isMemoryPressure) {
      res.setHeader('Retry-After', '60');
      return res.status(503).json({ error: "Server under memory pressure. Please retry later." });
    }
    try {
      logger.info(`[IMPORT] Received import request`);
      if (!req.file) {
        logger.info(`[IMPORT] No file in request`);
        return res.status(400).json({ error: "No file uploaded" });
      }

      const tagMode = (req.body.tagMode === "override") ? "override" : "merge";
      const importTarget = "auto";
      const forcedTags = parseCommaSeparated(req.body.forcedTags);
      const forcedRefs = parseCommaSeparated(req.body.forcedRefs);
      const fileSizeBytes = req.file.size;
      logger.info(`[IMPORT] File received: ${req.file.originalname}, size: ${fileSizeBytes} bytes (${Math.round(fileSizeBytes / 1024 / 1024)}MB), tagMode: ${tagMode}, forcedTags: [${forcedTags.join(",")}], forcedRefs: [${forcedRefs.join(",")}]`);
      
      const csvFilePath = req.file.path;
      logger.info(`[IMPORT] File saved to disk: ${csvFilePath}`);
      
      const lineCount = await countLines(csvFilePath);
      logger.info(`[IMPORT] Streaming line count complete: ${lineCount} lines`);
      
      if (lineCount < 2) {
        logger.info(`[IMPORT] CSV empty or invalid, lines: ${lineCount}`);
        try { fs.unlinkSync(csvFilePath); } catch {}
        return res.status(400).json({ error: "CSV file is empty or invalid" });
      }

      const totalDataRows = lineCount - 1;
      logger.info(`[IMPORT] CSV has ${totalDataRows} data rows`);

      const job = await storage.createImportJob({
        filename: req.file.originalname,
        totalRows: totalDataRows,
        tagMode: tagMode,
        importTarget: importTarget,
        forcedTags,
        forcedRefs,
      });
      logger.info(`[IMPORT] Created import job: ${job.id}`);

      const useReplitStorage = process.env.STORAGE_BACKEND === "replit";
      let storagePath: string;

      if (useReplitStorage) {
        storagePath = await objectStorageService.uploadLocalFile(csvFilePath, `${job.id}.csv`);
        logger.info(`[IMPORT] Uploaded to object storage: ${storagePath}`);
        const objectExists = await objectStorageService.objectExists(storagePath);
        if (!objectExists) {
          throw new Error(`Object storage verification failed: ${storagePath} does not exist after upload`);
        }
        try { fs.unlinkSync(csvFilePath); } catch {}
      } else {
        storagePath = csvFilePath;
        logger.info(`[IMPORT] Using local disk storage: ${storagePath}`);
      }

      const queueItem = await db.transaction(async (tx) => {
        await tx.update(importJobs).set({ status: "queued" }).where(sql`${importJobs.id} = ${job.id}`);
        const [queued] = await tx.insert(importJobQueue).values({
          importJobId: job.id,
          csvFilePath: storagePath,
          totalLines: lineCount,
          processedLines: 0,
          fileSizeBytes,
          processedBytes: 0,
          lastCheckpointLine: 0,
          status: "pending",
        }).returning();
        return queued;
      });
      logger.info(`[IMPORT] Import job ${job.id} enqueued with queue item ID: ${queueItem.id}, path: ${storagePath}`);

      res.status(202).json(job);
    } catch (error) {
      logger.error("[IMPORT] Error starting import:", error);
      if (req.file?.path) {
        try { fs.unlinkSync(req.file.path); } catch {}
      }
      res.status(500).json({ error: "Failed to start import" });
    }
  });

  app.get("/api/import-jobs", async (req: Request, res: Response) => {
    try {
      const jobs = await storage.getImportJobs();
      res.json(jobs);
    } catch (error) {
      logger.error("Error fetching import jobs:", error);
      res.status(500).json({ error: "Failed to fetch import jobs" });
    }
  });

  app.get("/api/import/queue-health", async (_req: Request, res: Response) => {
    try {
      const result = await db.execute(sql`
        SELECT
          COUNT(*)::int AS pending_count,
          EXTRACT(EPOCH FROM (NOW() - MIN(created_at)))::int AS oldest_pending_age_seconds
        FROM import_job_queue
        WHERE status = 'pending'
      `);
      const row = (result.rows as any[])[0];
      res.json({
        pendingCount: Number(row?.pending_count ?? 0),
        oldestPendingAgeSeconds: row?.oldest_pending_age_seconds != null
          ? Number(row.oldest_pending_age_seconds)
          : null,
      });
    } catch (error) {
      logger.error("Error fetching import queue health:", error);
      res.status(500).json({ error: "Failed to fetch queue health" });
    }
  });

  app.post("/api/import/:id/cancel", async (req: Request, res: Response) => {
    try {
      if (!validateId(req.params.id)) {
        return res.status(400).json({ error: "Invalid ID format" });
      }
      const cancelled = await storage.cancelImportJob(req.params.id);
      if (cancelled) {
        logger.info(`[IMPORT] Import job ${req.params.id} cancelled by user`);
        res.json({ success: true, message: "Import cancelled" });
      } else {
        res.status(400).json({ error: "Import cannot be cancelled (already completed or not found)" });
      }
    } catch (error) {
      logger.error("Error cancelling import:", error);
      res.status(500).json({ error: "Failed to cancel import" });
    }
  });

  app.post("/api/import/:id/requeue", async (req: Request, res: Response) => {
    try {
      if (!validateId(req.params.id)) {
        return res.status(400).json({ error: "Invalid ID format" });
      }
      const { id } = req.params;

      const [existingJob] = await db
        .select({ status: importJobs.status })
        .from(importJobs)
        .where(eq(importJobs.id, id))
        .limit(1);

      if (!existingJob) {
        return res.status(404).json({ error: "Import job not found" });
      }
      const currentStatus = existingJob.status;
      if (!["queued", "failed", "cancelled"].includes(currentStatus)) {
        return res.status(400).json({ error: `Import cannot be requeued from status '${currentStatus}'` });
      }

      let requeued = false;
      await db.transaction(async (tx) => {
        const resetResult = await tx.execute(sql`
          UPDATE import_job_queue
          SET status = 'pending',
              retry_count = 0,
              started_at = NULL,
              heartbeat = NULL,
              worker_id = NULL,
              completed_at = NULL,
              error_message = NULL
          WHERE id = (
            SELECT id FROM import_job_queue
            WHERE import_job_id = ${id}
            ORDER BY created_at DESC
            LIMIT 1
          )
          RETURNING id
        `);

        if (resetResult.rows.length === 0) {
          return;
        }

        await tx.execute(sql`
          UPDATE import_jobs
          SET status = 'queued', completed_at = NULL, error_message = NULL
          WHERE id = ${id}
        `);

        requeued = true;
      });

      if (!requeued) {
        return res.status(400).json({ error: "No queue row found for this import — the original CSV path is unavailable" });
      }

      try {
        await db.execute(sql`NOTIFY import_jobs`);
      } catch (notifyErr: unknown) {
        logger.warn(`[IMPORT] NOTIFY import_jobs failed after requeue of ${id} — worker will pick up job on next poll:`, notifyErr);
      }

      logger.info(`[IMPORT] Import job ${id} force-requeued by user (was: ${currentStatus})`);
      res.json({ success: true, message: "Import requeued successfully" });
    } catch (error) {
      logger.error("Error requeueing import:", error);
      res.status(500).json({ error: "Failed to requeue import" });
    }
  });

  app.post("/api/import/:id/force-complete", async (req: Request, res: Response) => {
    try {
      if (!validateId(req.params.id)) {
        return res.status(400).json({ error: "Invalid ID format" });
      }
      const { id } = req.params;
      await db.execute(sql`
        UPDATE import_job_queue SET status = 'completed', completed_at = NOW()
        WHERE import_job_id = ${id} AND status IN ('pending', 'processing', 'queued')
      `);
      await db.execute(sql`
        UPDATE import_jobs
        SET status = 'completed', completed_at = COALESCE(completed_at, NOW())
        WHERE id = ${id} AND status NOT IN ('completed', 'cancelled')
      `);
      logger.info(`[IMPORT] Import job ${id} force-completed by user`);
      res.json({ success: true, message: "Import marked as completed" });
    } catch (error) {
      logger.error("Error force-completing import:", error);
      res.status(500).json({ error: "Failed to force-complete import" });
    }
  });

  app.delete("/api/import/:id", async (req: Request, res: Response) => {
    try {
      if (!validateId(req.params.id)) {
        return res.status(400).json({ error: "Invalid ID format" });
      }
      const { id } = req.params;
      await db.execute(sql`
        UPDATE import_job_queue SET status = 'cancelled', completed_at = NOW()
        WHERE import_job_id = ${id} AND status IN ('pending', 'processing', 'queued')
      `);
      await db.execute(sql`
        UPDATE import_jobs
        SET status = 'cancelled', completed_at = COALESCE(completed_at, NOW())
        WHERE id = ${id} AND status != 'cancelled'
      `);
      logger.info(`[IMPORT] Import job ${id} force-deleted by user`);
      res.json({ success: true, message: "Import removed" });
    } catch (error) {
      logger.error("Error force-deleting import:", error);
      res.status(500).json({ error: "Failed to remove import" });
    }
  });

  app.get("/api/import/:id/progress", async (req: Request, res: Response) => {
    try {
      if (!validateId(req.params.id)) {
        return res.status(400).json({ error: "Invalid ID format" });
      }
      const job = await storage.getImportJob(req.params.id);
      if (!job) {
        return res.status(404).json({ error: "Import job not found" });
      }
      
      const queueStatus = await storage.getImportJobQueueStatus(job.id);
      
      res.json({
        id: job.id,
        filename: job.filename,
        status: job.status,
        queueStatus: queueStatus,
        totalRows: job.totalRows,
        processedRows: job.processedRows,
        newSubscribers: job.newSubscribers,
        updatedSubscribers: job.updatedSubscribers,
        failedRows: job.failedRows,
        failureReasons: job.failureReasons,
        skippedRows: job.skippedRows,
        progress: job.totalRows > 0 ? Math.min(Math.round((job.processedRows / job.totalRows) * 100), 100) : 0,
        errorMessage: job.errorMessage,
        createdAt: job.createdAt,
        completedAt: job.completedAt,
      });
    } catch (error) {
      logger.error("Error fetching import progress:", error);
      res.status(500).json({ error: "Failed to fetch import progress" });
    }
  });

  app.patch("/api/import-jobs/:id/confirm", async (req: Request, res: Response) => {
    try {
      if (!validateId(req.params.id)) {
        return res.status(400).json({ error: "Invalid ID format" });
      }

      const job = await storage.getImportJob(req.params.id);
      if (!job) {
        return res.status(404).json({ error: "Import job not found" });
      }
      if (job.status !== "awaiting_confirmation") {
        return res.status(400).json({ error: `Import job is not awaiting confirmation (current status: ${job.status})` });
      }

      const cleanExistingRefs = req.body.cleanExistingRefs === true;
      const deleteExistingRefs = req.body.deleteExistingRefs === true;
      const confirmed = await storage.confirmImportJob(req.params.id, cleanExistingRefs, deleteExistingRefs);
      if (!confirmed) {
        return res.status(400).json({ error: "Failed to confirm import job" });
      }

      const [queueItem] = await db.insert(importJobQueue).values({
        importJobId: job.id,
        csvFilePath: "phase2_merge",
        totalLines: job.totalRows,
        processedLines: 0,
        fileSizeBytes: 0,
        processedBytes: 0,
        lastCheckpointLine: 0,
        status: "pending",
      }).returning();

      try {
        await db.execute(sql`NOTIFY import_jobs`);
      } catch {}

      logger.info(`[IMPORT] Import job ${job.id} confirmed (cleanExistingRefs: ${cleanExistingRefs}, deleteExistingRefs: ${deleteExistingRefs}), enqueued merge phase: ${queueItem.id}`);

      res.json({ id: job.id, status: "processing" });
    } catch (error) {
      logger.error("Error confirming import job:", error);
      res.status(500).json({ error: "Failed to confirm import job" });
    }
  });

  app.get("/api/import-jobs/:id/affected-count", async (req: Request, res: Response) => {
    try {
      if (!validateId(req.params.id)) {
        return res.status(400).json({ error: "Invalid ID format" });
      }

      const job = await storage.getImportJob(req.params.id);
      if (!job) {
        return res.status(404).json({ error: "Import job not found" });
      }

      const detectedRefs = job.detectedRefs || [];
      if (detectedRefs.length === 0) {
        return res.json({ affectedSubscribers: 0, bckProtected: 0 });
      }

      const [count, bckCount] = await Promise.all([
        storage.countAffectedSubscribers(detectedRefs),
        storage.countBckProtectedSubscribers(detectedRefs),
      ]);
      res.json({ affectedSubscribers: count, bckProtected: bckCount });
    } catch (error) {
      logger.error("Error fetching affected count:", error);
      res.status(500).json({ error: "Failed to fetch affected subscriber count" });
    }
  });

  app.post("/api/import/chunked/start", async (req: Request, res: Response) => {
    try {
      const { filename, tagMode, totalChunks, totalSize, forcedTags: rawForcedTags, forcedRefs: rawForcedRefs } = req.body;
      
      if (!filename || !totalChunks || !totalSize) {
        return res.status(400).json({ error: "Missing required fields: filename, totalChunks, totalSize" });
      }
      
      if (totalSize > 1024 * 1024 * 1024) {
        return res.status(400).json({ error: "File too large. Maximum size is 1GB" });
      }
      
      const uploadId = `chunk_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
      
      chunkedUploads.set(uploadId, {
        filename,
        tagMode: tagMode === "override" ? "override" : "merge",
        importTarget: "auto",
        forcedTags: parseCommaSeparated(rawForcedTags),
        forcedRefs: parseCommaSeparated(rawForcedRefs),
        totalChunks: parseInt(totalChunks),
        totalSize: parseInt(totalSize),
        receivedChunks: new Set(),
        createdAt: new Date(),
      });
      
      logger.info(`[CHUNKED] Started upload: ${uploadId}, file: ${filename}, ${totalChunks} chunks, ${Math.round(totalSize / 1024 / 1024)}MB`);
      
      res.json({ uploadId, message: "Chunked upload started" });
    } catch (error) {
      logger.error("[CHUNKED] Error starting upload:", error);
      res.status(500).json({ error: "Failed to start chunked upload" });
    }
  });

  app.post("/api/import/chunked/:uploadId/chunk/:chunkIndex", uploadChunkToDisk.single("chunk"), async (req: Request, res: Response) => {
    try {
      const { uploadId, chunkIndex } = req.params;
      const index = parseInt(chunkIndex);
      
      if (isNaN(index) || index < 0) {
        if (req.file?.path) try { fs.unlinkSync(req.file.path); } catch {}
        return res.status(400).json({ error: "Invalid chunk index" });
      }
      
      const upload = chunkedUploads.get(uploadId);
      if (!upload) {
        if (req.file?.path) try { fs.unlinkSync(req.file.path); } catch {}
        return res.status(404).json({ error: "Upload session not found or expired" });
      }
      
      if (index >= upload.totalChunks) {
        if (req.file?.path) try { fs.unlinkSync(req.file.path); } catch {}
        return res.status(400).json({ error: `Chunk index ${index} exceeds total chunks ${upload.totalChunks}` });
      }
      
      if (!req.file) {
        return res.status(400).json({ error: "No chunk data received" });
      }
      
      const chunkPath = path.join(CHUNKS_DIR, `${uploadId}_${index}`);
      fs.renameSync(req.file.path, chunkPath);
      
      upload.receivedChunks.add(index);
      
      logger.info(`[CHUNKED] ${uploadId}: Received chunk ${index + 1}/${upload.totalChunks}`);
      
      res.json({ 
        success: true, 
        chunkIndex: index,
        receivedChunks: upload.receivedChunks.size,
        totalChunks: upload.totalChunks,
        progress: Math.round((upload.receivedChunks.size / upload.totalChunks) * 100)
      });
    } catch (error) {
      logger.error("[CHUNKED] Error receiving chunk:", error);
      if (req.file?.path) try { fs.unlinkSync(req.file.path); } catch {}
      res.status(500).json({ error: "Failed to receive chunk" });
    }
  });

  app.post("/api/import/chunked/:uploadId/complete", async (req: Request, res: Response) => {
    if (isMemoryPressure) {
      res.setHeader('Retry-After', '60');
      return res.status(503).json({ error: "Server under memory pressure. Please retry later." });
    }
    const tempCsvPath = path.join(UPLOADS_DIR_BASE, `upload-${Date.now()}-temp.csv`);
    let writeStream: fs.WriteStream | null = null;
    
    try {
      const { uploadId } = req.params;
      
      const upload = chunkedUploads.get(uploadId);
      if (!upload) {
        return res.status(404).json({ error: "Upload session not found or expired" });
      }
      
      if (upload.receivedChunks.size !== upload.totalChunks) {
        const missing = [];
        for (let i = 0; i < upload.totalChunks; i++) {
          if (!upload.receivedChunks.has(i)) missing.push(i);
        }
        return res.status(400).json({ 
          error: `Missing chunks: ${missing.join(", ")}`,
          receivedChunks: upload.receivedChunks.size,
          totalChunks: upload.totalChunks
        });
      }
      
      logger.info(`[CHUNKED] ${uploadId}: All ${upload.totalChunks} chunks received, assembling file...`);
      
      writeStream = fs.createWriteStream(tempCsvPath);
      
      for (let i = 0; i < upload.totalChunks; i++) {
        const chunkPath = path.join(CHUNKS_DIR, `${uploadId}_${i}`);
        
        if (!fs.existsSync(chunkPath)) {
          throw new Error(`Missing chunk file: ${i}`);
        }
        
        await new Promise<void>((resolve, reject) => {
          const readStream = fs.createReadStream(chunkPath);
          readStream.on('error', reject);
          readStream.on('end', () => {
            try { fs.unlinkSync(chunkPath); } catch {}
            resolve();
          });
          readStream.pipe(writeStream!, { end: false });
        });
      }
      
      await new Promise<void>((resolve, reject) => {
        writeStream!.end((err: Error | null) => {
          if (err) reject(err);
          else resolve();
        });
      });
      
      const fileSizeBytes = fs.statSync(tempCsvPath).size;
      logger.info(`[CHUNKED] ${uploadId}: File assembled: ${tempCsvPath}, size: ${Math.round(fileSizeBytes / 1024 / 1024)}MB`);
      
      const lineCount = await countLines(tempCsvPath);
      logger.info(`[CHUNKED] ${uploadId}: Line count: ${lineCount}`);
      
      if (lineCount < 2) {
        fs.unlinkSync(tempCsvPath);
        chunkedUploads.delete(uploadId);
        return res.status(400).json({ error: "CSV file is empty or invalid" });
      }
      
      const totalDataRows = lineCount - 1;
      
      const job = await storage.createImportJob({
        filename: upload.filename,
        totalRows: totalDataRows,
        tagMode: upload.tagMode,
        importTarget: upload.importTarget,
        forcedTags: upload.forcedTags,
        forcedRefs: upload.forcedRefs,
      });
      logger.info(`[CHUNKED] ${uploadId}: Created import job: ${job.id}`);
      
      const useReplitStorageChunked = process.env.STORAGE_BACKEND === "replit";
      let storagePathChunked: string;
      const verifiedSize = fs.statSync(tempCsvPath).size;

      if (useReplitStorageChunked) {
        storagePathChunked = await objectStorageService.uploadLocalFile(tempCsvPath, `${job.id}.csv`);
        logger.info(`[CHUNKED] ${uploadId}: Uploaded to object storage: ${storagePathChunked}`);
        const objectExists = await objectStorageService.objectExists(storagePathChunked);
        if (!objectExists) {
          throw new Error(`Object storage verification failed: ${storagePathChunked} does not exist after upload`);
        }
        logger.info(`[CHUNKED] ${uploadId}: File verified in object storage, size: ${verifiedSize} bytes`);
        try { fs.unlinkSync(tempCsvPath); } catch {}
      } else {
        storagePathChunked = tempCsvPath;
        logger.info(`[CHUNKED] ${uploadId}: Using local disk storage: ${storagePathChunked}, size: ${verifiedSize} bytes`);
      }

      const queueItem = await db.transaction(async (tx) => {
        await tx.update(importJobs).set({ status: "queued" }).where(sql`${importJobs.id} = ${job.id}`);
        const [queued] = await tx.insert(importJobQueue).values({
          importJobId: job.id,
          csvFilePath: storagePathChunked,
          totalLines: lineCount,
          processedLines: 0,
          fileSizeBytes: verifiedSize,
          processedBytes: 0,
          lastCheckpointLine: 0,
          status: "pending",
        }).returning();
        return queued;
      });
      logger.info(`[CHUNKED] ${uploadId}: Import job ${job.id} enqueued, path: ${storagePathChunked}`);
      
      chunkedUploads.delete(uploadId);
      
      res.status(202).json(job);
    } catch (error: any) {
      logger.error("[CHUNKED] Error completing upload:", error);
      
      try { 
        if (fs.existsSync(tempCsvPath)) {
          fs.unlinkSync(tempCsvPath); 
        }
      } catch {}
      
      if (writeStream) {
        try { writeStream.destroy(); } catch {}
      }
      
      const { uploadId } = req.params;
      const upload = chunkedUploads.get(uploadId);
      if (upload) {
        for (let i = 0; i < upload.totalChunks; i++) {
          const chunkPath = path.join(CHUNKS_DIR, `${uploadId}_${i}`);
          try { fs.unlinkSync(chunkPath); } catch {}
        }
        chunkedUploads.delete(uploadId);
      }
      
      res.status(500).json({ error: error.message || "Failed to complete chunked upload" });
    }
  });

  app.get("/api/import/chunked/:uploadId/status", async (req: Request, res: Response) => {
    try {
      const upload = chunkedUploads.get(req.params.uploadId);
      if (!upload) {
        return res.status(404).json({ error: "Upload session not found or expired" });
      }
      
      res.json({
        uploadId: req.params.uploadId,
        filename: upload.filename,
        totalChunks: upload.totalChunks,
        receivedChunks: upload.receivedChunks.size,
        progress: Math.round((upload.receivedChunks.size / upload.totalChunks) * 100),
        createdAt: upload.createdAt,
      });
    } catch (error) {
      logger.error("[CHUNKED] Error fetching status:", error);
      res.status(500).json({ error: "Failed to fetch upload status" });
    }
  });

  app.get("/api/export", async (req: Request, res: Response) => {
    try {
      const fields = (req.query.fields as string)?.split(",") || ["email", "tags", "refs", "ipAddress", "importDate"];
      
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename=critsend-export-${new Date().toISOString().split("T")[0]}.csv`);
      res.setHeader("Transfer-Encoding", "chunked");
      
      const headerMap: Record<string, string> = {
        email: "email",
        tags: "tags",
        refs: "refs",
        ipAddress: "ip_address",
        importDate: "import_date",
      };
      res.write(fields.map(f => headerMap[f] || f).join(";") + "\n");
      
      let page = 1;
      const limit = 10000;
      
      while (true) {
        const { subscribers: subs, total } = await storage.getSubscribers(page, limit);
        
        let chunk = "";
        for (const sub of subs) {
          const row = fields.map(field => {
            let val = "";
            if (field === "email") val = sub.email;
            else if (field === "tags") val = (sub.tags || []).join(",");
            else if (field === "refs") val = (sub.refs || []).join(",");
            else if (field === "ipAddress") val = sub.ipAddress || "";
            else if (field === "importDate") val = sub.importDate.toISOString();
            val = sanitizeCsvValue(val);
            if (val.includes(";") || val.includes('"') || val.includes("\n")) {
              return '"' + val.replace(/"/g, '""') + '"';
            }
            return val;
          });
          chunk += row.join(";") + "\n";
        }
        
        if (chunk) {
          const canContinue = res.write(chunk);
          if (!canContinue) {
            await new Promise<void>(resolve => res.once("drain", resolve));
          }
        }
        
        if (page * limit >= total || subs.length === 0) break;
        page++;
      }
      
      res.end();
    } catch (error) {
      logger.error("Error exporting:", error);
      if (!res.headersSent) {
        res.status(500).json({ error: "Failed to export" });
      } else {
        res.end();
      }
    }
  });

  app.get("/api/jobs/stream", (req: Request, res: Response) => {
    if (!req.isAuthenticated || !req.isAuthenticated()) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    res.write(":\n\n");

    const onProgress = (event: JobProgressEvent) => {
      try {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch (_) {}
    };

    jobEvents.on("progress", onProgress);

    const keepAlive = setInterval(() => {
      try {
        res.write(":\n\n");
      } catch (_) {
        cleanup();
      }
    }, 15000);

    const cleanup = () => {
      jobEvents.off("progress", onProgress);
      clearInterval(keepAlive);
    };

    req.on("close", cleanup);
    res.on("close", cleanup);
  });
}
