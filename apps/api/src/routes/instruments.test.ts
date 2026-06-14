import { expect, test, beforeEach } from "bun:test";
import { resetDb, makeApp, initAndLogin } from "../lib/test-helpers";
import { instrumentsRoutes } from "./instruments";

beforeEach(resetDb);

test("requires auth", async () => {
  const app = makeApp(instrumentsRoutes);
  const res = await app.handle(new Request("http://localhost/instruments"));
  expect(res.status).toBe(401);
});

test("create then list instruments", async () => {
  const app = makeApp(instrumentsRoutes);
  const { cookie } = await initAndLogin({ app });

  const create = await app.handle(new Request("http://localhost/instruments", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name: "Apple", kind: "stock", currency: "usd", symbol: "AAPL" }),
  }));
  expect(create.status).toBe(200);
  const { id } = await create.json();
  expect(id).toBeTruthy();

  const list = await (await app.handle(new Request("http://localhost/instruments", { headers: { cookie } }))).json();
  expect(list.length).toBe(1);
  expect(list[0].name).toBe("Apple");
  expect(list[0].symbol).toBe("AAPL");
  expect(list[0].currency).toBe("USD"); // uppercased
});

test("POST /instruments/currency find-or-creates and is idempotent", async () => {
  const app = makeApp(instrumentsRoutes);
  const { cookie } = await initAndLogin({ app, baseCurrency: "USD" });

  const r1 = await app.handle(new Request("http://localhost/instruments/currency", {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ symbol: "sgd" }),
  }));
  expect(r1.status).toBe(200);
  const b1 = await r1.json();
  expect(b1.symbol).toBe("SGD");
  expect(b1.kind).toBe("currency");

  const r2 = await app.handle(new Request("http://localhost/instruments/currency", {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ symbol: "SGD" }),
  }));
  const b2 = await r2.json();
  expect(b2.id).toBe(b1.id);
});

test("POST /instruments accepts crypto kind", async () => {
  const app = makeApp(instrumentsRoutes);
  const { cookie } = await initAndLogin({ app, baseCurrency: "USD" });
  const res = await app.handle(new Request("http://localhost/instruments", {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name: "Bitcoin", kind: "crypto", currency: "USD", symbol: "BTC" }),
  }));
  expect(res.status).toBe(200);
});
