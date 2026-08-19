/**
 * Shared building blocks for Master Data Workbench panels: a searchable list
 * with an active/inactive toggle, and small formatting helpers. Every panel
 * reads from the single `listAllMasterData` snapshot and invalidates it after
 * a mutation — no panel keeps its own list query.
 */
import * as React from "react";
import { Search, Plus } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { EmptyState } from "@/components/os/EmptyState";
import { StatusChip } from "@/components/os/StatusChip";

export function slugify(s: string) {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 100);
}

export interface PanelItem {
  id: string;
  title: string;
  subtitle?: string;
  active: boolean;
}

export function PanelToolbar({
  search,
  onSearch,
  onCreate,
  createLabel = "New",
}: {
  search: string;
  onSearch: (v: string) => void;
  onCreate: () => void;
  createLabel?: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative flex-1 min-w-48">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          placeholder="Search…"
          className="h-11 pl-9"
        />
      </div>
      <Button type="button" className="h-11" onClick={onCreate}>
        <Plus className="mr-1 h-4 w-4" />
        {createLabel}
      </Button>
    </div>
  );
}

export function PanelList({
  items,
  onEdit,
  onToggleActive,
  toggling,
  emptyTitle = "Nothing yet",
  emptyDescription,
}: {
  items: PanelItem[];
  onEdit: (id: string) => void;
  onToggleActive?: (id: string, active: boolean) => void;
  toggling?: string | null;
  emptyTitle?: string;
  emptyDescription?: string;
}) {
  if (items.length === 0) {
    return <EmptyState title={emptyTitle} description={emptyDescription} />;
  }
  return (
    <ul className="divide-y">
      {items.map((it) => (
        <li key={it.id} className="flex min-h-14 flex-wrap items-center justify-between gap-3 py-3">
          <button
            type="button"
            onClick={() => onEdit(it.id)}
            className="min-w-0 flex-1 text-left"
          >
            <p className="truncate text-sm font-medium">{it.title}</p>
            {it.subtitle ? <p className="truncate text-xs text-muted-foreground">{it.subtitle}</p> : null}
          </button>
          <div className="flex items-center gap-2">
            <StatusChip tone={it.active ? "success" : "neutral"}>
              {it.active ? "Active" : "Inactive"}
            </StatusChip>
            {onToggleActive ? (
              <Switch
                checked={it.active}
                disabled={toggling === it.id}
                onCheckedChange={(v) => onToggleActive(it.id, v)}
                aria-label="Toggle active"
              />
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}
