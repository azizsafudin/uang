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
