import { Elysia, t } from "elysia";
import { createClient } from "@libsql/client";
import { authGuard } from "../lib/auth-guard";
import { sqlite } from "../db/client";
import { isSqliteFile, validateUpload, replaceAllData } from "../lib/db-import";

export const importRoutes = new Elysia()
  .use(authGuard)
  .post(
    "/import",
    async ({ body, isAdmin, set }: any) => {
      if (!isAdmin) {
        set.status = 403;
        return { error: "admin_only" };
      }

      const bytes = new Uint8Array(await body.file.arrayBuffer());
      if (!isSqliteFile(bytes)) {
        set.status = 400;
        return { error: "not_sqlite" };
      }

      // Stage the upload to a temp file and open it as a second connection.
      const tmpPath = `/tmp/uang-import-${Date.now()}.db`;
      const { Bun } = globalThis as unknown as {
        Bun: { write(path: string, data: Uint8Array): Promise<number> };
      };
      await Bun.write(tmpPath, bytes);
      const src = createClient({ url: `file:${tmpPath}` });

      const valid = await validateUpload(src);
      if (!valid.ok) {
        set.status = 400;
        return { error: valid.error };
      }

      // Defence-in-depth: snapshot the live DB before we overwrite it.
      await sqlite.execute(`VACUUM INTO '/tmp/uang-pre-import-${Date.now()}.db'`);

      await replaceAllData(src, sqlite);
      return { ok: true };
    },
    { body: t.Object({ file: t.File() }) },
  );
