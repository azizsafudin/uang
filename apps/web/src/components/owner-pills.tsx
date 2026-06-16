import { useUsers } from "@/lib/use-users";
import { cn } from "@/lib/utils";

// Small rounded pills naming each owner of an account. Shown wherever an account
// is rendered as a row or card — inline, to the right of the account name.
// Renders nothing for an account with no owners.
export function OwnerPills({
  ownerIds,
  className,
}: {
  ownerIds: string[];
  className?: string;
}) {
  const { data: users } = useUsers();
  if (ownerIds.length === 0) return null;
  return (
    <div className={cn("flex shrink-0 flex-wrap items-center gap-1", className)}>
      {ownerIds.map((id) => (
        <span
          key={id}
          className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary"
        >
          {users?.find((u) => u.id === id)?.name ?? "…"}
        </span>
      ))}
    </div>
  );
}
