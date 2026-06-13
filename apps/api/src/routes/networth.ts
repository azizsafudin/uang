import { Elysia, t } from "elysia";
import { authGuard } from "../lib/auth-guard";
import { netWorth } from "../lib/valuation";

export const networthRoutes = new Elysia()
  .use(authGuard)
  .get("/networth", async ({ query }) => netWorth(query.asOf), {
    query: t.Object({ asOf: t.Optional(t.String()) }),
  });
