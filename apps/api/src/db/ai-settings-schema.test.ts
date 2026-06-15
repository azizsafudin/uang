import { expect, test, beforeEach } from "bun:test";
import { db } from "./client";
import { settings } from "./schema";
import { eq } from "drizzle-orm";
import { resetDb } from "../lib/test-helpers";
import { nowEpoch } from "../lib/ids";

beforeEach(resetDb);

test("settings stores AI provider fields", async () => {
  await db.insert(settings).values({
    id: 1, householdName: "H", baseCurrency: "USD", createdAt: nowEpoch(),
    aiBaseUrl: "http://localhost:11434/v1", aiModel: "llama3.1", aiApiKey: "sk-x",
  });
  const [s] = await db.select().from(settings).where(eq(settings.id, 1));
  expect(s.aiBaseUrl).toBe("http://localhost:11434/v1");
  expect(s.aiModel).toBe("llama3.1");
  expect(s.aiApiKey).toBe("sk-x");
});
