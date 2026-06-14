import { db } from "../db/client";
import { settings } from "../db/schema";
import { eq } from "drizzle-orm";
import { netWorth } from "./valuation";

export type NetWorthPoint = { date: string; totalBaseMinor: number };
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

export async function netWorthSeries(opts: {
  from: string;
  to?: string;
  owner?: string;
}): Promise<NetWorthSeries> {
  const to = opts.to ?? todayISO();
  const dates = weeklyDates(opts.from, to);

  const points: NetWorthPoint[] = [];
  let baseCurrency: string | null = null;
  for (const date of dates) {
    const nw = await netWorth({ asOf: date, owner: opts.owner });
    baseCurrency = nw.baseCurrency;
    points.push({ date, totalBaseMinor: nw.totalBaseMinor });
  }

  return {
    baseCurrency: baseCurrency ?? (await baseCurrencyFromSettings()),
    points,
  };
}
