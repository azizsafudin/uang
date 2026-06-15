import { Elysia, t } from "elysia";
import { db } from "../db/client";
import { importParsers } from "../db/schema";
import { eq } from "drizzle-orm";
import { authGuard } from "../lib/auth-guard";
import { createId, nowEpoch } from "../lib/ids";
import { validateParserConfig } from "../lib/import/validate";

export const importParsersRoutes = new Elysia()
  .use(authGuard)
  .get("/import-parsers", async () => {
    const rows = await db.select().from(importParsers);
    return rows.map((r) => ({ ...r, config: JSON.parse(r.config), fingerprint: JSON.parse(r.fingerprint) }));
  })
  .post(
    "/import-parsers",
    async ({ body, userId, set }: any) => {
      try {
        validateParserConfig(body.config);
      } catch {
        set.status = 422; return { error: "invalid_config" };
      }
      const id = body.id ?? createId();
      await db.insert(importParsers).values({
        id, name: body.name, sourceFormat: body.sourceFormat,
        config: JSON.stringify(body.config), fingerprint: JSON.stringify(body.fingerprint),
        origin: body.origin ?? "manual", createdAt: nowEpoch(), createdBy: userId!,
      });
      return { id };
    },
    {
      body: t.Object({
        id: t.Optional(t.String()),
        name: t.String(),
        sourceFormat: t.Union([t.Literal("csv"), t.Literal("ofx"), t.Literal("qif"), t.Literal("pdf")]),
        config: t.Unknown(),
        fingerprint: t.Unknown(),
        origin: t.Optional(t.Union([t.Literal("ai"), t.Literal("manual")])),
      }),
    },
  )
  .patch(
    "/import-parsers/:id",
    async ({ params, body, set }: any) => {
      const update: Record<string, unknown> = {};
      if (body.name !== undefined) update.name = body.name;
      if (body.config !== undefined) {
        try { validateParserConfig(body.config); } catch { set.status = 422; return { error: "invalid_config" }; }
        update.config = JSON.stringify(body.config);
      }
      if (body.fingerprint !== undefined) update.fingerprint = JSON.stringify(body.fingerprint);
      await db.update(importParsers).set(update).where(eq(importParsers.id, params.id));
      return { ok: true };
    },
    { body: t.Object({ name: t.Optional(t.String()), config: t.Optional(t.Unknown()), fingerprint: t.Optional(t.Unknown()) }) },
  )
  .delete("/import-parsers/:id", async ({ params }) => {
    await db.delete(importParsers).where(eq(importParsers.id, params.id));
    return { ok: true };
  });
