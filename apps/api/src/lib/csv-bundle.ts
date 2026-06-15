import {
  accounts,
  groups,
  transactions,
  instruments,
  goals,
  settings,
  user,
} from "../db/schema";
import { db } from "../db/client";
import { accountPositions } from "./positions";
import { toCsv, minorToDecimal, scaledToDecimal } from "./csv-export";

// Builds the readable CSV bundle: filename -> CSV text. Values are denormalised
// (names instead of IDs) and decimalised. No market data (prices/fx) by design.
export async function buildCsvBundle(): Promise<Record<string, string>> {
  const [acctRows, groupRows, txRows, instRows, goalRows, settingRows, userRows] =
    await Promise.all([
      db.select().from(accounts),
      db.select().from(groups),
      db.select().from(transactions),
      db.select().from(instruments),
      db.select().from(goals),
      db.select().from(settings),
      db.select().from(user),
    ]);

  const groupName = new Map(groupRows.map((g) => [g.id, g.name]));
  const acctById = new Map(acctRows.map((a) => [a.id, a]));
  const instById = new Map(instRows.map((i) => [i.id, i]));
  const userName = new Map(userRows.map((u) => [u.id, u.name]));

  const accountsCsv = toCsv(
    [
      "name",
      "class",
      "subtype",
      "currency",
      "institution",
      "group",
      "archived",
      "growth_rate_pct",
      "accessible_from_age",
      "early_withdrawal",
      "illiquid",
      "liquidation_age",
    ],
    acctRows.map((a) => [
      a.name,
      a.class,
      a.subtype,
      a.currency,
      a.institution ?? "",
      a.groupId ? groupName.get(a.groupId) ?? "" : "",
      a.isArchived ? "true" : "false",
      String(a.growthRateBps / 100),
      String(a.accessibleFromAge),
      a.earlyWithdrawal,
      a.illiquid ? "true" : "false",
      a.liquidationAge === null ? "" : String(a.liquidationAge),
    ]),
  );

  const transactionsCsv = toCsv(
    [
      "date",
      "account",
      "instrument_symbol",
      "instrument_name",
      "units",
      "unit_price",
      "fees",
      "notes",
    ],
    txRows.map((t) => {
      const acct = acctById.get(t.accountId);
      const inst = instById.get(t.instrumentId);
      return [
        t.date,
        acct?.name ?? "",
        inst?.symbol ?? "",
        inst?.name ?? "",
        scaledToDecimal(t.unitsDelta),
        t.unitPriceScaled === null ? "" : scaledToDecimal(t.unitPriceScaled),
        acct ? minorToDecimal(t.feesMinor, acct.currency) : String(t.feesMinor),
        t.notes ?? "",
      ];
    }),
  );

  const holdingsRows: (string | number | null)[][] = [];
  for (const a of acctRows) {
    const positions = await accountPositions(a.id);
    for (const p of positions) {
      holdingsRows.push([
        a.name,
        p.instrument.symbol ?? "",
        p.instrument.name,
        scaledToDecimal(p.units),
        p.missingPrice
          ? ""
          : minorToDecimal(p.marketValueMinor, p.instrumentCurrency),
        p.instrumentCurrency,
      ]);
    }
  }
  const holdingsCsv = toCsv(
    [
      "account",
      "instrument_symbol",
      "instrument_name",
      "units",
      "current_value",
      "currency",
    ],
    holdingsRows,
  );

  const goalsCsv = toCsv(
    [
      "name",
      "target_amount",
      "currency",
      "target_date",
      "monthly_contribution",
      "owner",
      "spend_type",
      "spend_amount",
      "spend_rate_pct",
    ],
    goalRows.map((g) => [
      g.name,
      minorToDecimal(g.targetAmountMinor, g.currency),
      g.currency,
      g.targetDate ?? "",
      minorToDecimal(g.monthlyContributionMinor, g.currency),
      g.ownerScope === "household"
        ? "household"
        : userName.get(g.ownerScope) ?? g.ownerScope,
      g.spendType,
      g.spendAmountMinor === null
        ? ""
        : minorToDecimal(g.spendAmountMinor, g.currency),
      g.spendRateBps === null ? "" : String(g.spendRateBps / 100),
    ]),
  );

  const s = settingRows[0];
  const settingsCsv = toCsv(
    [
      "household_name",
      "base_currency",
      "contribution_growth_rate_pct",
      "projection_end_age",
    ],
    s
      ? [
          [
            s.householdName,
            s.baseCurrency,
            String(s.contributionGrowthRateBps / 100),
            String(s.projectionEndAge),
          ],
        ]
      : [],
  );

  return {
    "accounts.csv": accountsCsv,
    "transactions.csv": transactionsCsv,
    "holdings.csv": holdingsCsv,
    "goals.csv": goalsCsv,
    "settings.csv": settingsCsv,
  };
}
