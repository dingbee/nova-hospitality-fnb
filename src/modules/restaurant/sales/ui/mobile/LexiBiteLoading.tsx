import { cn } from "@/lib/utils";
import { LexiBiteMark } from "./LexiBiteMark";

/**
 * The revolving bitten "e" — LexiBite's loading state for the mobile POS.
 * Use wherever the till is genuinely waiting on async work (a query still
 * loading, a mutation in flight); never as decoration. Honors
 * prefers-reduced-motion via the `lexibite-spin` utility (styles.css).
 */
export function LexiBiteLoading({
  label = "Loading",
  size = 32,
  inline = false,
  className,
}: {
  /** Announced to screen readers; also shown as text unless `inline`. */
  label?: string;
  size?: number;
  /** Compact form for use next to other content (e.g. a button's own label). */
  inline?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-center gap-2",
        !inline && "flex-col py-8",
        className,
      )}
      role="status"
      aria-busy="true"
      aria-live="polite"
    >
      <LexiBiteMark size={size} className="lexibite-spin" />
      <span className={inline ? "sr-only" : "text-sm font-medium text-muted-foreground"}>
        {label}
      </span>
    </div>
  );
}
