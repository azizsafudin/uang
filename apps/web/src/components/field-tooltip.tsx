import { Tooltip } from "@base-ui/react/tooltip";
import { InfoIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export function FieldTooltip({
  content,
  className,
}: {
  content: string;
  className?: string;
}) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger
        className={cn(
          "ml-1 inline-flex cursor-default items-center text-muted-foreground hover:text-foreground focus:outline-none",
          className,
        )}
        aria-label={content}
      >
        <InfoIcon className="size-3.5" />
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Positioner sideOffset={4}>
          <Tooltip.Popup className="z-50 max-w-xs rounded-lg bg-popover px-3 py-1.5 text-xs text-popover-foreground shadow-md ring-1 ring-foreground/10">
            {content}
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
