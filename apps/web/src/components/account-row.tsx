import { Link } from "@tanstack/react-router";
import { GripVertical } from "lucide-react";
import { Money } from "@/components/money.tsx";
import { subtypeLabel } from "@/components/labels";
import { OwnerPills } from "@/components/owner-pills";
import { cn } from "@/lib/utils";

type Account = {
  id: string;
  name: string;
  subtype: string;
  currency: string;
  balanceMinor: number;
  baseMinor: number;
  missingRate: boolean;
  class: string;
  ownerIds: string[];
};

type Props = {
  account: Account;
  baseCurrency: string;
  isLast: boolean;
  dragHandleProps?: React.HTMLAttributes<HTMLElement>;
  // When true, the whole row is the drag handle (reorder mode) and navigation
  // is suppressed so dragging doesn't open the account.
  dragWholeRow?: boolean;
  isDragging?: boolean;
  // When provided, the row is a button that calls this (e.g. open an edit dialog)
  // instead of linking to the account detail page.
  onSelect?: () => void;
  // When provided, replaces the right-hand balance block (e.g. show projection
  // config instead of the account value on the /projections page).
  trailing?: React.ReactNode;
};

function initials(name: string) {
  const words = name.trim().split(/\s+/);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

function iconClass(cls: string, subtype: string) {
  if (cls === "liability") return "bg-destructive/10 text-destructive";
  if (subtype === "investment") return "bg-gold/10 text-gold";
  return "bg-primary/10 text-primary";
}

export function AccountRow({
  account,
  baseCurrency,
  isLast,
  dragHandleProps,
  dragWholeRow,
  isDragging,
  onSelect,
  trailing,
}: Props) {
  const inner = (
    <>
      <div
        className={cn(
          "flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[10px] font-bold",
          iconClass(account.class, account.subtype),
        )}
      >
        {initials(account.name)}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <p className="truncate text-sm font-medium">{account.name}</p>
          <OwnerPills ownerIds={account.ownerIds} />
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
          <span>
            {subtypeLabel(account.subtype)} · {account.currency}
          </span>
          {account.missingRate && (
            <span className="rounded-full bg-destructive/10 px-1.5 py-0.5 text-[0.65rem] font-medium text-destructive">
              no FX rate
            </span>
          )}
        </div>
      </div>

      {trailing !== undefined ? (
        <div className="shrink-0 text-right">{trailing}</div>
      ) : (
        <div className="shrink-0 text-right tabular-nums">
          <p className={cn("text-sm font-medium", account.balanceMinor < 0 && "text-destructive")}>
            <Money minor={account.balanceMinor} currency={account.currency} />
          </p>
          {account.currency !== baseCurrency && !account.missingRate && (
            <p className="text-xs text-muted-foreground">
              <Money minor={account.baseMinor} currency={baseCurrency} />
            </p>
          )}
        </div>
      )}
    </>
  );

  const innerClass = "flex flex-1 items-center gap-3 min-w-0";
  const wholeRowDrag = Boolean(dragWholeRow && dragHandleProps);

  return (
    <div
      data-testid="account-row"
      {...(wholeRowDrag ? dragHandleProps : {})}
      className={cn(
        "group relative flex items-center gap-2 pl-2 pr-4 py-3 transition-colors hover:bg-accent",
        !isLast && "border-b border-border/70",
        wholeRowDrag && "cursor-grab touch-none active:cursor-grabbing",
        isDragging && "opacity-50",
      )}
    >
      {dragHandleProps && (
        <span
          {...(wholeRowDrag ? {} : dragHandleProps)}
          className={cn(
            "shrink-0 text-muted-foreground/40 transition-colors",
            !wholeRowDrag &&
              "cursor-grab touch-none hover:text-muted-foreground active:cursor-grabbing",
          )}
          aria-label="Drag to reorder"
        >
          <GripVertical size={14} />
        </span>
      )}

      {wholeRowDrag ? (
        <div className={innerClass}>{inner}</div>
      ) : onSelect ? (
        <button type="button" onClick={onSelect} className={cn(innerClass, "text-left")}>
          {inner}
        </button>
      ) : (
        <Link to="/accounts/$id" params={{ id: account.id }} className={innerClass}>
          {inner}
        </Link>
      )}
    </div>
  );
}
