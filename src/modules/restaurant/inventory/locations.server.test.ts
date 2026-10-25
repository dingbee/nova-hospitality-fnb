import { beforeEach, describe, expect, it, vi } from "vitest";

const assertCapability = vi.fn();
const emitRestaurantEvent = vi.fn();

vi.mock("../core/access.server", () => ({
  assertCapability: (...args: unknown[]) => assertCapability(...args),
  assertTenantRead: vi.fn(),
}));
vi.mock("../events/emit.server", () => ({
  emitRestaurantEvent: (...args: unknown[]) => emitRestaurantEvent(...args),
}));

const { upsertLocation } = await import("./locations.server");

const TENANT = "11111111-1111-1111-1111-111111111111";
const USER = "22222222-2222-2222-2222-222222222222";
const PROPERTY = "33333333-3333-3333-3333-333333333333";
const OTHER_PROPERTY = "44444444-4444-4444-4444-444444444444";
const PARENT = "55555555-5555-5555-5555-555555555555";

function fakeSupabase(options: {
  propertyTenant?: string;
  parentProperty?: string;
  parentStorage?: boolean;
} = {}) {
  const writes: Array<{ table: string; operation: string; payload?: unknown }> = [];
  const tables: Record<string, any> = {
    restaurant_properties: {
      id: PROPERTY,
      tenant_id: options.propertyTenant ?? TENANT,
      status: "active",
    },
    restaurant_locations: {
      id: PARENT,
      tenant_id: TENANT,
      property_id: options.parentProperty ?? PROPERTY,
      is_storage: options.parentStorage ?? false,
    },
  };

  function builder(table: string) {
    const filters: Record<string, unknown> = {};
    let operation = "select";
    let payload: any;
    const api: any = {
      select: () => api,
      eq: (column: string, value: unknown) => {
        filters[column] = value;
        return api;
      },
      maybeSingle: async () => {
        const row = tables[table];
        if (!row || Object.entries(filters).some(([key, value]) => row[key] !== value)) {
          return { data: null, error: null };
        }
        return { data: row, error: null };
      },
      insert: (value: unknown) => {
        operation = "insert";
        payload = value;
        return api;
      },
      update: (value: unknown) => {
        operation = "update";
        payload = value;
        return api;
      },
      single: async () => {
        writes.push({ table, operation, payload });
        return {
          data: {
            id: "new-location",
            name: "Test",
            location_type: "outlet",
            is_storage: false,
            status: "active",
          },
          error: null,
        };
      },
    };
    return api;
  }

  return { sb: { from: (table: string) => builder(table) }, writes };
}

const input = {
  tenantId: TENANT,
  propertyId: PROPERTY,
  scope: "property" as const,
  parentId: PARENT,
  slug: "terrace",
  name: "Terrace",
  locationType: "outlet",
  isStorage: false,
  active: true,
};

beforeEach(() => {
  assertCapability.mockReset().mockResolvedValue(undefined);
  emitRestaurantEvent.mockReset().mockResolvedValue(undefined);
});

describe("upsertLocation property and parent scope", () => {
  it("rejects a property that does not belong to the requested tenant", async () => {
    const fake = fakeSupabase({ propertyTenant: "66666666-6666-6666-6666-666666666666" });
    await expect(upsertLocation(fake.sb, USER, input as any)).rejects.toThrow(
      "Property not found in this tenant.",
    );
    expect(fake.writes).toEqual([]);
  });

  it("rejects a parent from another property before writing", async () => {
    const fake = fakeSupabase({ parentProperty: OTHER_PROPERTY });
    await expect(upsertLocation(fake.sb, USER, input as any)).rejects.toThrow(
      "Parent location must belong to the same property.",
    );
    expect(fake.writes).toEqual([]);
  });

  it("rejects a store as the parent of an outlet before writing", async () => {
    const fake = fakeSupabase({ parentStorage: true });
    await expect(upsertLocation(fake.sb, USER, input as any)).rejects.toThrow(
      "Parent location must be in the same location domain.",
    );
    expect(fake.writes).toEqual([]);
  });

  it("creates a tenant-level central store without a property or parent", async () => {
    const fake = fakeSupabase();
    const result = await upsertLocation(fake.sb, USER, {
      ...input,
      propertyId: null,
      scope: "tenant",
      parentId: null,
      isStorage: true,
      locationType: "store",
      name: "Group Central Store",
      slug: "group-central-store",
    } as any);
    expect(result.id).toBe("new-location");
    expect(fake.writes).toHaveLength(1);
    expect(fake.writes[0].payload).toMatchObject({
      tenant_id: TENANT,
      property_id: null,
      scope: "tenant",
      parent_id: null,
      is_storage: true,
    });
  });

  it("rejects tenant-level central stores with property or parent assignments", async () => {
    const fake = fakeSupabase();
    await expect(upsertLocation(fake.sb, USER, {
      ...input,
      scope: "tenant",
      propertyId: PROPERTY,
      parentId: null,
      isStorage: true,
    } as any)).rejects.toThrow("A tenant central store must be storage-only, tenant-scoped, and have no parent.");
    expect(fake.writes).toEqual([]);
  });

  it("prevents editing an existing property location into tenant scope", async () => {
    const fake = fakeSupabase();
    await expect(upsertLocation(fake.sb, USER, {
      ...input,
      id: PARENT,
      scope: "tenant",
      propertyId: null,
      parentId: null,
      isStorage: true,
    } as any)).rejects.toThrow("Location scope and property assignment cannot be changed after creation.");
    expect(fake.writes).toEqual([]);
  });
});
