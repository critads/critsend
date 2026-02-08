import { type Express, type Request, type Response } from "express";
import { db } from "../db";
import { automationWorkflows, automationEnrollments, subscribers, insertAutomationWorkflowSchema } from "@shared/schema";
import { eq, and, sql } from "drizzle-orm";
import { logger } from "../logger";
import { z } from "zod";

function validateId(id: string): boolean {
  return typeof id === 'string' && id.length > 0 && id.length <= 100 && /^[a-zA-Z0-9_-]+$/.test(id);
}

export function registerAutomationRoutes(app: Express) {

  app.get("/api/automation", async (req: Request, res: Response) => {
    try {
      const workflows = await db.select().from(automationWorkflows);
      const workflowsWithCounts = await Promise.all(
        workflows.map(async (workflow) => {
          const [countResult] = await db
            .select({ count: sql<number>`count(*)::int` })
            .from(automationEnrollments)
            .where(eq(automationEnrollments.workflowId, workflow.id));
          return {
            ...workflow,
            enrollmentCount: countResult?.count ?? 0,
          };
        })
      );
      res.json(workflowsWithCounts);
    } catch (error) {
      logger.error("Error fetching automation workflows:", error);
      res.status(500).json({ error: "Failed to fetch automation workflows" });
    }
  });

  app.get("/api/automation/:id", async (req: Request, res: Response) => {
    try {
      if (!validateId(req.params.id)) {
        return res.status(400).json({ error: "Invalid ID format" });
      }
      const [workflow] = await db
        .select()
        .from(automationWorkflows)
        .where(eq(automationWorkflows.id, req.params.id));
      if (!workflow) {
        return res.status(404).json({ error: "Workflow not found" });
      }
      res.json(workflow);
    } catch (error) {
      logger.error("Error fetching automation workflow:", error);
      res.status(500).json({ error: "Failed to fetch automation workflow" });
    }
  });

  app.post("/api/automation", async (req: Request, res: Response) => {
    try {
      const data = insertAutomationWorkflowSchema.parse(req.body);
      const [workflow] = await db
        .insert(automationWorkflows)
        .values(data)
        .returning();
      res.status(201).json(workflow);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.errors });
      }
      logger.error("Error creating automation workflow:", error);
      res.status(500).json({ error: "Failed to create automation workflow" });
    }
  });

  app.put("/api/automation/:id", async (req: Request, res: Response) => {
    try {
      if (!validateId(req.params.id)) {
        return res.status(400).json({ error: "Invalid ID format" });
      }
      const [existing] = await db
        .select()
        .from(automationWorkflows)
        .where(eq(automationWorkflows.id, req.params.id));
      if (!existing) {
        return res.status(404).json({ error: "Workflow not found" });
      }
      const [workflow] = await db
        .update(automationWorkflows)
        .set({ ...req.body, updatedAt: new Date() })
        .where(eq(automationWorkflows.id, req.params.id))
        .returning();
      res.json(workflow);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.errors });
      }
      logger.error("Error updating automation workflow:", error);
      res.status(500).json({ error: "Failed to update automation workflow" });
    }
  });

  app.delete("/api/automation/:id", async (req: Request, res: Response) => {
    try {
      if (!validateId(req.params.id)) {
        return res.status(400).json({ error: "Invalid ID format" });
      }
      const [existing] = await db
        .select()
        .from(automationWorkflows)
        .where(eq(automationWorkflows.id, req.params.id));
      if (!existing) {
        return res.status(404).json({ error: "Workflow not found" });
      }
      await db
        .delete(automationEnrollments)
        .where(eq(automationEnrollments.workflowId, req.params.id));
      await db
        .delete(automationWorkflows)
        .where(eq(automationWorkflows.id, req.params.id));
      res.status(204).send();
    } catch (error) {
      logger.error("Error deleting automation workflow:", error);
      res.status(500).json({ error: "Failed to delete automation workflow" });
    }
  });

  app.post("/api/automation/:id/activate", async (req: Request, res: Response) => {
    try {
      if (!validateId(req.params.id)) {
        return res.status(400).json({ error: "Invalid ID format" });
      }
      const [workflow] = await db
        .update(automationWorkflows)
        .set({ status: "active", updatedAt: new Date() })
        .where(eq(automationWorkflows.id, req.params.id))
        .returning();
      if (!workflow) {
        return res.status(404).json({ error: "Workflow not found" });
      }
      res.json(workflow);
    } catch (error) {
      logger.error("Error activating automation workflow:", error);
      res.status(500).json({ error: "Failed to activate automation workflow" });
    }
  });

  app.post("/api/automation/:id/pause", async (req: Request, res: Response) => {
    try {
      if (!validateId(req.params.id)) {
        return res.status(400).json({ error: "Invalid ID format" });
      }
      const [workflow] = await db
        .update(automationWorkflows)
        .set({ status: "paused", updatedAt: new Date() })
        .where(eq(automationWorkflows.id, req.params.id))
        .returning();
      if (!workflow) {
        return res.status(404).json({ error: "Workflow not found" });
      }
      res.json(workflow);
    } catch (error) {
      logger.error("Error pausing automation workflow:", error);
      res.status(500).json({ error: "Failed to pause automation workflow" });
    }
  });

  app.get("/api/automation/:id/enrollments", async (req: Request, res: Response) => {
    try {
      if (!validateId(req.params.id)) {
        return res.status(400).json({ error: "Invalid ID format" });
      }
      const limit = Math.max(1, Math.min(100, parseInt(req.query.limit as string) || 20));
      const offset = Math.max(0, parseInt(req.query.offset as string) || 0);

      const enrollments = await db
        .select({
          id: automationEnrollments.id,
          workflowId: automationEnrollments.workflowId,
          subscriberId: automationEnrollments.subscriberId,
          currentStepIndex: automationEnrollments.currentStepIndex,
          status: automationEnrollments.status,
          enrolledAt: automationEnrollments.enrolledAt,
          nextActionAt: automationEnrollments.nextActionAt,
          completedAt: automationEnrollments.completedAt,
          lastError: automationEnrollments.lastError,
          subscriberEmail: subscribers.email,
        })
        .from(automationEnrollments)
        .leftJoin(subscribers, eq(automationEnrollments.subscriberId, subscribers.id))
        .where(eq(automationEnrollments.workflowId, req.params.id))
        .limit(limit)
        .offset(offset);

      const [countResult] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(automationEnrollments)
        .where(eq(automationEnrollments.workflowId, req.params.id));

      res.json({
        enrollments,
        total: countResult?.count ?? 0,
        limit,
        offset,
      });
    } catch (error) {
      logger.error("Error fetching automation enrollments:", error);
      res.status(500).json({ error: "Failed to fetch automation enrollments" });
    }
  });

  app.post("/api/automation/:id/enroll", async (req: Request, res: Response) => {
    try {
      if (!validateId(req.params.id)) {
        return res.status(400).json({ error: "Invalid ID format" });
      }
      const { subscriberId } = req.body;
      if (!subscriberId || !validateId(subscriberId)) {
        return res.status(400).json({ error: "Valid subscriberId is required" });
      }
      const [workflow] = await db
        .select()
        .from(automationWorkflows)
        .where(eq(automationWorkflows.id, req.params.id));
      if (!workflow) {
        return res.status(404).json({ error: "Workflow not found" });
      }
      const [subscriber] = await db
        .select()
        .from(subscribers)
        .where(eq(subscribers.id, subscriberId));
      if (!subscriber) {
        return res.status(404).json({ error: "Subscriber not found" });
      }
      const [enrollment] = await db
        .insert(automationEnrollments)
        .values({
          workflowId: req.params.id,
          subscriberId,
          status: "active",
        })
        .returning();
      await db
        .update(automationWorkflows)
        .set({ totalEnrolled: sql`${automationWorkflows.totalEnrolled} + 1`, updatedAt: new Date() })
        .where(eq(automationWorkflows.id, req.params.id));
      res.status(201).json(enrollment);
    } catch (error: any) {
      if (error?.code === '23505') {
        return res.status(409).json({ error: "Subscriber is already enrolled in this workflow" });
      }
      logger.error("Error enrolling subscriber:", error);
      res.status(500).json({ error: "Failed to enroll subscriber" });
    }
  });

  app.delete("/api/automation/:id/enrollments/:enrollmentId", async (req: Request, res: Response) => {
    try {
      if (!validateId(req.params.id) || !validateId(req.params.enrollmentId)) {
        return res.status(400).json({ error: "Invalid ID format" });
      }
      const [enrollment] = await db
        .select()
        .from(automationEnrollments)
        .where(
          and(
            eq(automationEnrollments.id, req.params.enrollmentId),
            eq(automationEnrollments.workflowId, req.params.id)
          )
        );
      if (!enrollment) {
        return res.status(404).json({ error: "Enrollment not found" });
      }
      await db
        .update(automationEnrollments)
        .set({ status: "cancelled", completedAt: new Date() })
        .where(eq(automationEnrollments.id, req.params.enrollmentId));
      res.status(204).send();
    } catch (error) {
      logger.error("Error cancelling automation enrollment:", error);
      res.status(500).json({ error: "Failed to cancel enrollment" });
    }
  });
}
