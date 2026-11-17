/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase fake rows are untyped at this boundary. */
import { describe, expect, it } from "vitest";
import { resolveMenuAvailability } from "./availability.server";

const tenant = "tenant-1";
const property = "property-1";
const location = "location-1";

function fakeDb(rows: Record<string, any[]>) {
  return {
    from(table: string) {
      let filtered = rows[table] ?? [];
      const builder: any = {
        select: () => builder,
        eq: (column: string, value: unknown) => {
          filtered = filtered.filter((row) => row[column] === value);
          return builder;
        },
        in: (column: string, values: unknown[]) => {
          const set = new Set(values);
          filtered = filtered.filter((row) => set.has(row[column]));
          return builder;
        },
        or: (clause: string) => {
          const conditions = clause.split(",").map((part) => {
            const [column, op, value] = part.split(".");
            return { column: column!, op: op!, value };
          });
          filtered = filtered.filter((row) =>
            conditions.some((c) =>
              c.op === "is" ? row[c.column] == null : String(row[c.column]) === c.value,
            ),
          );
          return builder;
        },
        then: (resolve: (value: unknown) => unknown) =>
          Promise.resolve({ data: filtered }).then(resolve),
      };
      return builder;
    },
  };
}

const item = { id: "menu-item-1", available: true, lifecycle_status: "active" };
const product = { id: "product-1", menu_item_id: item.id, recipe_id: "recipe-1", active: true };

describe("outlet-scoped menu availability", () => {
  it("blocks a menu item when required recipe stock is below the recipe quantity", async () => {
    const db = fakeDb({
      restaurant_recipes: [{ id: "recipe-1", status: "active" }],
      restaurant_recipe_lines: [
        {
          recipe_id: "recipe-1",
          inventory_item_id: "stock-1",
          component_kind: "inventory",
          is_optional: false,
          quantity: 3,
        },
      ],
      restaurant_inventory_items: [
        {
          id: "stock-1",
          name: "Chicken",
          current_quantity: 2,
          status: "active",
          property_id: property,
          location_id: location,
        },
      ],
    });
    const result = await resolveMenuAvailability(db, tenant, [item], [product], {
      propertyId: property,
      locationId: location,
    });
    expect(result.get(item.id)).toMatchObject({ available: false, inventoryReady: false, availableQuantity: 0 });
    expect(result.get(item.id)?.reasons[0]).toContain("Chicken");
  });

  it("resolves nested sub-recipes before declaring the item available", async () => {
    const db = fakeDb({
      restaurant_recipes: [
        { id: "recipe-1", status: "active" },
        { id: "recipe-2", status: "active" },
      ],
      restaurant_recipe_lines: [
        {
          recipe_id: "recipe-1",
          component_kind: "sub_recipe",
          sub_recipe_id: "recipe-2",
          is_optional: false,
          quantity: 1,
        },
        {
          recipe_id: "recipe-2",
          component_kind: "inventory",
          inventory_item_id: "stock-1",
          is_optional: false,
          quantity: 1,
        },
      ],
      restaurant_inventory_items: [
        {
          id: "stock-1",
          name: "Flour",
          current_quantity: 5,
          status: "active",
          property_id: property,
          location_id: location,
        },
      ],
    });
    const result = await resolveMenuAvailability(db, tenant, [item], [product], {
      propertyId: property,
      locationId: location,
    });
    expect(result.get(item.id)).toMatchObject({
      available: true,
      inventoryReady: true,
      reasons: [],
    });
  });

  it("fails closed when a required ingredient is outside the selected outlet scope", async () => {
    const db = fakeDb({
      restaurant_recipes: [{ id: "recipe-1", status: "active" }],
      restaurant_recipe_lines: [
        {
          recipe_id: "recipe-1",
          inventory_item_id: "stock-1",
          component_kind: "inventory",
          is_optional: false,
          quantity: 1,
        },
      ],
      restaurant_inventory_items: [
        {
          id: "stock-1",
          name: "Milk",
          current_quantity: 5,
          status: "active",
          property_id: property,
          location_id: "another-outlet",
        },
      ],
    });
    const result = await resolveMenuAvailability(db, tenant, [item], [product], {
      propertyId: property,
      locationId: location,
    });
    expect(result.get(item.id)?.available).toBe(false);
    expect(result.get(item.id)?.reasons.join(" ")).toContain("unavailable at this outlet");
  });

  it("subtracts active reservations before computing orderable quantity", async () => {
    const db = fakeDb({
      restaurant_recipes: [{ id: "recipe-1", status: "active" }],
      restaurant_recipe_lines: [{ recipe_id: "recipe-1", inventory_item_id: "stock-1", component_kind: "inventory", is_optional: false, quantity: 1 }],
      restaurant_inventory_items: [{ id: "stock-1", name: "Beans", current_quantity: 8, status: "active", property_id: property, location_id: location }],
      restaurant_stock_positions_v: [{ inventory_item_id: "stock-1", location_id: location, on_hand: 8 }],
      restaurant_stock_reservations: [{ inventory_item_id: "stock-1", location_id: location, quantity: 6 }],
    });
    const result = await resolveMenuAvailability(db, tenant, [item], [product], { propertyId: property, locationId: location });
    expect(result.get(item.id)).toMatchObject({ available: true, availableQuantity: 2 });
  });

  it("blocks inactive menu lifecycle and inactive recipe states", async () => {
    const db = fakeDb({
      restaurant_recipes: [{ id: "recipe-1", status: "draft" }],
      restaurant_recipe_lines: [],
      restaurant_inventory_items: [],
    });
    const result = await resolveMenuAvailability(
      db,
      tenant,
      [{ ...item, lifecycle_status: "paused" }],
      [product],
      { propertyId: property, locationId: location },
    );
    expect(result.get(item.id)?.available).toBe(false);
    expect(result.get(item.id)?.reasons.join(" ")).toContain("paused");
    expect(result.get(item.id)?.reasons.join(" ")).toContain("Recipe is draft");
  });
});
