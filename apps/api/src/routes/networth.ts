import { Elysia, t } from "elysia";
import { authGuard } from "../lib/auth-guard";
import { netWorth } from "../lib/valuation";

export const networthRoutes = new Elysia()
  .use(authGuard)
  .get("/networth", async ({ query }) => netWorth({ asOf: query.asOf, owner: query.owner }), {
    query: t.Object({
      asOf: t.Optional(t.String()),
      owner: t.Optional(t.String()),
    }),
  });
