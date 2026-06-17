import { useEffect, useRef, useState } from "react";
import { formatMoney } from "./money.ts";
import { maskMoney, useValuesHidden } from "@/lib/values-hidden";
import { cn } from "@/lib/utils";

// One physical wheel of an odometer: a vertical strip 0-9 (with a trailing 0 so
// the 9→0 wrap reads continuously) translated so `displayed` sits in the window.
// `displayed` is a real number in [0, 10); the fractional part is mid-roll.
const STRIP = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0];

function DigitWheel({ displayed }: { displayed: number }) {
  return (
    <span
      className="relative inline-block overflow-hidden align-bottom"
      style={{ height: "1em", lineHeight: 1 }}
      aria-hidden
    >
      {/* invisible glyph reserves the (tabular) digit width */}
      <span className="invisible">0</span>
      <span
        className="absolute left-0 top-0 flex flex-col"
        style={{ transform: `translateY(${-displayed}em)`, lineHeight: 1 }}
      >
        {STRIP.map((d, i) => (
          <span key={i} style={{ height: "1em" }}>
            {d}
          </span>
        ))}
      </span>
    </span>
  );
}

const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;
const DURATION_MS = 1100;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

// Renders a currency amount as a mechanical odometer that counts up to the value:
// each digit wheel rolls and settles on its final digit, lower places spinning
// faster than higher ones. Honors the app-wide value-privacy toggle (shows the
// mask, unanimated) and prefers-reduced-motion (snaps straight to the value).
export function OdometerMoney({
  minor,
  currency,
  className,
}: {
  minor: number;
  currency: string;
  className?: string;
}) {
  const { hidden } = useValuesHidden();
  const formatted = formatMoney(minor, currency);
  const absMinor = Math.abs(Math.round(minor));

  // `progress` drives every wheel; 0 = all wheels at zero, 1 = settled on value.
  const [progress, setProgress] = useState(1);
  const frame = useRef<number | null>(null);

  useEffect(() => {
    if (hidden || prefersReducedMotion()) {
      setProgress(1);
      return;
    }
    setProgress(0);
    let start: number | null = null;
    const tick = (now: number) => {
      if (start === null) start = now;
      const t = Math.min(1, (now - start) / DURATION_MS);
      setProgress(t);
      if (t < 1) frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    };
  }, [absMinor, hidden]);

  if (hidden) {
    return <span className={cn("tabular-nums", className)}>{maskMoney(formatted, true)}</span>;
  }

  const eased = easeOutCubic(progress);
  // Count digit chars remaining to the right of each position → that digit's
  // place exponent in minor units. A wheel at place e rolls through
  // floor(absMinor / 10^e) detents, so it lands exactly on its digit at t=1.
  const chars = formatted.split("");
  let digitsToRight = chars.filter((c) => c >= "0" && c <= "9").length;

  return (
    <span className={cn("inline-flex items-stretch tabular-nums", className)}>
      {/* Real value for assistive tech, copy-paste, and text-based tests; the
          animated wheels below are aria-hidden and carry no meaningful text. */}
      <span className="sr-only">{formatted}</span>
      {chars.map((ch, i) => {
        if (ch < "0" || ch > "9") {
          return (
            <span key={i} aria-hidden style={{ lineHeight: 1 }}>
              {ch}
            </span>
          );
        }
        digitsToRight -= 1;
        const detents = Math.floor(absMinor / 10 ** digitsToRight);
        const displayed = (eased * detents) % 10;
        return <DigitWheel key={i} displayed={displayed} />;
      })}
    </span>
  );
}
