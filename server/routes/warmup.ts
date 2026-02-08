import { type Express, type Request, type Response } from "express";
import { db } from "../db";
import { warmupSchedules, mtas } from "@shared/schema";
import { insertWarmupScheduleSchema } from "@shared/schema";
import { eq } from "drizzle-orm";
import { logger } from "../logger";
import { z } from "zod";

function calculateDailyVolume(day: number, initialCap: number, rampMultiplier: number, maxVolume: number): number {
  const volume = Math.floor(initialCap * Math.pow(rampMultiplier, day - 1));
  return Math.min(volume, maxVolume);
}

function validateId(id: string): boolean {
  return typeof id === 'string' && id.length > 0 && id.length <= 100 && /^[a-zA-Z0-9_-]+$/.test(id);
}

export function registerWarmupRoutes(app: Express) {
  app.get("/api/warmup", async (req: Request, res: Response) => {
    try {
      const schedules = await db
        .select({
          id: warmupSchedules.id,
          mtaId: warmupSchedules.mtaId,
          name: warmupSchedules.name,
          status: warmupSchedules.status,
          startDate: warmupSchedules.startDate,
          currentDay: warmupSchedules.currentDay,
          totalDays: warmupSchedules.totalDays,
          dailyVolumeCap: warmupSchedules.dailyVolumeCap,
          maxDailyVolume: warmupSchedules.maxDailyVolume,
          rampMultiplier: warmupSchedules.rampMultiplier,
          sentToday: warmupSchedules.sentToday,
          lastResetDate: warmupSchedules.lastResetDate,
          createdAt: warmupSchedules.createdAt,
          mtaName: mtas.name,
        })
        .from(warmupSchedules)
        .leftJoin(mtas, eq(warmupSchedules.mtaId, mtas.id));
      res.json(schedules);
    } catch (error) {
      logger.error("Error fetching warmup schedules:", error);
      res.status(500).json({ error: "Failed to fetch warmup schedules" });
    }
  });

  app.get("/api/warmup/:id", async (req: Request, res: Response) => {
    try {
      if (!validateId(req.params.id)) {
        return res.status(400).json({ error: "Invalid ID format" });
      }
      const [schedule] = await db
        .select({
          id: warmupSchedules.id,
          mtaId: warmupSchedules.mtaId,
          name: warmupSchedules.name,
          status: warmupSchedules.status,
          startDate: warmupSchedules.startDate,
          currentDay: warmupSchedules.currentDay,
          totalDays: warmupSchedules.totalDays,
          dailyVolumeCap: warmupSchedules.dailyVolumeCap,
          maxDailyVolume: warmupSchedules.maxDailyVolume,
          rampMultiplier: warmupSchedules.rampMultiplier,
          sentToday: warmupSchedules.sentToday,
          lastResetDate: warmupSchedules.lastResetDate,
          createdAt: warmupSchedules.createdAt,
          mtaName: mtas.name,
        })
        .from(warmupSchedules)
        .leftJoin(mtas, eq(warmupSchedules.mtaId, mtas.id))
        .where(eq(warmupSchedules.id, req.params.id));
      if (!schedule) {
        return res.status(404).json({ error: "Warmup schedule not found" });
      }
      const rampMultiplier = parseFloat(schedule.rampMultiplier);
      const todayVolumeCap = calculateDailyVolume(schedule.currentDay, schedule.dailyVolumeCap, rampMultiplier, schedule.maxDailyVolume);
      const progressPercent = schedule.totalDays > 0 ? Math.round((schedule.currentDay / schedule.totalDays) * 100) : 0;
      res.json({
        ...schedule,
        todayVolumeCap,
        progressPercent,
      });
    } catch (error) {
      logger.error("Error fetching warmup schedule:", error);
      res.status(500).json({ error: "Failed to fetch warmup schedule" });
    }
  });

  app.post("/api/warmup", async (req: Request, res: Response) => {
    try {
      const data = insertWarmupScheduleSchema.parse(req.body);
      const [mtaExists] = await db.select({ id: mtas.id }).from(mtas).where(eq(mtas.id, data.mtaId));
      if (!mtaExists) {
        return res.status(400).json({ error: "MTA not found" });
      }
      const [schedule] = await db.insert(warmupSchedules).values(data).returning();
      res.status(201).json(schedule);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.errors });
      }
      logger.error("Error creating warmup schedule:", error);
      res.status(500).json({ error: "Failed to create warmup schedule" });
    }
  });

  app.put("/api/warmup/:id", async (req: Request, res: Response) => {
    try {
      if (!validateId(req.params.id)) {
        return res.status(400).json({ error: "Invalid ID format" });
      }
      const [existing] = await db.select({ id: warmupSchedules.id }).from(warmupSchedules).where(eq(warmupSchedules.id, req.params.id));
      if (!existing) {
        return res.status(404).json({ error: "Warmup schedule not found" });
      }
      const [updated] = await db
        .update(warmupSchedules)
        .set(req.body)
        .where(eq(warmupSchedules.id, req.params.id))
        .returning();
      res.json(updated);
    } catch (error) {
      logger.error("Error updating warmup schedule:", error);
      res.status(500).json({ error: "Failed to update warmup schedule" });
    }
  });

  app.delete("/api/warmup/:id", async (req: Request, res: Response) => {
    try {
      if (!validateId(req.params.id)) {
        return res.status(400).json({ error: "Invalid ID format" });
      }
      const [existing] = await db.select({ id: warmupSchedules.id }).from(warmupSchedules).where(eq(warmupSchedules.id, req.params.id));
      if (!existing) {
        return res.status(404).json({ error: "Warmup schedule not found" });
      }
      await db.delete(warmupSchedules).where(eq(warmupSchedules.id, req.params.id));
      res.status(204).send();
    } catch (error) {
      logger.error("Error deleting warmup schedule:", error);
      res.status(500).json({ error: "Failed to delete warmup schedule" });
    }
  });

  app.post("/api/warmup/:id/pause", async (req: Request, res: Response) => {
    try {
      if (!validateId(req.params.id)) {
        return res.status(400).json({ error: "Invalid ID format" });
      }
      const [schedule] = await db.select().from(warmupSchedules).where(eq(warmupSchedules.id, req.params.id));
      if (!schedule) {
        return res.status(404).json({ error: "Warmup schedule not found" });
      }
      if (schedule.status === "paused") {
        return res.status(400).json({ error: "Schedule is already paused" });
      }
      const [updated] = await db
        .update(warmupSchedules)
        .set({ status: "paused" })
        .where(eq(warmupSchedules.id, req.params.id))
        .returning();
      res.json(updated);
    } catch (error) {
      logger.error("Error pausing warmup schedule:", error);
      res.status(500).json({ error: "Failed to pause warmup schedule" });
    }
  });

  app.post("/api/warmup/:id/resume", async (req: Request, res: Response) => {
    try {
      if (!validateId(req.params.id)) {
        return res.status(400).json({ error: "Invalid ID format" });
      }
      const [schedule] = await db.select().from(warmupSchedules).where(eq(warmupSchedules.id, req.params.id));
      if (!schedule) {
        return res.status(404).json({ error: "Warmup schedule not found" });
      }
      if (schedule.status !== "paused") {
        return res.status(400).json({ error: "Schedule is not paused" });
      }
      const [updated] = await db
        .update(warmupSchedules)
        .set({ status: "active" })
        .where(eq(warmupSchedules.id, req.params.id))
        .returning();
      res.json(updated);
    } catch (error) {
      logger.error("Error resuming warmup schedule:", error);
      res.status(500).json({ error: "Failed to resume warmup schedule" });
    }
  });

  app.post("/api/warmup/:id/reset", async (req: Request, res: Response) => {
    try {
      if (!validateId(req.params.id)) {
        return res.status(400).json({ error: "Invalid ID format" });
      }
      const [schedule] = await db.select().from(warmupSchedules).where(eq(warmupSchedules.id, req.params.id));
      if (!schedule) {
        return res.status(404).json({ error: "Warmup schedule not found" });
      }
      const newDay = Math.min(schedule.currentDay + 1, schedule.totalDays);
      const [updated] = await db
        .update(warmupSchedules)
        .set({
          sentToday: 0,
          currentDay: newDay,
          lastResetDate: new Date(),
        })
        .where(eq(warmupSchedules.id, req.params.id))
        .returning();
      res.json(updated);
    } catch (error) {
      logger.error("Error resetting warmup schedule:", error);
      res.status(500).json({ error: "Failed to reset warmup schedule" });
    }
  });

  app.get("/api/warmup/:id/progress", async (req: Request, res: Response) => {
    try {
      if (!validateId(req.params.id)) {
        return res.status(400).json({ error: "Invalid ID format" });
      }
      const [schedule] = await db.select().from(warmupSchedules).where(eq(warmupSchedules.id, req.params.id));
      if (!schedule) {
        return res.status(404).json({ error: "Warmup schedule not found" });
      }
      const rampMultiplier = parseFloat(schedule.rampMultiplier);
      const timeline: Array<{ day: number; volumeCap: number; actualSent?: number }> = [];
      for (let day = 1; day <= schedule.totalDays; day++) {
        const volumeCap = calculateDailyVolume(day, schedule.dailyVolumeCap, rampMultiplier, schedule.maxDailyVolume);
        const entry: { day: number; volumeCap: number; actualSent?: number } = { day, volumeCap };
        if (day < schedule.currentDay) {
          entry.actualSent = volumeCap;
        } else if (day === schedule.currentDay) {
          entry.actualSent = schedule.sentToday;
        }
        timeline.push(entry);
      }
      res.json({
        scheduleId: schedule.id,
        name: schedule.name,
        status: schedule.status,
        currentDay: schedule.currentDay,
        totalDays: schedule.totalDays,
        timeline,
      });
    } catch (error) {
      logger.error("Error fetching warmup progress:", error);
      res.status(500).json({ error: "Failed to fetch warmup progress" });
    }
  });
}
