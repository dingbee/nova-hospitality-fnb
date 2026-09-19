import { useId } from "react";
import { LEXIBITE_GOLD } from "./brand";

/**
 * The bitten "e" — LexiBite's standalone mark.
 *
 * No official logo asset was supplied to this build (see brand.ts), so this
 * is a constructed placeholder: an "e" ring with a wedge bitten out of its
 * upper-right, in the LexiBite gold. The bite is a real transparent cutout
 * (an SVG mask), so the mark reads correctly on any background — the green
 * header, a white card, a receipt screen — without needing to know what's
 * behind it. Swap this file's markup for the real asset once one is
 * supplied; nothing else references its internals.
 */
export function LexiBiteMark({
  size = 28,
  className,
}: {
  size?: number;
  className?: string;
}) {
  const maskId = useId();
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      className={className}
      role="img"
      aria-label="LexiBite"
    >
      <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="48" height="48">
        <rect x="0" y="0" width="48" height="48" fill="white" />
        <circle cx="35" cy="10" r="9" fill="black" />
      </mask>
      <g mask={`url(#${maskId})`}>
        <path
          d="M24 4a20 20 0 1 1-14.14 5.86"
          stroke={LEXIBITE_GOLD}
          strokeWidth="7"
          strokeLinecap="round"
          fill="none"
        />
        <rect x="14" y="21.5" width="20" height="5" rx="2.5" fill={LEXIBITE_GOLD} />
      </g>
    </svg>
  );
}
