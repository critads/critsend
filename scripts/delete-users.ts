import { db } from "../server/db";
import { users } from "../shared/schema";
import { inArray } from "drizzle-orm";

async function main() {
  const toDelete = ["admin_test_mN36", "shiwani@fensterweb.com"];
  const deleted = await db
    .delete(users)
    .where(inArray(users.username, toDelete))
    .returning({ username: users.username });
  console.log("Deleted accounts:", deleted.map((u) => u.username).join(", ") || "none");
  process.exit(0);
}

main().catch((err) => { console.error(err.message); process.exit(1); });
