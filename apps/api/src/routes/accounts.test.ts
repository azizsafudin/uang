import { expect, test, beforeEach } from "bun:test";
import { resetDb, makeApp, initAndLogin } from "../lib/test-helpers";
import { accountsRoutes } from "./accounts";

beforeEach(resetDb);

test("requires auth", async () => {
  const app = makeApp(accountsRoutes);
  const res = await app.handle(new Request("http://localhost/accounts"));
  expect(res.status).toBe(401);
});

test("create then list accounts, with optional opening balance", async () => {
  const app = makeApp(accountsRoutes);
  const { cookie } = await initAndLogin({ app, baseCurrency: "USD" });

  const create = await app.handle(
    new Request("http://localhost/accounts", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        name: "Checking",
        class: "asset",
        subtype: "bank",
        currency: "USD",
        openingBalanceMinor: 100000,
        openingDate: "2026-01-01",
      }),
    }),
  );
  expect(create.status).toBe(200);
  const created = await create.json();
  expect(created.id).toBeTruthy();

  const list = await app.handle(
    new Request("http://localhost/accounts", { headers: { cookie } }),
  );
  const body = await list.json();
  expect(body.length).toBe(1);
  expect(body[0].name).toBe("Checking");
  expect(body[0].balanceMinor).toBe(100000); // opening entry applied
});

test("rejects holdings valuation mode in v2", async () => {
  const app = makeApp(accountsRoutes);
  const { cookie } = await initAndLogin({ app });

  const res = await app.handle(
    new Request("http://localhost/accounts", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        name: "Broker",
        class: "asset",
        subtype: "investment",
        currency: "USD",
        valuationMode: "holdings",
      }),
    }),
  );
  expect(res.status).toBe(400);
});
