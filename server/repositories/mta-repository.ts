import {
  mtas,
  emailHeaders,
  nullsinkCaptures,
  type Mta,
  type InsertMta,
  type EmailHeader,
  type InsertEmailHeader,
} from "@shared/schema";
import { db } from "../db";
import { eq, desc, sql } from "drizzle-orm";
import { encrypt, decrypt } from "../crypto";

// ═══════════════════════════════════════════════════════════════
// MTA MANAGEMENT
// ═══════════════════════════════════════════════════════════════

export async function getMtas(): Promise<Mta[]> {
  const results = await db.select().from(mtas).orderBy(desc(mtas.createdAt));
  return results.map(mta => ({
    ...mta,
    password: mta.password ? "••••••••" : null,
  }));
}

export async function getMta(id: string): Promise<Mta | undefined> {
  const [mta] = await db.select().from(mtas).where(eq(mtas.id, id));
  if (mta && mta.password) {
    mta.password = decrypt(mta.password);
  }
  return mta;
}

export async function createMta(data: InsertMta): Promise<Mta> {
  const dataToInsert = { ...data };
  if (dataToInsert.password) {
    dataToInsert.password = encrypt(dataToInsert.password);
  }
  const [mta] = await db.insert(mtas).values(dataToInsert).returning();
  return mta;
}

export async function updateMta(id: string, data: Partial<InsertMta>): Promise<Mta | undefined> {
  const dataToUpdate = { ...data };
  if (dataToUpdate.password && typeof dataToUpdate.password === 'string') {
    dataToUpdate.password = encrypt(dataToUpdate.password);
  }
  const [mta] = await db.update(mtas).set(dataToUpdate).where(eq(mtas.id, id)).returning();
  return mta;
}

export async function deleteMta(id: string): Promise<void> {
  await db.delete(nullsinkCaptures).where(eq(nullsinkCaptures.mtaId, id));
  await db.execute(sql`UPDATE campaigns SET mta_id = NULL WHERE mta_id = ${id}`);
  await db.delete(mtas).where(eq(mtas.id, id));
}

// ═══════════════════════════════════════════════════════════════
// EMAIL HEADERS
// ═══════════════════════════════════════════════════════════════

export async function getHeaders(): Promise<EmailHeader[]> {
  return db.select().from(emailHeaders);
}

export async function getDefaultHeaders(): Promise<EmailHeader[]> {
  return db.select().from(emailHeaders).where(eq(emailHeaders.isDefault, true));
}

export async function getHeader(id: string): Promise<EmailHeader | undefined> {
  const [header] = await db.select().from(emailHeaders).where(eq(emailHeaders.id, id));
  return header;
}

export async function createHeader(data: InsertEmailHeader): Promise<EmailHeader> {
  const [header] = await db.insert(emailHeaders).values(data).returning();
  return header;
}

export async function updateHeader(id: string, data: Partial<InsertEmailHeader>): Promise<EmailHeader | undefined> {
  const [header] = await db.update(emailHeaders).set(data).where(eq(emailHeaders.id, id)).returning();
  return header;
}

export async function deleteHeader(id: string): Promise<void> {
  await db.delete(emailHeaders).where(eq(emailHeaders.id, id));
}
