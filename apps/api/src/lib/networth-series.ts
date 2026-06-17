import { db } from "../db/client";
import { settings, accounts, transactions, instruments } from "../db/schema";
import { eq } from "drizzle-orm";
import { netWorth, convertMinor } from "./valuation";
import { getAllOwnerSets } from "./owners";
import { currencyDecimals, toBig, fromBig, roundDiv, SCALE } from "@uang/shared";

export type NetWorthPoint = { date: string; totalBaseMinor: number; netDepositsBaseMinor: number };
export type NetWorthSeries = { baseCurrency: string; points: NetWorthPoint[] };

const DAY_MS = 86_400_000;

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

// Weekly dates from `to` stepping back 7 days until before `from`, returned ascending.
// Anchoring on `to` guarantees the last point equals the headline's as-of-today value.
function weeklyDates(from: string, to: string): string[] {
  const fromMs = Date.parse(`${from}T00:00:00Z`);
  let cur = Date.parse(`${to}T00:00:00Z`);
  const dates: string[] = [];
  while (cur >= fromMs) {
    dates.push(new Date(cur).toISOString().slice(0, 10));
    cur -= 7 * DAY_MS;
  }
  return dates.reverse();
}

async function baseCurrencyFromSettings(): Promise<string> {
  const s = (await db.select().from(settings).where(eq(settings.id, 1)))[0];
  return s?.baseCurrency ?? "USD";
}

type Flow = { date: string; baseMinor: number };

// The set of account ids net worth and contributions both draw from:
// non-archived, and (for a member owner) only that member's sole-owned accounts.
async function includedAccountIds(owner?: string): Promise<Set<string>> {
  const ownerSets = await getAllOwnerSets();
  const accts = await db.select().from(accounts).where(eq(accounts.isArchived, 0));
  const included = new Set<string>();
  for (const a of accts) {
    const ownerIds = ownerSets.get(a.id) ?? [];
    if (owner && owner !== "household") {
      const personal = ownerIds.length === 1 && ownerIds[0] === owner;
      if (!personal) continue;
    }
    included.add(a.id);
  }
  return included;
}

// Earliest transaction date across the owner's included accounts (the natural
// start for an "all time" range), or null when there are no transactions.
async function earliestTxDate(owner?: string): Promise<string | null> {
  const included = await includedAccountIds(owner);
  const rows = await db
    .select({ date: transactions.date, accountId: transactions.accountId })
    .from(transactions);
  let min: string | null = null;
  for (const r of rows) {
    if (!included.has(r.accountId)) continue;
    if (min === null || r.date < min) min = r.date;
  }
  return min;
}

// External contributions = every transaction that is NOT part of an internal
// transfer pair, from the same account set net worth uses (non-archived,
// owner-filtered), each valued in base currency at its own date's FX:
//   - currency rows  → the cash amount       (deposit +, withdrawal −)
//   - security rows  → cost/proceeds         (buy +, sell −) = unitsDelta × unitPriceScaled
// A transaction is internal (excluded) when it is itself a cash leg
// (linkedTransactionId set) or a security row that a cash leg points at.
async function contributionFlowsBase(owner?: string): Promise<Flow[]> {
  const base = await baseCurrencyFromSettings();
  const included = await includedAccountIds(owner);

  const rows = await db
    .select()
    .from(transactions)
    .innerJoin(instruments, eq(transactions.instrumentId, instruments.id));

  // Security rows that a cash leg points at are the internal side of a trade.
  const linkedToIds = new Set<string>();
  for (const r of rows) {
    const linked = r.transactions.linkedTransactionId;
    if (linked !== null) linkedToIds.add(linked);
  }

  const flows: Flow[] = [];
  for (const r of rows) {
    const tx = r.transactions;
    if (!included.has(tx.accountId)) continue;
    if (tx.linkedTransactionId !== null) continue; // a cash leg
    if (linkedToIds.has(tx.id)) continue; // a security row that has a cash leg

    const cur = r.instruments.currency;
    const dec = currencyDecimals(cur);

    let amountMinor: number;
    if (r.instruments.kind === "currency") {
      amountMinor = fromBig(roundDiv(toBig(tx.unitsDelta) * 10n ** BigInt(dec), SCALE));
    } else {
      if (tx.unitPriceScaled === null) continue; // unvaluable holding → skip
      amountMinor = fromBig(
        roundDiv(toBig(tx.unitsDelta) * toBig(tx.unitPriceScaled) * 10n ** BigInt(dec), SCALE * SCALE),
      );
    }

    const conv = await convertMinor(amountMinor, cur, base, base, tx.date);
    if (conv === null) continue; // missing FX → skip (consistent with net worth)
    flows.push({ date: tx.date, baseMinor: conv });
  }
  flows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return flows;
}

export async function netWorthSeries(opts: {
  from?: string;
  to?: string;
  owner?: string;
}): Promise<NetWorthSeries> {
  const to = opts.to ?? todayISO();
  // No `from` → "all time": start at the earliest transaction (or `to` if none).
  const from = opts.from ?? (await earliestTxDate(opts.owner)) ?? to;
  const dates = weeklyDates(from, to);
  const flows = await contributionFlowsBase(opts.owner);

  const points: NetWorthPoint[] = [];
  let baseCurrency: string | null = null;
  let fi = 0;
  let cumDeposits = 0;
  for (const date of dates) {
    const nw = await netWorth({ asOf: date, owner: opts.owner });
    baseCurrency = nw.baseCurrency;
    while (fi < flows.length && flows[fi].date <= date) {
      cumDeposits += flows[fi].baseMinor;
      fi++;
    }
    points.push({ date, totalBaseMinor: nw.totalBaseMinor, netDepositsBaseMinor: cumDeposits });
  }

  return {
    baseCurrency: baseCurrency ?? (await baseCurrencyFromSettings()),
    points,
  };
}
