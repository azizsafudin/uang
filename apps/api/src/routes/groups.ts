import { Elysia, t } from "elysia";
import { db } from "../db/client";
import { groups, accounts } from "../db/schema";
import { eq, asc } from "drizzle-orm";
import { authGuard } from "../lib/auth-guard";
import { createId, nowEpoch } from "../lib/ids";
import { isUniqueViolation } from "../lib/db-errors";

// Semantic palette keys. Must stay in sync with apps/web/src/lib/group-colors.ts.
const GROUP_COLOR_KEYS = [
  "slate", "red", "orange", "amber", "yellow", "lime",
  "green", "teal", "cyan", "blue", "violet", "pink",
] as const;
const GROUP_COLOR_KEY_SET: ReadonlySet<string> = new Set(GROUP_COLOR_KEYS);

// The body schema stays loose (string|null) so Eden treaty infers the payload
// type cleanly; the known-key check is enforced in the handlers below, which
// reject an unknown key with 422. null clears the color.
const colorSchema = t.Union([t.String(), t.Null()]);

// Returns true when the provided color is acceptable (absent, null, or a known
// key). Sets a 422 status on `set` and returns false otherwise.
function isValidColor(color: unknown, set: { status?: number | string }): boolean {
  if (color === undefined || color === null) return true;
  if (typeof color === "string" && GROUP_COLOR_KEY_SET.has(color)) return true;
  set.status = 422;
  return false;
}

export const groupsRoutes = new Elysia({ prefix: "/groups" })
  .use(authGuard)
  .get("/", async () => {
    return db.select().from(groups).orderBy(asc(groups.sortOrder));
  })
  .post(
    "/",
    async ({ body, set }: any) => {
      if (!isValidColor(body.color, set)) return { error: "invalid_color" };
      const id = body.id ?? createId();
      try {
        await db.insert(groups).values({
          id,
          name: body.name,
          class: body.class,
          sortOrder: body.sortOrder ?? 0,
          color: body.color ?? null,
          createdAt: nowEpoch(),
        });
      } catch (e) {
        if (isUniqueViolation(e)) {
          set.status = 409;
          return { error: "duplicate_id" };
        }
        throw e;
      }
      return { id };
    },
    {
      body: t.Object({
        id: t.Optional(t.String()),
        name: t.String({ minLength: 1 }),
        class: t.Union([t.Literal("asset"), t.Literal("liability")]),
        sortOrder: t.Optional(t.Number()),
        color: t.Optional(colorSchema),
      }),
    },
  )
  .patch(
    "/:id",
    async ({ params, body, set }: any) => {
      if (!isValidColor(body.color, set)) return { error: "invalid_color" };
      const update: Record<string, unknown> = {};
      if (body.name !== undefined) update.name = body.name;
      if (body.sortOrder !== undefined) update.sortOrder = body.sortOrder;
      if (body.color !== undefined) update.color = body.color;
      await db.update(groups).set(update).where(eq(groups.id, params.id));
      return { ok: true };
    },
    {
      body: t.Object({
        name: t.Optional(t.String({ minLength: 1 })),
        sortOrder: t.Optional(t.Number()),
        color: t.Optional(colorSchema),
      }),
    },
  )
  .delete("/:id", async ({ params }: any) => {
    await db.update(accounts).set({ groupId: null }).where(eq(accounts.groupId, params.id));
    await db.delete(groups).where(eq(groups.id, params.id));
    return { ok: true };
  });
