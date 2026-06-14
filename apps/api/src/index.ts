import { runMigrations } from "./db/migrate";
import { backfillOwners } from "./lib/owners";
import { createApp } from "./app";

const ephemeral = (process.env.DATABASE_URL ?? "").includes("/tmp/");
if (process.env.NODE_ENV === "production" && (ephemeral || !process.env.DATABASE_URL)) {
  throw new Error("Refusing to start in production without a persistent DATABASE_URL");
}

const secret = process.env.BETTER_AUTH_SECRET ?? "";
if (process.env.NODE_ENV === "production" && (secret === "" || secret === "dev-secret" || secret.length < 32)) {
  throw new Error("Refusing to start in production without a strong BETTER_AUTH_SECRET (>= 32 chars)");
}

await runMigrations();
await backfillOwners(); // idempotent: give pre-ownership accounts their creator as sole owner
const app = createApp();
const port = Number(process.env.PORT ?? 3000);
app.listen(port);
console.log(`API listening on :${port}`);
