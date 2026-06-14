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

// Instrument kinds, humanized (used for position badges).
export const INSTRUMENT_KIND_LABELS: Record<string, string> = {
  currency: "Cash", stock: "Stock", etf: "ETF", fund: "Fund", crypto: "Crypto", other: "Other",
};

export const instrumentKindLabel = (k: string): string => INSTRUMENT_KIND_LABELS[k] ?? k;
