import { cn } from "@/lib/utils";

/**
 * The official LexiBite processing/loading signal: the bitten-"e" mark
 * revolving while LexiBite is working, and stopped/static as soon as it
 * finishes. Uses the supplied brand asset as-is (never redrawn) — see
 * public/brand/lexibite-icon.{png,svg}. Respects prefers-reduced-motion via
 * the `.lexibite-loader__mark` animation defined in styles.css: the mark
 * stays static but the busy/label semantics below are unaffected, so
 * loading state is never conveyed by animation alone.
 */

const SIZE_PX: Record<"xs" | "sm" | "md" | "lg", number> = {
  xs: 14,
  sm: 20,
  md: 32,
  lg: 56,
};

export function LexiBiteLoader({
  size = "sm",
  variant = "inline",
  label = "Loading…",
  showLabel = false,
  className,
}: {
  size?: "xs" | "sm" | "md" | "lg";
  /** inline: sits next to text. centered: block, centered in its parent. overlay: fixed, covers the viewport. */
  variant?: "inline" | "centered" | "overlay" | "block";
  /** Accessible status text — always present for assistive tech, only shown visually when showLabel is true. */
  label?: string;
  showLabel?: boolean;
  className?: string;
}) {
  const px = SIZE_PX[size];
  const mark = (
    <img
      src="/brand/lexibite-icon.svg"
      alt=""
      aria-hidden
      width={px}
      height={px}
      className="lexibite-loader__mark shrink-0"
      style={{ width: px, height: px }}
    />
  );

  const content = (
    <span
      role="status"
      aria-live="polite"
      aria-busy="true"
      className={cn(
        "inline-flex items-center gap-2",
        variant === "centered" && "flex-col justify-center py-6",
        variant === "block" && "justify-center",
        className,
      )}
    >
      {mark}
      <span className={showLabel ? "text-sm text-muted-foreground" : "sr-only"}>{label}</span>
    </span>
  );

  if (variant === "overlay") {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 backdrop-blur-sm">
        {content}
      </div>
    );
  }

  return content;
}
