import {
  brands,
  type Brand,
  type InsertBrand,
} from "@shared/schema";
import { db } from "../db";
import { asc, desc, or, sql } from "drizzle-orm";

export interface BrandPage {
  brands: Brand[];
  total: number;
}

/**
 * Search is deliberately expressed as a parameterized literal substring
 * search.  Apart from avoiding SQL construction from request input, this
 * means `%` and `_` in a brand/ref are treated as ordinary characters rather
 * than LIKE wildcards.
 */
function searchCondition(search?: string) {
  const value = search?.trim();
  if (!value) return undefined;
  const lowerSearch = value.toLowerCase();
  return or(
    sql`position(${lowerSearch} in lower(${brands.name})) > 0`,
    sql`position(${lowerSearch} in lower(${brands.ref})) > 0`,
  );
}

export async function getBrandsPaginated(opts: {
  page: number;
  limit: number;
  search?: string;
}): Promise<BrandPage> {
  const where = searchCondition(opts.search);
  const offset = (opts.page - 1) * opts.limit;

  const [countResult, rows] = await Promise.all([
    db.select({ count: sql<number>`count(*)::int` })
      .from(brands)
      .where(where),
    db.select()
      .from(brands)
      .where(where)
      .orderBy(desc(brands.createdAt), asc(brands.id))
      .limit(opts.limit)
      .offset(offset),
  ]);

  return {
    brands: rows,
    total: Number(countResult[0]?.count ?? 0),
  };
}

export async function createBrand(data: InsertBrand): Promise<Brand> {
  const [brand] = await db.insert(brands).values(data).returning();
  return brand;
}

/**
 * Insert the complete parsed import in one transaction.  De-duplicating the
 * input before INSERT lets `skipped` include repeated rows in the CSV while
 * ON CONFLICT handles rows already present (including concurrent imports).
 */
export async function importBrands(rows: InsertBrand[]): Promise<{
  created: number;
  skipped: number;
  total: number;
}> {
  const total = rows.length;
  if (total === 0) {
    return { created: 0, skipped: 0, total: 0 };
  }

  const uniqueRows: InsertBrand[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const key = `${row.name}\u0000${row.ref}`;
    if (!seen.has(key)) {
      seen.add(key);
      uniqueRows.push(row);
    }
  }

  const created = await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(brands)
      .values(uniqueRows)
      .onConflictDoNothing({ target: [brands.name, brands.ref] })
      .returning({ id: brands.id });
    return inserted.length;
  });

  return {
    created,
    skipped: total - created,
    total,
  };
}