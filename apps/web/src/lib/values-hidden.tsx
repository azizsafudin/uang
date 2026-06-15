import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { formatMoney } from "../components/money.ts";

export const MASK = "••••••";

// Pure masking gate: returns the placeholder when values are hidden,
// otherwise the already-formatted money string. Kept pure + JSX-free so it
// is unit-testable under `bun test`.
export function maskMoney(formatted: string, hidden: boolean): string {
  return hidden ? MASK : formatted;
}

const STORAGE_KEY = "uang.valuesHidden";

type ValuesHiddenContextValue = {
  hidden: boolean;
  toggle: () => void;
  setHidden: (v: boolean) => void;
};

const ValuesHiddenContext = createContext<ValuesHiddenContextValue | null>(null);

function readInitial(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(STORAGE_KEY) === "1";
}

export function ValuesHiddenProvider({ children }: { children: React.ReactNode }) {
  const [hidden, setHidden] = useState<boolean>(readInitial);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(STORAGE_KEY, hidden ? "1" : "0");
  }, [hidden]);

  const toggle = useCallback(() => setHidden((h) => !h), []);
  const value = useMemo(() => ({ hidden, toggle, setHidden }), [hidden, toggle]);

  return <ValuesHiddenContext.Provider value={value}>{children}</ValuesHiddenContext.Provider>;
}

export function useValuesHidden(): ValuesHiddenContextValue {
  const ctx = useContext(ValuesHiddenContext);
  if (!ctx) throw new Error("useValuesHidden must be used within ValuesHiddenProvider");
  return ctx;
}

// String formatter for non-JSX call sites (chart tooltips, concatenated
// subtitles). Honors the privacy toggle.
export function useMoney(): (minor: number, currency: string) => string {
  const { hidden } = useValuesHidden();
  return useCallback(
    (minor: number, currency: string) => maskMoney(formatMoney(minor, currency), hidden),
    [hidden],
  );
}
