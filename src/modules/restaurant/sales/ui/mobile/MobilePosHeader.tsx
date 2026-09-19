import { ChevronDown, Menu as MenuIcon, User } from "lucide-react";
import { LexiBiteMark } from "./LexiBiteMark";

/**
 * The one shell header every mobile POS screen shares. Compact by design —
 * two rows at most, never a marketing-style banner — so the workspace below
 * it keeps the viewport.
 *
 * Two shapes: the brand row (outlet name, no back arrow) for the primary
 * bottom-nav destinations, or a title row (with a back arrow, unless
 * `showBack` is false) for a screen reached by drilling in.
 *
 * The right-hand avatar is a generic icon, not a fabricated initial — this
 * codebase has no current-staff display-name/photo source wired up client
 * side yet (see StaffPanel.tsx, TopBar.tsx), so this doesn't invent one.
 */
export function MobilePosHeader({
  outletName,
  title,
  subtitle,
  showBack = true,
  onBack,
  onMenu,
}: {
  outletName: string;
  /** When set, replaces the "lexibite / outlet" row with a title row (e.g. "New Order", "Table T2"). */
  title?: string;
  /** Optional contextual second line under a title (e.g. "4 pax · 28 min"). Ignored when `title` is unset. */
  subtitle?: string;
  /** Set false for a titled top-level screen (Kitchen View, Receipts, More) reached via the bottom nav, not by drilling in. */
  showBack?: boolean;
  onBack?: () => void;
  onMenu?: () => void;
}) {
  return (
    <header
      className="shrink-0 text-white"
      style={{ background: "linear-gradient(180deg, var(--lb-green-dark) 0%, var(--lb-green) 100%)" }}
      data-testid="mobile-pos-header"
    >
      <div className="flex items-center gap-3 px-4 pt-[max(0.625rem,env(safe-area-inset-top))] pb-2.5">
        {title ? (
          <>
            {showBack ? (
              <button
                type="button"
                onClick={onBack}
                className="-ml-1.5 flex size-11 shrink-0 items-center justify-center rounded-full text-white/90 active:bg-white/10"
                aria-label="Back"
              >
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
                  <path
                    d="M15 6l-6 6 6 6"
                    stroke="currentColor"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            ) : null}
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-base font-semibold leading-tight">{title}</h1>
              {subtitle && <p className="truncate text-xs leading-tight text-white/80">{subtitle}</p>}
            </div>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={onMenu}
              className="flex size-11 shrink-0 items-center justify-center rounded-full active:bg-white/10"
              aria-label="Menu"
            >
              <MenuIcon className="size-5" />
            </button>
            <div className="flex flex-1 items-center justify-center gap-1.5">
              <LexiBiteMark size={20} />
              <span className="text-[15px] font-semibold tracking-tight">lexibite</span>
            </div>
            <span
              className="flex size-9 shrink-0 items-center justify-center rounded-full"
              style={{ background: "var(--lb-gold)", color: "var(--lb-green-dark)" }}
              aria-hidden
            >
              <User className="size-[18px]" />
            </span>
          </>
        )}
      </div>
      {!title && (
        <div className="flex items-center gap-1 px-4 pb-2.5 text-sm font-medium text-white/95">
          <span className="min-w-0 truncate">{outletName}</span>
          <ChevronDown className="size-3.5 shrink-0 opacity-80" />
        </div>
      )}
    </header>
  );
}
