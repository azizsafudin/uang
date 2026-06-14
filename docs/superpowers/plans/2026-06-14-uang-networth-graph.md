# Net Worth Over Time (graph) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a weekly net-worth-over-time area chart to the dashboard, backed by a read-only `/networth/series` endpoint that loops the existing `netWorth` contract.

**Architecture:** Purely additive. A new server module `lib/networth-series.ts` generates weekly anchor dates (latest = `to`/today, stepping back 7 days) and calls the existing `netWorth({ asOf, owner })` per date, returning `{ baseCurrency, points: [{ date, totalBaseMinor }] }`. A thin Elysia route exposes it; the web app renders it with the shadcn `chart` (Recharts) and range presets that follow the existing owner toggle. No edits to `valuation.ts`, `routes/networth.ts`, or the toggle — so investment accounts flow in for free once the holdings slice merges.

**Tech Stack:** ElysiaJS + Bun + Drizzle/libSQL (API), bun:test (tests), TanStack Query + React + shadcn/Recharts (web).

**Branch:** `slice5-networth-graph` (worktree `.claude/worktrees/slice5-networth-graph`).

---

### Task 1: Server module `lib/networth-series.ts`

**Files:**
- Create: `apps/api/src/lib/networth-series.ts`
- Test: `apps/api/src/lib/networth-series.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/lib/networth-series.test.ts`:

```ts
import { expect, test, beforeEach } from "bun:test";
import { resetDb } from "./test-helpers";
import { netWorthSeries } from "./networth-series";
import { db } from "../db/client";
import { accounts, entries, accountOwners, settings } from "../db/schema";
import { createId, nowEpoch } from "./ids";

beforeEach(resetDb);

// resetDb wipes settings; netWorth needs a base-currency row. Seed it directly.
async function seedSettings(baseCurrency = "USD") {
  await db.insert(settings).values({
    id: 1,
    householdName: "Test",
    baseCurrency,
    createdAt: nowEpoch(),
  });
}

async function seedAccount(opts: {
  cls: "asset" | "liability";
  currency: string;
  amountMinor: number;
  date: string;
  userId?: string;
}) {
  const id = createId();
  await db.insert(accounts).values({
    id,
    name: "Acct",
    class: opts.cls,
    subtype: "bank",
    currency: opts.currency,
    valuationMode: "ledger",
    isArchived: 0,
    sortOrder: 0,
    createdAt: nowEpoch(),
    createdBy: opts.userId ?? "seed",
  });
  await db.insert(entries).values({
    id: createId(),
    accountId: id,
    date: opts.date,
    amountMinor: opts.amountMinor,
    kind: "opening",
    createdAt: nowEpoch(),
    createdBy: opts.userId ?? "seed",
  });
  return id;
}

async function ownAccount(accountId: string, userIds: string[]) {
  for (const userId of userIds) {
    await db.insert(accountOwners).values({ accountId, userId });
  }
}

test("weekly points are ascending, anchored on `to`, with as-of values", async () => {
  await seedSettings("USD");
  // Opening $1,000 on 2026-01-01; +$500 on 2026-02-01 (balance 1500 from Feb 1).
  const acct = await seedAccount({ cls: "asset", currency: "USD", amountMinor: 100000, date: "2026-01-01" });
  await db.insert(entries).values({
    id: createId(), accountId: acct, date: "2026-02-01", amountMinor: 50000,
    kind: "adjust", createdAt: nowEpoch(), createdBy: "seed",
  });

  const series = await netWorthSeries({ from: "2026-01-01", to: "2026-02-05" });

  // Anchored on 2026-02-05, stepping back 7 days, reversed ascending:
  // 01-01, 01-08, 01-15, 01-22, 01-29, 02-05
  expect(series.baseCurrency).toBe("USD");
  expect(series.points.map((p) => p.date)).toEqual([
    "2026-01-01", "2026-01-08", "2026-01-15", "2026-01-22", "2026-01-29", "2026-02-05",
  ]);
  // All weeks before Feb 1 see only the opening (100000); 02-05 sees both (150000).
  expect(series.points[0]).toEqual({ date: "2026-01-01", totalBaseMinor: 100000 });
  expect(series.points.at(-1)).toEqual({ date: "2026-02-05", totalBaseMinor: 150000 });
});

test("omitting `to` anchors the last point on today", async () => {
  await seedSettings("USD");
  await seedAccount({ cls: "asset", currency: "USD", amountMinor: 100000, date: "2020-01-01" });

  const series = await netWorthSeries({ from: "2020-01-01" });

  const today = new Date().toISOString().slice(0, 10);
  expect(series.points.at(-1)!.date).toBe(today);
  expect(series.points.at(-1)!.totalBaseMinor).toBe(100000);
});

test("owner filter restricts to that member's sole-owned accounts", async () => {
  await seedSettings("USD");
  const mine = await seedAccount({ cls: "asset", currency: "USD", amountMinor: 10000, date: "2026-01-01", userId: "u1" });
  await ownAccount(mine, ["u1"]);
  const joint = await seedAccount({ cls: "asset", currency: "USD", amountMinor: 20000, date: "2026-01-01", userId: "u1" });
  await ownAccount(joint, ["u1", "u2"]);

  const series = await netWorthSeries({ from: "2026-01-01", to: "2026-01-01", owner: "u1" });

  expect(series.points).toEqual([{ date: "2026-01-01", totalBaseMinor: 10000 }]);
});

test("from after to yields no points but still reports base currency", async () => {
  await seedSettings("EUR");

  const series = await netWorthSeries({ from: "2026-03-01", to: "2026-01-01" });

  expect(series.points).toEqual([]);
  expect(series.baseCurrency).toBe("EUR");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/api/src/lib/networth-series.test.ts`
Expected: FAIL — `Cannot find module './networth-series'` (or `netWorthSeries is not a function`).

- [ ] **Step 3: Write minimal implementation**

Create `apps/api/src/lib/networth-series.ts`:

```ts
import { db } from "../db/client";
import { settings } from "../db/schema";
import { eq } from "drizzle-orm";
import { netWorth } from "./valuation";

export type NetWorthPoint = { date: string; totalBaseMinor: number };
export type NetWorthSeries = { baseCurrency: string; points: NetWorthPoint[] };

const DAY_MS = 86_400_000;

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

// Weekly dates from `to` stepping back 7 days until before `from`, returned ascending.
// Anchoring on `to` guarantees the last point equals the headline's as-of-today value.
function weeklyDates(from: string, to: string): string[] {
  const fromMs = Date.parse(`${from}T00:00:00Z`);
  let cur = Date.parse(`${to}T00:00:00Z`);
  const dates: string[] = [];
  while (cur >= fromMs) {
    dates.push(new Date(cur).toISOString().slice(0, 10));
    cur -= 7 * DAY_MS;
  }
  return dates.reverse();
}

async function baseCurrencyFromSettings(): Promise<string> {
  const s = (await db.select().from(settings).where(eq(settings.id, 1)))[0];
  return s?.baseCurrency ?? "USD";
}

export async function netWorthSeries(opts: {
  from: string;
  to?: string;
  owner?: string;
}): Promise<NetWorthSeries> {
  const to = opts.to ?? todayISO();
  const dates = weeklyDates(opts.from, to);

  const points: NetWorthPoint[] = [];
  let baseCurrency: string | null = null;
  for (const date of dates) {
    const nw = await netWorth({ asOf: date, owner: opts.owner });
    baseCurrency = nw.baseCurrency;
    points.push({ date, totalBaseMinor: nw.totalBaseMinor });
  }

  return {
    baseCurrency: baseCurrency ?? (await baseCurrencyFromSettings()),
    points,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/api/src/lib/networth-series.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/networth-series.ts apps/api/src/lib/networth-series.test.ts
git commit -m "feat(api): netWorthSeries — weekly net-worth series over the netWorth contract"
```

---

### Task 2: Route `GET /networth/series` + register it

**Files:**
- Create: `apps/api/src/routes/networth-series.ts`
- Create: `apps/api/src/routes/networth-series.test.ts`
- Modify: `apps/api/src/app.ts` (import + `.use(...)`)

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/routes/networth-series.test.ts`:

```ts
import { expect, test, beforeEach } from "bun:test";
import { resetDb, makeApp, initAndLogin } from "../lib/test-helpers";
import { networthSeriesRoutes } from "./networth-series";
import { db } from "../db/client";
import { accounts, entries } from "../db/schema";
import { createId, nowEpoch } from "../lib/ids";

beforeEach(resetDb);

const app = makeApp(networthSeriesRoutes);

async function seedAccount(amountMinor: number, date: string) {
  const id = createId();
  await db.insert(accounts).values({
    id, name: "Checking", class: "asset", subtype: "bank", currency: "USD",
    valuationMode: "ledger", isArchived: 0, sortOrder: 0,
    createdAt: nowEpoch(), createdBy: "seed",
  });
  await db.insert(entries).values({
    id: createId(), accountId: id, date, amountMinor,
    kind: "opening", createdAt: nowEpoch(), createdBy: "seed",
  });
  return id;
}

test("GET /networth/series returns ascending weekly points", async () => {
  const { cookie } = await initAndLogin({ app, baseCurrency: "USD" });
  await seedAccount(100000, "2026-01-01");

  const res = await app.handle(
    new Request("http://localhost/networth/series?from=2026-01-01&to=2026-01-15", { headers: { cookie } }),
  );
  expect(res.status).toBe(200);

  const series = await res.json();
  expect(series.baseCurrency).toBe("USD");
  expect(series.points.map((p: any) => p.date)).toEqual(["2026-01-01", "2026-01-08", "2026-01-15"]);
  expect(series.points.every((p: any) => p.totalBaseMinor === 100000)).toBe(true);
});

test("GET /networth/series requires `from` (422 when missing)", async () => {
  const { cookie } = await initAndLogin({ app, baseCurrency: "USD" });
  const res = await app.handle(new Request("http://localhost/networth/series", { headers: { cookie } }));
  expect(res.status).toBe(422);
});

test("GET /networth/series returns 401 without auth", async () => {
  const res = await app.handle(new Request("http://localhost/networth/series?from=2026-01-01"));
  expect(res.status).toBe(401);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/api/src/routes/networth-series.test.ts`
Expected: FAIL — `Cannot find module './networth-series'`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/api/src/routes/networth-series.ts`:

```ts
import { Elysia, t } from "elysia";
import { authGuard } from "../lib/auth-guard";
import { netWorthSeries } from "../lib/networth-series";

export const networthSeriesRoutes = new Elysia()
  .use(authGuard)
  .get(
    "/networth/series",
    async ({ query }) =>
      netWorthSeries({ from: query.from, to: query.to, owner: query.owner }),
    {
      query: t.Object({
        from: t.String(),
        to: t.Optional(t.String()),
        owner: t.Optional(t.String()),
      }),
    },
  );
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/api/src/routes/networth-series.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Register the route in the app**

In `apps/api/src/app.ts`, add the import next to the other route imports:

```ts
import { networthRoutes } from "./routes/networth";
import { networthSeriesRoutes } from "./routes/networth-series";
```

And mount it right after `networthRoutes` in the `.use(...)` chain:

```ts
    .use(networthRoutes)
    .use(networthSeriesRoutes)
    .use(usersRoutes)
```

- [ ] **Step 6: Run the full API suite to confirm nothing regressed**

Run: `bun test apps/api`
Expected: PASS — all prior tests plus the 7 new ones (4 lib + 3 route).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/networth-series.ts apps/api/src/routes/networth-series.test.ts apps/api/src/app.ts
git commit -m "feat(api): GET /networth/series endpoint (weekly net-worth series)"
```

---

### Task 3: Add the shadcn `chart` component

**Files:**
- Create (via CLI): `apps/web/src/components/ui/chart.tsx`
- Modify (via CLI): `apps/web/package.json` (adds `recharts`)

- [ ] **Step 1: Add the chart component via the shadcn CLI**

From the repo root, run:

```bash
cd apps/web && bunx --bun shadcn@latest add chart
```

This creates `apps/web/src/components/ui/chart.tsx` and installs `recharts`. Accept any prompts to install dependencies.

- [ ] **Step 2: Verify recharts is installed**

Run: `grep recharts apps/web/package.json`
Expected: a `"recharts"` entry under dependencies. If it is missing, run `cd apps/web && bun add recharts`.

- [ ] **Step 3: Verify the web app still type-checks/builds**

Run: `bun --cwd apps/web run build`
Expected: PASS (tsc + vite build complete with no errors).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/ui/chart.tsx apps/web/package.json
git commit -m "chore(web): add shadcn chart component (recharts)"
```

---

### Task 4: `net-worth-chart.tsx` component

**Files:**
- Create: `apps/web/src/components/net-worth-chart.tsx`

- [ ] **Step 1: Write the component**

Create `apps/web/src/components/net-worth-chart.tsx`:

```tsx
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Area, AreaChart, CartesianGrid, XAxis } from "recharts";
import { api } from "@/lib/api";
import { formatMoney } from "@/components/money";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";

type SeriesPoint = { date: string; totalBaseMinor: number };
type Series = { baseCurrency: string; points: SeriesPoint[] };

const PRESETS = ["YTD", "1M", "6M", "1Y", "3Y", "Custom"] as const;
type Preset = (typeof PRESETS)[number];

const chartConfig = {
  net: { label: "Net worth", color: "var(--chart-1)" },
} satisfies ChartConfig;

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// Map a non-custom preset to a {from, to} range (to = today).
function presetRange(preset: Exclude<Preset, "Custom">): { from: string; to: string } {
  const today = new Date();
  const d = new Date(today);
  switch (preset) {
    case "YTD":
      d.setMonth(0, 1);
      break;
    case "1M":
      d.setMonth(d.getMonth() - 1);
      break;
    case "6M":
      d.setMonth(d.getMonth() - 6);
      break;
    case "1Y":
      d.setFullYear(d.getFullYear() - 1);
      break;
    case "3Y":
      d.setFullYear(d.getFullYear() - 3);
      break;
  }
  return { from: iso(d), to: iso(today) };
}

async function fetchSeries(from: string, to: string, owner: string): Promise<Series> {
  const { data, error } = await api.networth.series.get({ query: { from, to, owner } });
  if (error) throw new Error(String(error));
  return data as unknown as Series;
}

export function NetWorthChart({ owner }: { owner: string }) {
  const [preset, setPreset] = useState<Preset>("1Y");
  // Custom range inputs (used only when preset === "Custom").
  const [customFrom, setCustomFrom] = useState(() => presetRange("1Y").from);
  const [customTo, setCustomTo] = useState(() => iso(new Date()));

  const { from, to } =
    preset === "Custom" ? { from: customFrom, to: customTo } : presetRange(preset);

  const { data, isLoading } = useQuery({
    queryKey: ["networth-series", owner, from, to],
    queryFn: () => fetchSeries(from, to, owner),
  });

  const base = data?.baseCurrency ?? "";
  const rows = (data?.points ?? []).map((p) => ({ date: p.date, net: p.totalBaseMinor }));

  return (
    <section className="rounded-2xl border border-border bg-card px-4 py-4 shadow-sm md:px-6 md:py-5">
      <div className="mb-3 flex flex-wrap gap-1.5">
        {PRESETS.map((p) => (
          <Button
            key={p}
            size="sm"
            variant={preset === p ? "default" : "outline"}
            onClick={() => setPreset(p)}
            className={cn(preset === p && "pointer-events-none")}
          >
            {p}
          </Button>
        ))}
      </div>

      {preset === "Custom" && (
        <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
          <input
            type="date"
            value={customFrom}
            onChange={(e) => setCustomFrom(e.target.value)}
            className="rounded-md border border-border bg-background px-2 py-1"
          />
          <span className="text-muted-foreground">to</span>
          <input
            type="date"
            value={customTo}
            onChange={(e) => setCustomTo(e.target.value)}
            className="rounded-md border border-border bg-background px-2 py-1"
          />
        </div>
      )}

      {isLoading ? (
        <div className="h-[200px] animate-pulse rounded-xl bg-muted/40" />
      ) : rows.length === 0 ? (
        <p className="py-12 text-center text-sm text-muted-foreground">No data for this range.</p>
      ) : (
        <ChartContainer config={chartConfig} className="h-[200px] w-full">
          <AreaChart data={rows} margin={{ left: 8, right: 8, top: 8 }}>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="date"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              minTickGap={32}
              tickFormatter={(v: string) =>
                new Date(`${v}T00:00:00Z`).toLocaleDateString(undefined, {
                  month: "short",
                  day: "numeric",
                })
              }
            />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  labelFormatter={(label) =>
                    new Date(`${label}T00:00:00Z`).toLocaleDateString(undefined, {
                      year: "numeric",
                      month: "short",
                      day: "numeric",
                    })
                  }
                  formatter={(value) => formatMoney(Number(value), base)}
                />
              }
            />
            <Area
              dataKey="net"
              type="monotone"
              fill="var(--color-net)"
              fillOpacity={0.15}
              stroke="var(--color-net)"
              strokeWidth={2}
            />
          </AreaChart>
        </ChartContainer>
      )}
    </section>
  );
}
```

- [ ] **Step 2: Type-check the component**

Run: `bun --cwd apps/web run build`
Expected: PASS. (If the eden treaty type for `api.networth.series` is not yet resolved, confirm Task 2 Step 5 registered the route in `app.ts` — the web client's `App` type is derived from it.)

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/net-worth-chart.tsx
git commit -m "feat(web): net-worth-over-time chart component (presets + custom range)"
```

---

### Task 5: Mount the chart on the dashboard

**Files:**
- Modify: `apps/web/src/routes/dashboard.tsx` (import + render between hero and groups)

- [ ] **Step 1: Import the component**

In `apps/web/src/routes/dashboard.tsx`, add near the other component imports (after the `NetWorthToggle` import):

```tsx
import { NetWorthToggle } from "@/components/net-worth-toggle";
import { NetWorthChart } from "@/components/net-worth-chart";
```

- [ ] **Step 2: Render the chart between the hero and the account groups**

In `apps/web/src/routes/dashboard.tsx`, locate the closing `</section>` of the hero block (the one rendering the headline) and the line `<div className="mt-9 space-y-8">`. Insert the chart between them:

```tsx
      </section>

      <div className="mt-6">
        <NetWorthChart owner={owner} />
      </div>

      <div className="mt-9 space-y-8">
```

- [ ] **Step 3: Build to type-check the full web app**

Run: `bun --cwd apps/web run build`
Expected: PASS.

- [ ] **Step 4: Manual smoke check (optional but recommended)**

Run the stack (`bun run dev` from repo root), open the dashboard, and confirm: the chart renders under the headline; preset buttons switch ranges; toggling household/member refetches the curve; the rightmost point matches the headline number.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/routes/dashboard.tsx
git commit -m "feat(web): show net-worth-over-time chart on dashboard"
```

---

## Self-Review notes

- **Spec coverage:** endpoint (Task 2) ✓; `lib/networth-series.ts` weekly anchoring + loop (Task 1) ✓; `from > to` empty + base-currency fallback (Task 1 test) ✓; owner passthrough (Tasks 1–2) ✓; shadcn chart via CLI (Task 3) ✓; presets YTD/1M/6M/1Y/3Y/Custom default 1Y + follows toggle (Task 4) ✓; placement between hero and groups (Task 5) ✓; API tests, web typecheck-only (all tasks) ✓; no edits to `valuation.ts`/`networth.ts`/toggle ✓.
- **Type consistency:** `NetWorthSeries`/`NetWorthPoint` (`{ baseCurrency, points: [{ date, totalBaseMinor }] }`) are identical across lib, route, and the web `Series` type. `netWorthSeries({ from, to?, owner? })` signature matches every call site.
- **Deferred (per spec):** goals, projections, non-weekly granularity, bucketed-SQL optimization — intentionally absent.
