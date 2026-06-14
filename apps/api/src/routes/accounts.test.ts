import { expect, test, beforeEach } from "bun:test";
import { resetDb, makeApp, initAndLogin } from "../lib/test-helpers";
import { accountsRoutes } from "./accounts";
import { groupsRoutes } from "./groups";
import { db } from "../db/client";
import { user } from "../db/schema";

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

test("persists a client-supplied id, and rejects a duplicate with 409", async () => {
  const app = makeApp(accountsRoutes);
  const { cookie } = await initAndLogin({ app, baseCurrency: "USD" });

  const body = JSON.stringify({
    id: "client-chosen-id-1",
    name: "Savings",
    class: "asset",
    subtype: "bank",
    currency: "USD",
  });
  const post = (b: string) =>
    app.handle(
      new Request("http://localhost/accounts", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: b,
      }),
    );

  const first = await post(body);
  expect(first.status).toBe(200);
  expect((await first.json()).id).toBe("client-chosen-id-1");

  const list = await app.handle(new Request("http://localhost/accounts", { headers: { cookie } }));
  expect((await list.json())[0].id).toBe("client-chosen-id-1");

  // Same id again → conflict, not a 500 and not an overwrite.
  const dup = await post(body);
  expect(dup.status).toBe(409);
  expect((await dup.json()).error).toBe("duplicate_id");
});

test("accepts holdings valuation mode", async () => {
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
  expect(res.status).toBe(200);
});

async function firstUserId(): Promise<string> {
  const rows = await db.select({ id: user.id }).from(user);
  return rows[0]!.id;
}

test("create defaults owner to the creator and GET returns ownerIds", async () => {
  const app = makeApp(accountsRoutes);
  const { cookie } = await initAndLogin({ app });
  const me = await firstUserId();

  const create = await app.handle(new Request("http://localhost/accounts", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name: "Solo", class: "asset", subtype: "bank", currency: "USD" }),
  }));
  expect(create.status).toBe(200);

  const list = await (await app.handle(
    new Request("http://localhost/accounts", { headers: { cookie } }),
  )).json();
  expect(list[0].ownerIds).toEqual([me]);
});

test("create accepts explicit ownerIds", async () => {
  const app = makeApp(accountsRoutes);
  const { cookie } = await initAndLogin({ app });
  const me = await firstUserId();

  const create = await app.handle(new Request("http://localhost/accounts", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name: "Joint", class: "asset", subtype: "bank", currency: "USD", ownerIds: [me] }),
  }));
  expect(create.status).toBe(200);
  const list = await (await app.handle(
    new Request("http://localhost/accounts", { headers: { cookie } }),
  )).json();
  expect(list.find((a: any) => a.name === "Joint").ownerIds).toEqual([me]);
});

test("create rejects invalid owner ids with 422", async () => {
  const app = makeApp(accountsRoutes);
  const { cookie } = await initAndLogin({ app });

  const res = await app.handle(new Request("http://localhost/accounts", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name: "Bad", class: "asset", subtype: "bank", currency: "USD", ownerIds: ["ghost"] }),
  }));
  expect(res.status).toBe(422);
});

test("PATCH /:id/owners replaces the owner set", async () => {
  const app = makeApp(accountsRoutes);
  const { cookie } = await initAndLogin({ app });
  const me = await firstUserId();

  const { id } = await (await app.handle(new Request("http://localhost/accounts", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name: "Solo", class: "asset", subtype: "bank", currency: "USD" }),
  }))).json();

  const patch = await app.handle(new Request(`http://localhost/accounts/${id}/owners`, {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ ownerIds: [me] }),
  }));
  expect(patch.status).toBe(200);

  const list = await (await app.handle(
    new Request("http://localhost/accounts", { headers: { cookie } }),
  )).json();
  expect(list.find((a: any) => a.id === id).ownerIds).toEqual([me]);
});

test("PATCH /:id/owners rejects empty list (422)", async () => {
  const app = makeApp(accountsRoutes);
  const { cookie } = await initAndLogin({ app });
  const { id } = await (await app.handle(new Request("http://localhost/accounts", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name: "Solo", class: "asset", subtype: "bank", currency: "USD" }),
  }))).json();

  const res = await app.handle(new Request(`http://localhost/accounts/${id}/owners`, {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ ownerIds: [] }),
  }));
  expect(res.status).toBe(422);
});

test("PATCH /:id/owners rejects invalid owner ids (422)", async () => {
  const app = makeApp(accountsRoutes);
  const { cookie } = await initAndLogin({ app });
  const { id } = await (await app.handle(new Request("http://localhost/accounts", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name: "Solo", class: "asset", subtype: "bank", currency: "USD" }),
  }))).json();

  const res = await app.handle(new Request(`http://localhost/accounts/${id}/owners`, {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ ownerIds: ["ghost"] }),
  }));
  expect(res.status).toBe(422);
});

test("creates a holdings account (valuationMode='holdings')", async () => {
  const app = makeApp(accountsRoutes);
  const { cookie } = await initAndLogin({ app });

  const res = await app.handle(new Request("http://localhost/accounts", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name: "Broker", class: "asset", subtype: "investment", currency: "USD", valuationMode: "holdings" }),
  }));
  expect(res.status).toBe(200);

  const list = await (await app.handle(new Request("http://localhost/accounts", { headers: { cookie } }))).json();
  const broker = list.find((a: any) => a.name === "Broker");
  expect(broker.valuationMode).toBe("holdings");
});

test("POST then PATCH round-trips projection assumptions", async () => {
  const app = makeApp(accountsRoutes);
  const { cookie } = await initAndLogin({ app, baseCurrency: "USD" });

  const id = crypto.randomUUID();
  const create = await app.handle(new Request("http://localhost/accounts", {
    method: "POST", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({
      id, name: "SRS", class: "asset", subtype: "investment", currency: "USD",
      valuationMode: "ledger",
      growthRateBps: 800, accessibleFromAge: 62, earlyWithdrawal: "penalty",
      earlyHaircutBps: 500, illiquid: false, liquidationAge: null,
    }),
  }));
  expect(create.status).toBe(200);

  let list = await (await app.handle(new Request("http://localhost/accounts", { headers: { cookie } }))).json();
  let a = list.find((x: any) => x.id === id);
  expect(a.growthRateBps).toBe(800);
  expect(a.accessibleFromAge).toBe(62);
  expect(a.earlyWithdrawal).toBe("penalty");
  expect(a.earlyHaircutBps).toBe(500);

  const patch = await app.handle(new Request(`http://localhost/accounts/${id}`, {
    method: "PATCH", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ growthRateBps: 250, accessibleFromAge: 55, earlyWithdrawal: "none", illiquid: true, liquidationAge: 70 }),
  }));
  expect(patch.status).toBe(200);

  list = await (await app.handle(new Request("http://localhost/accounts", { headers: { cookie } }))).json();
  a = list.find((x: any) => x.id === id);
  expect(a.growthRateBps).toBe(250);
  expect(a.accessibleFromAge).toBe(55);
  expect(a.earlyWithdrawal).toBe("none");
  expect(a.illiquid).toBe(1);
  expect(a.liquidationAge).toBe(70);
});

test("DELETE /:id removes an archived account and cascades its data", async () => {
  const app = makeApp(accountsRoutes);
  const { cookie } = await initAndLogin({ app, baseCurrency: "USD" });

  // Create with an opening balance (produces an entry row)
  const { id } = await (
    await app.handle(
      new Request("http://localhost/accounts", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({
          name: "Old Bank",
          class: "asset",
          subtype: "bank",
          currency: "USD",
          openingBalanceMinor: 50000,
        }),
      }),
    )
  ).json();

  // Archive first
  await app.handle(
    new Request(`http://localhost/accounts/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ isArchived: true }),
    }),
  );

  // Delete
  const del = await app.handle(
    new Request(`http://localhost/accounts/${id}`, {
      method: "DELETE",
      headers: { cookie },
    }),
  );
  expect(del.status).toBe(200);
  expect((await del.json()).ok).toBe(true);

  // Gone from list
  const list = await (
    await app.handle(
      new Request("http://localhost/accounts", { headers: { cookie } }),
    )
  ).json();
  expect(list.find((a: any) => a.id === id)).toBeUndefined();
});

test("DELETE /:id rejects a non-archived account with 422", async () => {
  const app = makeApp(accountsRoutes);
  const { cookie } = await initAndLogin({ app });

  const { id } = await (
    await app.handle(
      new Request("http://localhost/accounts", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({
          name: "Active",
          class: "asset",
          subtype: "bank",
          currency: "USD",
        }),
      }),
    )
  ).json();

  const del = await app.handle(
    new Request(`http://localhost/accounts/${id}`, {
      method: "DELETE",
      headers: { cookie },
    }),
  );
  expect(del.status).toBe(422);
  expect((await del.json()).error).toBe("not_archived");
});

test("PATCH /:id accepts groupId", async () => {
  const app = makeApp(accountsRoutes, groupsRoutes);
  const { cookie } = await initAndLogin({ app });

  const gRes = await app.handle(
    new Request("http://localhost/groups", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "CPF", class: "asset" }),
    }),
  );
  const { id: groupId } = await gRes.json();

  const aRes = await app.handle(
    new Request("http://localhost/accounts", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "CPF OA", class: "asset", subtype: "bank", currency: "SGD" }),
    }),
  );
  const { id: accountId } = await aRes.json();

  const patch = await app.handle(
    new Request(`http://localhost/accounts/${accountId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ groupId }),
    }),
  );
  expect(patch.status).toBe(200);

  const list = await app.handle(
    new Request("http://localhost/accounts", { headers: { cookie } }),
  );
  const body = await list.json();
  expect(body.find((a: any) => a.id === accountId).groupId).toBe(groupId);
});

test("PATCH /reorder updates sortOrder for accounts and groups", async () => {
  const app = makeApp(accountsRoutes, groupsRoutes);
  const { cookie } = await initAndLogin({ app });

  const aRes = await app.handle(
    new Request("http://localhost/accounts", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "Savings", class: "asset", subtype: "bank", currency: "SGD" }),
    }),
  );
  const { id: accountId } = await aRes.json();

  const gRes = await app.handle(
    new Request("http://localhost/groups", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "CPF", class: "asset" }),
    }),
  );
  const { id: groupId } = await gRes.json();

  const reorder = await app.handle(
    new Request("http://localhost/accounts/reorder", {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        items: [
          { id: accountId, kind: "account", sortOrder: 10 },
          { id: groupId, kind: "group", sortOrder: 5 },
        ],
      }),
    }),
  );
  expect(reorder.status).toBe(200);

  const { db } = await import("../db/client");
  const { accounts, groups } = await import("../db/schema");
  const { eq } = await import("drizzle-orm");
  const [acct] = await db.select().from(accounts).where(eq(accounts.id, accountId));
  const [grp] = await db.select().from(groups).where(eq(groups.id, groupId));
  expect(acct.sortOrder).toBe(10);
  expect(grp.sortOrder).toBe(5);
});
