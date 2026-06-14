import { expect, test, beforeEach } from "bun:test";
import { resetDb, makeApp, initAndLogin } from "../lib/test-helpers";
import { membersRoutes } from "./members";

beforeEach(resetDb);

const app = makeApp(membersRoutes);

test("GET /members lists users with null birthYear by default", async () => {
  const { cookie } = await initAndLogin({ app, baseCurrency: "USD" });
  const res = await app.handle(new Request("http://localhost/members", { headers: { cookie } }));
  expect(res.status).toBe(200);
  const members = await res.json();
  expect(members.length).toBe(1);
  expect(members[0].birthYear).toBeNull();
  expect(typeof members[0].id).toBe("string");
});

test("PATCH /members/:id sets and clears birthYear", async () => {
  const { cookie } = await initAndLogin({ app, baseCurrency: "USD" });
  const list = await (await app.handle(new Request("http://localhost/members", { headers: { cookie } }))).json();
  const id = list[0].id;

  const set = await app.handle(new Request(`http://localhost/members/${id}`, {
    method: "PATCH", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ birthYear: 1990 }),
  }));
  expect(set.status).toBe(200);

  const after = await (await app.handle(new Request("http://localhost/members", { headers: { cookie } }))).json();
  expect(after[0].birthYear).toBe(1990);

  // Idempotent upsert: setting again updates in place.
  await app.handle(new Request(`http://localhost/members/${id}`, {
    method: "PATCH", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ birthYear: 1991 }),
  }));
  const after2 = await (await app.handle(new Request("http://localhost/members", { headers: { cookie } }))).json();
  expect(after2[0].birthYear).toBe(1991);
});
