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

// Fixed monthly payment (minor units, positive) that amortizes an outstanding
// loan `balanceMinor` (magnitude; sign ignored) to zero over `termMonths` at
// `annualRateBps` annual interest. Returns 0 when there is no term.
export function loanMonthlyPaymentMinor(
  balanceMinor: number,
  annualRateBps: number,
  termMonths: number,
): number {
  if (termMonths <= 0) return 0;
  const principal = Math.abs(balanceMinor);
  if (principal === 0) return 0;
  if (annualRateBps === 0) return Math.round(principal / termMonths);
  const r = annualRateBps / 120_000; // monthly rate fraction (bps / 10_000 / 12)
  const payment = (principal * r) / (1 - Math.pow(1 + r, -termMonths));
  return Math.round(payment);
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

export type CompoundInterval = "monthly" | "quarterly" | "annually";

function periodsPerYear(interval: CompoundInterval): number {
  return interval === "monthly" ? 12 : interval === "quarterly" ? 4 : 1;
}

// A monthly saving stream into an account, running until `untilYear` inclusive
// (null = the whole projection). Multiple goals may contribute to one account.
export type ContributionStream = {
  monthlyMinor: number;
  untilYear: number | null;
};

// A drawdown stream out of an account, beginning in `startYear`. Multiple goals
// may draw from one account.
export type PayoutStream = {
  spendType: "once" | "monthly" | "percent";
  spendAmountMinor: number | null; // 'once' lump / 'monthly' per-month
  spendRateBps: number | null;     // 'percent' annual % of balance
  startYear: number;
};

export type ProjectionAccount = AccessibilityConfig & {
  baseMinor: number;       // current base-currency balance (signed; negative for debt)
  growthRateBps: number;   // assets: growth rate; liabilities: annual loan interest rate
  ownerBirthYears: number[]; // owners' birth years; empty = unknown
  isLiability: boolean;    // true => amortize as a loan instead of accumulate/withdraw
  loanTermMonths: number | null;
  compoundInterval: CompoundInterval;
  contributions: ContributionStream[];
  payouts: PayoutStream[];
};

export type ProjectionPoint = {
  year: number;
  totalBaseMinor: number;
  accessibleBaseMinor: number;
};

// Year-by-year outstanding balance (negative) for a loan, amortized monthly and
// sampled at each year end. Offset 0 is today's balance. With no term (or a
// non-negative balance) the balance is held flat across the whole span.
function amortizeLoanSeries(account: ProjectionAccount, span: number): number[] {
  const start = toBig(account.baseMinor);
  const term = account.loanTermMonths ?? 0;
  // No term, or not actually a debt: hold flat.
  if (term <= 0 || start >= 0n) {
    return Array.from({ length: span + 1 }, () => fromBig(start));
  }
  const payment = toBig(loanMonthlyPaymentMinor(account.baseMinor, account.growthRateBps, term));
  const rateBps = toBig(account.growthRateBps);
  let owed = -start; // positive outstanding magnitude
  const out: number[] = [fromBig(start)];
  let month = 0;
  for (let year = 1; year <= span; year++) {
    for (let m = 0; m < 12; m++) {
      month++;
      if (owed <= 0n || month > term) {
        owed = 0n;
        continue;
      }
      if (month === term) {
        owed = 0n; // final payment clears the remainder exactly
        continue;
      }
      const interest = roundDiv(owed * rateBps, 120_000n); // owed * (rate/12)
      let principalPaid = payment - interest;
      if (principalPaid < 0n) principalPaid = 0n; // guard; formula keeps this positive
      owed = principalPaid >= owed ? 0n : owed - principalPaid;
    }
    out.push(fromBig(-owed));
  }
  return out;
}

// Year-by-year balance for one account: accumulate (contribution streams + growth,
// compounded at the chosen interval), then apply payout streams. Offset 0 is today's
// balance, untouched. Each later year runs `n` sub-periods (n = 12/4/1 for monthly/
// quarterly/annually); each sub-period adds that period's share of the total monthly
// contributions then grows by rate/n. Contributions run until their respective
// untilYear (null = whole projection). Payouts are applied once per year after
// accumulation; they never push a balance below 0.
export function projectAccountSeries(
  account: ProjectionAccount,
  span: number,
  fromYear: number,
  youngestBirthYear: number | null,
): number[] {
  assertYears(span);
  if (account.isLiability) return amortizeLoanSeries(account, span);
  const n = periodsPerYear(account.compoundInterval);
  const periods = BigInt(n);
  const denom = BPS * periods;
  const numer = denom + toBig(account.growthRateBps);
  const monthsPerPeriod = BigInt(12 / n);
  let b = toBig(account.baseMinor);
  const out: number[] = [fromBig(b)];
  const onceFired = account.payouts.map(() => false);
  for (let offset = 1; offset <= span; offset++) {
    const year = fromYear + offset;

    let monthlyTotal = 0n;
    for (const c of account.contributions) {
      if (c.untilYear === null || year <= c.untilYear) monthlyTotal += toBig(c.monthlyMinor);
    }
    const contribPerPeriod = monthlyTotal * monthsPerPeriod;
    for (let p = 0; p < n; p++) {
      b = roundDiv((b + contribPerPeriod) * numer, denom);
    }

    for (let i = 0; i < account.payouts.length; i++) {
      const pay = account.payouts[i];
      if (year < pay.startYear || b <= 0n) continue;
      if (pay.spendType === "once") {
        if (!onceFired[i]) {
          const amt = toBig(pay.spendAmountMinor ?? 0);
          b = amt > b ? 0n : b - amt;
          onceFired[i] = true;
        }
      } else if (pay.spendType === "monthly") {
        const amt = toBig(pay.spendAmountMinor ?? 0) * 12n;
        b = amt > b ? 0n : b - amt;
      } else if (pay.spendType === "percent") {
        const wd = roundDiv(b * toBig(pay.spendRateBps ?? 0), BPS);
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
