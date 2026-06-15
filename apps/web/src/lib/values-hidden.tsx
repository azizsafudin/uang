export const MASK = "••••••";

// Pure masking gate: returns the placeholder when values are hidden,
// otherwise the already-formatted money string. Kept pure + JSX-free so it
// is unit-testable under `bun test`.
export function maskMoney(formatted: string, hidden: boolean): string {
  return hidden ? MASK : formatted;
}
