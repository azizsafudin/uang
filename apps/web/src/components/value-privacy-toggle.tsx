import { Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useValuesHidden } from "@/lib/values-hidden";

// The eye toggle that masks money values. Extracted from router.tsx so both the
// top bar and the PWA sidebar footer can render it.
export function ValuePrivacyToggle() {
  const { hidden, toggle } = useValuesHidden();
  return (
    <Button
      type="button"
      size="icon"
      variant="ghost"
      onClick={toggle}
      aria-pressed={hidden}
      aria-label={hidden ? "Show values" : "Hide values"}
      title={hidden ? "Show values" : "Hide values"}
    >
      {hidden ? <EyeOff /> : <Eye />}
    </Button>
  );
}
