import { expect, test, beforeEach } from "bun:test";
import { and, eq } from "drizzle-orm";
import { resetDb } from "../test-helpers";
import { db } from "../../db/client";
import { instruments, prices, fxRates, accounts, settings } from "../../db/schema";
import { createId, nowEpoch } from "../ids";
import { refreshInstrumentPrice, refreshFx } from "./index";
import type { InstrumentPriceProvider, FxRateProvider } from "./types";

beforeEach(resetDb);

const fakePrice: InstrumentPriceProvider = {
  name: "fake",
  async fetchPrice() { return { price: 100, currency: "USD", date: "2026-06-15" }; },
  async fetchPriceSeries() {
    return [
      { price: 90, currency: "USD", date: "2026-06-10" },
      { price: 100, currency: "USD", date: "2026-06-15" },
    ];
  },
};

async function seedInstrument(kind = "stock"): Promise<string> {
  const id = createId();
  await db.insert(instruments).values({ id, symbol: "X", isin: null, name: "X", kind: kind as "stock", currency: "USD", createdAt: nowEpoch() });
  return id;
}

test("latest refresh upserts today's row with the provider source", async () => {
  const id = await seedInstrument();
  const r = await refreshInstrumentPrice(id, undefined, [fakePrice]);
  expect(r.status).toBe("updated");
  expect(r.source).toBe("fake");
  const rows = await db.select().from(prices).where(eq(prices.instrumentId, id));
  expect(rows.length).toBe(1);
  expect(rows[0].priceScaled).toBe(100 * 1e8);
  expect(rows[0].source).toBe("fake");
});

test("backfill inserts a series but never overwrites an existing manual row", async () => {
  const id = await seedInstrument();
  await db.insert(prices).values({ id: createId(), instrumentId: id, date: "2026-06-10", priceScaled: 1, source: "manual", createdAt: nowEpoch() });
  const r = await refreshInstrumentPrice(id, { backfill: true, from: "2026-06-01" }, [fakePrice]);
  expect(r.status).toBe("updated");
  expect(r.rowsWritten).toBe(1); // only 2026-06-15 is new
  const manual = (await db.select().from(prices).where(and(eq(prices.instrumentId, id), eq(prices.date, "2026-06-10"))))[0];
  expect(manual.priceScaled).toBe(1);
  expect(manual.source).toBe("manual");
});

test("backfill with no explicit range starts from the latest stored price date (incremental)", async () => {
  const id = await seedInstrument();
  // Already have a price on 2026-06-10; incremental backfill should anchor there.
  await db.insert(prices).values({ id: createId(), instrumentId: id, date: "2026-06-10", priceScaled: 50 * 1e8, source: "yahoo", createdAt: nowEpoch() });
  let capturedStart: string | null = null;
  const capturing: InstrumentPriceProvider = {
    name: "cap",
    async fetchPrice() { return { price: 1, currency: "USD", date: "2026-06-20" }; },
    async fetchPriceSeries(_inst, start) {
      capturedStart = start;
      return [
        { price: 50, currency: "USD", date: "2026-06-10" }, // already stored -> skipped
        { price: 60, currency: "USD", date: "2026-06-20" }, // new
      ];
    },
  };
  const r = await refreshInstrumentPrice(id, { backfill: true }, [capturing]);
  expect(capturedStart).toBe("2026-06-10");
  expect(r.rowsWritten).toBe(1); // only the new 2026-06-20 row
});

test("currency instruments are skipped", async () => {
  const id = await seedInstrument("currency");
  const r = await refreshInstrumentPrice(id, undefined, [fakePrice]);
  expect(r.status).toBe("skipped");
});

test("refreshFx writes base-per-foreign for in-use currencies", async () => {
  await db.insert(settings).values({ id: 1, householdName: "H", baseCurrency: "USD", createdAt: nowEpoch() });
  await db.insert(accounts).values({ id: createId(), name: "A", class: "asset", subtype: "cash", currency: "SGD", createdAt: nowEpoch(), createdBy: "x" });
  const fakeFx: FxRateProvider = { name: "fx", async fetchRate() { return { rate: 0.74, date: "2026-06-15" }; } };
  const summary = await refreshFx(undefined, [fakeFx]);
  expect(summary.updated).toBe(1);
  const rows = await db.select().from(fxRates);
  expect(rows[0].currency).toBe("SGD");
  expect(rows[0].rateScaled).toBe(Math.round(0.74 * 1e8));
  expect(rows[0].source).toBe("fx");
});
