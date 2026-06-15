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

// A titled card section with an eyebrow, used to group settings/projection forms.
export function Section({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string;
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-border bg-card p-5 md:p-6">
      <Eyebrow className="mb-2.5">{eyebrow}</Eyebrow>
      <h2 className="font-heading text-xl tracking-tight">{title}</h2>
      {description && (
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      )}
      <div className="mt-4">{children}</div>
    </section>
  );
}
