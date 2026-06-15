import { db } from "../db/client";
import { settings, accounts, transactions, instruments } from "../db/schema";
import { and, eq, isNull } from "drizzle-orm";
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

// External cash flows = currency-instrument transactions NOT linked to a trade
// (standalone deposits/withdrawals), from the same account set net worth uses
// (non-archived, owner-filtered), each converted to base at its own date's FX.
async function externalFlowsBase(owner?: string): Promise<Flow[]> {
  const base = await baseCurrencyFromSettings();
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

  const rows = await db
    .select()
    .from(transactions)
    .innerJoin(instruments, eq(transactions.instrumentId, instruments.id))
    .where(and(eq(instruments.kind, "currency"), isNull(transactions.linkedTransactionId)));

  const flows: Flow[] = [];
  for (const r of rows) {
    const tx = r.transactions;
    if (!included.has(tx.accountId)) continue;
    const cur = r.instruments.currency;
    const dec = currencyDecimals(cur);
    const amountMinor = fromBig(roundDiv(toBig(tx.unitsDelta) * 10n ** BigInt(dec), SCALE));
    const conv = await convertMinor(amountMinor, cur, base, base, tx.date);
    if (conv === null) continue; // missing FX → skip (consistent with net worth)
    flows.push({ date: tx.date, baseMinor: conv });
  }
  flows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return flows;
}

export async function netWorthSeries(opts: {
  from: string;
  to?: string;
  owner?: string;
}): Promise<NetWorthSeries> {
  const to = opts.to ?? todayISO();
  const dates = weeklyDates(opts.from, to);
  const flows = await externalFlowsBase(opts.owner);

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
