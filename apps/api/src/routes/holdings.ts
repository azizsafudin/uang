import { Elysia, t } from "elysia";
import { authGuard } from "../lib/auth-guard";
import { holdings } from "../lib/holdings";

export const holdingsRoutes = new Elysia()
  .use(authGuard)
  .get("/holdings", async ({ query }) => holdings({ asOf: query.asOf, owner: query.owner }), {
    query: t.Object({
      asOf: t.Optional(t.String()),
      owner: t.Optional(t.String()),
    }),
  });
