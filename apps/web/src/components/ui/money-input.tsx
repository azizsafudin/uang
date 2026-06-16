import * as React from "react"

import { cn } from "@/lib/utils"
import { Input } from "@/components/ui/input"
import { cleanMoneyInput, formatMoneyInput } from "@/components/money"

/**
 * A money amount input. The parent's `value` is always the canonical numeric
 * string (e.g. "5400", "-5400.5") so existing `parseFloat`-based form logic keeps
 * working. While focused it shows the raw number for easy editing; on blur it
 * reformats with grouping separators and the currency symbol ("$5,400.00").
 */
export function MoneyInput({
  value,
  onChange,
  currency,
  className,
  onFocus,
  onBlur,
  ...props
}: Omit<React.ComponentProps<typeof Input>, "value" | "onChange" | "type"> & {
  value: string
  onChange: (next: string) => void
  currency: string
}) {
  const [focused, setFocused] = React.useState(false)
  const display = focused ? value : formatMoneyInput(value, currency)

  return (
    <Input
      inputMode="decimal"
      value={display}
      onChange={(e) => onChange(cleanMoneyInput(e.target.value))}
      onFocus={(e) => {
        setFocused(true)
        onFocus?.(e)
      }}
      onBlur={(e) => {
        setFocused(false)
        onBlur?.(e)
      }}
      className={cn("text-right tabular-nums", className)}
      {...props}
    />
  )
}
