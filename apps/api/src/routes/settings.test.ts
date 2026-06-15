import { expect, test, beforeEach } from "bun:test";
import { resetDb, makeApp, initAndLogin } from "../lib/test-helpers";
import { settingsRoutes } from "./settings";

beforeEach(resetDb);

const app = makeApp(settingsRoutes);

test("GET /settings returns base currency + assumption defaults", async () => {
  const { cookie } = await initAndLogin({ app, baseCurrency: "USD" });
  const res = await app.handle(new Request("http://localhost/settings", { headers: { cookie } }));
  expect(res.status).toBe(200);
  const s = await res.json();
  expect(s.baseCurrency).toBe("USD");
  expect(s.contributionGrowthRateBps).toBe(800);
  expect(s.projectionEndAge).toBe(90);
});

test("PATCH /settings updates assumptions", async () => {
  const { cookie } = await initAndLogin({ app, baseCurrency: "USD" });
  const patch = await app.handle(new Request("http://localhost/settings", {
    method: "PATCH", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ contributionGrowthRateBps: 600, projectionEndAge: 85 }),
  }));
  expect(patch.status).toBe(200);

  const s = await (await app.handle(new Request("http://localhost/settings", { headers: { cookie } }))).json();
  expect(s.contributionGrowthRateBps).toBe(600);
  expect(s.projectionEndAge).toBe(85);
});

test("GET /settings returns the default dashboard tiles", async () => {
  const { cookie } = await initAndLogin({ app, baseCurrency: "USD" });
  const res = await app.handle(new Request("http://localhost/settings", { headers: { cookie } }));
  const s = await res.json();
  expect(s.dashboardTiles).toEqual(["assets", "liabilities", "goalsOnTrack"]);
});

test("PATCH /settings persists a reordered/filtered tile list", async () => {
  const { cookie } = await initAndLogin({ app, baseCurrency: "USD" });
  const patch = await app.handle(
    new Request("http://localhost/settings", {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ dashboardTiles: ["goalsOnTrack", "liquidAssets"] }),
    }),
  );
  expect(patch.status).toBe(200);
  const s = await (
    await app.handle(new Request("http://localhost/settings", { headers: { cookie } }))
  ).json();
  expect(s.dashboardTiles).toEqual(["goalsOnTrack", "liquidAssets"]);
});
