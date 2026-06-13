import { db } from "../db/client";
import { accounts, entries, fxRates, settings } from "../db/schema";
import { and, eq, lte, sql, desc } from "drizzle-orm";
import { convertToBase, toBig, fromBig, SCALE } from "@uang/shared";

export async function accountBalanceMinor(accountId: string, asOf?: string): Promise<number> {
  const where = asOf
    ? and(eq(entries.accountId, accountId), lte(entries.date, asOf))
    : eq(entries.accountId, accountId);
  const rows = await db
    .select({ total: sql<number>`coalesce(sum(${entries.amountMinor}), 0)` })
    .from(entries)
    .where(where);
  return Number(rows[0]?.total ?? 0);
}

export async function latestFxRateScaled(currency: string, asOf?: string): Promise<number | null> {
  const where = asOf
    ? and(eq(fxRates.currency, currency), lte(fxRates.date, asOf))
    : eq(fxRates.currency, currency);
  const rows = await db
    .select({ rateScaled: fxRates.rateScaled })
    .from(fxRates)
    .where(where)
    .orderBy(desc(fxRates.date))
    .limit(1);
  return rows[0]?.rateScaled ?? null;
}

export type AccountValuation = {
  id: string; name: string; class: string; subtype: string; currency: string;
  balanceMinor: number; baseMinor: number; missingRate: boolean;
};

export type NetWorth = {
  baseCurrency: string;
  totalBaseMinor: number;
  accounts: AccountValuation[];
};

export async function netWorth(asOf?: string): Promise<NetWorth> {
  const s = (await db.select().from(settings).where(eq(settings.id, 1)))[0];
  const base = s?.baseCurrency ?? "USD";
  const accts = await db.select().from(accounts).where(eq(accounts.isArchived, 0));

  let total = 0n;
  const out: AccountValuation[] = [];
  for (const a of accts) {
    const balanceMinor = await accountBalanceMinor(a.id, asOf);
    let baseMinor = 0;
    let missingRate = false;
    if (a.currency.toUpperCase() === base.toUpperCase()) {
      baseMinor = balanceMinor;
    } else {
      const rate = await latestFxRateScaled(a.currency, asOf);
      if (rate === null) {
        missingRate = true;
      } else {
        baseMinor = fromBig(convertToBase(toBig(balanceMinor), a.currency, base, toBig(rate)));
      }
    }
    if (!missingRate) total += toBig(baseMinor);
    out.push({
      id: a.id, name: a.name, class: a.class, subtype: a.subtype, currency: a.currency,
      balanceMinor, baseMinor, missingRate,
    });
  }
  return { baseCurrency: base, totalBaseMinor: fromBig(total), accounts: out };
}

export { SCALE };
