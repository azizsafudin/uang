import { runMigrations } from "./db/migrate";
import { createApp } from "./app";

const ephemeral = (process.env.DATABASE_URL ?? "").includes("/tmp/");
if (process.env.NODE_ENV === "production" && (ephemeral || !process.env.DATABASE_URL)) {
  throw new Error("Refusing to start in production without a persistent DATABASE_URL");
}

await runMigrations();
const app = createApp();
const port = Number(process.env.PORT ?? 3000);
app.listen(port);
console.log(`API listening on :${port}`);
