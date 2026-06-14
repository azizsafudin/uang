import { formatMoney } from "@/components/money";
import { cn } from "@/lib/utils";

type Props = {
  name: string;
  memberCount: number;
  subtotalMinor: number;
  baseCurrency: string;
  expanded: boolean;
  onToggle: () => void;
  dragHandleProps?: React.HTMLAttributes<HTMLSpanElement>;
  isDragging?: boolean;
};

export function AccountGroupRow({
  name,
  memberCount,
  subtotalMinor,
  baseCurrency,
  expanded,
  onToggle,
  dragHandleProps,
  isDragging,
}: Props) {
  return (
    <button
      onClick={onToggle}
      className={cn(
        "group relative flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors",
        "border-b border-border/70 last:border-b-0",
        "bg-[color-mix(in_oklab,var(--color-primary)_6%,var(--color-card))]",
        "hover:bg-[color-mix(in_oklab,var(--color-primary)_10%,var(--color-card))]",
        isDragging && "opacity-50",
      )}
    >
      {dragHandleProps && (
        <span
          {...dragHandleProps}
          className="absolute left-1 top-1/2 -translate-y-1/2 cursor-grab touch-none text-border opacity-0 transition-opacity group-hover:opacity-100 active:cursor-grabbing"
          onClick={(e) => e.stopPropagation()}
          aria-label="Drag to reorder"
        >
          ⠿
        </span>
      )}

      <span
        className={cn(
          "text-[9px] text-primary transition-transform duration-150",
          expanded ? "rotate-90" : "rotate-0",
        )}
      >
        ▶
      </span>

      <span className="flex-1 text-sm font-semibold text-primary">{name}</span>
      <span className="text-xs text-muted-foreground">
        {memberCount} {memberCount === 1 ? "account" : "accounts"}
      </span>
      <span className="font-heading text-sm tabular-nums font-semibold text-primary">
        {formatMoney(subtotalMinor, baseCurrency)}
      </span>
    </button>
  );
}
