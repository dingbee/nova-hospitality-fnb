/**
 * UAT-2 closure — receiving may establish that goods arrived, but only the
 * purchase-order state machine may move the order's lifecycle state.
 *
 * The Supabase client is replaced with a small in-memory store so the real
 * receiving service runs unmodified: the assertions are about its behaviour,
 * not about a re-implementation of it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const movements: any[] = [];
const events: any[] = [];

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
vi.mock("../events/emit.server", () => ({
  emitRestaurantEvent: vi.fn(async (_sb: unknown, _u: string, e: any) => {
    if (events.some((x) => x.dedupeKey === e.dedupeKey)) return null;
    events.push(e);
    return e;
  }),
}));
vi.mock("./audit.server", () => ({
  nextDocumentNumber: vi.fn(async () => `GRN-${Math.random().toString(36).slice(2, 8)}`),
  recordProcurementAudit: vi.fn(async () => undefined),
}));
vi.mock("./pricing.server", () => ({ recordPriceObservation: vi.fn(async () => undefined) }));
vi.mock("./variances.server", () => ({ raiseVariance: vi.fn(async () => null) }));

import { createGoodsReceipt, postGoodsReceipt } from "./receiving.server";

/* ---------------- minimal in-memory Supabase ---------------- */

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
      return Promise.resolve(row ? { data: row, error: null } : { data: null, error: { message: "not found" } });
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

function seedOrder(status: string, quantity = 100) {
  const orderId = id("po");
  const itemId = id("poi");
  db["restaurant_purchase_orders"] = [
    {
      id: orderId,
      tenant_id: TENANT,
      status,
      currency: "TZS",
      supplier_id: "sup-1",
      property_id: null,
      location_id: null,
      document_number: "PO-1",
      reference: "PO-1",
      correlation_id: "corr-1",
      expected_at: null,
    },
  ];
  db["restaurant_purchase_order_items"] = [
    {
      id: itemId,
      tenant_id: TENANT,
      purchase_order_id: orderId,
      description: "Tomatoes",
      quantity,
      unit_price: 1000,
      received_quantity: 0,
      accepted_quantity: 0,
      rejected_quantity: 0,
      inventory_item_id: "inv-1",
      unit_id: "unit-1",
    },
  ];
  db["restaurant_inventory_items"] = [{ id: "inv-1", tenant_id: TENANT, track_batches: false }];
  db["restaurant_inventory_batches"] = [];
  db["restaurant_goods_receipts"] = [];
  db["restaurant_goods_receipt_items"] = [];
  return { orderId, itemId };
}

const line = (itemId: string, qty: number) => ({
  purchaseOrderItemId: itemId,
  inventoryItemId: "inv-1",
  unitId: "unit-1",
  description: "Tomatoes",
  orderedQuantity: 100,
  receivedQuantity: qty,
  acceptedQuantity: qty,
  rejectedQuantity: 0,
  damagedQuantity: 0,
  orderedUnitCost: 1000,
  unitCost: 1000,
});

const orderStatus = (orderId: string) =>
  db["restaurant_purchase_orders"]!.find((o) => o.id === orderId)!.status;

beforeEach(() => {
  movements.length = 0;
  events.length = 0;
  for (const k of Object.keys(db)) delete db[k];
});

describe("receiving cannot bypass the purchase order state machine", () => {
  it("refuses to receive against a cancelled order and moves nothing", async () => {
    const { orderId, itemId } = seedOrder("cancelled");
    await expect(
      createGoodsReceipt(sb, USER, {
        tenantId: TENANT,
        purchaseOrderId: orderId,
        currency: "TZS",
        post: true,
        lines: [line(itemId, 40)],
      } as any),
    ).rejects.toThrow(/final|cannot be received/i);

    expect(orderStatus(orderId)).toBe("cancelled");
    expect(movements).toHaveLength(0);
    expect(events).toHaveLength(0);
    expect(db["restaurant_goods_receipts"]).toHaveLength(0);
  });

  it("refuses to resurrect an order cancelled after the receipt was drafted", async () => {
    const { orderId, itemId } = seedOrder("approved");
    const draft = await createGoodsReceipt(sb, USER, {
      tenantId: TENANT,
      purchaseOrderId: orderId,
      currency: "TZS",
      post: false,
      lines: [line(itemId, 40)],
    } as any);

    db["restaurant_purchase_orders"]![0]!.status = "cancelled";

    await expect(postGoodsReceipt(sb, USER, TENANT, draft.id)).rejects.toThrow(/final/i);
    expect(orderStatus(orderId)).toBe("cancelled");
    expect(movements).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  it("refuses to receive against an already received order", async () => {
    const { orderId, itemId } = seedOrder("received");
    await expect(
      createGoodsReceipt(sb, USER, {
        tenantId: TENANT,
        purchaseOrderId: orderId,
        currency: "TZS",
        post: true,
        lines: [line(itemId, 10)],
      } as any),
    ).rejects.toThrow(/final/i);
    expect(orderStatus(orderId)).toBe("received");
    expect(movements).toHaveLength(0);
  });

  it("refuses to receive against a draft order", async () => {
    const { orderId, itemId } = seedOrder("draft");
    await expect(
      createGoodsReceipt(sb, USER, {
        tenantId: TENANT,
        purchaseOrderId: orderId,
        currency: "TZS",
        post: true,
        lines: [line(itemId, 10)],
      } as any),
    ).rejects.toThrow(/draft/i);
    expect(orderStatus(orderId)).toBe("draft");
  });
});

describe("the legitimate fulfilment path still works", () => {
  it("moves approved → partially_received → received across two deliveries", async () => {
    const { orderId, itemId } = seedOrder("approved");

    const first = await createGoodsReceipt(sb, USER, {
      tenantId: TENANT,
      purchaseOrderId: orderId,
      currency: "TZS",
      post: true,
      lines: [line(itemId, 40)],
    } as any);
    expect(first.posted).toBe(true);
    expect(orderStatus(orderId)).toBe("partially_received");
    expect(movements).toHaveLength(1);
    expect(movements[0].quantity).toBe(40);

    await createGoodsReceipt(sb, USER, {
      tenantId: TENANT,
      purchaseOrderId: orderId,
      currency: "TZS",
      post: true,
      lines: [line(itemId, 60)],
    } as any);
    expect(orderStatus(orderId)).toBe("received");
    expect(movements).toHaveLength(2);
    expect(events).toHaveLength(2);
  });

  it("keeps a further partial delivery in partially_received without a duplicate transition", async () => {
    const { orderId, itemId } = seedOrder("approved", 100);
    await createGoodsReceipt(sb, USER, {
      tenantId: TENANT,
      purchaseOrderId: orderId,
      currency: "TZS",
      post: true,
      lines: [line(itemId, 30)],
    } as any);
    expect(orderStatus(orderId)).toBe("partially_received");
    await createGoodsReceipt(sb, USER, {
      tenantId: TENANT,
      purchaseOrderId: orderId,
      currency: "TZS",
      post: true,
      lines: [line(itemId, 30)],
    } as any);
    expect(orderStatus(orderId)).toBe("partially_received");
  });

  it("is idempotent when the same receipt is posted twice", async () => {
    const { orderId, itemId } = seedOrder("approved");
    const draft = await createGoodsReceipt(sb, USER, {
      tenantId: TENANT,
      purchaseOrderId: orderId,
      currency: "TZS",
      post: false,
      lines: [line(itemId, 100)],
    } as any);

    await postGoodsReceipt(sb, USER, TENANT, draft.id);
    const replay = await postGoodsReceipt(sb, USER, TENANT, draft.id);

    expect(replay.posted).toBe(true);
    expect(movements).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(db["restaurant_inventory_batches"]).toHaveLength(0);
    expect(orderStatus(orderId)).toBe("received");
  });

  it("posts inventory only for the accepted quantity", async () => {
    const { orderId, itemId } = seedOrder("approved");
    const draft = await createGoodsReceipt(sb, USER, {
      tenantId: TENANT,
      purchaseOrderId: orderId,
      currency: "TZS",
      post: false,
      lines: [
        {
          ...line(itemId, 50),
          acceptedQuantity: 45,
          rejectedQuantity: 5,
          rejectionReason: "Bruised on arrival",
        },
      ],
    } as any);
    await postGoodsReceipt(sb, USER, TENANT, draft.id);

    expect(movements).toHaveLength(1);
    expect(movements[0].quantity).toBe(45);
    expect(movements[0].movementType).toBe("purchase_receipt");
    expect(orderStatus(orderId)).toBe("partially_received");
  });
});