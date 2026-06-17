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
      id, name: "House", targetAmountMinor: 50_000_000,
      currency: "USD", targetDate: "2035-01-01", ownerScope: "household",
    }),
  }));
  expect(create.status).toBe(200);

  let list = await (await app.handle(new Request("http://localhost/goals", { headers: { cookie } }))).json();
  expect(list.length).toBe(1);
  let g = list.find((x: any) => x.id === id);
  expect(g.name).toBe("House");
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
      id, name: "House", targetAmountMinor: 50_000_000,
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

test("POST /goals accepts spend fields and round-trips them", async () => {
  const { cookie } = await initAndLogin({ app, baseCurrency: "USD" });
  const id = crypto.randomUUID();
  const create = await app.handle(new Request("http://localhost/goals", {
    method: "POST", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({
      id, name: "Retire", targetAmountMinor: 40_000_000, currency: "USD",
      targetDate: "2040-01-01", ownerScope: "household",
      spendType: "monthly", spendAmountMinor: 100_000,
    }),
  }));
  expect(create.status).toBe(200);

  const list = await (await app.handle(new Request("http://localhost/goals", { headers: { cookie } }))).json();
  const g = list.find((x: any) => x.id === id);
  expect(g.spendType).toBe("monthly");
  expect(g.spendAmountMinor).toBe(100_000);
  expect(g.spendRateBps).toBeNull();
});

test("POST /goals rejects a spend goal without a target date (422)", async () => {
  const { cookie } = await initAndLogin({ app, baseCurrency: "USD" });
  const res = await app.handle(new Request("http://localhost/goals", {
    method: "POST", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({
      id: crypto.randomUUID(), name: "Bad", targetAmountMinor: 1_000_000, currency: "USD",
      targetDate: null, spendType: "once", spendAmountMinor: 500_000,
    }),
  }));
  expect(res.status).toBe(422);
});

test("PATCH /goals rejects enabling spend when the goal has no target date (422)", async () => {
  const { cookie } = await initAndLogin({ app, baseCurrency: "USD" });
  const id = crypto.randomUUID();
  await app.handle(new Request("http://localhost/goals", {
    method: "POST", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ id, name: "Indef", targetAmountMinor: 1_000_000, currency: "USD", targetDate: null }),
  }));
  const res = await app.handle(new Request(`http://localhost/goals/${id}`, {
    method: "PATCH", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ spendType: "monthly", spendAmountMinor: 1_000 }),
  }));
  expect(res.status).toBe(422);
});

test("PUT /goals/:id/accounts replaces the funding set; analysis reflects it", async () => {
  const { cookie } = await initAndLogin({ app, baseCurrency: "USD" });
  const id = crypto.randomUUID();
  await app.handle(new Request("http://localhost/goals", {
    method: "POST", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({
      id, name: "Car", targetAmountMinor: 20_000_000, currency: "USD",
      targetDate: "2030-01-01", ownerScope: "household",
    }),
  }));

  const put = await app.handle(new Request(`http://localhost/goals/${id}/accounts`, {
    method: "PUT", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ accountIds: ["acc-1", "acc-2"] }),
  }));
  expect(put.status).toBe(200);

  const analysis = await (await app.handle(
    new Request("http://localhost/goals/analysis", { headers: { cookie } }),
  )).json();
  const g = analysis.goals.find((x: any) => x.id === id);
  expect(new Set(g.accountIds)).toEqual(new Set(["acc-1", "acc-2"]));

  // Replacing with an empty set clears funding.
  await app.handle(new Request(`http://localhost/goals/${id}/accounts`, {
    method: "PUT", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ accountIds: [] }),
  }));
  const analysis2 = await (await app.handle(
    new Request("http://localhost/goals/analysis", { headers: { cookie } }),
  )).json();
  expect(analysis2.goals.find((x: any) => x.id === id).accountIds).toEqual([]);
});
