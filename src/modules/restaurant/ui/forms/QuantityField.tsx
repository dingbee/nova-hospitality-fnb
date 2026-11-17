/**
 * Touch-friendly numeric entry: steppers plus a wide numeric input so a
 * storekeeper on a tablet never has to hunt for a caret.
 */
import * as React from "react";
import { Minus, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

interface QuantityFieldProps {
  value: number;
  onChange: (value: number) => void;
  step?: number;
  min?: number;
  max?: number;
  suffix?: string;
  disabled?: boolean;
  className?: string;
}

export function QuantityField({
  value,
  onChange,
  step = 1,
  min = 0,
  max,
  suffix,
  disabled,
  className,
}: QuantityFieldProps) {
  const clamp = (n: number) => {
    let v = Number.isFinite(n) ? n : min;
    if (min != null && v < min) v = min;
    if (max != null && v > max) v = max;
    return Math.round(v * 10000) / 10000;
  };

  return (
    <div className={cn("flex items-center gap-2", className)}>
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="h-11 w-11 shrink-0"
        disabled={disabled}
        onClick={() => onChange(clamp(value - step))}
        aria-label="Decrease"
      >
        <Minus className="h-4 w-4" />
      </Button>
      <div className="relative flex-1">
        <Input
          inputMode="decimal"
          type="number"
          step="any"
          className="h-11 text-center text-base"
          value={Number.isFinite(value) ? value : ""}
          disabled={disabled}
          onChange={(e) => onChange(clamp(parseFloat(e.target.value)))}
        />
        {suffix ? (
          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
            {suffix}
          </span>
        ) : null}
      </div>
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="h-11 w-11 shrink-0"
        disabled={disabled}
        onClick={() => onChange(clamp(value + step))}
        aria-label="Increase"
      >
        <Plus className="h-4 w-4" />
      </Button>
    </div>
  );
}