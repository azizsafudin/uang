import { cn } from "@/lib/utils";

// Content column for every signed-in page. The sidebar + chrome live in the
// layout route; this just sets the width and an optional page-header actions row.
export function AppShell({
  actions,
  children,
}: {
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto w-full max-w-5xl px-5 py-8 md:px-6 md:py-10">
      {actions ? (
        <div className="mb-6 flex items-center justify-end gap-1.5">{actions}</div>
      ) : null}
      {children}
    </div>
  );
}

// The signature device: a short brass ledger-rule before an uppercase eyebrow.
export function Eyebrow({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center gap-2.5", className)}>
      <span className="h-px w-5 shrink-0 bg-gold/70" />
      <span className="text-[0.7rem] font-medium uppercase tracking-[0.14em] text-muted-foreground">
        {children}
      </span>
    </div>
  );
}
