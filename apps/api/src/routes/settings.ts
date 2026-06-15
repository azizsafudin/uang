import { Elysia, t } from "elysia";
import { db } from "../db/client";
import { settings } from "../db/schema";
import { eq } from "drizzle-orm";
import { authGuard } from "../lib/auth-guard";
import { chatJson, AiError } from "../lib/import/ai";

export const settingsRoutes = new Elysia({ prefix: "/settings" })
  .use(authGuard)
  .get("/", async () => {
    const s = (await db.select().from(settings).where(eq(settings.id, 1)))[0];
    return {
      householdName: s?.householdName ?? "",
      baseCurrency: s?.baseCurrency ?? "USD",
      contributionGrowthRateBps: s?.contributionGrowthRateBps ?? 800,
      projectionEndAge: s?.projectionEndAge ?? 90,
      dashboardTiles: JSON.parse(
        s?.dashboardTiles ?? '["assets","liabilities","goalsOnTrack"]',
      ) as string[],
      aiBaseUrl: s?.aiBaseUrl ?? "",
      aiModel: s?.aiModel ?? "",
      aiApiKeySet: !!s?.aiApiKey,
    };
  })
  .patch(
    "/",
    async ({ body, isAdmin, set }: any) => {
      const touchesAi =
        body.aiBaseUrl !== undefined || body.aiModel !== undefined || body.aiApiKey !== undefined;
      if (touchesAi && !isAdmin) {
        set.status = 403;
        return { error: "admin_only" };
      }
      const update: Record<string, unknown> = {};
      if (body.contributionGrowthRateBps !== undefined) update.contributionGrowthRateBps = body.contributionGrowthRateBps;
      if (body.projectionEndAge !== undefined) update.projectionEndAge = body.projectionEndAge;
      if (body.dashboardTiles !== undefined) update.dashboardTiles = JSON.stringify(body.dashboardTiles);
      if (body.aiBaseUrl !== undefined) update.aiBaseUrl = body.aiBaseUrl || null;
      if (body.aiModel !== undefined) update.aiModel = body.aiModel || null;
      // Empty/omitted aiApiKey preserves the stored key (write-only field).
      if (typeof body.aiApiKey === "string" && body.aiApiKey.length > 0) update.aiApiKey = body.aiApiKey;
      if (Object.keys(update).length > 0) {
        await db.update(settings).set(update).where(eq(settings.id, 1));
      }
      return { ok: true };
    },
    {
      body: t.Object({
        contributionGrowthRateBps: t.Optional(t.Number()),
        projectionEndAge: t.Optional(t.Number()),
        dashboardTiles: t.Optional(t.Array(t.String())),
        aiBaseUrl: t.Optional(t.String()),
        aiModel: t.Optional(t.String()),
        aiApiKey: t.Optional(t.String()),
      }),
    },
  )
  .post("/ai/test", async ({ isAdmin, set }: any) => {
    if (!isAdmin) {
      set.status = 403;
      return { error: "admin_only" };
    }
    const s = (await db.select().from(settings).where(eq(settings.id, 1)))[0];
    if (!s?.aiBaseUrl || !s?.aiModel) return { ok: false, message: "AI is not configured" };
    try {
      await chatJson(
        { baseUrl: s.aiBaseUrl, model: s.aiModel, apiKey: s.aiApiKey ?? undefined },
        "Reply with {\"ok\":true} as JSON.",
        "ping",
      );
      return { ok: true };
    } catch (e) {
      return { ok: false, message: e instanceof AiError ? e.message : "request failed" };
    }
  });
