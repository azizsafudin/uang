// Human-readable labels for account enums (UI never shows raw enum values).
export const SUBTYPE_LABELS: Record<string, string> = {
  cash: "Cash",
  bank: "Bank",
  investment: "Investments",
  property: "Property",
  loan: "Loan",
  credit_card: "Credit card",
  other: "Other",
};

export const SUBTYPES = Object.keys(SUBTYPE_LABELS);

export const subtypeLabel = (s: string): string => SUBTYPE_LABELS[s] ?? s;

export const classLabel = (c: string): string =>
  c === "liability" ? "Liability" : "Asset";

// Ledger entry kinds, humanized.
export const KIND_LABELS: Record<string, string> = {
  opening: "Opening balance",
  adjustment: "Balance adjustment",
  revaluation: "Revaluation",
  transaction: "Transaction",
};

export const kindLabel = (k: string): string => KIND_LABELS[k] ?? k;
