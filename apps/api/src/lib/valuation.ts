import { db } from "../db/client";
import { accounts, settings } from "../db/schema";
import { eq } from "drizzle-orm";
import { convertToBase, convertFromBase, toBig, fromBig, SCALE } from "@uang/shared";
import { latestFxRateScaled } from "./fx";
import { accountPositions } from "./positions";
import { getAllOwnerSets } from "./owners";

// Convert an amount in `from` currency minor units to `to` currency minor units, routing
// through `base` (X→base via fx(X); base→Y via fx(Y) inverse). null if a needed rate is
// missing. Identity when from === to.
export async function convertMinor(
  amountMinor: number, from: string, to: string, base: string, asOf?: string,
): Promise<number | null> {
  if (from.toUpperCase() === to.toUpperCase()) return amountMinor;

  let baseMinor: number;
  if (from.toUpperCase() === base.toUpperCase()) {
    baseMinor = amountMinor;
  } else {
    const r = await latestFxRateScaled(from, asOf);
    if (r === null) return null;
    baseMinor = fromBig(convertToBase(toBig(amountMinor), from, base, toBig(r)));
  }

  if (to.toUpperCase() === base.toUpperCase()) return baseMinor;
  const r2 = await latestFxRateScaled(to, asOf);
  if (r2 === null) return null;
  return fromBig(convertFromBase(toBig(baseMinor), base, to, toBig(r2)));
}

// Total value of an account in `target` currency by summing each position's market value
// (in the instrument's currency) converted to `target`. A missing price or missing FX rate
// flags `missing` and excludes that position.
export async function accountValueMinor(
  accountId: string, target: string, base: string, asOf?: string,
): Promise<{ valueMinor: number; missing: boolean }> {
  const positions = await accountPositions(accountId, asOf);
  let total = 0n;
  let missing = false;
  for (const p of positions) {
    if (p.missingPrice) { missing = true; continue; }
    const conv = await convertMinor(p.marketValueMinor, p.instrumentCurrency, target, base, asOf);
    if (conv === null) { missing = true; continue; }
    total += toBig(conv);
  }
  return { valueMinor: fromBig(total), missing };
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
  spendType: "none" | "once" | "monthly" | "percent";
  spendAmountMinor: number | null;
  spendRateBps: number | null;
  spendStartKind: "age" | "target";
  spendStartAge: number | null;
  spendStartTargetMinor: number | null;
  contributionMinor: number;
  contributionUntilAge: number | null;
  compoundInterval: "monthly" | "quarterly" | "annually";
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
    if (owner && owner !== "household") {
      const personalToOwner = ownerIds.length === 1 && ownerIds[0] === owner;
      if (!personalToOwner) continue;
    }

    const baseRes = await accountValueMinor(a.id, base, base, asOf);
    const dispRes = await accountValueMinor(a.id, a.currency, base, asOf);
    const missingRate = baseRes.missing;
    if (!missingRate) total += toBig(baseRes.valueMinor);

    out.push({
      id: a.id, name: a.name, class: a.class, subtype: a.subtype, currency: a.currency,
      balanceMinor: dispRes.valueMinor, baseMinor: baseRes.valueMinor, missingRate, ownerIds, shared,
      growthRateBps: a.growthRateBps,
      accessibleFromAge: a.accessibleFromAge,
      earlyWithdrawal: a.earlyWithdrawal,
      earlyHaircutBps: a.earlyHaircutBps,
      illiquid: a.illiquid === 1,
      liquidationAge: a.liquidationAge ?? null,
      spendType: a.spendType,
      spendAmountMinor: a.spendAmountMinor ?? null,
      spendRateBps: a.spendRateBps ?? null,
      spendStartKind: a.spendStartKind,
      spendStartAge: a.spendStartAge ?? null,
      spendStartTargetMinor: a.spendStartTargetMinor ?? null,
      contributionMinor: a.contributionMinor,
      contributionUntilAge: a.contributionUntilAge ?? null,
      compoundInterval: a.compoundInterval,
      groupId: a.groupId ?? null,
      sortOrder: a.sortOrder,
    });
  }
  return { baseCurrency: base, totalBaseMinor: fromBig(total), accounts: out };
}

export { SCALE };
export { latestFxRateScaled };
