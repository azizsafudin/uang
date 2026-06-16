import { Elysia, t } from "elysia";
import { db } from "../db/client";
import { instruments, transactions, prices, accounts } from "../db/schema";
import { eq, and, desc, inArray, notInArray } from "drizzle-orm";
import { authGuard } from "../lib/auth-guard";
import { createId, nowEpoch } from "../lib/ids";
import { ensureCurrencyInstrument } from "../lib/instruments";
import { getAllOwnerSets } from "../lib/owners";
import { isUniqueViolation } from "../lib/db-errors";
import { SCALE, currencyDecimals, roundDiv, toBig, fromBig } from "@uang/shared";

export const instrumentsRoutes = new Elysia({ prefix: "/instruments" })
  .use(authGuard)
  .get("/", async () => {
    const list = await db.select().from(instruments).orderBy(instruments.name);

    const allPrices = await db.select({ instrumentId: prices.instrumentId, date: prices.date, priceScaled: prices.priceScaled }).from(prices);
    const latest = new Map<string, { date: string; priceScaled: number }>();
    for (const p of allPrices) {
      const cur = latest.get(p.instrumentId);
      if (!cur || p.date > cur.date) latest.set(p.instrumentId, { date: p.date, priceScaled: p.priceScaled });
    }

    const txRows = await db.select({ instrumentId: transactions.instrumentId, accountId: transactions.accountId, unitsDelta: transactions.unitsDelta }).from(transactions);
    const byInstr = new Map<string, Map<string, bigint>>();
    for (const r of txRows) {
      let m = byInstr.get(r.instrumentId);
      if (!m) { m = new Map(); byInstr.set(r.instrumentId, m); }
      m.set(r.accountId, (m.get(r.accountId) ?? 0n) + toBig(r.unitsDelta));
    }

    return list.map((i) => {
      const lp = latest.get(i.id);
      const m = byInstr.get(i.id);
      let holderCount = 0;
      if (m) for (const u of m.values()) if (u !== 0n) holderCount++;
      return { ...i, latestPriceScaled: lp?.priceScaled ?? null, latestPriceDate: lp?.date ?? null, holderCount };
    });
  })
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
    async ({ body, set }) => {
      const id = createId();
      try {
        await db.insert(instruments).values({
          id,
          symbol: body.symbol ? body.symbol.toUpperCase() : null,
          isin: body.isin ?? null,
          name: body.name,
          kind: body.kind,
          currency: body.currency.toUpperCase(),
          createdAt: nowEpoch(),
        });
      } catch (e) {
        if (isUniqueViolation(e)) { set.status = 409; return { error: "duplicate_symbol" }; }
        throw e;
      }
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
    async ({ params, body, set }: any) => {
      const [current] = await db.select().from(instruments).where(eq(instruments.id, params.id));
      if (!current) { set.status = 404; return { error: "not_found" }; }

      // Lock symbol/ISIN once provider prices have been fetched: changing them would
      // mix the stored series against a different security. (manual/trade prices are
      // not symbol-derived, so they don't lock.)
      const newSymbol = body.symbol !== undefined ? (body.symbol ? body.symbol.toUpperCase() : null) : current.symbol;
      const newIsin = body.isin !== undefined ? (body.isin || null) : current.isin;
      if (newSymbol !== current.symbol || newIsin !== current.isin) {
        const fetched = await db
          .select({ id: prices.id })
          .from(prices)
          .where(and(eq(prices.instrumentId, params.id), notInArray(prices.source, ["manual", "trade"])))
          .limit(1);
        if (fetched.length > 0) { set.status = 409; return { error: "symbol_locked" }; }
      }

      const update: Record<string, unknown> = {};
      if (body.name !== undefined) update.name = body.name;
      if (body.symbol !== undefined) update.symbol = body.symbol ? body.symbol.toUpperCase() : null;
      if (body.isin !== undefined) update.isin = body.isin || null;
      if (body.kind !== undefined) update.kind = body.kind;
      if (body.currency !== undefined) update.currency = body.currency.toUpperCase();
      try {
        await db.update(instruments).set(update).where(eq(instruments.id, params.id));
      } catch (e) {
        if (isUniqueViolation(e)) { set.status = 409; return { error: "duplicate_symbol" }; }
        throw e;
      }
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

    // Latest stored price (+ its date) without pulling the whole series to the client.
    let priceScaled: number | null;
    let latestPriceDate: string | null = null;
    if (instr.kind === "currency") {
      priceScaled = Number(SCALE);
    } else {
      const [lp] = await db
        .select({ d: prices.date, s: prices.priceScaled })
        .from(prices)
        .where(eq(prices.instrumentId, params.id))
        .orderBy(desc(prices.date))
        .limit(1);
      priceScaled = lp?.s ?? null;
      latestPriceDate = lp?.d ?? null;
    }
    // Whether any provider-fetched price exists (drives the symbol/ISIN lock in the UI).
    const [fetchedRow] = await db
      .select({ id: prices.id })
      .from(prices)
      .where(and(eq(prices.instrumentId, params.id), notInArray(prices.source, ["manual", "trade"])))
      .limit(1);
    const hasFetchedPrices = !!fetchedRow;
    const dec = currencyDecimals(instr.currency);

    const byAcct = new Map<string, { name: string; units: bigint; txCount: number }>();
    for (const r of rows) {
      let a = byAcct.get(r.accountId);
      if (!a) { a = { name: r.accountName, units: 0n, txCount: 0 }; byAcct.set(r.accountId, a); }
      a.units += toBig(r.unitsDelta);
      a.txCount += 1;
    }

    const ownerSets = await getAllOwnerSets();
    const out: { accountId: string; name: string; ownerIds: string[]; units: number; txCount: number; marketValueMinor: number; missingPrice: boolean }[] = [];
    let totalTx = 0;
    for (const [accountId, a] of byAcct) {
      totalTx += a.txCount;
      const holds = a.units !== 0n;
      const marketValueMinor = holds && priceScaled !== null
        ? fromBig(roundDiv(a.units * toBig(priceScaled) * 10n ** BigInt(dec), SCALE * SCALE))
        : 0;
      out.push({ accountId, name: a.name, ownerIds: ownerSets.get(accountId) ?? [], units: fromBig(a.units), txCount: a.txCount, marketValueMinor, missingPrice: holds && priceScaled === null });
    }
    out.sort((x, y) => x.name.localeCompare(y.name));

    return { instrument: instr, instrumentCurrency: instr.currency, latestPriceScaled: priceScaled, latestPriceDate, hasFetchedPrices, accounts: out, totalTx };
  })
  .delete(
    "/:id",
    async ({ params, query, set }: any) => {
      const [instr] = await db.select().from(instruments).where(eq(instruments.id, params.id));
      if (!instr) { set.status = 404; return { error: "not_found" }; }

      const own = await db.select({ id: transactions.id }).from(transactions).where(eq(transactions.instrumentId, params.id));

      if (query.confirm !== "true") {
        const rows = await db
          .select({ accountId: transactions.accountId, accountName: accounts.name })
          .from(transactions)
          .innerJoin(accounts, eq(transactions.accountId, accounts.id))
          .where(eq(transactions.instrumentId, params.id));
        const counts = new Map<string, { name: string; txCount: number }>();
        for (const r of rows) {
          const c = counts.get(r.accountId) ?? { name: r.accountName, txCount: 0 };
          c.txCount += 1;
          counts.set(r.accountId, c);
        }
        set.status = 409;
        return {
          error: "confirm_required",
          accounts: [...counts].map(([id, c]) => ({ id, name: c.name, txCount: c.txCount })),
          totalTx: rows.length,
        };
      }

      const ownIds = own.map((o) => o.id);
      if (ownIds.length > 0) {
        await db.delete(transactions).where(inArray(transactions.linkedTransactionId, ownIds));
      }
      await db.delete(transactions).where(eq(transactions.instrumentId, params.id));
      await db.delete(prices).where(eq(prices.instrumentId, params.id));
      await db.delete(instruments).where(eq(instruments.id, params.id));
      return { ok: true };
    },
    { query: t.Object({ confirm: t.Optional(t.String()) }) },
  );
