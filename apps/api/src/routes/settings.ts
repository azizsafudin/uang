import { Elysia, t } from "elysia";
import { db } from "../db/client";
import { settings } from "../db/schema";
import { eq } from "drizzle-orm";
import { authGuard } from "../lib/auth-guard";

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
    };
  })
  .patch(
    "/",
    async ({ body }: any) => {
      const update: Record<string, unknown> = {};
      if (body.contributionGrowthRateBps !== undefined) update.contributionGrowthRateBps = body.contributionGrowthRateBps;
      if (body.projectionEndAge !== undefined) update.projectionEndAge = body.projectionEndAge;
      if (body.dashboardTiles !== undefined) update.dashboardTiles = JSON.stringify(body.dashboardTiles);
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
      }),
    },
  );
