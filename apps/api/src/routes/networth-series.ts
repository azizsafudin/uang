import { Elysia, t } from "elysia";
import { authGuard } from "../lib/auth-guard";
import { netWorthSeries } from "../lib/networth-series";

export const networthSeriesRoutes = new Elysia()
  .use(authGuard)
  .get(
    "/networth/series",
    async ({ query }) =>
      netWorthSeries({ from: query.from, to: query.to, owner: query.owner }),
    {
      query: t.Object({
        from: t.String(),
        to: t.Optional(t.String()),
        owner: t.Optional(t.String()),
      }),
    },
  );
