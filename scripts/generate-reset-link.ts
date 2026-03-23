/**
 * Generates a one-time password reset link for the admin account.
 * The link is valid for 1 hour.
 *
 * Usage:
 *   npx tsx scripts/generate-reset-link.ts
 *
 * Optional env vars:
 *   BASE_URL  — e.g. https://your-app.replit.app  (defaults to http://localhost:5000)
 */

import crypto from "crypto";
import { db } from "../server/db";
import { users } from "../shared/schema";

async function main() {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    console.error("ERROR: SESSION_SECRET environment variable is not set.");
    process.exit(1);
  }

  const allUsers = await db.select({ id: users.id, username: users.username }).from(users);

  if (allUsers.length === 0) {
    console.error("ERROR: No users found in the database.");
    process.exit(1);
  }

  const user = allUsers[0];
  const expiresAt = Date.now() + 60 * 60 * 1000;
  const payload = `${user.id}|${expiresAt}`;
  const hmac = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  const token = Buffer.from(payload).toString("base64url") + "." + hmac;

  const baseUrl = (process.env.BASE_URL || "http://localhost:5000").replace(/\/$/, "");
  const resetUrl = `${baseUrl}/reset-password?token=${encodeURIComponent(token)}`;

  console.log("\n╔══════════════════════════════════════════════════════╗");
  console.log("║           CRITSEND PASSWORD RESET LINK              ║");
  console.log("╚══════════════════════════════════════════════════════╝");
  console.log(`\n  User     : ${user.username} (${user.id})`);
  console.log(`  Expires  : ${new Date(expiresAt).toLocaleString()} (1 hour)`);
  console.log(`\n  Reset URL:\n  ${resetUrl}`);
  console.log("\n  Keep this link private — it grants full password access.\n");

  process.exit(0);
}

main().catch((err) => {
  console.error("Error generating reset link:", err.message);
  process.exit(1);
});
