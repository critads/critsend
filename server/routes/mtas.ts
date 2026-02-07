import { type Express, type Request, type Response } from "express";
import { storage } from "../storage";
import { logger } from "../logger";
import { insertMtaSchema, insertEmailHeaderSchema } from "@shared/schema";
import { z } from "zod";

export function registerMtaRoutes(app: Express, helpers: {
  parsePagination: (query: any) => { page: number; limit: number };
  validateId: (id: string) => boolean;
}) {
  const { validateId } = helpers;

  app.get("/api/mtas", async (req: Request, res: Response) => {
    try {
      const mtasList = await storage.getMtas();
      res.json(mtasList);
    } catch (error) {
      logger.error("Error fetching MTAs:", error);
      res.status(500).json({ error: "Failed to fetch MTAs" });
    }
  });

  app.get("/api/mtas/:id", async (req: Request, res: Response) => {
    try {
      if (!validateId(req.params.id)) {
        return res.status(400).json({ error: "Invalid ID format" });
      }
      const mta = await storage.getMta(req.params.id);
      if (!mta) {
        return res.status(404).json({ error: "MTA not found" });
      }
      res.json(mta);
    } catch (error) {
      logger.error("Error fetching MTA:", error);
      res.status(500).json({ error: "Failed to fetch MTA" });
    }
  });

  app.post("/api/mtas", async (req: Request, res: Response) => {
    try {
      const data = insertMtaSchema.parse(req.body);
      const mta = await storage.createMta(data);
      res.status(201).json(mta);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.errors });
      }
      logger.error("Error creating MTA:", error);
      res.status(500).json({ error: "Failed to create MTA" });
    }
  });

  app.patch("/api/mtas/:id", async (req: Request, res: Response) => {
    try {
      if (!validateId(req.params.id)) {
        return res.status(400).json({ error: "Invalid ID format" });
      }
      const mta = await storage.updateMta(req.params.id, req.body);
      if (!mta) {
        return res.status(404).json({ error: "MTA not found" });
      }
      res.json(mta);
    } catch (error) {
      logger.error("Error updating MTA:", error);
      res.status(500).json({ error: "Failed to update MTA" });
    }
  });

  app.delete("/api/mtas/:id", async (req: Request, res: Response) => {
    try {
      if (!validateId(req.params.id)) {
        return res.status(400).json({ error: "Invalid ID format" });
      }
      await storage.deleteMta(req.params.id);
      res.status(204).send();
    } catch (error) {
      logger.error("Error deleting MTA:", error);
      res.status(500).json({ error: "Failed to delete MTA" });
    }
  });

  app.get("/api/headers", async (req: Request, res: Response) => {
    try {
      const headers = await storage.getHeaders();
      res.json(headers);
    } catch (error) {
      logger.error("Error fetching headers:", error);
      res.status(500).json({ error: "Failed to fetch headers" });
    }
  });

  app.post("/api/headers", async (req: Request, res: Response) => {
    try {
      const data = insertEmailHeaderSchema.parse(req.body);
      const header = await storage.createHeader(data);
      res.status(201).json(header);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.errors });
      }
      logger.error("Error creating header:", error);
      res.status(500).json({ error: "Failed to create header" });
    }
  });

  app.patch("/api/headers/:id", async (req: Request, res: Response) => {
    try {
      if (!validateId(req.params.id)) {
        return res.status(400).json({ error: "Invalid ID format" });
      }
      const header = await storage.updateHeader(req.params.id, req.body);
      if (!header) {
        return res.status(404).json({ error: "Header not found" });
      }
      res.json(header);
    } catch (error) {
      logger.error("Error updating header:", error);
      res.status(500).json({ error: "Failed to update header" });
    }
  });

  app.delete("/api/headers/:id", async (req: Request, res: Response) => {
    try {
      if (!validateId(req.params.id)) {
        return res.status(400).json({ error: "Invalid ID format" });
      }
      await storage.deleteHeader(req.params.id);
      res.status(204).send();
    } catch (error) {
      logger.error("Error deleting header:", error);
      res.status(500).json({ error: "Failed to delete header" });
    }
  });
}
