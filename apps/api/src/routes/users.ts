import { Elysia, t } from "elysia";
import { db } from "../db/client";
import { user } from "../db/schema";
import { authGuard } from "../lib/auth-guard";
import { auth } from "../auth";

export const usersRoutes = new Elysia({ prefix: "/users" })
  .use(authGuard)
  .get("/", async () => {
    const rows = await db.select().from(user);
    return rows.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      isAdmin: !!u.isAdmin,
    }));
  })
  .post(
    "/",
    async ({ body, isAdmin, set }: any) => {
      if (!isAdmin) {
        set.status = 403;
        return { error: "admin_only" };
      }
      try {
        await auth.api.signUpEmail({
          body: { email: body.email, name: body.name, password: body.password },
          headers: new Headers(),
        });
      } catch {
        set.status = 422;
        return { error: "create_failed" };
      }
      return { ok: true };
    },
    {
      body: t.Object({
        email: t.String({ format: "email" }),
        name: t.String({ minLength: 1 }),
        password: t.String({ minLength: 8 }),
      }),
    },
  );
