import { db } from "../db/client";
import { accounts, entries, settings } from "../db/schema";
import { and, eq, lte, sql } from "drizzle-orm";
import { convertToBase, toBig, fromBig, SCALE } from "@uang/shared";
import { latestFxRateScaled } from "./fx";
import { holdingsAccountValuation } from "./holdings";
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
  growthRateBps: number;
  accessibleFromAge: number;
  earlyWithdrawal: "none" | "penalty";
  earlyHaircutBps: number;
  illiquid: boolean;
  liquidationAge: number | null;
  groupId: string | null; sortOrder: number;
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

    let balanceMinor = 0;
    let baseMinor = 0;
    let missingRate = false;
    let currency = a.currency;

    if (a.valuationMode === "holdings") {
      const hv = await holdingsAccountValuation(a.id, asOf, base);
      baseMinor = hv.baseMinor;
      balanceMinor = hv.baseMinor; // holdings: own-currency balance == base total (display rule)
      missingRate = hv.missing;
      currency = base;             // holdings report in base currency
    } else {
      balanceMinor = await accountBalanceMinor(a.id, asOf);
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
    }
    if (!missingRate) total += toBig(baseMinor);
    out.push({
      id: a.id, name: a.name, class: a.class, subtype: a.subtype, currency,
      balanceMinor, baseMinor, missingRate, ownerIds, shared,
      growthRateBps: a.growthRateBps,
      accessibleFromAge: a.accessibleFromAge,
      earlyWithdrawal: a.earlyWithdrawal,
      earlyHaircutBps: a.earlyHaircutBps,
      illiquid: a.illiquid === 1,
      liquidationAge: a.liquidationAge ?? null,
      groupId: a.groupId ?? null,
      sortOrder: a.sortOrder,
    });
  }
  return { baseCurrency: base, totalBaseMinor: fromBig(total), accounts: out };
}

export { SCALE };
export { latestFxRateScaled };
