import { ChevronDown, UserCog } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { ACCOUNT_ITEM, type NavGroup } from "./navigation";

/**
 * The operations nav list — permission-filtered groups of links, each
 * collapsible, plus the account link. Rendered twice by NovaShell (the
 * desktop rail and the mobile drawer) with identical markup, so it lives
 * here once rather than as a JSX variable built inline.
 *
 * `rail`: the whole sidebar is in icon-only collapsed mode (desktop only —
 * the mobile drawer never passes this). Group headers and item labels are
 * hidden; each item's own label still reaches assistive tech via
 * `aria-label` and a native `title` tooltip on hover/focus, so nothing
 * becomes unrecognisable, just narrower.
 */
export function NavPanel({
  groups,
  collapsed,
  onToggleGroup,
  rail = false,
}: {
  groups: NavGroup[];
  collapsed: Record<string, boolean>;
  onToggleGroup: (label: string) => void;
  rail?: boolean;
}) {
  return (
    <nav
      aria-label="Operations"
      className={rail ? "flex flex-col gap-3 p-2" : "flex flex-col gap-5 p-3"}
    >
      {groups.map((group) => {
        const isCollapsed = !rail && (collapsed[group.label] ?? false);
        return (
          <div key={group.label}>
            {rail ? (
              <div className="mb-1 h-px bg-[color:var(--nova-line)]" aria-hidden="true" />
            ) : (
              <button
                type="button"
                data-nav-plain="true"
                aria-expanded={!isCollapsed}
                onClick={() => onToggleGroup(group.label)}
                className="nova-eyebrow flex w-full items-center justify-between rounded-lg px-2 py-1.5 hover:text-[color:var(--nova-ink)]"
              >
                {group.label}
                <ChevronDown
                  className={`size-3.5 transition-transform ${isCollapsed ? "-rotate-90" : ""}`}
                />
              </button>
            )}
            {!isCollapsed && (
              <ul className={rail ? "space-y-1" : "mt-1.5 space-y-1"}>
                {group.items.map((item) => (
                  <li key={item.to}>
                    <Link
                      to={item.to}
                      title={rail ? item.label : item.hint}
                      aria-label={item.label}
                      activeOptions={{ exact: item.exact ?? false }}
                      activeProps={{ className: "nova-nav-active", "aria-current": "page" }}
                      inactiveProps={{ className: "nova-nav-link" }}
                      className={
                        rail
                          ? "flex min-h-11 items-center justify-center rounded-xl outline-none transition-colors"
                          : "flex min-h-11 items-center gap-3 rounded-xl px-3 text-sm outline-none transition-colors"
                      }
                    >
                      <item.icon className="size-[17px] shrink-0" aria-hidden="true" />
                      {!rail && <span className="truncate">{item.label}</span>}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
      <div
        className={
          rail
            ? "border-t border-[color:var(--nova-line)] pt-3"
            : "border-t border-[color:var(--nova-line)] pt-4"
        }
      >
        <Link
          to={ACCOUNT_ITEM.to}
          title={rail ? ACCOUNT_ITEM.label : undefined}
          aria-label={ACCOUNT_ITEM.label}
          activeProps={{ className: "nova-nav-active" }}
          inactiveProps={{ className: "nova-nav-link" }}
          className={
            rail
              ? "flex min-h-11 items-center justify-center rounded-xl"
              : "flex min-h-11 items-center gap-3 rounded-xl px-3 text-sm"
          }
        >
          <UserCog className="size-[17px]" />
          {!rail && ACCOUNT_ITEM.label}
        </Link>
      </div>
    </nav>
  );
}
