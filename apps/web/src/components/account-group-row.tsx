import { useState } from "react";
import { GripVertical } from "lucide-react";
import { Money } from "@/components/money.tsx";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";

type Props = {
  name: string;
  memberCount: number;
  subtotalMinor: number;
  baseCurrency: string;
  expanded: boolean;
  onToggle: () => void;
  onRename?: (name: string) => void;
  onDelete?: () => void;
  onAddAccount?: () => void;
  addAccountLabel?: string;
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
  onAddAccount,
  addAccountLabel = "Add account to this group",
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
    if (trimmed && trimmed !== name) onRename?.(trimmed);
    setRenaming(false);
  }

  const hasMenu = Boolean(onRename || onDelete || onAddAccount);

  const row = (
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
            <Money minor={subtotalMinor} currency={baseCurrency} />
          </span>
        </button>
      )}

    </div>
  );

  if (!hasMenu) return row;

  return (
    <ContextMenu>
      <ContextMenuTrigger render={row} />
      <ContextMenuContent>
        {onAddAccount && (
          <ContextMenuItem onClick={onAddAccount}>{addAccountLabel}</ContextMenuItem>
        )}
        {onAddAccount && (onRename || onDelete) && <ContextMenuSeparator />}
        {onRename && <ContextMenuItem onClick={startRename}>Rename</ContextMenuItem>}
        {onRename && onDelete && <ContextMenuSeparator />}
        {onDelete && (
          <ContextMenuItem variant="destructive" onClick={onDelete}>
            Delete group
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
