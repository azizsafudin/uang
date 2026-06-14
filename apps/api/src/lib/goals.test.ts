import { expect, test, beforeEach } from "bun:test";
import { db } from "../db/client";
import { accounts, entries, goals, memberProfiles, user } from "../db/schema";
import { createId, nowEpoch } from "./ids";
import { setOwners } from "./owners";
import { resetDb, initAndLogin } from "./test-helpers";
import { analyzeGoals, goalProjection } from "./goals";

beforeEach(resetDb);

// Seed an asset account owned by `ownerId`, with an opening ledger balance.
async function addAccount(opts: {
  name: string; subtype: string; accessibleFromAge?: number;
  earlyWithdrawal?: "none" | "penalty"; earlyHaircutBps?: number; illiquid?: boolean;
  openingMinor: number; ownerId: string;
}) {
  const id = createId();
  await db.insert(accounts).values({
    id, name: opts.name, class: "asset", subtype: opts.subtype, currency: "USD",
    valuationMode: "ledger", isArchived: 0, sortOrder: 0,
    growthRateBps: 0,
    accessibleFromAge: opts.accessibleFromAge ?? 0,
    earlyWithdrawal: opts.earlyWithdrawal ?? "none",
    earlyHaircutBps: opts.earlyHaircutBps ?? 0,
    illiquid: opts.illiquid ? 1 : 0, liquidationAge: null,
    createdAt: nowEpoch(), createdBy: "seed",
  });
  await setOwners(id, [opts.ownerId]);
  await db.insert(entries).values({
    id: createId(), accountId: id, date: "2020-01-01", amountMinor: opts.openingMinor,
    kind: "opening", createdAt: nowEpoch(), createdBy: "seed",
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

  await addAccount({ name: "Cash", subtype: "bank", openingMinor: 5_000_000, ownerId: userId });
  await addAccount({ name: "CPF", subtype: "other", accessibleFromAge: 55, openingMinor: 10_000_000, ownerId: userId });

  await db.insert(goals).values([
    { id: "short", name: "Car", term: "short", targetAmountMinor: 3_000_000, currency: "USD", targetDate: "2030-01-01", ownerScope: "household", anchorDate: null, monthlyContributionMinor: 0, sortOrder: 0, createdAt: nowEpoch(), createdBy: "seed" },
    { id: "long", name: "Retire", term: "long", targetAmountMinor: 100_000_000, currency: "USD", targetDate: "2050-01-01", ownerScope: "household", anchorDate: null, monthlyContributionMinor: 0, sortOrder: 0, createdAt: nowEpoch(), createdBy: "seed" },
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
  await addAccount({ name: "Cash", subtype: "bank", openingMinor: 1_000_000, ownerId: owner.id });

  // Tiny allocation, large planned saving: the contribution closes the gap.
  await db.insert(goals).values({
    id: "c", name: "Save", term: "short", targetAmountMinor: 50_000_000, currency: "USD",
    targetDate: "2030-01-01", ownerScope: "household", anchorDate: null,
    monthlyContributionMinor: 2_000_000, sortOrder: 0, createdAt: nowEpoch(), createdBy: "seed",
  });

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

  await addAccount({ name: "Cash", subtype: "bank", openingMinor: 5_000_000, ownerId: userId });
  await addAccount({ name: "CPF", subtype: "other", accessibleFromAge: 55, openingMinor: 10_000_000, ownerId: userId });

  await db.insert(goals).values({
    id: "g", name: "Retire", term: "long", targetAmountMinor: 150_000_000, currency: "USD",
    targetDate: "2050-01-01", ownerScope: "household", anchorDate: null, monthlyContributionMinor: 0,
    sortOrder: 0, createdAt: nowEpoch(), createdBy: "seed",
  });

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
