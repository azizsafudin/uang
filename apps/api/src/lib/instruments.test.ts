import { expect, test, beforeEach } from "bun:test";
import { db } from "../db/client";
import { instruments } from "../db/schema";
import { eq } from "drizzle-orm";
import { resetDb } from "./test-helpers";
import { ensureCurrencyInstrument } from "./instruments";

beforeEach(resetDb);

test("creates a currency instrument once and is idempotent", async () => {
  const id1 = await ensureCurrencyInstrument("sgd");
  const id2 = await ensureCurrencyInstrument("SGD");
  expect(id1).toBe(id2);

  const rows = await db.select().from(instruments).where(eq(instruments.symbol, "SGD"));
  expect(rows.length).toBe(1);
  expect(rows[0].kind).toBe("currency");
  expect(rows[0].currency).toBe("SGD");
  expect(rows[0].name).toBe("Singapore Dollar");
});
