import { Link } from "@tanstack/react-router";
import { formatMoney } from "@/components/money";
import { subtypeLabel } from "@/components/labels";
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
};

type Props = {
  account: Account;
  baseCurrency: string;
  isLast: boolean;
  dragHandleProps?: React.HTMLAttributes<HTMLSpanElement>;
  isDragging?: boolean;
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

export function AccountRow({ account, baseCurrency, isLast, dragHandleProps, isDragging }: Props) {
  return (
    <div
      data-testid="account-row"
      className={cn(
        "group relative flex items-center gap-3 px-4 py-3 transition-colors hover:bg-accent",
        !isLast && "border-b border-border/70",
        isDragging && "opacity-50",
      )}
    >
      {dragHandleProps && (
        <span
          {...dragHandleProps}
          className="absolute left-1 top-1/2 -translate-y-1/2 cursor-grab touch-none text-border opacity-0 transition-opacity group-hover:opacity-100 active:cursor-grabbing"
          aria-label="Drag to reorder"
        >
          ⠿
        </span>
      )}

      <Link
        to="/accounts/$id"
        params={{ id: account.id }}
        className="flex flex-1 items-center gap-3 min-w-0"
      >
        <div
          className={cn(
            "flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[10px] font-bold",
            iconClass(account.class, account.subtype),
          )}
        >
          {initials(account.name)}
        </div>

        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{account.name}</p>
          <p className="text-xs text-muted-foreground">
            {subtypeLabel(account.subtype)} · {account.currency}
            {account.missingRate && (
              <span className="ml-1.5 rounded-full bg-destructive/10 px-1.5 py-0.5 text-[0.65rem] font-medium text-destructive">
                no FX rate
              </span>
            )}
          </p>
        </div>

        <div className="shrink-0 text-right tabular-nums">
          <p className={cn("text-sm font-medium", account.balanceMinor < 0 && "text-destructive")}>
            {formatMoney(account.balanceMinor, account.currency)}
          </p>
          {account.currency !== baseCurrency && !account.missingRate && (
            <p className="text-xs text-muted-foreground">
              {formatMoney(account.baseMinor, baseCurrency)}
            </p>
          )}
        </div>
      </Link>
    </div>
  );
}
