import { useUsers } from "@/lib/use-users";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";

// Checkbox list of household members. At least one should be selected (the
// caller enforces non-empty before submitting). Selecting 2+ marks the account shared.
export function OwnersField({
  value,
  onChange,
}: {
  value: string[];
  onChange: (ids: string[]) => void;
}) {
  const { data: users } = useUsers();
  const toggle = (id: string, checked: boolean) =>
    onChange(checked ? [...value, id] : value.filter((v) => v !== id));

  return (
    <div className="space-y-1.5">
      {(users ?? []).map((u) => (
        <Label
          key={u.id}
          data-testid="owner-option"
          className="flex cursor-pointer items-center gap-2 font-normal"
        >
          <Checkbox
            checked={value.includes(u.id)}
            onCheckedChange={(c) => toggle(u.id, c === true)}
          />
          {u.name}
        </Label>
      ))}
      {value.length >= 2 && (
        <p className="text-xs text-muted-foreground">
          Shared — counts only toward the household total.
        </p>
      )}
    </div>
  );
}
