import { db } from "../db/client";
import { accounts, settings } from "../db/schema";
import { eq } from "drizzle-orm";
import { toBig, fromBig } from "@uang/shared";
import { accountPositions } from "./positions";
import { convertMinor } from "./valuation";
import { getAllOwnerSets } from "./owners";

// Subtypes whose currency balance counts as investable "cash" on the Holdings tab.
// Property/vehicle/other are balance-tracked too, but are NOT portfolio cash.
const CASH_SUBTYPES = new Set(["cash", "bank", "investment"]);

export type SecurityHolding = {
  instrumentId: string;
  symbol: string | null;
  name: string;
  kind: string;                 // "stock" | "etf" | "fund" | "crypto" | "other"
  currency: string;             // instrument currency
  units: number;                // Σ net units across accounts, ×1e8
  valueBaseMinor: number;       // market value converted to base
  unrealizedGainBaseMinor: number;
  accountCount: number;         // distinct in-scope accounts holding it
  missing: boolean;             // any contributing position missing price/FX
};

export type CashHolding = {
  currency: string;
  valueBaseMinor: number;
  accountCount: number;
  missing: boolean;
};

export type Holdings = {
  baseCurrency: string;
  totalBaseMinor: number;                              // securities + cash
  byKind: { kind: string; valueBaseMinor: number }[]; // donut buckets
  securities: SecurityHolding[];                       // sorted by value desc
  cash: CashHolding[];                                 // sorted by value desc
};

export type HoldingsOpts = { asOf?: string; owner?: string };

type SecAgg = {
  symbol: string | null; name: string; kind: string; currency: string;
  units: bigint; valueBase: bigint; gainBase: bigint; accounts: Set<string>; missing: boolean;
};
type CashAgg = { valueBase: bigint; accounts: Set<string>; missing: boolean };

export async function holdings(opts: HoldingsOpts = {}): Promise<Holdings> {
  const { asOf, owner } = opts;
  const s = (await db.select().from(settings).where(eq(settings.id, 1)))[0];
  const base = s?.baseCurrency ?? "USD";
  const accts = await db.select().from(accounts).where(eq(accounts.isArchived, 0));
  const ownerSets = await getAllOwnerSets();

  const secMap = new Map<string, SecAgg>();
  const cashMap = new Map<string, CashAgg>();

  for (const a of accts) {
    if (a.class !== "asset") continue;

    // Same owner filter as netWorth: a specific member sees only sole-owned accounts.
    const ownerIds = ownerSets.get(a.id) ?? [];
    if (owner && owner !== "household") {
      const sole = ownerIds.length === 1 && ownerIds[0] === owner;
      if (!sole) continue;
    }

    const positions = await accountPositions(a.id, asOf);
    for (const p of positions) {
      if (p.instrument.kind === "currency") {
        if (!CASH_SUBTYPES.has(a.subtype)) continue;
        const cur = p.instrumentCurrency;
        let c = cashMap.get(cur);
        if (!c) { c = { valueBase: 0n, accounts: new Set(), missing: false }; cashMap.set(cur, c); }
        c.accounts.add(a.id);
        if (p.missingPrice) { c.missing = true; continue; }
        const conv = await convertMinor(p.marketValueMinor, p.instrumentCurrency, base, base, asOf);
        if (conv === null) { c.missing = true; continue; }
        c.valueBase += toBig(conv);
      } else {
        const key = p.instrument.id;
        let m = secMap.get(key);
        if (!m) {
          m = {
            symbol: p.instrument.symbol, name: p.instrument.name, kind: p.instrument.kind,
            currency: p.instrumentCurrency, units: 0n, valueBase: 0n, gainBase: 0n,
            accounts: new Set(), missing: false,
          };
          secMap.set(key, m);
        }
        m.accounts.add(a.id);
        m.units += toBig(p.units);
        if (p.missingPrice) { m.missing = true; continue; }
        const v = await convertMinor(p.marketValueMinor, p.instrumentCurrency, base, base, asOf);
        const g = await convertMinor(p.unrealizedGainMinor, p.instrumentCurrency, base, base, asOf);
        if (v === null || g === null) { m.missing = true; continue; }
        m.valueBase += toBig(v);
        m.gainBase += toBig(g);
      }
    }
  }

  const securities: SecurityHolding[] = [...secMap.entries()]
    .map(([instrumentId, m]) => ({
      instrumentId, symbol: m.symbol, name: m.name, kind: m.kind, currency: m.currency,
      units: fromBig(m.units), valueBaseMinor: fromBig(m.valueBase),
      unrealizedGainBaseMinor: fromBig(m.gainBase), accountCount: m.accounts.size, missing: m.missing,
    }))
    .sort((a, b) => b.valueBaseMinor - a.valueBaseMinor);

  const cash: CashHolding[] = [...cashMap.entries()]
    .map(([currency, c]) => ({
      currency, valueBaseMinor: fromBig(c.valueBase), accountCount: c.accounts.size, missing: c.missing,
    }))
    .sort((a, b) => b.valueBaseMinor - a.valueBaseMinor);

  const kindTotals = new Map<string, bigint>();
  let total = 0n;
  for (const m of secMap.values()) {
    kindTotals.set(m.kind, (kindTotals.get(m.kind) ?? 0n) + m.valueBase);
    total += m.valueBase;
  }
  let cashTotal = 0n;
  for (const c of cashMap.values()) cashTotal += c.valueBase;
  total += cashTotal;

  const byKind = [...kindTotals.entries()].map(([kind, v]) => ({ kind, valueBaseMinor: fromBig(v) }));
  if (cashTotal > 0n) byKind.push({ kind: "cash", valueBaseMinor: fromBig(cashTotal) });
  byKind.sort((a, b) => b.valueBaseMinor - a.valueBaseMinor);

  return { baseCurrency: base, totalBaseMinor: fromBig(total), byKind, securities, cash };
}
