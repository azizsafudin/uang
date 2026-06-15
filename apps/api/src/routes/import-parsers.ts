import { Elysia, t } from "elysia";
import { db } from "../db/client";
import { importParsers, settings } from "../db/schema";
import { eq } from "drizzle-orm";
import { authGuard } from "../lib/auth-guard";
import { createId, nowEpoch } from "../lib/ids";
import { validateParserConfig, validateFingerprint } from "../lib/import/validate";
import { isUniqueViolation } from "../lib/db-errors";
import { synthesizeCsvConfig, refineCsvConfig, capSample, AiError, type AiConfig } from "../lib/import/ai";
import { parseCsv } from "../lib/import/csv";
import type { ParserConfig } from "../lib/import/types";

async function loadAiConfig(): Promise<AiConfig | null> {
  const s = (await db.select().from(settings).where(eq(settings.id, 1)))[0];
  if (!s?.aiBaseUrl || !s?.aiModel) return null;
  return { baseUrl: s.aiBaseUrl, model: s.aiModel, apiKey: s.aiApiKey ?? undefined };
}

function aiErrorResponse(e: unknown, set: { status?: number | string }) {
  if (e instanceof AiError && e.code === "ai_invalid_output") { set.status = 422; return { error: "ai_invalid_output" }; }
  set.status = 502; return { error: "ai_unavailable", message: e instanceof Error ? e.message : "failed" };
}

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
      try {
        validateFingerprint(body.fingerprint);
      } catch {
        set.status = 422; return { error: "invalid_fingerprint" };
      }
      const id = body.id ?? createId();
      try {
        await db.insert(importParsers).values({
          id, name: body.name, sourceFormat: body.sourceFormat,
          config: JSON.stringify(body.config), fingerprint: JSON.stringify(body.fingerprint),
          origin: body.origin ?? "manual", createdAt: nowEpoch(), createdBy: userId!,
        });
      } catch (e) {
        if (isUniqueViolation(e)) { set.status = 409; return { error: "duplicate_id" }; }
        throw e;
      }
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
      if (body.fingerprint !== undefined) {
        try { validateFingerprint(body.fingerprint); } catch { set.status = 422; return { error: "invalid_fingerprint" }; }
        update.fingerprint = JSON.stringify(body.fingerprint);
      }
      await db.update(importParsers).set(update).where(eq(importParsers.id, params.id));
      return { ok: true };
    },
    { body: t.Object({ name: t.Optional(t.String()), config: t.Optional(t.Unknown()), fingerprint: t.Optional(t.Unknown()) }) },
  )
  .delete("/import-parsers/:id", async ({ params }) => {
    await db.delete(importParsers).where(eq(importParsers.id, params.id));
    return { ok: true };
  })
  .post(
    "/import-parsers/synthesize",
    async ({ body, set }: any) => {
      const cfg = await loadAiConfig();
      if (!cfg) { set.status = 422; return { error: "ai_not_configured" }; }
      try {
        const config = await synthesizeCsvConfig(capSample(body.content), cfg);
        return { config };
      } catch (e) {
        return aiErrorResponse(e, set);
      }
    },
    { body: t.Object({ content: t.String({ maxLength: 200_000 }) }) },
  )
  .post(
    "/import-parsers/refine",
    async ({ body, set }: any) => {
      const cfg = await loadAiConfig();
      if (!cfg) { set.status = 422; return { error: "ai_not_configured" }; }
      try {
        const config = await refineCsvConfig(
          capSample(body.content), body.config, body.instruction ?? "", body.errors ?? [], cfg,
        );
        return { config };
      } catch (e) {
        return aiErrorResponse(e, set);
      }
    },
    {
      body: t.Object({
        content: t.String({ maxLength: 200_000 }),
        config: t.Unknown(),
        instruction: t.Optional(t.String({ maxLength: 500 })),
        errors: t.Optional(t.Array(t.Object({ raw: t.Record(t.String(), t.String()), reason: t.String() }), { maxItems: 50 })),
      }),
    },
  )
  .post(
    "/import-parsers/preview",
    async ({ body, set }: any) => {
      let config: ParserConfig;
      try { config = validateParserConfig(body.config); }
      catch { set.status = 422; return { error: "invalid_config" }; }
      if (config.format !== "csv") { set.status = 422; return { error: "invalid_config" }; }
      const all = parseCsv(body.content, config, (body.currency ?? "USD").toUpperCase());
      const bad = all.filter((r) => r.error || r.date === null || r.amountMinor === null);
      return {
        rows: all.slice(0, 5).map((r) => ({
          date: r.date, amountMinor: r.amountMinor, description: r.description, error: r.error ?? null,
        })),
        total: all.length,
        errorCount: bad.length,
        errors: bad.slice(0, 10).map((r) => ({ raw: r.raw, reason: r.error ?? "unparseable" })),
      };
    },
    { body: t.Object({ content: t.String({ maxLength: 200_000 }), config: t.Unknown(), currency: t.Optional(t.String()) }) },
  );
