import type { ContributionStream, PayoutStream } from "./projection";

// One goal's already-resolved routing into accounts. The caller (client) decides
// payoutAccountId (the goal's contributionAccountId, else its first assigned
// account) and the cutoff/start years (target year, or reach year for undated).
export type GoalFlowInput = {
  monthlyContributionMinor: number;
  contributionAccountId: string | null;
  contributionUntilYear: number | null;
  spendType: "none" | "once" | "monthly" | "percent";
  spendAmountMinor: number | null;
  spendRateBps: number | null;
  payoutStartYear: number | null;
  payoutAccountId: string | null;
};

export type AccountFlows = { contributions: ContributionStream[]; payouts: PayoutStream[] };

// Bucket goal contribution/payout streams by the account they touch. Goals with a
// zero contribution / no contributionAccountId, or spendType none / no payout
// account / no start year, contribute nothing.
export function deriveAccountFlows(goals: GoalFlowInput[]): Map<string, AccountFlows> {
  const out = new Map<string, AccountFlows>();
  const bucket = (id: string): AccountFlows => {
    const existing = out.get(id);
    if (existing) return existing;
    const fresh: AccountFlows = { contributions: [], payouts: [] };
    out.set(id, fresh);
    return fresh;
  };
  for (const g of goals) {
    if (g.monthlyContributionMinor > 0 && g.contributionAccountId) {
      bucket(g.contributionAccountId).contributions.push({
        monthlyMinor: g.monthlyContributionMinor,
        untilYear: g.contributionUntilYear,
      });
    }
    if (g.spendType !== "none" && g.payoutStartYear !== null && g.payoutAccountId) {
      bucket(g.payoutAccountId).payouts.push({
        spendType: g.spendType,
        spendAmountMinor: g.spendAmountMinor,
        spendRateBps: g.spendRateBps,
        startYear: g.payoutStartYear,
      });
    }
  }
  return out;
}
