import { expect, test, beforeEach } from "bun:test";
import { resetDb, makeApp, initAndLogin } from "../lib/test-helpers";
import { accountsRoutes } from "./accounts";
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
