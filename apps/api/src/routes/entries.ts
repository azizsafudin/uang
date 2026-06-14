import { Elysia, t } from "elysia";
import { db } from "../db/client";
import { entries } from "../db/schema";
import { eq } from "drizzle-orm";
import { authGuard } from "../lib/auth-guard";
import { createId, nowEpoch } from "../lib/ids";
import { accountBalanceMinor } from "../lib/valuation";

// Shared mechanic: compute the delta needed so the account's balance AT `date` equals
// `targetMinor`, then insert a single entry of the given `kind`.
async function applyTarget(
  accountId: string,
  targetMinor: number,
  date: string,
  kind: "adjustment" | "revaluation",
  userId: string,
) {
  const current = await accountBalanceMinor(accountId, date);
  const delta = targetMinor - current;
  await db.insert(entries).values({
    id: createId(),
    accountId,
    date,
    amountMinor: delta,
    kind,
    createdAt: nowEpoch(),
    createdBy: userId,
  });
}

export const entriesRoutes = new Elysia()
  .use(authGuard)
  // List entries for an account, ordered by date
  .get("/accounts/:id/entries", async ({ params }) => {
    return db
      .select()
      .from(entries)
      .where(eq(entries.accountId, params.id))
      .orderBy(entries.date);
  })
  // Set the balance at a specific date by inserting an adjustment delta entry
  .post(
    "/accounts/:id/set-balance",
    async ({ params, body, userId }) => {
      await applyTarget(params.id, body.targetMinor, body.date, "adjustment", userId!);
      return { ok: true };
    },
    {
      body: t.Object({
        targetMinor: t.Number(),
        date: t.String(),
      }),
    },
  )
  // Revalue an account at a specific date (for FX or mark-to-market revaluations)
  .post(
    "/accounts/:id/revalue",
    async ({ params, body, userId }) => {
      await applyTarget(params.id, body.newValueMinor, body.date, "revaluation", userId!);
      return { ok: true };
    },
    {
      body: t.Object({
        newValueMinor: t.Number(),
        date: t.String(),
      }),
    },
  )
  // Raw entry insert (for manual transactions)
  .post(
    "/accounts/:id/entries",
    async ({ params, body, userId }) => {
      const id = createId();
      await db.insert(entries).values({
        id,
        accountId: params.id,
        date: body.date,
        amountMinor: body.amountMinor,
        kind: body.kind ?? "transaction",
        note: body.note ?? null,
        createdAt: nowEpoch(),
        createdBy: userId!,
      });
      return { id };
    },
    {
      body: t.Object({
        amountMinor: t.Number(),
        date: t.String(),
        kind: t.Optional(t.String()),
        note: t.Optional(t.String()),
      }),
    },
  )
  // Delete an entry by its own ID
  .delete("/entries/:id", async ({ params }) => {
    await db.delete(entries).where(eq(entries.id, params.id));
    return { ok: true };
  });
