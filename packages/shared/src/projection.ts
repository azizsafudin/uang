import { roundDiv, toBig, fromBig } from "./money";

// Rates and haircuts are integer basis points: 8% === 800, 100% === 10_000.
const BPS = 10_000n;

function assertYears(years: number): void {
  if (!Number.isInteger(years) || years < 0) {
    throw new Error("projection: years must be a non-negative integer");
  }
}

// Compound a starting balance (minor units, may be negative for debt) for `years`
// whole years at `growthRateBps` per year, banker's-rounded each year.
export function compoundMinor(balanceMinor: number, growthRateBps: number, years: number): number {
  assertYears(years);
  let b = toBig(balanceMinor);
  const factor = BPS + toBig(growthRateBps);
  for (let i = 0; i < years; i++) b = roundDiv(b * factor, BPS);
  return fromBig(b);
}

// Balance at each year offset 0..years inclusive. `contributionPerYear` (minor
// units) is added at the start of each year before that year's growth.
// Offset 0 is always the untouched starting balance (today).
export function projectSeries(
  balanceMinor: number,
  growthRateBps: number,
  years: number,
  contributionPerYear = 0,
): number[] {
  assertYears(years);
  const factor = BPS + toBig(growthRateBps);
  const contrib = toBig(contributionPerYear);
  let b = toBig(balanceMinor);
  const out: number[] = [fromBig(b)];
  for (let i = 1; i <= years; i++) {
    b = roundDiv((b + contrib) * factor, BPS);
    out.push(fromBig(b));
  }
  return out;
}

export type EarlyWithdrawal = "none" | "penalty";

export type AccessibilityConfig = {
  accessibleFromAge: number;
  earlyWithdrawal: EarlyWithdrawal;
  earlyHaircutBps: number;
  illiquid: boolean;
  liquidationAge: number | null;
};

// Withdrawable value of a balance at a given owner age. Slice 1 has no late
// haircut (tax deferred), so at/after the free age the full balance counts.
export function accessibleValueMinor(
  balanceMinor: number,
  ownerAge: number,
  c: AccessibilityConfig,
): number {
  if (c.illiquid) {
    return c.liquidationAge !== null && ownerAge >= c.liquidationAge ? balanceMinor : 0;
  }
  if (ownerAge >= c.accessibleFromAge) return balanceMinor;
  if (c.earlyWithdrawal === "penalty") {
    if (c.earlyHaircutBps < 0 || c.earlyHaircutBps > 10000) {
      throw new Error("accessibleValueMinor: earlyHaircutBps must be in [0, 10000]");
    }
    return fromBig(roundDiv(toBig(balanceMinor) * (BPS - toBig(c.earlyHaircutBps)), BPS));
  }
  return 0;
}

// Note: the spend-type union is inlined here rather than exported as `SpendType`,
// because `./goals` already exports a `SpendType` and the package barrel re-exports
// both modules with `export *` (a named `SpendType` here would collide — TS2308).
export type SpendStartKind = "age" | "target";

export type WithdrawalConfig = {
  spendType: "none" | "once" | "monthly" | "percent";
  spendAmountMinor: number | null;   // base minor: 'once' lump / 'monthly' per-month amount
  spendRateBps: number | null;       // 'percent' annual % of balance
  spendStartKind: SpendStartKind;
  spendStartAge: number | null;      // start when youngest owner reaches this age
  spendStartTargetMinor: number | null; // start when this account's balance reaches this (base minor)
};

export type ProjectionAccount = AccessibilityConfig & WithdrawalConfig & {
  baseMinor: number;      // current base-currency balance (signed)
  growthRateBps: number;
  ownerBirthYears: number[]; // owners' birth years; empty = unknown
};

export type ProjectionPoint = {
  year: number;
  totalBaseMinor: number;
  accessibleBaseMinor: number;
};

// Year-by-year balance for one account, modelling growth then withdrawal.
// Offset 0 is today's balance, untouched. Each later year: grow at growthRateBps,
// then (if the spend trigger has fired and the balance is positive) withdraw.
// Withdrawals never push a balance below 0; naturally-negative balances (debt)
// keep compounding and are never floored.
export function projectAccountSeries(
  account: ProjectionAccount,
  span: number,
  fromYear: number,
  youngestBirthYear: number | null,
): number[] {
  assertYears(span);
  const factor = BPS + toBig(account.growthRateBps);
  let b = toBig(account.baseMinor);
  const out: number[] = [fromBig(b)];
  let started = false;
  let finishedOnce = false;
  for (let offset = 1; offset <= span; offset++) {
    const year = fromYear + offset;
    b = roundDiv(b * factor, BPS); // grow

    if (account.spendType !== "none" && !started) {
      if (account.spendStartKind === "age") {
        if (
          youngestBirthYear !== null &&
          account.spendStartAge !== null &&
          year - youngestBirthYear >= account.spendStartAge
        ) {
          started = true;
        }
      } else if (
        account.spendStartTargetMinor !== null &&
        b >= toBig(account.spendStartTargetMinor)
      ) {
        started = true;
      }
    }

    if (started && b > 0n) {
      if (account.spendType === "once") {
        if (!finishedOnce) {
          const amt = toBig(account.spendAmountMinor ?? 0);
          b = amt > b ? 0n : b - amt;
          finishedOnce = true;
        }
      } else if (account.spendType === "monthly") {
        const amt = toBig(account.spendAmountMinor ?? 0) * 12n;
        b = amt > b ? 0n : b - amt;
      } else if (account.spendType === "percent") {
        const wd = roundDiv(b * toBig(account.spendRateBps ?? 0), BPS);
        b = wd > b ? 0n : b - wd;
      }
    }
    out.push(fromBig(b));
  }
  return out;
}

export function projectNetWorth(params: {
  accounts: ProjectionAccount[];
  fromYear: number;
  toYear: number;
}): ProjectionPoint[] {
  const { accounts, fromYear, toYear } = params;
  if (toYear < fromYear) throw new Error("projectNetWorth: toYear must be >= fromYear");
  const span = toYear - fromYear;
  const youngestBirths = accounts.map((a) =>
    a.ownerBirthYears.length ? Math.max(...a.ownerBirthYears) : null,
  );
  // Each account's withdrawn balance series (offset 0..span).
  const series = accounts.map((a, i) => projectAccountSeries(a, span, fromYear, youngestBirths[i]));
  const points: ProjectionPoint[] = [];
  for (let offset = 0; offset <= span; offset++) {
    const year = fromYear + offset;
    let total = 0;
    let accessible = 0;
    accounts.forEach((a, i) => {
      const bal = series[i][offset];
      total += bal;
      const youngestBirth = youngestBirths[i];
      const age = youngestBirth === null ? Number.POSITIVE_INFINITY : year - youngestBirth;
      accessible += accessibleValueMinor(bal, age, a);
    });
    points.push({ year, totalBaseMinor: total, accessibleBaseMinor: accessible });
  }
  return points;
}

// Calendar years a person reaches each milestone age.
export function milestoneYears(
  birthYear: number,
  ages: number[] = [55, 62, 65],
): { age: number; year: number }[] {
  return ages.map((age) => ({ age, year: birthYear + age }));
}
