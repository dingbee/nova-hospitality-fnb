import { ChevronDown, UserCog } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { ACCOUNT_ITEM, type NavGroup } from "./navigation";

/**
 * The operations nav list — permission-filtered groups of links, each
 * collapsible, plus the account link. Rendered twice by NovaShell (the
 * desktop rail and the mobile drawer) with identical markup, so it lives
 * here once rather than as a JSX variable built inline.
 */
export function NavPanel({
  groups,
  collapsed,
  onToggleGroup,
}: {
  groups: NavGroup[];
  collapsed: Record<string, boolean>;
  onToggleGroup: (label: string) => void;
}) {
  return (
    <nav aria-label="Operations" className="flex flex-col gap-5 p-3">
      {groups.map((group) => {
        const isCollapsed = collapsed[group.label] ?? false;
        return (
          <div key={group.label}>
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
            {!isCollapsed && (
              <ul className="mt-1.5 space-y-1">
                {group.items.map((item) => (
                  <li key={item.to}>
                    <Link
                      to={item.to}
                      title={item.hint}
                      activeOptions={{ exact: item.exact ?? false }}
                      activeProps={{ className: "nova-nav-active", "aria-current": "page" }}
                      inactiveProps={{ className: "nova-nav-link" }}
                      className="flex min-h-11 items-center gap-3 rounded-xl px-3 text-sm outline-none transition-colors"
                    >
                      <item.icon className="size-[17px] shrink-0" aria-hidden="true" />
                      <span className="truncate">{item.label}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
      <div className="border-t border-[color:var(--nova-line)] pt-4">
        <Link
          to={ACCOUNT_ITEM.to}
          activeProps={{ className: "nova-nav-active" }}
          inactiveProps={{ className: "nova-nav-link" }}
          className="flex min-h-11 items-center gap-3 rounded-xl px-3 text-sm"
        >
          <UserCog className="size-[17px]" />
          {ACCOUNT_ITEM.label}
        </Link>
      </div>
    </nav>
  );
}
