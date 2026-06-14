import { Elysia, t } from "elysia";
import { db } from "../db/client";
import { memberProfiles, user } from "../db/schema";
import { authGuard } from "../lib/auth-guard";

export const membersRoutes = new Elysia({ prefix: "/members" })
  .use(authGuard)
  .get("/", async () => {
    const users = await db.select().from(user);
    const profiles = await db.select().from(memberProfiles);
    const birthYearById = new Map(profiles.map((p) => [p.userId, p.birthYear]));
    return users.map((u) => ({
      id: u.id,
      name: u.name,
      birthYear: birthYearById.get(u.id) ?? null,
    }));
  })
  .patch(
    "/:id",
    async ({ params, body }: any) => {
      const birthYear = body.birthYear ?? null;
      await db
        .insert(memberProfiles)
        .values({ userId: params.id, birthYear })
        .onConflictDoUpdate({ target: memberProfiles.userId, set: { birthYear } });
      return { ok: true };
    },
    { body: t.Object({ birthYear: t.Union([t.Number(), t.Null()]) }) },
  );
