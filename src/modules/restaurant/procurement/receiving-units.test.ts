/* eslint-disable @typescript-eslint/no-explicit-any -- fake Supabase client is untyped at this boundary. */
/**
 * O6 — unit conversion at goods-receipt posting.
 *
 * Root cause fixed: postGoodsReceipt used to write the accepted quantity
 * straight into the ledger in whatever unit the receipt line happened to be
 * captured in, with no regard for the item's actual stock unit. A
 * storekeeper receiving "5 cartons" of an item stocked in bottles (pack
 * size 24) would silently post 5 units of stock instead of 120 — a real
 * and dangerous data-integrity gap. Fixed by converting purchase-unit and
 * dimensionally-different units to the item's stock unit before the
 * movement is written, and refusing (before any line posts) when a
 * conversion isn't possible rather than guessing.
 *
 * Reuses the exact in-memory Supabase harness established in
 * receiving-governance.test.ts — the real postGoodsReceipt runs unmodified.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const movements: any[] = [];

vi.mock("../core/access.server", () => ({
  assertCapability: vi.fn(async () => true),
  assertTenantRead: vi.fn(async () => true),
  isPlatformAdmin: vi.fn(async () => true),
  rolesInTenant: vi.fn(async () => ["owner"]),
}));
vi.mock("../inventory/movements.server", () => ({
  insertMovement: vi.fn(async (_sb: unknown, _u: string, m: any) => {
    if (movements.some((x) => x.dedupeKey === m.dedupeKey)) return null;
    const row = { id: `mv-${movements.length + 1}`, ...m };
    movements.push(row);
    return row;
  }),
}));
vi.mock("../events/emit.server", () => ({ emitRestaurantEvent: vi.fn(async () => undefined) }));
vi.mock("./audit.server", () => ({
  nextDocumentNumber: vi.fn(async () => `GRN-${Math.random().toString(36).slice(2, 8)}`),
  recordProcurementAudit: vi.fn(async () => undefined),
}));
vi.mock("./pricing.server", () => ({ recordPriceObservation: vi.fn(async () => undefined) }));
vi.mock("./variances.server", () => ({ raiseVariance: vi.fn(async () => null) }));

import { createGoodsReceipt, postGoodsReceipt } from "./receiving.server";

type Row = Record<string, any>;
const db: Record<string, Row[]> = {};
let seq = 0;
const id = (p: string) => `${p}-${++seq}`;

function query(table: string) {
  const filters: Array<[string, any]> = [];
  const api: any = {
    _mode: "select" as "select" | "update" | "insert",
    _payload: null as any,
    select() {
      return api;
    },
    insert(payload: any) {
      api._mode = "insert";
      api._payload = payload;
      return api;
    },
    update(payload: any) {
      api._mode = "update";
      api._payload = payload;
      return api;
    },
    eq(col: string, val: any) {
      filters.push([col, val]);
      return api;
    },
    in(col: string, vals: any[]) {
      filters.push([col, { __in: vals }]);
      return api;
    },
    order() {
      return api;
    },
    limit() {
      return api;
    },
    match(rows: Row[]) {
      return rows.filter((r) =>
        filters.every(([c, v]) => (v && v.__in ? v.__in.includes(r[c]) : r[c] === v)),
      );
    },
    run() {
      db[table] ??= [];
      if (api._mode === "insert") {
        const payload = Array.isArray(api._payload) ? api._payload : [api._payload];
        const inserted = payload.map((p: Row) => ({ id: p.id ?? id(table), ...p }));
        db[table]!.push(...inserted);
        return Array.isArray(api._payload) ? inserted : inserted[0];
      }
      const hit = api.match(db[table]!);
      if (api._mode === "update") {
        for (const r of hit) Object.assign(r, api._payload);
        return hit;
      }
      return hit;
    },
    single() {
      const r = api.run();
      const row = Array.isArray(r) ? r[0] : r;
      return Promise.resolve(
        row ? { data: row, error: null } : { data: null, error: { message: "not found" } },
      );
    },
    maybeSingle() {
      const r = api.run();
      const row = Array.isArray(r) ? r[0] : r;
      return Promise.resolve({ data: row ?? null, error: null });
    },
    then(resolve: any) {
      const r = api.run();
      return Promise.resolve(resolve({ data: Array.isArray(r) ? r : [r], error: null }));
    },
  };
  return api;
}
const sb: any = { from: (t: string) => query(t) };

const TENANT = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";

const BOTTLE = "unit-bottle";
const CARTON = "unit-carton";
const ML = "unit-ml";
const LITRE = "unit-litre";
const KG = "unit-kg";

beforeEach(() => {
  movements.length = 0;
  for (const k of Object.keys(db)) delete db[k];
  db["restaurant_inventory_units"] = [
    { id: BOTTLE, dimension: "count", factor: 1, base_unit_id: null },
    { id: ML, dimension: "volume", factor: 1, base_unit_id: null },
    { id: LITRE, dimension: "volume", factor: 1000, base_unit_id: ML },
    { id: KG, dimension: "mass", factor: 1, base_unit_id: null },
  ];
  db["restaurant_inventory_batches"] = [];
  db["restaurant_goods_receipts"] = [];
  db["restaurant_goods_receipt_items"] = [];
});

function draftReceipt(itemId: string, unitId: string, quantity: number, unitCost: number) {
  return createGoodsReceipt(sb, USER, {
    tenantId: TENANT,
    currency: "TZS",
    post: false,
    lines: [
      {
        inventoryItemId: itemId,
        unitId,
        description: "Test item",
        orderedQuantity: 0,
        receivedQuantity: quantity,
        acceptedQuantity: quantity,
        rejectedQuantity: 0,
        damagedQuantity: 0,
        orderedUnitCost: 0,
        unitCost,
      },
    ],
  } as any);
}

describe("unit conversion at receiving", () => {
  it("passes the quantity through unchanged when the line is already in the item's stock unit", async () => {
    db["restaurant_inventory_items"] = [
      { id: "item-1", tenant_id: TENANT, unit_id: BOTTLE, purchase_unit_id: null, pack_size: 1 },
    ];
    const draft = await draftReceipt("item-1", BOTTLE, 12, 500);
    await postGoodsReceipt(sb, USER, TENANT, draft.id);

    expect(movements).toHaveLength(1);
    expect(movements[0].quantity).toBe(12);
    expect(movements[0].unitCost).toBe(500);
  });

  it("converts a purchase-unit delivery (cartons) into the stock unit (bottles) via pack size", async () => {
    db["restaurant_inventory_items"] = [
      { id: "item-1", tenant_id: TENANT, unit_id: BOTTLE, purchase_unit_id: CARTON, pack_size: 24 },
    ];
    // 5 cartons at 12,000/carton -> 120 bottles at 500/bottle. Total value unchanged: 60,000.
    const draft = await draftReceipt("item-1", CARTON, 5, 12000);
    await postGoodsReceipt(sb, USER, TENANT, draft.id);

    expect(movements).toHaveLength(1);
    expect(movements[0].quantity).toBe(120);
    expect(movements[0].unitCost).toBe(500);
    expect(movements[0].quantity * movements[0].unitCost).toBe(5 * 12000);
  });

  it("converts a dimensionally-different unit (litres received, ml stocked) via the units table factor", async () => {
    db["restaurant_inventory_items"] = [
      { id: "item-1", tenant_id: TENANT, unit_id: ML, purchase_unit_id: null, pack_size: 1 },
    ];
    // 2 litres at 5,000/litre -> 2,000 ml at 5/ml. Total value unchanged: 10,000.
    const draft = await draftReceipt("item-1", LITRE, 2, 5000);
    await postGoodsReceipt(sb, USER, TENANT, draft.id);

    expect(movements).toHaveLength(1);
    expect(movements[0].quantity).toBe(2000);
    expect(movements[0].unitCost).toBe(5);
  });

  it("refuses to post — atomically, before any line is written — when a unit cannot be converted", async () => {
    db["restaurant_inventory_items"] = [
      // Stock unit is mass (kg); the line was captured in a volume unit (litre) with no relation.
      { id: "item-1", tenant_id: TENANT, unit_id: KG, purchase_unit_id: null, pack_size: 1 },
    ];
    const draft = await draftReceipt("item-1", LITRE, 3, 4000);

    await expect(postGoodsReceipt(sb, USER, TENANT, draft.id)).rejects.toThrow(
      /cannot be converted|Cannot convert/i,
    );
    expect(movements).toHaveLength(0); // nothing posted — never a partial, wrong-unit write
    expect(db["restaurant_goods_receipts"]![0]!.status).toBe("draft"); // never silently marked posted
  });

  it("never guesses a bare unhandled unit — falls through unchanged only when the item itself has no stock unit recorded", async () => {
    db["restaurant_inventory_items"] = [
      { id: "item-1", tenant_id: TENANT, unit_id: null, purchase_unit_id: null, pack_size: 1 },
    ];
    const draft = await draftReceipt("item-1", CARTON, 5, 12000);
    await postGoodsReceipt(sb, USER, TENANT, draft.id);

    // No stock unit on the item at all — nothing to convert against, so the
    // captured quantity is trusted as-is rather than the post being blocked.
    expect(movements).toHaveLength(1);
    expect(movements[0].quantity).toBe(5);
  });
});
