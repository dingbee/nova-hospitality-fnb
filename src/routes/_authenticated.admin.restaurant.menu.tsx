/* eslint-disable @typescript-eslint/no-explicit-any -- server function rows are untyped at this boundary. */
import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Plus } from "lucide-react";
import { PageHeader } from "@/components/os/PageHeader";
import { SectionCard } from "@/components/os/SectionCard";
import { EmptyState } from "@/components/os/EmptyState";
import { StatusChip, type StatusTone } from "@/components/os/StatusChip";
import { Button } from "@/components/ui/button";
import { useAdminMutation } from "@/hooks/use-admin-mutation";
import { useRestaurantWorkspace } from "@/modules/restaurant/ui/useRestaurantWorkspace";
import { hasRestaurantCapability } from "@/modules/restaurant/core/permissions";
import {
  listRestaurantMenusFn,
  listRestaurantMenuItemsFn,
  listRestaurantCategoriesFn,
  upsertRestaurantMenuFn,
  upsertRestaurantMenuItemFn,
} from "@/modules/restaurant/menu/menu.functions";
import { MenuSheet, type MenuFormValue } from "@/modules/restaurant/menu/ui/MenuSheet";
import { MenuItemSheet, type MenuItemFormValue } from "@/modules/restaurant/menu/ui/MenuItemSheet";
import { MenuLifecycleBoard } from "@/modules/restaurant/menu/ui/MenuLifecycleBoard";

export const Route = createFileRoute("/_authenticated/admin/restaurant/menu")({
  head: () => ({
    meta: [
      { title: "Menu Management — Restaurant & Bar OS" },
      { name: "description", content: "Menus, versions and items for every outlet in the restaurant tenant." },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: MenuPage,
});

const MENU_TONE: Record<string, StatusTone> = { draft: "neutral", published: "success", archived: "warning" };

function MenuPage() {
  const ws = useRestaurantWorkspace();
  const tenantId = ws.data?.tenant?.id;
  const roles = ws.data?.roles ?? [];
  const platformAdmin = Boolean(ws.data?.platformAdmin);
  const canManage = hasRestaurantCapability(roles, "menu.manage", platformAdmin);
  const qc = useQueryClient();

  const menusFn = useServerFn(listRestaurantMenusFn);
  const itemsFn = useServerFn(listRestaurantMenuItemsFn);
  const categoriesFn = useServerFn(listRestaurantCategoriesFn);
  const upsertMenuFn = useServerFn(upsertRestaurantMenuFn);
  const upsertItemFn = useServerFn(upsertRestaurantMenuItemFn);

  const menus = useQuery({
    queryKey: ["restaurant.menus", tenantId],
    queryFn: () => menusFn({ data: { tenantId: tenantId!, limit: 100 } }),
    enabled: Boolean(tenantId),
  });
  const items = useQuery({
    queryKey: ["restaurant.menu-items", tenantId],
    queryFn: () => itemsFn({ data: { tenantId: tenantId!, limit: 200 } }),
    enabled: Boolean(tenantId),
  });
  const categories = useQuery({
    queryKey: ["restaurant.categories", tenantId],
    queryFn: () => categoriesFn({ data: { tenantId: tenantId!, kind: "menu" } }),
    enabled: Boolean(tenantId),
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["restaurant.menus", tenantId] });
    void qc.invalidateQueries({ queryKey: ["restaurant.menu-items", tenantId] });
  };

  const [menuSheetOpen, setMenuSheetOpen] = useState(false);
  const [editingMenu, setEditingMenu] = useState<MenuFormValue | null>(null);
  const [itemSheetOpen, setItemSheetOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<MenuItemFormValue | null>(null);

  const saveMenu = useAdminMutation({
    mutationFn: (v: MenuFormValue) =>
      upsertMenuFn({
        data: {
          tenantId: tenantId!,
          id: v.id,
          name: v.name,
          slug: v.slug,
          currency: v.currency,
          status: v.status,
          description: v.description || undefined,
        },
      }),
    successMessage: "Menu saved",
    onSuccess: () => {
      setMenuSheetOpen(false);
      invalidate();
    },
  });

  const statusMutation = useAdminMutation({
    mutationFn: (m: any) =>
      upsertMenuFn({
        data: {
          tenantId: tenantId!,
          id: m.id,
          name: m.name,
          slug: m.slug,
          currency: m.currency,
          status: m.status === "published" ? "archived" : "published",
          description: m.description ?? undefined,
        },
      }),
    successMessage: "Menu status updated",
    onSuccess: invalidate,
  });

  const saveItem = useAdminMutation({
    mutationFn: (v: MenuItemFormValue) =>
      upsertItemFn({
        data: {
          tenantId: tenantId!,
          id: v.id,
          menuId: v.menuId,
          categoryId: v.categoryId ?? undefined,
          name: v.name,
          slug: v.slug,
          description: v.description || undefined,
          price: v.price,
          currency: v.currency,
          available: v.available,
          sortOrder: v.sortOrder,
        },
      }),
    successMessage: "Menu item saved",
    onSuccess: () => {
      setItemSheetOpen(false);
      invalidate();
    },
  });

  if (!ws.isLoading && !ws.data?.tenant) {
    return <EmptyState title="No restaurant tenant" description="You are not a member of a Restaurant & Bar OS tenant." />;
  }

  const menuRows = (menus.data ?? []) as any[];
  const itemRows = (items.data ?? []) as any[];
  const menuOptions = menuRows.map((m) => ({ value: m.id, label: m.name, hint: m.status }));
  const categoryOptions = ((categories.data ?? []) as any[]).map((c) => ({ value: c.id, label: c.name }));
  const menuNameById = new Map(menuRows.map((m) => [m.id, m.name]));

  return (
    <div className="space-y-4">
      <PageHeader
        title="Menu Management"
        description="Versioned menus per outlet. Items, pricing and availability are stored per tenant — nothing is hard-coded."
      />

      <SectionCard
        title="Menus"
        actions={
          canManage ? (
            <Button
              size="sm"
              className="h-10"
              onClick={() => {
                setEditingMenu(null);
                setMenuSheetOpen(true);
              }}
            >
              <Plus className="mr-1 h-4 w-4" /> New menu
            </Button>
          ) : undefined
        }
      >
        {menuRows.length === 0 ? (
          <EmptyState title="No menus yet" description="Create a menu to start building your offer." />
        ) : (
          <ul className="divide-y text-sm">
            {menuRows.map((m) => (
              <li key={m.id} className="flex min-h-14 flex-wrap items-center justify-between gap-3 py-3">
                <button
                  type="button"
                  className="min-w-0 text-left hover:underline"
                  disabled={!canManage}
                  onClick={() => {
                    setEditingMenu({
                      id: m.id,
                      name: m.name,
                      slug: m.slug,
                      currency: m.currency,
                      status: m.status,
                      description: m.description ?? "",
                    });
                    setMenuSheetOpen(true);
                  }}
                >
                  {m.name} <span className="text-muted-foreground">v{m.version}</span>
                </button>
                <div className="flex items-center gap-2">
                  <StatusChip tone={MENU_TONE[m.status] ?? "neutral"}>{m.status}</StatusChip>
                  <span className="text-xs text-muted-foreground">{m.currency}</span>
                  {canManage && m.status !== "draft" && (
                    <Button size="sm" variant="outline" className="h-9" onClick={() => statusMutation.mutate(m)}>
                      {m.status === "published" ? "Archive" : "Publish"}
                    </Button>
                  )}
                  {canManage && m.status === "draft" && (
                    <Button size="sm" variant="outline" className="h-9" onClick={() => statusMutation.mutate(m)}>
                      Publish
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard
        title="Items"
        description="Across all menus in this tenant."
        actions={
          canManage && menuRows.length > 0 ? (
            <Button
              size="sm"
              className="h-10"
              onClick={() => {
                setEditingItem(null);
                setItemSheetOpen(true);
              }}
            >
              <Plus className="mr-1 h-4 w-4" /> New item
            </Button>
          ) : undefined
        }
      >
        {itemRows.length === 0 ? (
          <EmptyState title="No menu items" description="Items appear here once a menu has been populated." />
        ) : (
          <ul className="divide-y text-sm">
            {itemRows.map((i) => (
              <li key={i.id} className="flex min-h-14 flex-wrap items-center justify-between gap-3 py-2">
                <button
                  type="button"
                  className="min-w-0 text-left hover:underline"
                  disabled={!canManage}
                  onClick={() => {
                    setEditingItem({
                      id: i.id,
                      menuId: i.menu_id,
                      categoryId: i.category_id ?? null,
                      name: i.name,
                      slug: i.slug,
                      description: i.description ?? "",
                      price: Number(i.price),
                      currency: i.currency,
                      available: Boolean(i.available),
                      sortOrder: Number(i.sort_order ?? 0),
                    });
                    setItemSheetOpen(true);
                  }}
                >
                  {i.name}
                  <span className="ml-2 text-xs text-muted-foreground">{menuNameById.get(i.menu_id) ?? ""}</span>
                </button>
                <span className="text-xs text-muted-foreground">
                  {i.currency} {Number(i.price).toLocaleString()} · {i.available ? "available" : "off menu"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <MenuSheet
        open={menuSheetOpen}
        onOpenChange={setMenuSheetOpen}
        initial={editingMenu}
        pending={saveMenu.isPending}
        onSubmit={(v) => saveMenu.mutate(v)}
      />
      <MenuItemSheet
        open={itemSheetOpen}
        onOpenChange={setItemSheetOpen}
        initial={editingItem}
        menus={menuOptions}
        categories={categoryOptions}
        defaultMenuId={menuRows[0]?.id}
        pending={saveItem.isPending}
        onSubmit={(v) => saveItem.mutate(v)}
      />

      {tenantId && <MenuLifecycleBoard tenantId={tenantId} canManage={canManage} />}
    </div>
  );
}
