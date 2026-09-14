import { beforeEach, describe, expect, it, vi } from "vitest";

const transaction = vi.fn();
const insert = vi.fn();
const values = vi.fn();
const onConflictDoNothing = vi.fn();
const returning = vi.fn();

vi.mock("../server/db", () => ({
  db: {
    transaction: (...args: any[]) => transaction(...args),
  },
}));

import { importBrands } from "../server/repositories/brand-repository";

beforeEach(() => {
  vi.clearAllMocks();
  returning.mockResolvedValue([{ id: "created-1" }]);
  onConflictDoNothing.mockReturnValue({ returning });
  values.mockReturnValue({ onConflictDoNothing });
  insert.mockReturnValue({ values });
  transaction.mockImplementation(async (callback: (tx: unknown) => unknown) =>
    callback({ insert }),
  );
});

describe("Brands directory repository import", () => {
  it("deduplicates exact CSV pairs inside one transaction and counts conflicts as skipped", async () => {
    const result = await importBrands([
      { name: "Acme", ref: "REF-1" },
      { name: "Acme", ref: "REF-1" },
      { name: "Acme", ref: "ref-1" },
    ]);

    expect(result).toEqual({ created: 1, skipped: 2, total: 3 });
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledTimes(1);
    expect(values).toHaveBeenCalledWith([
      { name: "Acme", ref: "REF-1" },
      { name: "Acme", ref: "ref-1" },
    ]);
    expect(onConflictDoNothing).toHaveBeenCalledWith({
      target: expect.any(Array),
    });
    expect(returning).toHaveBeenCalledTimes(1);
  });

  it("does not open a transaction for an empty import", async () => {
    await expect(importBrands([])).resolves.toEqual({
      created: 0,
      skipped: 0,
      total: 0,
    });
    expect(transaction).not.toHaveBeenCalled();
  });
});