import { useState } from "react";
import { GripVertical, MoreVertical } from "lucide-react";
import { formatMoney } from "@/components/money";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

type Props = {
  name: string;
  memberCount: number;
  subtotalMinor: number;
  baseCurrency: string;
  expanded: boolean;
  onToggle: () => void;
  onRename: (name: string) => void;
  onDelete: () => void;
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
  onRename,
  onDelete,
  dragHandleProps,
  isDragging,
}: Props) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(name);

  function startRename() {
    setDraft(name);
    setRenaming(true);
  }

  function commitRename() {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== name) onRename(trimmed);
    setRenaming(false);
  }

  return (
    <div
      className={cn(
        "flex w-full items-center gap-2 pl-2 pr-2 py-2.5 transition-colors",
        "bg-[color-mix(in_oklab,var(--color-primary)_6%,var(--color-card))]",
        isDragging && "opacity-50",
      )}
    >
      {dragHandleProps && (
        <span
          {...dragHandleProps}
          className="shrink-0 cursor-grab touch-none text-primary/50 transition-colors hover:text-primary active:cursor-grabbing"
          aria-label="Drag group"
        >
          <GripVertical size={14} />
        </span>
      )}

      {renaming ? (
        <div className="flex flex-1 items-center gap-2 min-w-0">
          <Input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename();
              if (e.key === "Escape") setRenaming(false);
            }}
            className="h-7 text-sm"
          />
        </div>
      ) : (
        <button onClick={onToggle} className="flex flex-1 cursor-pointer items-center gap-3 text-left min-w-0">
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
      )}

      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              aria-label="Group actions"
              className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            />
          }
        >
          <MoreVertical size={15} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={startRename}>Rename</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={onDelete}>
            Delete group
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
