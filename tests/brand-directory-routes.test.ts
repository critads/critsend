import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "http";

const getBrandsPaginated = vi.fn();
const createBrand = vi.fn();
const importBrands = vi.fn();

vi.mock("../server/storage", () => ({
  storage: {
    getBrandsPaginated,
    createBrand,
    importBrands,
  },
}));

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const { registerBrandRoutes } = await import("../server/routes/brands");
  const app = express();
  app.use(express.json());
  registerBrandRoutes(app);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Test server did not expose a TCP address");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Brands directory HTTP routes", () => {
  it("passes pagination/search to storage and returns pagination metadata", async () => {
    const createdAt = new Date("2026-01-02T03:04:05.000Z");
    getBrandsPaginated.mockResolvedValue({
      brands: [{ id: "brand-1", name: "Acme", ref: "REF-1", createdAt }],
      total: 51,
    });

    const response = await fetch(
      `${baseUrl}/api/brands?search=acme&page=2&limit=25`,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      brands: [{
        id: "brand-1",
        name: "Acme",
        ref: "REF-1",
        createdAt: createdAt.toISOString(),
      }],
      total: 51,
      page: 2,
      totalPages: 3,
    });
    expect(getBrandsPaginated).toHaveBeenCalledWith({
      page: 2,
      limit: 25,
      search: "acme",
    });
  });

  it("rejects malformed pagination before touching storage", async () => {
    const response = await fetch(`${baseUrl}/api/brands?page=0&limit=25`);

    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("Invalid pagination");
    expect(getBrandsPaginated).not.toHaveBeenCalled();
  });

  it("returns a helpful string for invalid create input", async () => {
    const response = await fetch(`${baseUrl}/api/brands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: " ", ref: "" }),
    });

    const body = await response.json();
    expect(response.status).toBe(400);
    expect(typeof body.error).toBe("string");
    expect(body.error).toContain("name");
    expect(body.error).toContain("ref");
    expect(createBrand).not.toHaveBeenCalled();
  });

  it("trims and creates a brand", async () => {
    const createdAt = new Date("2026-01-03T00:00:00.000Z");
    createBrand.mockResolvedValue({
      id: "brand-2",
      name: "Acme",
      ref: "REF-2",
      createdAt,
    });

    const response = await fetch(`${baseUrl}/api/brands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "  Acme ", ref: " REF-2 " }),
    });

    expect(response.status).toBe(201);
    expect((await response.json()).name).toBe("Acme");
    expect(createBrand).toHaveBeenCalledWith({ name: "Acme", ref: "REF-2" });
  });

  it("maps the exact-pair unique violation to 409", async () => {
    createBrand.mockRejectedValue({ code: "23505" });

    const response = await fetch(`${baseUrl}/api/brands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Acme", ref: "REF-1" }),
    });

    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain("exact name and ref");
  });

  it("imports a valid multipart CSV and reports storage results", async () => {
    importBrands.mockResolvedValue({ created: 2, skipped: 1, total: 3 });
    const form = new FormData();
    form.append(
      "file",
      new Blob([
        "\uFEFFbrand;ref\r\nAcme;R-1\r\n\"Acme, Inc.\";R-2\r\nAcme;R-1\r\n",
      ], { type: "text/csv" }),
      "brands.csv",
    );

    const response = await fetch(`${baseUrl}/api/brands/import`, {
      method: "POST",
      body: form,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      created: 2,
      skipped: 1,
      total: 3,
    });
    expect(importBrands).toHaveBeenCalledWith([
      { name: "Acme", ref: "R-1" },
      { name: "Acme, Inc.", ref: "R-2" },
      { name: "Acme", ref: "R-1" },
    ]);
  });

  it("rejects an invalid CSV atomically without calling import storage", async () => {
    const form = new FormData();
    form.append(
      "file",
      new Blob(["brand,ref\nGood,R-1\nBroken,\n"], { type: "text/csv" }),
      "invalid.csv",
    );

    const response = await fetch(`${baseUrl}/api/brands/import`, {
      method: "POST",
      body: form,
    });

    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.error).toContain("CSV error on line 3");
    expect(importBrands).not.toHaveBeenCalled();
  });
});