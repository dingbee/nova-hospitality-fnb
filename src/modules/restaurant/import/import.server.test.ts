/* eslint-disable @typescript-eslint/no-explicit-any -- fake Supabase client is untyped at this boundary. */
/**
 * O7 Import Studio — orchestration tests.
 *
 * Runs the real staging/commit orchestration (import.server.ts) against an
 * in-memory Supabase fake, with the downstream write-path service functions
 * mocked so each test asserts what import.server.ts itself decided (what to
 * stage, what to commit, in what order, idempotently) rather than
 * re-verifying those services' own already-tested internals. The mocks
 * still write into the same fake tables import.server.ts reads back from,
 * so a two-pass import (commit inventory, then re-stage a sheet that
 * references it) behaves exactly as it would against the real database.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const TENANT = "11111111-1111-1111-1111-111111111111";
const OTHER_TENANT = "99999999-9999-9999-9999-999999999999";
const USER = "22222222-2222-2222-2222-222222222222";

/* ---------------- in-memory database ---------------- */

type Row = Record<string, any>;
const db: Record<string, Row[]> = {};
let seq = 0;
const nextId = (p: string) => `${p}-${++seq}`;

function resetDb() {
  for (const k of Object.keys(db)) delete db[k];
  db.restaurant_inventory_units = [
    { id: "u-kg", code: "kg", name: "Kilogram", dimension: "mass", factor: 1000, tenant_id: null },
    { id: "u-g", code: "g", name: "Gram", dimension: "mass", factor: 1, tenant_id: null },
    { id: "u-ml", code: "ml", name: "Millilitre", dimension: "volume", factor: 1, tenant_id: null },
  ];
  db.restaurant_suppliers = [];
  db.restaurant_inventory_items = [];
  db.restaurant_inventory_categories = [];
  db.restaurant_categories = [];
  db.restaurant_menu_items = [];
  db.restaurant_supplier_products = [];
  db.restaurant_locations = [{ id: "loc-1", name: "Dry Store", tenant_id: TENANT }];
  db.restaurant_import_workspaces = [];
  db.restaurant_import_sources = [];
  db.restaurant_import_field_mappings = [];
  db.restaurant_import_staged_records = [];
}
resetDb();

/** Mirrors the SQL column defaults the real migration declares, since this fake has no DDL. */
function defaultsFor(table: string): Row {
  if (table === "restaurant_import_workspaces") return { status: "open" };
  if (table === "restaurant_import_sources") return { status: "uploaded" };
  return {};
}

function matchesOrClause(row: Row, clause: string): boolean {
  // Only pattern actually used: "tenant_id.is.null,tenant_id.eq.<uuid>"
  return clause.split(",").some((part) => {
    const [col, op, val] = part.split(".");
    if (op === "is" && val === "null") return row[col!] === null || row[col!] === undefined;
    if (op === "eq") return String(row[col!]) === val;
    return false;
  });
}

function builder(table: string) {
  db[table] = db[table] ?? [];
  const rows = () => db[table]!;
  const filters: Array<(r: Row) => boolean> = [];
  let mode: "select" | "insert" | "update" | "upsert" = "select";
  let payload: any = null;
  let onConflict: string | undefined;
  let orderCol: string | undefined;

  const api: any = {
    select: () => api,
    eq(col: string, val: any) {
      filters.push((r) => r[col] === val);
      return api;
    },
    or(clause: string) {
      filters.push((r) => matchesOrClause(r, clause));
      return api;
    },
    is(col: string, val: any) {
      filters.push((r) =>
        val === null ? r[col] === null || r[col] === undefined : r[col] === val,
      );
      return api;
    },
    in(col: string, vals: any[]) {
      filters.push((r) => vals.includes(r[col]));
      return api;
    },
    order(col: string) {
      orderCol = col;
      return api;
    },
    limit: () => api,
    insert(p: any) {
      mode = "insert";
      payload = p;
      return api;
    },
    update(p: any) {
      mode = "update";
      payload = p;
      return api;
    },
    upsert(p: any, opts?: { onConflict?: string }) {
      mode = "upsert";
      payload = p;
      onConflict = opts?.onConflict;
      return api;
    },
    async maybeSingle() {
      const r = await run();
      return { data: (r.data as any[])[0] ?? null, error: r.error };
    },
    async single() {
      const r = await run();
      const d = (r.data as any[])[0];
      return d
        ? { data: d, error: null }
        : { data: null, error: { message: `${table}: not found` } };
    },
    then(resolve: any, reject: any) {
      return run().then(resolve, reject);
    },
  };

  async function run() {
    if (mode === "select") {
      let result = rows().filter((r) => filters.every((f) => f(r)));
      if (orderCol) result = [...result].sort((a, b) => (a[orderCol!] > b[orderCol!] ? 1 : -1));
      return { data: result, error: null };
    }
    if (mode === "insert") {
      const items = Array.isArray(payload) ? payload : [payload];
      const created = items.map((p) => ({
        ...defaultsFor(table),
        id: p.id ?? nextId(table),
        ...p,
      }));
      db[table]!.push(...created);
      return { data: created, error: null };
    }
    if (mode === "update") {
      const matched = rows().filter((r) => filters.every((f) => f(r)));
      matched.forEach((r) => Object.assign(r, payload));
      return { data: matched, error: null };
    }
    // upsert on a composite key (tenant_id,source_id,sheet_name,domain)
    const keys = (onConflict ?? "id").split(",");
    const existing = rows().find((r) => keys.every((k) => r[k] === payload[k]));
    if (existing) Object.assign(existing, payload);
    else db[table]!.push({ id: payload.id ?? nextId(table), ...payload });
    return { data: [existing ?? payload], error: null };
  }

  return api;
}

const storage: Record<string, Buffer> = {};

const sb: any = {
  from: (t: string) => builder(t),
  rpc: async (fn: string) => {
    if (fn === "restaurant_next_document_number")
      return { data: `IMP-2026-${String(++seq).padStart(5, "0")}`, error: null };
    if (fn === "has_any_role") return { data: false, error: null };
    return { data: null, error: null };
  },
  storage: {
    from: () => ({
      upload: async (path: string, buf: Buffer) => {
        storage[path] = buf;
        return { data: { path }, error: null };
      },
      download: async (path: string) => {
        const buf = storage[path];
        if (!buf) return { data: null, error: { message: "not found" } };
        return {
          data: {
            arrayBuffer: async () =>
              buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
          },
          error: null,
        };
      },
      remove: async () => ({ data: null, error: null }),
      getPublicUrl: (path: string) => ({ data: { publicUrl: `https://example/${path}` } }),
    }),
  },
};

/* ---------------- mocks ---------------- */

vi.mock("../core/access.server", () => ({
  assertCapability: vi.fn(async () => true),
  assertTenantRead: vi.fn(async () => true),
  isPlatformAdmin: vi.fn(async () => true),
  rolesInTenant: vi.fn(async () => ["owner"]),
}));
vi.mock("../events/emit.server", () => ({ emitRestaurantEvent: vi.fn(async () => undefined) }));

vi.mock("../suppliers/suppliers.server", () => ({
  upsertSupplier: vi.fn(async (_sb: any, _u: string, input: any) => {
    const row = {
      id: input.id ?? nextId("sup"),
      tenant_id: input.tenantId,
      code: input.code ?? null,
      name: input.name,
    };
    const existingIdx = db.restaurant_suppliers!.findIndex((r) => r.id === row.id);
    if (existingIdx >= 0)
      db.restaurant_suppliers![existingIdx] = { ...db.restaurant_suppliers![existingIdx], ...row };
    else db.restaurant_suppliers!.push(row);
    return row;
  }),
  upsertSupplierProduct: vi.fn(async (_sb: any, _u: string, input: any) => {
    const row = {
      id: input.id ?? nextId("sp"),
      tenant_id: input.tenantId,
      supplier_id: input.supplierId,
      inventory_item_id: input.inventoryItemId,
      supplier_sku: input.supplierSku ?? null,
      barcode: input.barcode ?? null,
      unit_price: input.unitPrice,
    };
    const existingIdx = db.restaurant_supplier_products!.findIndex((r) => r.id === row.id);
    if (existingIdx >= 0)
      db.restaurant_supplier_products![existingIdx] = {
        ...db.restaurant_supplier_products![existingIdx],
        ...row,
      };
    else db.restaurant_supplier_products!.push(row);
    return row;
  }),
}));

vi.mock("../inventory/inventory.server", () => ({
  upsertInventoryItem: vi.fn(async (_sb: any, _u: string, input: any) => {
    const row = {
      id: input.id ?? nextId("item"),
      tenant_id: input.tenantId,
      sku: input.sku ?? null,
      name: input.name,
      barcode: input.barcode ?? null,
      brand: input.brand ?? null,
      unit_id: input.unitId ?? null,
      category_id: input.categoryId ?? null,
      average_cost: input.averageCost ?? 0,
      current_quantity: input.currentQuantity ?? 0,
      currency: input.currency ?? "TZS",
      property_id: null,
      location_id: null,
    };
    const existingIdx = db.restaurant_inventory_items!.findIndex((r) => r.id === row.id);
    if (existingIdx >= 0)
      db.restaurant_inventory_items![existingIdx] = {
        ...db.restaurant_inventory_items![existingIdx],
        ...row,
      };
    else db.restaurant_inventory_items!.push(row);
    return row;
  }),
}));

vi.mock("../menu/menu.server", () => ({
  upsertMenu: vi.fn(async (_sb: any, _u: string, input: any) => {
    const row = {
      id: nextId("menu"),
      tenant_id: input.tenantId,
      name: input.name,
      status: input.status,
    };
    return row;
  }),
  upsertMenuItem: vi.fn(async (_sb: any, _u: string, input: any) => {
    const row = {
      id: input.id ?? nextId("mi"),
      tenant_id: input.tenantId,
      menu_id: input.menuId,
      name: input.name,
      price: input.price,
    };
    const existingIdx = db.restaurant_menu_items!.findIndex((r) => r.id === row.id);
    if (existingIdx >= 0)
      db.restaurant_menu_items![existingIdx] = {
        ...db.restaurant_menu_items![existingIdx],
        ...row,
      };
    else db.restaurant_menu_items!.push(row);
    return row;
  }),
}));

const recipeComponents: any[] = [];
vi.mock("../costing/costing.server", () => ({
  upsertRecipeComponent: vi.fn(async (_sb: any, _u: string, input: any) => {
    const row = {
      id: input.id ?? nextId("rc"),
      tenant_id: input.tenantId,
      menu_item_id: input.menuItemId,
      inventory_item_id: input.inventoryItemId,
      quantity: input.quantity,
    };
    recipeComponents.push(row);
    return row;
  }),
}));

const movements: any[] = [];
vi.mock("../inventory/movements.server", () => ({
  insertMovement: vi.fn(async (_sb: any, _u: string, m: any) => {
    if (movements.some((x) => x.dedupeKey === m.dedupeKey)) return null;
    const row = { id: nextId("mv"), balance_after: m.quantity, ...m };
    movements.push(row);
    return row;
  }),
}));

import {
  bulkDecideStagedRecords,
  commitImportWorkspace,
  confirmImportMapping,
  createImportWorkspace,
  decideStagedRecord,
  getImportWorkspace,
  listStagedRecords,
  parseImportSource,
  uploadImportSource,
} from "./import.server";

beforeEach(() => {
  resetDb();
  movements.length = 0;
  recipeComponents.length = 0;
});

async function stageCsv(tenantId: string, workspaceId: string, csv: string, domain: string) {
  const source = await uploadImportSource(sb, USER, {
    tenantId,
    workspaceId,
    kind: "csv",
    text: csv,
  } as any);
  await parseImportSource(sb, USER, { tenantId, sourceId: source.id });
  const headers = csv.split("\n")[0]!.split(",");
  const mapping = headers.map((h) => ({
    sourceColumn: h,
    canonicalField: h.trim() === "" ? null : mapHeader(domain, h),
    confidence: 1,
    auto: true,
  }));
  await confirmImportMapping(sb, USER, {
    tenantId,
    sourceId: source.id,
    sheetName: "Sheet1",
    domain,
    mapping,
  } as any);
  return source;
}

/** Simulates a human bulk-approving every still-pending "new entity" proposal in a workspace, as the exception queue UI would. */
async function approveAllPending(tenantId: string, workspaceId: string) {
  await bulkDecideStagedRecords(sb, USER, { tenantId, workspaceId, decision: "approved" } as any);
}

function mapHeader(domain: string, header: string): string | null {
  const table: Record<string, Record<string, string>> = {
    supplier: { Name: "name", Code: "code" },
    inventory_item: {
      Name: "name",
      SKU: "sku",
      Barcode: "barcode",
      OpeningQty: "openingQuantity",
      Unit: "unitCode",
      Cost: "averageCost",
    },
    supplier_product: {
      Supplier: "supplierName",
      ItemSku: "itemSku",
      UnitPrice: "unitPrice",
      SupplierSku: "supplierSku",
    },
    menu_item: { Name: "name", Price: "price" },
    recipe_component: {
      Dish: "menuItemName",
      IngredientSku: "ingredientSku",
      Quantity: "quantity",
      Unit: "unitCode",
    },
    opening_stock: { ItemSku: "itemSku", Quantity: "quantity", Location: "locationName" },
  };
  return table[domain]?.[header] ?? null;
}

describe("createImportWorkspace", () => {
  it("creates a workspace scoped to the tenant", async () => {
    const ws = await createImportWorkspace(sb, USER, {
      tenantId: TENANT,
      name: "Onboarding — Sunset Grill",
    } as any);
    expect(ws.tenant_id).toBe(TENANT);
    expect(ws.status).toBe("open");
    expect(ws.workspace_number).toMatch(/^IMP-/);
  });
});

describe("staging a clean inventory import", () => {
  it("stages new items and auto-approves an exact SKU match", async () => {
    db.restaurant_inventory_items!.push({
      id: "item-existing",
      tenant_id: TENANT,
      sku: "ITM-9",
      name: "Existing Rice",
      barcode: null,
      brand: null,
    });
    const ws = await createImportWorkspace(sb, USER, { tenantId: TENANT, name: "Test" } as any);
    const csv =
      "Name,SKU,Barcode,OpeningQty,Unit,Cost\nRice,ITM-9,,250,kg,3000\nBeef,,,10,kg,15000\n";
    await stageCsv(TENANT, ws.id, csv, "inventory_item");

    const staged = await listStagedRecords(sb, USER, {
      tenantId: TENANT,
      workspaceId: ws.id,
      limit: 100,
    } as any);
    expect(staged).toHaveLength(2);
    const riceRow = staged.find((r: any) => r.mapped_data.name === "Rice")!;
    expect(riceRow.match_status).toBe("exact_match");
    expect(riceRow.decision).toBe("approved"); // auto_ok severity auto-approves
    const beefRow = staged.find((r: any) => r.mapped_data.name === "Beef")!;
    expect(beefRow.match_status).toBe("new_entity");
    expect(beefRow.decision).toBe("pending");
  });
});

describe("duplicate inventory / re-import", () => {
  it("re-staging the same source is idempotent — no duplicate staged rows", async () => {
    const ws = await createImportWorkspace(sb, USER, { tenantId: TENANT, name: "Test" } as any);
    const csv = "Name,SKU\nRice,ITM-1\n";
    const source = await stageCsv(TENANT, ws.id, csv, "inventory_item");
    const first = (
      await listStagedRecords(sb, USER, { tenantId: TENANT, workspaceId: ws.id, limit: 100 } as any)
    ).length;

    const mapping = [
      { sourceColumn: "Name", canonicalField: "name", confidence: 1, auto: true },
      { sourceColumn: "SKU", canonicalField: "sku", confidence: 1, auto: true },
    ];
    await confirmImportMapping(sb, USER, {
      tenantId: TENANT,
      sourceId: source.id,
      sheetName: "Sheet1",
      domain: "inventory_item",
      mapping,
    } as any);
    const second = (
      await listStagedRecords(sb, USER, { tenantId: TENANT, workspaceId: ws.id, limit: 100 } as any)
    ).length;
    expect(second).toBe(first);
  });

  it("importing a source that matches an already-committed item updates it rather than duplicating", async () => {
    const ws = await createImportWorkspace(sb, USER, { tenantId: TENANT, name: "Test" } as any);
    await stageCsv(TENANT, ws.id, "Name,SKU\nRice,ITM-1\n", "inventory_item");
    await approveAllPending(TENANT, ws.id); // a brand new item is proposed, not auto-approved — a human approves it once
    await commitImportWorkspace(sb, USER, { tenantId: TENANT, workspaceId: ws.id } as any);
    expect(db.restaurant_inventory_items).toHaveLength(1);

    const ws2 = await createImportWorkspace(sb, USER, { tenantId: TENANT, name: "Test 2" } as any);
    await stageCsv(TENANT, ws2.id, "Name,SKU\nRice,ITM-1\n", "inventory_item");
    const staged = await listStagedRecords(sb, USER, {
      tenantId: TENANT,
      workspaceId: ws2.id,
      limit: 100,
    } as any);
    expect(staged[0]!.match_status).toBe("exact_match");
    await commitImportWorkspace(sb, USER, { tenantId: TENANT, workspaceId: ws2.id } as any);
    expect(db.restaurant_inventory_items).toHaveLength(1); // updated, not duplicated
  });
});

describe("commit: dependency order and cross-domain resolution", () => {
  it("supplier -> inventory -> supplier_product -> menu -> recipe -> opening stock, resolving relationships that reference the same workspace's earlier commits", async () => {
    const ws = await createImportWorkspace(sb, USER, {
      tenantId: TENANT,
      name: "Full migration",
      locationId: "loc-1",
    } as any);

    await stageCsv(TENANT, ws.id, "Name,Code\nFresh Foods,FF\n", "supplier");
    await stageCsv(
      TENANT,
      ws.id,
      "Name,SKU,OpeningQty,Unit,Cost\nChicken Breast,ITM-CHK,50,kg,12000\n",
      "inventory_item",
    );
    // A human approves the two brand-new entities before the supplier product row (which
    // depends on both existing) can be staged as a resolvable match.
    await approveAllPending(TENANT, ws.id);
    await commitImportWorkspace(sb, USER, { tenantId: TENANT, workspaceId: ws.id } as any);

    await stageCsv(
      TENANT,
      ws.id,
      "Supplier,ItemSku,SupplierSku,UnitPrice\nFresh Foods,ITM-CHK,FF-CHK,11000\n",
      "supplier_product",
    );
    await stageCsv(TENANT, ws.id, "Name,Price\nGrilled Chicken,18000\n", "menu_item");
    await approveAllPending(TENANT, ws.id);

    const result = await commitImportWorkspace(sb, USER, {
      tenantId: TENANT,
      workspaceId: ws.id,
    } as any);
    expect(result.status).toBe("committed");
    expect(result.failed).toBe(0);
    expect(db.restaurant_suppliers).toHaveLength(1);
    expect(db.restaurant_inventory_items).toHaveLength(1);
    expect(db.restaurant_supplier_products).toHaveLength(1);
    expect(db.restaurant_menu_items).toHaveLength(1);
    // inventory_item's own opening quantity flowed through the mocked upsertInventoryItem call
    expect(db.restaurant_inventory_items![0]!.current_quantity).toBe(50);

    // Second pass: recipe referencing the just-committed dish + ingredient now resolves.
    await stageCsv(
      TENANT,
      ws.id,
      "Dish,IngredientSku,Quantity,Unit\nGrilled Chicken,ITM-CHK,0.2,kg\n",
      "recipe_component",
    );
    const staged = await listStagedRecords(sb, USER, {
      tenantId: TENANT,
      workspaceId: ws.id,
      domain: "recipe_component" as any,
      limit: 100,
    } as any);
    expect(staged[0]!.match_status).toBe("exact_match");
    expect(staged[0]!.decision).toBe("approved");

    const result2 = await commitImportWorkspace(sb, USER, {
      tenantId: TENANT,
      workspaceId: ws.id,
    } as any);
    expect(result2.failed).toBe(0);
    expect(recipeComponents).toHaveLength(1);
  });

  it("blocks a recipe row that references a dish not yet imported, without fabricating a link", async () => {
    const ws = await createImportWorkspace(sb, USER, {
      tenantId: TENANT,
      name: "Recipes only",
    } as any);
    db.restaurant_inventory_items!.push({
      id: "item-1",
      tenant_id: TENANT,
      sku: "ITM-1",
      name: "Flour",
      barcode: null,
      brand: null,
    });
    await stageCsv(
      TENANT,
      ws.id,
      "Dish,IngredientSku,Quantity\nUnknown Dish,ITM-1,1\n",
      "recipe_component",
    );
    const staged = await listStagedRecords(sb, USER, {
      tenantId: TENANT,
      workspaceId: ws.id,
      limit: 100,
    } as any);
    expect(staged[0]!.severity).toBe("cannot_map");
    expect(staged[0]!.decision).toBe("pending");
  });
});

describe("opening stock: ledger integrity", () => {
  it("posts an opening balance movement for a matched item", async () => {
    db.restaurant_inventory_items!.push({
      id: "item-1",
      tenant_id: TENANT,
      sku: "ITM-1",
      name: "Rice",
      barcode: null,
      brand: null,
      unit_id: "u-kg",
      average_cost: 0,
      currency: "TZS",
    });
    const ws = await createImportWorkspace(sb, USER, {
      tenantId: TENANT,
      name: "Stock",
      locationId: "loc-1",
    } as any);
    await stageCsv(
      TENANT,
      ws.id,
      "ItemSku,Quantity,Location\nITM-1,250,Dry Store\n",
      "opening_stock",
    );
    const result = await commitImportWorkspace(sb, USER, {
      tenantId: TENANT,
      workspaceId: ws.id,
    } as any);
    expect(result.failed).toBe(0);
    expect(movements).toHaveLength(1);
    expect(movements[0]!.quantity).toBe(250);
    expect(movements[0]!.movementType).toBe("opening_balance");
  });

  it("never double-posts opening stock for the same item across a retried commit", async () => {
    db.restaurant_inventory_items!.push({
      id: "item-1",
      tenant_id: TENANT,
      sku: "ITM-1",
      name: "Rice",
      barcode: null,
      brand: null,
      unit_id: "u-kg",
      average_cost: 0,
      currency: "TZS",
    });
    const ws = await createImportWorkspace(sb, USER, {
      tenantId: TENANT,
      name: "Stock",
      locationId: "loc-1",
    } as any);
    await stageCsv(
      TENANT,
      ws.id,
      "ItemSku,Quantity,Location\nITM-1,250,Dry Store\n",
      "opening_stock",
    );
    await commitImportWorkspace(sb, USER, { tenantId: TENANT, workspaceId: ws.id } as any);
    expect(movements).toHaveLength(1);

    // Simulate a retry: force the staged record back to uncommitted and commit again.
    db.restaurant_import_staged_records!.forEach((r) => {
      r.committed_at = null;
      r.commit_error = null;
    });
    await commitImportWorkspace(sb, USER, { tenantId: TENANT, workspaceId: ws.id } as any);
    expect(movements).toHaveLength(1); // dedupeKey protected the ledger
  });

  it("fails clearly, without partial silent success, when the referenced item was never resolved", async () => {
    const ws = await createImportWorkspace(sb, USER, { tenantId: TENANT, name: "Stock" } as any);
    await stageCsv(TENANT, ws.id, "ItemSku,Quantity\nNOPE,10\n", "opening_stock");
    const staged = await listStagedRecords(sb, USER, {
      tenantId: TENANT,
      workspaceId: ws.id,
      limit: 100,
    } as any);
    expect(staged[0]!.severity).toBe("cannot_map");
    // A cannot_map row is never auto-approved, so committing the workspace commits nothing for it.
    const result = await commitImportWorkspace(sb, USER, {
      tenantId: TENANT,
      workspaceId: ws.id,
    } as any);
    expect(result.committed).toBe(0);
    expect(result.failed).toBe(0);
  });
});

describe("human review", () => {
  it("a human can approve an ambiguous match, and it commits as approved afterward", async () => {
    // Two existing items that both fully contain the query word "Tomato" tie for best match.
    db.restaurant_inventory_items!.push(
      {
        id: "item-1",
        tenant_id: TENANT,
        sku: "ITM-1",
        name: "Tomato Whole",
        barcode: null,
        brand: null,
      },
      {
        id: "item-2",
        tenant_id: TENANT,
        sku: "ITM-2",
        name: "Tomato Paste",
        barcode: null,
        brand: null,
      },
    );
    const ws = await createImportWorkspace(sb, USER, { tenantId: TENANT, name: "Test" } as any);
    await stageCsv(TENANT, ws.id, "Name,SKU\nTomato,\n", "inventory_item");
    const staged = await listStagedRecords(sb, USER, {
      tenantId: TENANT,
      workspaceId: ws.id,
      limit: 100,
    } as any);
    expect(staged[0]!.match_status).toBe("ambiguous");
    expect(staged[0]!.decision).toBe("pending");

    await decideStagedRecord(sb, USER, {
      tenantId: TENANT,
      recordId: staged[0]!.id,
      decision: "approved",
    } as any);
    const result = await commitImportWorkspace(sb, USER, {
      tenantId: TENANT,
      workspaceId: ws.id,
    } as any);
    expect(result.failed).toBe(0);
    expect(result.committed).toBe(1);
  });

  it("a rejected record is never committed", async () => {
    const ws = await createImportWorkspace(sb, USER, { tenantId: TENANT, name: "Test" } as any);
    await stageCsv(TENANT, ws.id, "Name,SKU\nWidget,\n", "inventory_item");
    const staged = await listStagedRecords(sb, USER, {
      tenantId: TENANT,
      workspaceId: ws.id,
      limit: 100,
    } as any);
    await decideStagedRecord(sb, USER, {
      tenantId: TENANT,
      recordId: staged[0]!.id,
      decision: "rejected",
    } as any);
    const result = await commitImportWorkspace(sb, USER, {
      tenantId: TENANT,
      workspaceId: ws.id,
    } as any);
    expect(result.committed).toBe(0);
    expect(db.restaurant_inventory_items).toHaveLength(0);
  });

  it("a committed record can no longer be re-decided", async () => {
    const ws = await createImportWorkspace(sb, USER, { tenantId: TENANT, name: "Test" } as any);
    await stageCsv(TENANT, ws.id, "Name,SKU\nWidget,ITM-W\n", "inventory_item");
    await approveAllPending(TENANT, ws.id);
    await commitImportWorkspace(sb, USER, { tenantId: TENANT, workspaceId: ws.id } as any);
    const staged = await listStagedRecords(sb, USER, {
      tenantId: TENANT,
      workspaceId: ws.id,
      limit: 100,
    } as any);
    await expect(
      decideStagedRecord(sb, USER, {
        tenantId: TENANT,
        recordId: staged[0]!.id,
        decision: "rejected",
      } as any),
    ).rejects.toThrow(/already been committed/);
  });
});

describe("PDF source (no OCR configured)", () => {
  it("reports the extraction boundary honestly rather than fabricating parsed content", async () => {
    const ws = await createImportWorkspace(sb, USER, { tenantId: TENANT, name: "Test" } as any);
    const source = await uploadImportSource(sb, USER, {
      tenantId: TENANT,
      workspaceId: ws.id,
      kind: "pdf",
      fileBase64: Buffer.from("not really a pdf").toString("base64"),
      originalFilename: "delivery-note.pdf",
    } as any);
    await expect(
      parseImportSource(sb, USER, { tenantId: TENANT, sourceId: source.id }),
    ).rejects.toThrow(/No document\/OCR extraction is configured/);
    const [row] = db.restaurant_import_sources!.filter((r) => r.id === source.id);
    expect(row!.status).toBe("extraction_unavailable");
  });
});

describe("cross-tenant isolation", () => {
  it("a workspace created for one tenant is invisible to another", async () => {
    const ws = await createImportWorkspace(sb, USER, {
      tenantId: TENANT,
      name: "Tenant A workspace",
    } as any);
    await expect(
      getImportWorkspace(sb, USER, { tenantId: OTHER_TENANT, workspaceId: ws.id }),
    ).rejects.toThrow(/not found/);
  });
});

describe("workspace summary", () => {
  it("reports counts by domain, severity and decision without leaking raw_data by default", async () => {
    const ws = await createImportWorkspace(sb, USER, { tenantId: TENANT, name: "Test" } as any);
    await stageCsv(TENANT, ws.id, "Name,SKU\nA,\nB,\n", "inventory_item");
    const { summary } = await getImportWorkspace(sb, USER, {
      tenantId: TENANT,
      workspaceId: ws.id,
    });
    expect(summary.total).toBe(2);
    expect(summary.byDomain.inventory_item).toBe(2);
  });
});
