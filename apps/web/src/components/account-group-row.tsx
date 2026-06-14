import { GripVertical } from "lucide-react";
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
    <div
      className={cn(
        "flex w-full items-center gap-2 pl-2 pr-4 py-2.5 transition-colors",
        "bg-[color-mix(in_oklab,var(--color-primary)_6%,var(--color-card))]",
        isDragging && "opacity-50",
      )}
    >
      {dragHandleProps && (
        <span
          {...dragHandleProps}
          className="shrink-0 cursor-grab touch-none text-primary/50 transition-colors hover:text-primary active:cursor-grabbing"
          onClick={(e) => e.stopPropagation()}
          aria-label="Drag group"
        >
          <GripVertical size={14} />
        </span>
      )}

      <button
        onClick={onToggle}
        className="flex flex-1 items-center gap-3 text-left min-w-0"
      >
        <span
          className={cn(
            "text-[9px] text-primary transition-transform duration-150",
            expanded ? "rotate-90" : "rotate-0",
          )}
        >
          ▶
        </span>

        <span className="flex-1 truncate text-sm font-semibold text-primary">{name}</span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {memberCount} {memberCount === 1 ? "account" : "accounts"}
        </span>
        <span className="shrink-0 font-heading text-sm tabular-nums font-semibold text-primary">
          {formatMoney(subtotalMinor, baseCurrency)}
        </span>
      </button>
    </div>
  );
}
