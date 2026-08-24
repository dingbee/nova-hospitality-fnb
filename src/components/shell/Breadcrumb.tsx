import { Link } from "@tanstack/react-router";
import { PRODUCT } from "@/config/product";

/** Page-context trail above the main content: product → nav group (if any) → current page. */
export function Breadcrumb({
  currentGroup,
  currentLabel,
}: {
  currentGroup: string | null;
  currentLabel: string;
}) {
  return (
    <nav aria-label="Breadcrumb" className="mb-4 text-[0.7rem] text-[color:var(--nova-ink-3)]">
      <ol className="flex flex-wrap items-center gap-1.5">
        <li>
          <Link to="/admin/restaurant" className="hover:text-[color:var(--nova-ink)]">
            {PRODUCT.shortName}
          </Link>
        </li>
        {currentGroup && (
          <>
            <li aria-hidden="true">/</li>
            <li>{currentGroup}</li>
          </>
        )}
        <li aria-hidden="true">/</li>
        <li className="text-[color:var(--nova-ink)]">{currentLabel}</li>
      </ol>
    </nav>
  );
}
