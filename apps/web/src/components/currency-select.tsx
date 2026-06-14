import { CURRENCY_CODES, currencySymbol } from "@uang/shared";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// A select of all supported currencies, each labelled "CODE (symbol)".
// `value` is the ISO code; emits the chosen code via `onValueChange`.
export function CurrencySelect({
  value,
  onValueChange,
  className,
  placeholder,
  "data-testid": testId,
}: {
  value: string;
  onValueChange: (code: string) => void;
  className?: string;
  placeholder?: string;
  "data-testid"?: string;
}) {
  return (
    <Select value={value} onValueChange={(v: string | null) => v && onValueChange(v)}>
      <SelectTrigger className={className ?? "w-full"} data-testid={testId}>
        <SelectValue>
          {(v: unknown) => {
            const code = String(v ?? "");
            if (code) return `${code} (${currencySymbol(code)})`;
            return placeholder ? (
              <span className="text-muted-foreground">{placeholder}</span>
            ) : (
              ""
            );
          }}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {CURRENCY_CODES.map((code) => (
          <SelectItem key={code} value={code}>
            {code} <span className="text-muted-foreground">({currencySymbol(code)})</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
