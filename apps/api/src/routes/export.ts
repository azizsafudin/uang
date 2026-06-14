import { Elysia } from "elysia";
import { authGuard } from "../lib/auth-guard";
import { sqlite } from "../db/client";

export const exportRoutes = new Elysia()
  .use(authGuard)
  .get("/export", async () => {
    // VACUUM INTO writes a clean, WAL-free snapshot to a temp file.
    // Works for both file-based and in-memory databases.
    const tmpPath = `/tmp/uang-export-${Date.now()}.db`;
    await sqlite.execute(`VACUUM INTO '${tmpPath}'`);

    // Typed access to Bun.file: this module is pulled into the web app's
    // typecheck via the Eden `App` type, where Bun's global types aren't loaded.
    const { Bun } = globalThis as unknown as { Bun: { file(path: string): Blob } };
    const file = Bun.file(tmpPath);
    const today = new Date().toISOString().slice(0, 10);

    return new Response(file, {
      headers: {
        "content-type": "application/octet-stream",
        "content-disposition": `attachment; filename="uang-${today}.db"`,
      },
    });
  });
