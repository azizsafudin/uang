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
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { GROUP_COLORS, resolveGroupColor } from "@/lib/group-colors";

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
  /** Stored palette key for this group, or null for the default appearance. */
  color?: string | null;
  /** Persist a new color key (or null to clear). Omitted for owner buckets. */
  onSetColor?: (color: string | null) => void;
  dragHandleProps?: React.HTMLAttributes<HTMLElement>;
  // When true, the whole header is the drag handle (reorder mode) rather than
  // just the grip icon.
  dragWholeRow?: boolean;
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
  color,
  onSetColor,
  dragHandleProps,
  dragWholeRow,
  isDragging,
}: Props) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(name);
  const accent = resolveGroupColor(color);

  function startRename() {
    setDraft(name);
    setRenaming(true);
  }

  function commitRename() {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== name) onRename?.(trimmed);
    setRenaming(false);
  }

  const hasMenu = Boolean(onRename || onDelete || onAddAccount || onSetColor);
  const wholeRowDrag = Boolean(dragWholeRow && dragHandleProps);

  const row = (
    <div
      {...(wholeRowDrag ? dragHandleProps : {})}
      style={accent ? ({ "--group-accent": accent } as React.CSSProperties) : undefined}
      className={cn(
        "flex w-full items-center gap-2 pl-2 pr-2 py-2.5 transition-colors",
        accent
          ? "bg-[color-mix(in_oklab,var(--group-accent)_8%,var(--color-card))]"
          : "bg-[color-mix(in_oklab,var(--color-primary)_6%,var(--color-card))]",
        wholeRowDrag && "cursor-grab touch-none active:cursor-grabbing",
        isDragging && "opacity-50",
      )}
    >
      {dragHandleProps && (
        <span
          {...(wholeRowDrag ? {} : dragHandleProps)}
          style={accent ? ({ color: "var(--group-accent)" } as React.CSSProperties) : undefined}
          className={cn(
            "shrink-0 transition-colors",
            accent ? "opacity-50" : "text-primary/50",
            !wholeRowDrag &&
              (accent
                ? "cursor-grab touch-none hover:opacity-100 active:cursor-grabbing"
                : "cursor-grab touch-none hover:text-primary active:cursor-grabbing"),
          )}
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
            style={accent ? ({ color: "var(--group-accent)" } as React.CSSProperties) : undefined}
            className={cn(
              "text-[9px] transition-transform duration-150",
              accent ? "" : "text-primary",
              expanded ? "rotate-90" : "rotate-0",
            )}
          >
            ▶
          </span>

          <span
            style={accent ? ({ color: "var(--group-accent)" } as React.CSSProperties) : undefined}
            className={cn("flex-1 truncate text-sm font-semibold", accent ? "" : "text-primary")}
          >
            {name}
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">
            {memberCount} {memberCount === 1 ? "account" : "accounts"}
          </span>
          <span
            style={accent ? ({ color: "var(--group-accent)" } as React.CSSProperties) : undefined}
            className={cn(
              "shrink-0 font-heading text-sm tabular-nums font-semibold",
              accent ? "" : "text-primary",
            )}
          >
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
        {onAddAccount && (onRename || onDelete || onSetColor) && <ContextMenuSeparator />}
        {onRename && <ContextMenuItem onClick={startRename}>Rename</ContextMenuItem>}
        {onSetColor && (
          <ContextMenuSub>
            <ContextMenuSubTrigger>Set color</ContextMenuSubTrigger>
            <ContextMenuSubContent className="grid grid-cols-6 gap-1 p-1">
              {GROUP_COLORS.map((c) => (
                <ContextMenuItem
                  key={c.key}
                  onClick={() => onSetColor(c.key)}
                  title={c.label}
                  aria-label={c.label}
                  className="flex h-7 w-7 items-center justify-center p-0"
                >
                  <span
                    style={{ backgroundColor: c.base }}
                    className={cn(
                      "h-4 w-4 rounded-full ring-1 ring-black/10",
                      color === c.key && "ring-2 ring-offset-1 ring-foreground",
                    )}
                  />
                </ContextMenuItem>
              ))}
              <ContextMenuItem
                onClick={() => onSetColor(null)}
                title="Default"
                aria-label="Default color"
                className="col-span-6 justify-center text-xs"
              >
                ⊘ Default
              </ContextMenuItem>
            </ContextMenuSubContent>
          </ContextMenuSub>
        )}
        {(onRename || onSetColor) && onDelete && <ContextMenuSeparator />}
        {onDelete && (
          <ContextMenuItem variant="destructive" onClick={onDelete}>
            Delete group
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
