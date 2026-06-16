import { db } from "../db/client";
import { settings } from "../db/schema";
import { eq } from "drizzle-orm";

export async function getSettings() {
  const rows = await db.select().from(settings).where(eq(settings.id, 1));
  return rows[0] ?? null;
}

export async function isInitialized(): Promise<boolean> {
  return (await getSettings()) !== null;
}

// Market-data provider config from the singleton settings row. Alpha Vantage is
// the only keyed provider; Yahoo/Frankfurter need no key.
export async function loadMarketDataConfig(): Promise<{ alphaVantageApiKey?: string }> {
  const s = await getSettings();
  return { alphaVantageApiKey: s?.marketDataApiKey ?? undefined };
}
