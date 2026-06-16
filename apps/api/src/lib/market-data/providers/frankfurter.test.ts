import { expect, test, afterEach } from "bun:test";
import { endpoints } from "../endpoints";
import { makeFrankfurterProvider } from "./frankfurter";

const realBase = endpoints.frankfurter;
afterEach(() => { endpoints.frankfurter = realBase; });

function mock(handler: (req: Request) => Response) {
  const server = Bun.serve({ port: 0, fetch: handler });
  endpoints.frankfurter = `http://localhost:${server.port}`;
  return server;
}

test("fetchRate returns base-per-foreign and the date", async () => {
  const server = mock((req) => {
    expect(new URL(req.url).searchParams.get("from")).toBe("SGD");
    expect(new URL(req.url).searchParams.get("to")).toBe("USD");
    return Response.json({ amount: 1, base: "SGD", date: "2026-06-15", rates: { USD: 0.74 } });
  });
  try {
    const p = makeFrankfurterProvider();
    const r = await p.fetchRate("SGD", "USD");
    expect(r).toEqual({ rate: 0.74, date: "2026-06-15" });
  } finally { server.stop(true); }
});

test("fetchRateSeries returns sorted points", async () => {
  const server = mock(() =>
    Response.json({ rates: { "2026-06-02": { USD: 0.75 }, "2026-06-01": { USD: 0.74 } } }),
  );
  try {
    const p = makeFrankfurterProvider();
    const s = await p.fetchRateSeries!("SGD", "USD", "2026-06-01", "2026-06-02");
    expect(s).toEqual([
      { rate: 0.74, date: "2026-06-01" },
      { rate: 0.75, date: "2026-06-02" },
    ]);
  } finally { server.stop(true); }
});

test("same currency returns null", async () => {
  const p = makeFrankfurterProvider();
  expect(await p.fetchRate("USD", "USD")).toBeNull();
});
