import { db } from "../server/db";
import { users } from "../shared/schema";
import { ne } from "drizzle-orm";

async function main() {
  const deleted = await db
    .delete(users)
    .where(ne(users.username, "ianis"))
    .returning({ username: users.username });
  console.log(`Deleted ${deleted.length} account(s):`, deleted.map((u) => u.username).join(", "));
  process.exit(0);
}

main().catch((err) => { console.error(err.message); process.exit(1); });
