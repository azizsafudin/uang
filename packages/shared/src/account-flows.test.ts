import { expect, test } from "bun:test";
import { deriveAccountFlows, type GoalFlowInput } from "./account-flows";

test("routes a goal's monthly contribution to its contributionAccountId until its cutoff year", () => {
  const goals: GoalFlowInput[] = [
    { monthlyContributionMinor: 1_000, contributionAccountId: "isa", contributionUntilYear: 2030,
      spendType: "none", spendAmountMinor: null, spendRateBps: null, payoutStartYear: null, payoutAccountId: null },
  ];
  const flows = deriveAccountFlows(goals);
  expect(flows.get("isa")?.contributions).toEqual([{ monthlyMinor: 1_000, untilYear: 2030 }]);
  expect(flows.get("isa")?.payouts).toEqual([]);
});

test("routes a goal's payout to its payoutAccountId from payoutStartYear", () => {
  const goals: GoalFlowInput[] = [
    { monthlyContributionMinor: 0, contributionAccountId: null, contributionUntilYear: null,
      spendType: "monthly", spendAmountMinor: 4_000, spendRateBps: null, payoutStartYear: 2045, payoutAccountId: "pension" },
  ];
  const flows = deriveAccountFlows(goals);
  expect(flows.get("pension")?.payouts).toEqual([
    { spendType: "monthly", spendAmountMinor: 4_000, spendRateBps: null, startYear: 2045 },
  ]);
});

test("multiple goals stack streams on a shared account", () => {
  const goals: GoalFlowInput[] = [
    { monthlyContributionMinor: 500, contributionAccountId: "chk", contributionUntilYear: 2028,
      spendType: "none", spendAmountMinor: null, spendRateBps: null, payoutStartYear: null, payoutAccountId: null },
    { monthlyContributionMinor: 300, contributionAccountId: "chk", contributionUntilYear: 2030,
      spendType: "none", spendAmountMinor: null, spendRateBps: null, payoutStartYear: null, payoutAccountId: null },
  ];
  const flows = deriveAccountFlows(goals);
  expect(flows.get("chk")?.contributions).toEqual([
    { monthlyMinor: 500, untilYear: 2028 },
    { monthlyMinor: 300, untilYear: 2030 },
  ]);
});

test("ignores zero contributions, none-spend, and unrouted flows", () => {
  const goals: GoalFlowInput[] = [
    { monthlyContributionMinor: 0, contributionAccountId: "isa", contributionUntilYear: 2030,
      spendType: "none", spendAmountMinor: null, spendRateBps: null, payoutStartYear: null, payoutAccountId: null },
    { monthlyContributionMinor: 1_000, contributionAccountId: null, contributionUntilYear: 2030,
      spendType: "monthly", spendAmountMinor: 9, spendRateBps: null, payoutStartYear: 2040, payoutAccountId: null },
  ];
  const flows = deriveAccountFlows(goals);
  expect(flows.size).toBe(0);
});
