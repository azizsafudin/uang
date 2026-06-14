import { useUsers } from "@/lib/use-users";
import { Badge } from "@/components/ui/badge";

// Renders who owns an account: a plain member name for personal accounts,
// or a "Shared" badge (with owner names) when 2+ own it.
export function OwnersBadge({ ownerIds }: { ownerIds: string[] }) {
  const { data: users } = useUsers();
  const names = ownerIds.map((id) => users?.find((u) => u.id === id)?.name ?? "…");

  if (ownerIds.length >= 2) {
    return (
      <Badge variant="secondary" className="font-normal">
        Shared · {names.join(", ")}
      </Badge>
    );
  }
  return (
    <span className="text-xs text-muted-foreground">{names[0] ?? "Unowned"}</span>
  );
}
