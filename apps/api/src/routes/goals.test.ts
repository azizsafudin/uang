import { expect, test, beforeEach } from "bun:test";
import { resetDb, makeApp, initAndLogin } from "../lib/test-helpers";
import { goalsRoutes } from "./goals";

beforeEach(resetDb);

const app = makeApp(goalsRoutes);

test("POST /goals creates, GET lists, PATCH edits, DELETE removes", async () => {
  const { cookie } = await initAndLogin({ app, baseCurrency: "USD" });
  const id = crypto.randomUUID();

  const create = await app.handle(new Request("http://localhost/goals", {
    method: "POST", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({
      id, name: "House", term: "long", targetAmountMinor: 50_000_000,
      currency: "USD", targetDate: "2035-01-01", ownerScope: "household",
    }),
  }));
  expect(create.status).toBe(200);

  let list = await (await app.handle(new Request("http://localhost/goals", { headers: { cookie } }))).json();
  expect(list.length).toBe(1);
  let g = list.find((x: any) => x.id === id);
  expect(g.name).toBe("House");
  expect(g.term).toBe("long");
  expect(g.targetAmountMinor).toBe(50_000_000);
  expect(g.targetDate).toBe("2035-01-01");
  expect(g.ownerScope).toBe("household");
  expect(g.anchorDate).toBeNull();

  const patch = await app.handle(new Request(`http://localhost/goals/${id}`, {
    method: "PATCH", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ name: "Bigger house", targetAmountMinor: 80_000_000, anchorDate: "2024-01-01" }),
  }));
  expect(patch.status).toBe(200);

  list = await (await app.handle(new Request("http://localhost/goals", { headers: { cookie } }))).json();
  g = list.find((x: any) => x.id === id);
  expect(g.name).toBe("Bigger house");
  expect(g.targetAmountMinor).toBe(80_000_000);
  expect(g.anchorDate).toBe("2024-01-01");

  const del = await app.handle(new Request(`http://localhost/goals/${id}`, { method: "DELETE", headers: { cookie } }));
  expect(del.status).toBe(200);
  list = await (await app.handle(new Request("http://localhost/goals", { headers: { cookie } }))).json();
  expect(list.length).toBe(0);
});

test("GET /goals/:id/projection returns a series; 404 for unknown id", async () => {
  const { cookie } = await initAndLogin({ app, baseCurrency: "USD" });
  const id = crypto.randomUUID();
  await app.handle(new Request("http://localhost/goals", {
    method: "POST", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({
      id, name: "House", term: "long", targetAmountMinor: 50_000_000,
      currency: "USD", targetDate: "2040-01-01", ownerScope: "household",
    }),
  }));

  const ok = await app.handle(new Request(`http://localhost/goals/${id}/projection?historyMonths=3`, { headers: { cookie } }));
  expect(ok.status).toBe(200);
  const body = await ok.json();
  expect(body.goal.id).toBe(id);
  expect(body.targetMinor).toBe(50_000_000);
  expect(Array.isArray(body.series)).toBe(true);
  expect(body.series.length).toBeGreaterThan(0);

  const missing = await app.handle(new Request(`http://localhost/goals/does-not-exist/projection`, { headers: { cookie } }));
  expect(missing.status).toBe(404);
});
