import { expect, test, beforeEach } from "bun:test";
import { resetDb, makeApp, initAndLogin } from "../lib/test-helpers";
import { importParsersRoutes } from "./import-parsers";

beforeEach(resetDb);
const app = makeApp(importParsersRoutes);

const config = {
  version: 1, format: "csv", csv: { delimiter: ",", headerRow: 0, skipRows: 0 },
  fields: {
    date: { column: "Date", format: "DD MMM YYYY" },
    description: { column: "Description" },
    amount: { mode: "single", column: "Amount", decimal: ".", thousands: ",", sign: "negativeIsDebit" },
  },
};
const fingerprint = { format: "csv", delimiter: ",", headerColumns: ["amount", "date", "description"] };

test("create, list, patch, delete a parser", async () => {
  const { cookie } = await initAndLogin({ app });

  const created = await app.handle(new Request("http://localhost/import-parsers", {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name: "DBS Statement Parser", sourceFormat: "csv", config, fingerprint }),
  }));
  expect(created.status).toBe(200);
  const { id } = await created.json();

  const list = await (await app.handle(new Request("http://localhost/import-parsers", { headers: { cookie } }))).json();
  expect(list.length).toBe(1);
  expect(list[0].name).toBe("DBS Statement Parser");
  expect(list[0].config.fields.amount.mode).toBe("single"); // returned parsed, not string

  const patched = await app.handle(new Request(`http://localhost/import-parsers/${id}`, {
    method: "PATCH", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name: "DBS (SGD)" }),
  }));
  expect(patched.status).toBe(200);

  await app.handle(new Request(`http://localhost/import-parsers/${id}`, { method: "DELETE", headers: { cookie } }));
  const after = await (await app.handle(new Request("http://localhost/import-parsers", { headers: { cookie } }))).json();
  expect(after.length).toBe(0);
});

test("rejects an invalid config with 422", async () => {
  const { cookie } = await initAndLogin({ app });
  const res = await app.handle(new Request("http://localhost/import-parsers", {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name: "Bad", sourceFormat: "csv", config: { version: 1, format: "csv" }, fingerprint }),
  }));
  expect(res.status).toBe(422);
});

test("rejects an invalid fingerprint with 422", async () => {
  const { cookie } = await initAndLogin({ app });
  const res = await app.handle(new Request("http://localhost/import-parsers", {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name: "Bad FP", sourceFormat: "csv", config, fingerprint: { format: "csv", delimiter: ";;", headerColumns: "x" } }),
  }));
  expect(res.status).toBe(422);
  expect((await res.json()).error).toBe("invalid_fingerprint");
});

test("posting twice with the same explicit id returns 409", async () => {
  const { cookie } = await initAndLogin({ app });
  const body = JSON.stringify({ id: "fixed-id", name: "Dup", sourceFormat: "csv", config, fingerprint });
  const first = await app.handle(new Request("http://localhost/import-parsers", {
    method: "POST", headers: { "content-type": "application/json", cookie }, body,
  }));
  expect(first.status).toBe(200);
  const second = await app.handle(new Request("http://localhost/import-parsers", {
    method: "POST", headers: { "content-type": "application/json", cookie }, body,
  }));
  expect(second.status).toBe(409);
  expect((await second.json()).error).toBe("duplicate_id");
});
