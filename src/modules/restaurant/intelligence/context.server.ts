/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Read-only context the Intelligence Core (or a human) can consult about a
 * restaurant tenant. Pure aggregation — it never writes and never reasons.
 */
import { assertTenantRead } from "../core/access.server";

type Sb = any;

export interface RestaurantContextSnapshot {
  tenantId: string;
  generatedAt: string;
  locations: number;
  menus: { total: number; published: number };
  menuItems: { total: number; available: number };
  inventory: { total: number; low: number; stockValue: number };
  suppliers: { total: number; active: number };
  purchasing: { open: number; openValue: number };
  costing: { costedItems: number; averageFoodCostPercent: number | null };
}

export async function getRestaurantContext(
  sb: Sb,
  userId: string,
  tenantId: string,
): Promise<RestaurantContextSnapshot> {
  await assertTenantRead(sb, userId, tenantId);

  const [locations, menus, items, inventory, suppliers, orders, costs] = await Promise.all([
    sb.from("restaurant_locations").select("id").eq("tenant_id", tenantId),
    sb.from("restaurant_menus").select("id, status").eq("tenant_id", tenantId),
    sb.from("restaurant_menu_items").select("id, available").eq("tenant_id", tenantId),
    sb
      .from("restaurant_inventory_items")
      .select("id, current_quantity, reorder_point, average_cost")
      .eq("tenant_id", tenantId),
    sb.from("restaurant_suppliers").select("id, status").eq("tenant_id", tenantId),
    sb.from("restaurant_purchase_orders").select("id, status, total").eq("tenant_id", tenantId),
    sb.from("restaurant_recipe_costs").select("menu_item_id, food_cost_percent").eq("tenant_id", tenantId),
  ]);

  const inv = (inventory.data ?? []) as any[];
  const ords = (orders.data ?? []) as any[];
  const costRows = ((costs.data ?? []) as any[]).filter((c) => c.food_cost_percent != null);

  return {
    tenantId,
    generatedAt: new Date().toISOString(),
    locations: (locations.data ?? []).length,
    menus: {
      total: (menus.data ?? []).length,
      published: ((menus.data ?? []) as any[]).filter((m) => m.status === "published").length,
    },
    menuItems: {
      total: (items.data ?? []).length,
      available: ((items.data ?? []) as any[]).filter((i) => i.available).length,
    },
    inventory: {
      total: inv.length,
      low: inv.filter((i) => i.reorder_point != null && Number(i.current_quantity) <= Number(i.reorder_point))
        .length,
      stockValue: Number(
        inv.reduce((s, i) => s + Number(i.current_quantity ?? 0) * Number(i.average_cost ?? 0), 0).toFixed(2),
      ),
    },
    suppliers: {
      total: (suppliers.data ?? []).length,
      active: ((suppliers.data ?? []) as any[]).filter((s) => s.status === "active").length,
    },
    purchasing: {
      open: ords.filter((o) => ["draft", "submitted", "approved", "partially_received"].includes(o.status))
        .length,
      openValue: Number(
        ords
          .filter((o) => ["draft", "submitted", "approved", "partially_received"].includes(o.status))
          .reduce((s, o) => s + Number(o.total ?? 0), 0)
          .toFixed(2),
      ),
    },
    costing: {
      costedItems: new Set(costRows.map((c) => c.menu_item_id)).size,
      averageFoodCostPercent:
        costRows.length > 0
          ? Number(
              (costRows.reduce((s, c) => s + Number(c.food_cost_percent), 0) / costRows.length).toFixed(2),
            )
          : null,
    },
  };
}