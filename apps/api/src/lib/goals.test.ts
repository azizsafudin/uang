import { expect, test, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { accounts, instruments, transactions, goals, memberProfiles, user, goalAccounts } from "../db/schema";
import { SCALE, currencyDecimals } from "@uang/shared";
import { createId, nowEpoch } from "./ids";
import { setOwners } from "./owners";
import { resetDb, initAndLogin } from "./test-helpers";
import { analyzeGoals, goalProjection } from "./goals";

beforeEach(resetDb);

// Reuse one USD instrument across accounts — the instruments_symbol_uq index
// forbids two rows with the same symbol.
async function usdInstrumentId(): Promise<string> {
  const existing = await db.select().from(instruments).where(eq(instruments.symbol, "USD"));
  if (existing.length) return existing[0].id;
  const id = createId();
  await db.insert(instruments).values({
    id, symbol: "USD", isin: null, name: "US Dollar",
    kind: "currency", currency: "USD", createdAt: nowEpoch(),
  });
  return id;
}

// Seed an asset account owned by `ownerId`, funded with an opening cash transaction.
async function addAccount(opts: {
  name: string; subtype: string; accessibleFromAge?: number;
  earlyWithdrawal?: "none" | "penalty"; earlyHaircutBps?: number; illiquid?: boolean;
  openingMinor: number; ownerId: string;
}) {
  const id = createId();
  await db.insert(accounts).values({
    id, name: opts.name, class: "asset", subtype: opts.subtype, currency: "USD",
    isArchived: 0, sortOrder: 0,
    growthRateBps: 0,
    accessibleFromAge: opts.accessibleFromAge ?? 0,
    earlyWithdrawal: opts.earlyWithdrawal ?? "none",
    earlyHaircutBps: opts.earlyHaircutBps ?? 0,
    illiquid: opts.illiquid ? 1 : 0, liquidationAge: null,
    createdAt: nowEpoch(), createdBy: "seed",
  });
  await setOwners(id, [opts.ownerId]);
  const instrId = await usdInstrumentId();
  const major = opts.openingMinor / 10 ** currencyDecimals("USD");
  await db.insert(transactions).values({
    id: createId(), accountId: id, instrumentId: instrId, date: "2020-01-01",
    unitsDelta: Math.round(major * Number(SCALE)), unitPriceScaled: Number(SCALE),
    feesMinor: 0, notes: null, createdAt: nowEpoch(), createdBy: "seed",
  });
  return id;
}

test("analyzeGoals: soonest-first allocation, short sees cash only, long picks up CPF", async () => {
  // initAndLogin creates the household (settings with default assumptions) + the admin user.
  await initAndLogin({ baseCurrency: "USD" });
  const [owner] = await db.select().from(user);
  const userId = owner.id;
  // Member well under 55 at the short target (2030) and over 55 at the long one (2050).
  await db.insert(memberProfiles).values({ userId, birthYear: 1990 });

  const cashId = await addAccount({ name: "Cash", subtype: "bank", openingMinor: 5_000_000, ownerId: userId });
  const cpfId = await addAccount({ name: "CPF", subtype: "other", accessibleFromAge: 55, openingMinor: 10_000_000, ownerId: userId });

  await db.insert(goals).values([
    { id: "short", name: "Car", targetAmountMinor: 3_000_000, currency: "USD", targetDate: "2030-01-01", ownerScope: "household", anchorDate: null, monthlyContributionMinor: 0, sortOrder: 0, createdAt: nowEpoch(), createdBy: "seed" },
    { id: "long", name: "Retire", targetAmountMinor: 100_000_000, currency: "USD", targetDate: "2050-01-01", ownerScope: "household", anchorDate: null, monthlyContributionMinor: 0, sortOrder: 0, createdAt: nowEpoch(), createdBy: "seed" },
  ]);
  await db.insert(goalAccounts).values([
    { goalId: "short", accountId: cashId }, { goalId: "short", accountId: cpfId },
    { goalId: "long", accountId: cashId },  { goalId: "long", accountId: cpfId },
  ]);

  const r = await analyzeGoals();
  const short = r.goals.find((g) => g.id === "short")!;
  const long = r.goals.find((g) => g.id === "long")!;

  expect(short.allocatedMinor).toBe(3_000_000); // all from cash (CPF locked at age 40)
  expect(short.progressPct).toBe(100);
  expect(long.allocatedMinor).toBe(12_000_000); // leftover cash 2_000_000 + CPF 10_000_000
  expect(long.progressPct).toBe(12);            // 12M of a 100M target
  expect(r.unallocatedMinor).toBe(0);
  expect(r.contributionGrowthRateBps).toBe(800);

  // Short is already covered (allocation grows past target at the plan rate) -> on track, no contribution needed.
  expect(short.requiredMonthlyMinor).toBe(0);
  expect(short.onTrack).toBe(true);
  // Long is far short even after growth and has no planned contribution -> behind, needs one.
  expect(long.monthlyContributionMinor).toBe(0);
  expect(long.requiredMonthlyMinor).toBeGreaterThan(0);
  expect(long.onTrack).toBe(false);

  // Funding sources surface per goal (drives the list/detail donut + breakdown).
  expect(short.sources.map((s) => s.name)).toEqual(["Cash"]);
  expect(long.sources.map((s) => s.name)).toEqual(["Cash", "CPF"]);
  expect(long.sources.reduce((sum, s) => sum + s.allocatedMinor, 0)).toBe(long.allocatedMinor);
});

test("analyzeGoals: a sufficient monthly contribution puts a goal on track", async () => {
  await initAndLogin({ baseCurrency: "USD" });
  const [owner] = await db.select().from(user);
  const cashId = await addAccount({ name: "Cash", subtype: "bank", openingMinor: 1_000_000, ownerId: owner.id });

  // Tiny allocation, large planned saving: the contribution closes the gap.
  await db.insert(goals).values({
    id: "c", name: "Save", targetAmountMinor: 50_000_000, currency: "USD",
    targetDate: "2030-01-01", ownerScope: "household", anchorDate: null,
    monthlyContributionMinor: 2_000_000, sortOrder: 0, createdAt: nowEpoch(), createdBy: "seed",
  });
  await db.insert(goalAccounts).values({ goalId: "c", accountId: cashId });

  const r = await analyzeGoals();
  const g = r.goals.find((x) => x.id === "c")!;
  expect(g.monthlyContributionMinor).toBe(2_000_000);
  expect(g.requiredMonthlyMinor).toBeGreaterThan(0);                 // allocation alone doesn't cover it
  expect(g.projectedAtTargetMinor).toBeGreaterThanOrEqual(g.targetAmountMinor); // ...but the contribution does
  expect(g.onTrack).toBe(true);
});

test("goalProjection: past actual then a single projected trajectory toward target", async () => {
  await initAndLogin({ baseCurrency: "USD" });
  const [owner] = await db.select().from(user);
  const userId = owner.id;
  await db.insert(memberProfiles).values({ userId, birthYear: 1990 });

  const cashId = await addAccount({ name: "Cash", subtype: "bank", openingMinor: 5_000_000, ownerId: userId });
  const cpfId = await addAccount({ name: "CPF", subtype: "other", accessibleFromAge: 55, openingMinor: 10_000_000, ownerId: userId });

  await db.insert(goals).values({
    id: "g", name: "Retire", targetAmountMinor: 150_000_000, currency: "USD",
    targetDate: "2050-01-01", ownerScope: "household", anchorDate: null, monthlyContributionMinor: 0,
    sortOrder: 0, createdAt: nowEpoch(), createdBy: "seed",
  });
  await db.insert(goalAccounts).values([
    { goalId: "g", accountId: cashId }, { goalId: "g", accountId: cpfId },
  ]);

  const r = await goalProjection("g", 2);
  if (!r) throw new Error("expected a projection");

  // Single goal sees both accounts by 2050 (owner age 60 -> CPF unlocked): 5M + 10M.
  expect(r.allocatedMinor).toBe(15_000_000);
  expect(r.progressPct).toBe(10);                     // 15M of a 150M target
  expect(r.targetMinor).toBe(150_000_000);
  expect(r.monthlyContributionMinor).toBe(0);
  expect(r.requiredMonthlyMinor).toBeGreaterThan(0);  // growth alone falls short
  expect(r.onTrack).toBe(false);

  // Funding sources: this goal draws from both accounts, named, most-liquid first.
  expect(r.sources.map((s) => s.name)).toEqual(["Cash", "CPF"]);
  expect(r.sources.map((s) => s.allocatedMinor)).toEqual([5_000_000, 10_000_000]);
  expect(r.sources.reduce((sum, s) => sum + s.allocatedMinor, 0)).toBe(r.allocatedMinor);

  const today = new Date().toISOString().slice(0, 10);
  const todayPoint = r.series.find((p) => p.date === today);
  if (!todayPoint) throw new Error("expected a today point");
  // At today the actual and projected lines meet at the current allocation.
  expect(todayPoint.actual).toBe(15_000_000);
  expect(todayPoint.projected).toBe(15_000_000);

  // Past points: actual present, projected null.
  const past = r.series.filter((p) => p.date < today);
  expect(past.length).toBeGreaterThan(0);
  expect(past.every((p) => p.actual !== null && p.projected === null)).toBe(true);

  // Future points: actual null, projected present and growing past today's allocation.
  const future = r.series.filter((p) => p.date > today);
  expect(future.length).toBeGreaterThan(0);
  expect(future.every((p) => p.actual === null && p.projected !== null)).toBe(true);
  const last = r.series[r.series.length - 1];
  expect(last.date.slice(0, 7)).toBe("2050-01");      // final point lands on the target month
  expect((last.projected ?? 0)).toBeGreaterThan(15_000_000); // grew at the plan rate
  expect(r.projectedAtTargetMinor).toBe(last.projected); // the final projected point
});

test("goals: an indefinite (no target date) goal reports a reach date, no required rate", async () => {
  await initAndLogin({ baseCurrency: "USD" });
  const [owner] = await db.select().from(user);
  const cashId = await addAccount({ name: "Cash", subtype: "bank", openingMinor: 1_000_000, ownerId: owner.id });

  await db.insert(goals).values({
    id: "indef", name: "Wealth", targetAmountMinor: 50_000_000, currency: "USD",
    targetDate: null, ownerScope: "household", anchorDate: null,
    monthlyContributionMinor: 1_000_000, sortOrder: 0, createdAt: nowEpoch(), createdBy: "seed",
  });
  await db.insert(goalAccounts).values({ goalId: "indef", accountId: cashId });

  const a = (await analyzeGoals()).goals.find((g) => g.id === "indef")!;
  expect(a.targetDate).toBeNull();
  expect(a.requiredMonthlyMinor).toBe(0);          // no deadline -> no required rate
  expect(a.projectedAtTargetMinor).toBeNull();     // no date to project to
  expect(a.reachDate).not.toBeNull();              // but it does reach the amount
  expect(a.onTrack).toBeNull();                    // undated -> no pass/fail

  const proj = await goalProjection("indef", 2);
  if (!proj) throw new Error("expected a projection");
  expect(proj.goal.targetDate).toBeNull();
  // The projected line runs to the reach month and ends at/above the target.
  const last = proj.series[proj.series.length - 1];
  expect((last.projected ?? 0)).toBeGreaterThanOrEqual(proj.targetMinor);
});

test("goalProjection: a monthly-spend goal draws down after its target date", async () => {
  await initAndLogin({ baseCurrency: "USD" });
  const [owner] = await db.select().from(user);
  const cashId = await addAccount({ name: "Cash", subtype: "bank", openingMinor: 50_000_000, ownerId: owner.id });

  await db.insert(goals).values({
    id: "draw", name: "Retire", targetAmountMinor: 40_000_000, currency: "USD",
    targetDate: "2030-01-01", ownerScope: "household", anchorDate: null,
    monthlyContributionMinor: 0, spendType: "monthly", spendAmountMinor: 500_000, spendRateBps: null,
    sortOrder: 0, createdAt: nowEpoch(), createdBy: "seed",
  });
  await db.insert(goalAccounts).values({ goalId: "draw", accountId: cashId });

  const r = await goalProjection("draw", 2);
  if (!r) throw new Error("expected a projection");

  expect(r.spendType).toBe("monthly");
  // Income figure: flat monthly spend annualised.
  expect(r.annualIncomeMinor).toBe(500_000 * 12);

  // The projected line extends past the target date and ends lower than its value
  // at the target date (drawdown is visible).
  const target = "2030-01";
  const atTarget = r.series.find((p) => p.date.slice(0, 7) === target && p.projected !== null);
  if (!atTarget) throw new Error("expected a point at the target month");
  const last = r.series[r.series.length - 1];
  expect(last.date > "2030-01-01").toBe(true);                 // extends into drawdown
  expect((last.projected ?? 0)).toBeLessThan(atTarget.projected ?? 0); // declines after spending
});

test("analyzeGoals: a percent-spend goal reports an annual income from balance-at-target", async () => {
  await initAndLogin({ baseCurrency: "USD" });
  const [owner] = await db.select().from(user);
  const cashId = await addAccount({ name: "Cash", subtype: "bank", openingMinor: 100_000_000, ownerId: owner.id });

  await db.insert(goals).values({
    id: "swr", name: "FIRE", targetAmountMinor: 80_000_000, currency: "USD",
    targetDate: "2030-01-01", ownerScope: "household", anchorDate: null,
    monthlyContributionMinor: 0, spendType: "percent", spendAmountMinor: null, spendRateBps: 400,
    sortOrder: 0, createdAt: nowEpoch(), createdBy: "seed",
  });
  await db.insert(goalAccounts).values({ goalId: "swr", accountId: cashId });

  const a = (await analyzeGoals()).goals.find((g) => g.id === "swr")!;
  expect(a.spendType).toBe("percent");
  // 4% of the balance reached by the target date.
  expect(a.annualIncomeMinor).not.toBeNull();
  expect(a.annualIncomeMinor!).toBeGreaterThan(0);
});

test("analyzeGoals: an unassigned account never funds a goal; undated goal has null onTrack", async () => {
  await initAndLogin({ baseCurrency: "USD" });
  const [owner] = await db.select().from(user);
  const chkId = await addAccount({ name: "Checking", subtype: "bank", openingMinor: 10_000_000, ownerId: owner.id });
  await addAccount({ name: "Savings", subtype: "bank", openingMinor: 10_000_000, ownerId: owner.id }); // unassigned

  await db.insert(goals).values([
    { id: "car", name: "Car", targetAmountMinor: 20_000_000, currency: "USD", targetDate: "2030-01-01", ownerScope: "household", anchorDate: null, monthlyContributionMinor: 0, sortOrder: 0, createdAt: nowEpoch(), createdBy: "seed" },
    { id: "buffer", name: "Buffer", targetAmountMinor: 5_000_000, currency: "USD", targetDate: null, ownerScope: "household", anchorDate: null, monthlyContributionMinor: 0, sortOrder: 1, createdAt: nowEpoch(), createdBy: "seed" },
  ]);
  await db.insert(goalAccounts).values({ goalId: "car", accountId: chkId });

  const res = await analyzeGoals();
  const car = res.goals.find((g) => g.id === "car")!;
  const buffer = res.goals.find((g) => g.id === "buffer")!;

  expect(car.allocatedMinor).toBe(10_000_000);
  expect(car.accountIds).toEqual([chkId]);
  expect(typeof car.onTrack).toBe("boolean");
  expect(buffer.allocatedMinor).toBe(0);
  expect(buffer.onTrack).toBeNull();
  expect(res.unallocatedMinor).toBe(10_000_000);
});
