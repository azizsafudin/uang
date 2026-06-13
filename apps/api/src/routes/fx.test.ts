import { expect, test, beforeEach } from "bun:test";
import { resetDb, makeApp, initAndLogin } from "../lib/test-helpers";
import { fxRoutes } from "./fx";

beforeEach(resetDb);

test("create, list, and replace (upsert) an fx rate per currency+date", async () => {
  const app = makeApp(fxRoutes);
  const { cookie } = await initAndLogin({ app, baseCurrency: "USD" });

  const post = (body: any) => app.handle(new Request("http://localhost/fx", {
    method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body),
  }));

  expect((await post({ currency: "MYR", date: "2026-01-01", rateScaled: 22_000_000 })).status).toBe(200);
  // same currency+date again -> upsert, not a duplicate (unique index)
  expect((await post({ currency: "MYR", date: "2026-01-01", rateScaled: 23_000_000 })).status).toBe(200);

  const list = await (await app.handle(new Request("http://localhost/fx", { headers: { cookie } }))).json();
  const myr = list.filter((r: any) => r.currency === "MYR");
  expect(myr.length).toBe(1);
  expect(myr[0].rateScaled).toBe(23_000_000);
});

test("GET /fx requires auth", async () => {
  const app = makeApp(fxRoutes);
  const res = await app.handle(new Request("http://localhost/fx"));
  expect(res.status).toBe(401);
});

test("DELETE /fx/:id removes a rate", async () => {
  const app = makeApp(fxRoutes);
  const { cookie } = await initAndLogin({ app, baseCurrency: "USD" });

  // Create a rate
  const postRes = await app.handle(new Request("http://localhost/fx", {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ currency: "EUR", date: "2026-01-01", rateScaled: 108_000_000 }),
  }));
  expect(postRes.status).toBe(200);
  const { id } = await postRes.json();

  // Delete it
  const delRes = await app.handle(new Request(`http://localhost/fx/${id}`, {
    method: "DELETE", headers: { cookie },
  }));
  expect(delRes.status).toBe(200);
  const delBody = await delRes.json();
  expect(delBody.ok).toBe(true);

  // Confirm gone
  const list = await (await app.handle(new Request("http://localhost/fx", { headers: { cookie } }))).json();
  expect(list.filter((r: any) => r.currency === "EUR").length).toBe(0);
});
