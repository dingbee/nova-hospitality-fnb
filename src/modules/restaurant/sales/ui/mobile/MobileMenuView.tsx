/* eslint-disable @typescript-eslint/no-explicit-any -- catalogue rows are untyped at this boundary, matching PosWorkspace. */
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/os/EmptyState";
import { cn } from "@/lib/utils";
import type { LexiBiteMobilePosData } from "./useLexiBiteMobilePos";
import { MobileMenuItemCard } from "./MobileMenuItemCard";
import { LexiBiteLoading } from "./LexiBiteLoading";

/** Screen 2 — the catalogue. Search + category chips + a 2-column image-first grid. */
export function MobileMenuView({
  data,
  onSelectItem,
}: {
  data: LexiBiteMobilePosData;
  onSelectItem: (item: any) => void;
}) {
  const isBar = data.lens === "bar";
  const canAdd = Boolean(data.orderId || data.queuedOrder);

  if (data.catalog.isLoading) return <LexiBiteLoading label="Loading menu…" />;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 space-y-2.5 px-4 pt-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={data.catalogSearch}
            onChange={(e) => data.setCatalogSearch(e.target.value)}
            placeholder={isBar ? "Search drinks…" : "Search menu items…"}
            className="h-12 rounded-full pl-9 text-[15px]"
            enterKeyHint="search"
          />
        </div>
        <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
          <CategoryChip
            label="All"
            active={data.categoryId === null}
            onClick={() => data.setCategoryId(null)}
          />
          {data.categories.map((c: any) => (
            <CategoryChip
              key={c.id}
              label={c.name}
              active={data.categoryId === c.id}
              onClick={() => data.setCategoryId(c.id)}
            />
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 pt-2">
        {data.filtered.length === 0 ? (
          <EmptyState
            title={data.catalogSearch ? "No matches" : "No items"}
            description={
              data.catalogSearch
                ? "Try a different search or category."
                : "Publish a menu to sell from this till."
            }
          />
        ) : (
          <div className="grid grid-cols-2 gap-3">
            {data.filtered.map((item: any) => (
              <MobileMenuItemCard
                key={item.id}
                item={item}
                currency={data.currency}
                disabled={!canAdd || item.available === false || item.priceConfigured === false}
                onSelect={() => onSelectItem(item)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function CategoryChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "min-h-9 shrink-0 rounded-full border px-3.5 text-sm font-medium transition-colors",
        active ? "border-transparent text-white" : "border-border bg-card text-foreground",
      )}
      style={active ? { background: "var(--lb-green)" } : undefined}
    >
      {label}
    </button>
  );
}
