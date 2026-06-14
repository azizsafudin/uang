import { db } from "../db/client";
import { accounts, entries, settings } from "../db/schema";
import { and, eq, lte, sql } from "drizzle-orm";
import { convertToBase, toBig, fromBig, SCALE } from "@uang/shared";
import { latestFxRateScaled } from "./fx";
import { getAllOwnerSets } from "./owners";

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

export type AccountValuation = {
  id: string; name: string; class: string; subtype: string; currency: string;
  balanceMinor: number; baseMinor: number; missingRate: boolean;
  ownerIds: string[]; shared: boolean;
};

export type NetWorthOpts = { asOf?: string; owner?: string };

export type NetWorth = {
  baseCurrency: string;
  totalBaseMinor: number;
  accounts: AccountValuation[];
};

export async function netWorth(opts: NetWorthOpts = {}): Promise<NetWorth> {
  const { asOf, owner } = opts;
  const s = (await db.select().from(settings).where(eq(settings.id, 1)))[0];
  const base = s?.baseCurrency ?? "USD";
  const accts = await db.select().from(accounts).where(eq(accounts.isArchived, 0));
  const ownerSets = await getAllOwnerSets();

  let total = 0n;
  const out: AccountValuation[] = [];
  for (const a of accts) {
    const ownerIds = ownerSets.get(a.id) ?? [];
    const shared = ownerIds.length >= 2;

    // Owner filter: a specific member sees only accounts they solely own.
    // `household` (or absent) sees everything.
    if (owner && owner !== "household") {
      const personalToOwner = ownerIds.length === 1 && ownerIds[0] === owner;
      if (!personalToOwner) continue;
    }

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
      balanceMinor, baseMinor, missingRate, ownerIds, shared,
    });
  }
  return { baseCurrency: base, totalBaseMinor: fromBig(total), accounts: out };
}

export { SCALE };
export { latestFxRateScaled };
