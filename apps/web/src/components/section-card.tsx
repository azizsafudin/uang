import { Pencil, X } from "lucide-react";
import { cn } from "@/lib/utils";

// A titled card with an inline edit toggle, used for the editable Details sections.
// The header echoes the Eyebrow signature (brass rule + uppercase label) for a
// lighter, on-brand look than a filled band.
export function SectionCard({
  title,
  editing,
  onToggle,
  children,
}: {
  title: string;
  editing: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-2.5">
          <span className="h-px w-4 shrink-0 bg-gold/70" />
          <span className="text-[0.7rem] font-medium uppercase tracking-[0.14em] text-muted-foreground">
            {title}
          </span>
        </div>
        <button
          type="button"
          onClick={onToggle}
          aria-label={editing ? "Cancel editing" : `Edit ${title.toLowerCase()}`}
          title={editing ? "Cancel editing" : `Edit ${title.toLowerCase()}`}
          className={cn(
            "flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
            editing && "bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground",
          )}
        >
          {editing ? <X size={13} /> : <Pencil size={13} />}
        </button>
      </div>
      {children}
    </div>
  );
}
