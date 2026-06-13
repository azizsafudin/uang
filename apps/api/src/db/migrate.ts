import { migrate } from "drizzle-orm/libsql/migrator";
import { db, sqlite } from "./client";

export async function runMigrations() {
  await migrate(db, { migrationsFolder: new URL("../../drizzle", import.meta.url).pathname });
}

// Allow running directly: `bun run src/db/migrate.ts`
if (import.meta.main) {
  await runMigrations();
  sqlite.close();
  console.log("migrations applied");
}
