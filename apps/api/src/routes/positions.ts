import { Elysia } from "elysia";
import { db } from "../db/client";
import { accounts, settings } from "../db/schema";
import { eq } from "drizzle-orm";
import { authGuard } from "../lib/auth-guard";
import { accountPositions } from "../lib/positions";
import { accountValueMinor, convertMinor } from "../lib/valuation";

export const positionsRoutes = new Elysia()
  .use(authGuard)
  .get("/accounts/:id/positions", async ({ params }) => {
    const s = (await db.select().from(settings).where(eq(settings.id, 1)))[0];
    const base = s?.baseCurrency ?? "USD";
    const [acct] = await db.select().from(accounts).where(eq(accounts.id, params.id));
    const accountCurrency = acct?.currency ?? base;

    const positions = await accountPositions(params.id);
    const enriched = await Promise.all(positions.map(async (p) => {
      if (p.missingPrice) return { ...p, valueDisplayMinor: 0, valueMissing: true };
      const conv = await convertMinor(p.marketValueMinor, p.instrumentCurrency, accountCurrency, base);
      return { ...p, valueDisplayMinor: conv ?? 0, valueMissing: conv === null };
    }));

    const totalDisp = await accountValueMinor(params.id, accountCurrency, base);
    const totalBase = await accountValueMinor(params.id, base, base);

    return {
      accountCurrency,
      baseCurrency: base,
      totalMinor: totalDisp.valueMinor,
      totalBaseMinor: totalBase.valueMinor,
      missing: totalBase.missing,
      positions: enriched,
    };
  });
