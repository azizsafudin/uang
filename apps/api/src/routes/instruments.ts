import { Elysia, t } from "elysia";
import { db } from "../db/client";
import { instruments, transactions, prices, accounts } from "../db/schema";
import { eq, inArray } from "drizzle-orm";
import { authGuard } from "../lib/auth-guard";
import { createId, nowEpoch } from "../lib/ids";
import { ensureCurrencyInstrument } from "../lib/instruments";
import { SCALE, currencyDecimals, roundDiv, toBig, fromBig } from "@uang/shared";
import { instrumentPriceScaled } from "../lib/positions";

export const instrumentsRoutes = new Elysia({ prefix: "/instruments" })
  .use(authGuard)
  .get("/", async () => db.select().from(instruments).orderBy(instruments.name))
  // Find-or-create the currency instrument for a symbol; returns the full row.
  .post(
    "/currency",
    async ({ body }) => {
      const id = await ensureCurrencyInstrument(body.symbol);
      const [row] = await db.select().from(instruments).where(eq(instruments.id, id));
      return row;
    },
    { body: t.Object({ symbol: t.String({ pattern: "^[A-Za-z]{3}$" }) }) },
  )
  .post(
    "/",
    async ({ body }) => {
      const id = createId();
      await db.insert(instruments).values({
        id,
        symbol: body.symbol ?? null,
        isin: body.isin ?? null,
        name: body.name,
        kind: body.kind,
        currency: body.currency.toUpperCase(),
        createdAt: nowEpoch(),
      });
      return { id };
    },
    {
      body: t.Object({
        name: t.String({ minLength: 1 }),
        kind: t.Union([
          t.Literal("stock"), t.Literal("etf"), t.Literal("fund"),
          t.Literal("crypto"), t.Literal("other"),
        ]),
        currency: t.String({ pattern: "^[A-Za-z]{3}$" }),
        symbol: t.Optional(t.String()),
        isin: t.Optional(t.String()),
      }),
    },
  )
  .patch(
    "/:id",
    async ({ params, body }: any) => {
      const update: Record<string, unknown> = {};
      if (body.name !== undefined) update.name = body.name;
      if (body.symbol !== undefined) update.symbol = body.symbol || null;
      if (body.isin !== undefined) update.isin = body.isin || null;
      if (body.kind !== undefined) update.kind = body.kind;
      if (body.currency !== undefined) update.currency = body.currency.toUpperCase();
      await db.update(instruments).set(update).where(eq(instruments.id, params.id));
      return { ok: true };
    },
    {
      body: t.Object({
        name: t.Optional(t.String({ minLength: 1 })),
        symbol: t.Optional(t.String()),
        isin: t.Optional(t.String()),
        kind: t.Optional(t.Union([
          t.Literal("currency"), t.Literal("stock"), t.Literal("etf"),
          t.Literal("fund"), t.Literal("crypto"), t.Literal("other"),
        ])),
        currency: t.Optional(t.String({ pattern: "^[A-Za-z]{3}$" })),
      }),
    },
  )
  .get("/:id", async ({ params, set }) => {
    const [instr] = await db.select().from(instruments).where(eq(instruments.id, params.id));
    if (!instr) { set.status = 404; return { error: "not_found" }; }

    const rows = await db
      .select({ accountId: transactions.accountId, accountName: accounts.name, unitsDelta: transactions.unitsDelta })
      .from(transactions)
      .innerJoin(accounts, eq(transactions.accountId, accounts.id))
      .where(eq(transactions.instrumentId, params.id));

    const priceScaled = instr.kind === "currency" ? Number(SCALE) : await instrumentPriceScaled(params.id);
    const dec = currencyDecimals(instr.currency);

    const byAcct = new Map<string, { name: string; units: bigint; txCount: number }>();
    for (const r of rows) {
      let a = byAcct.get(r.accountId);
      if (!a) { a = { name: r.accountName, units: 0n, txCount: 0 }; byAcct.set(r.accountId, a); }
      a.units += toBig(r.unitsDelta);
      a.txCount += 1;
    }

    const out: { accountId: string; name: string; units: number; txCount: number; marketValueMinor: number; missingPrice: boolean }[] = [];
    let totalTx = 0;
    for (const [accountId, a] of byAcct) {
      totalTx += a.txCount;
      const holds = a.units !== 0n;
      const marketValueMinor = holds && priceScaled !== null
        ? fromBig(roundDiv(a.units * toBig(priceScaled) * 10n ** BigInt(dec), SCALE * SCALE))
        : 0;
      out.push({ accountId, name: a.name, units: fromBig(a.units), txCount: a.txCount, marketValueMinor, missingPrice: holds && priceScaled === null });
    }
    out.sort((x, y) => x.name.localeCompare(y.name));

    return { instrument: instr, instrumentCurrency: instr.currency, latestPriceScaled: priceScaled, accounts: out, totalTx };
  });
