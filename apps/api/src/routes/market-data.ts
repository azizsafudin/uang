import { Elysia, t } from "elysia";
import { db } from "../db/client";
import { settings } from "../db/schema";
import { eq } from "drizzle-orm";
import { authGuard } from "../lib/auth-guard";
import { refreshInstrumentPrice, refreshAllPrices, refreshFx, lookupInstrument } from "../lib/market-data";
import { makeAlphaVantageProvider } from "../lib/market-data/providers/alphavantage";

const range = t.Optional(t.Object({
  from: t.Optional(t.String()),
  to: t.Optional(t.String()),
  backfill: t.Optional(t.Boolean()),
}));

export const marketDataRoutes = new Elysia({ prefix: "/market-data" })
  .use(authGuard)
  .post("/instrument/:id/refresh", async ({ params, body }: any) =>
    refreshInstrumentPrice(params.id, body ?? undefined), { body: range })
  .post("/instruments/refresh", async ({ body }: any) =>
    refreshAllPrices(body ?? undefined), { body: range })
  .post("/fx/refresh", async ({ body }: any) =>
    refreshFx(body ?? undefined), { body: range })
  .post("/lookup", async ({ body }: any) => {
    const r = await lookupInstrument(body.query);
    return r ? { found: true, ...r } : { found: false };
  }, { body: t.Object({ query: t.String({ minLength: 1 }) }) })
  .post("/test", async ({ body, isAdmin, set }: any) => {
    if (!isAdmin) { set.status = 403; return { error: "admin_only" }; }
    const s = (await db.select().from(settings).where(eq(settings.id, 1)))[0];
    // Prefer the (possibly unsaved) key from the form; a blank field falls back
    // to the stored key (write-only field).
    const apiKey =
      typeof body?.marketDataApiKey === "string" && body.marketDataApiKey.length > 0
        ? body.marketDataApiKey
        : s?.marketDataApiKey;
    if (!apiKey) return { ok: false, message: "No Alpha Vantage key configured" };
    try {
      const r = await makeAlphaVantageProvider(apiKey)
        .fetchPrice({ symbol: "IBM", isin: null, currency: "USD", kind: "stock" });
      return r ? { ok: true } : { ok: false, message: "No data (rate-limited or invalid key)" };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : "request failed" };
    }
  }, {
    body: t.Optional(t.Object({
      marketDataApiKey: t.Optional(t.String()),
    })),
  });
