import { formatMoney } from "./money.ts";
import { maskMoney, useValuesHidden } from "@/lib/values-hidden";

export { formatMoney } from "./money.ts";

// Renders an integer minor-unit amount as currency, honoring the app-wide
// value-privacy toggle. Use this everywhere money is shown in JSX.
export function Money({ minor, currency }: { minor: number; currency: string }) {
  const { hidden } = useValuesHidden();
  return <span className="tabular-nums">{maskMoney(formatMoney(minor, currency), hidden)}</span>;
}
