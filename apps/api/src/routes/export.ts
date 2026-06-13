import { Elysia } from "elysia";
import { authGuard } from "../lib/auth-guard";
import { sqlite } from "../db/client";

export const exportRoutes = new Elysia()
  .use(authGuard)
  .get("/export", async () => {
    // Checkpoint WAL so the file on disk is consistent.
    try { await sqlite.execute("PRAGMA wal_checkpoint(TRUNCATE);"); } catch { /* non-fatal */ }

    const url = process.env.DATABASE_URL ?? "file:./data/uang.db";
    const path = url.replace(/^file:/, "");
    const file = (globalThis as any).Bun.file(path) as Blob;
    const today = new Date().toISOString().slice(0, 10);

    return new Response(file, {
      headers: {
        "content-type": "application/octet-stream",
        "content-disposition": `attachment; filename="uang-${today}.db"`,
      },
    });
  });
