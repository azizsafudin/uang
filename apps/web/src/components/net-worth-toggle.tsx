import { useUsers } from "@/lib/use-users";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// "Household" plus one option per member. Controls only the headline selection.
export function NetWorthToggle({
  value,
  onChange,
}: {
  value: string; // "household" | userId
  onChange: (v: string) => void;
}) {
  const { data: users } = useUsers();
  const options = [
    { id: "household", label: "Household" },
    ...(users ?? []).map((u) => ({ id: u.id, label: u.name })),
  ];

  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => (
        <Button
          key={o.id}
          variant={value === o.id ? "default" : "outline"}
          onClick={() => onChange(o.id)}
          className={cn(value === o.id && "pointer-events-none")}
        >
          {o.label}
        </Button>
      ))}
    </div>
  );
}
