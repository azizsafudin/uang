import type { EarlyWithdrawal } from "@uang/shared";

export type Assumptions = {
  growthRateBps: number;
  accessibleFromAge: number;
  earlyWithdrawal: EarlyWithdrawal;
  earlyHaircutBps: number;
  illiquid: boolean;
  liquidationAge: number | null;
};

// Sensible starting points; every field is editable per account afterwards.
export function defaultAssumptions(subtype: string): Assumptions {
  const base: Assumptions = {
    growthRateBps: 0, accessibleFromAge: 0, earlyWithdrawal: "none",
    earlyHaircutBps: 0, illiquid: false, liquidationAge: null,
  };
  switch (subtype) {
    case "investment": return { ...base, growthRateBps: 800 };
    case "property": return { ...base, growthRateBps: 300, illiquid: true };
    default: return base; // cash, bank, loan, credit_card, other
  }
}
