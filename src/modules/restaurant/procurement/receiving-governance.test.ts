/* eslint-disable @typescript-eslint/no-explicit-any -- fake Supabase rows are untyped at this boundary. */
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
const poBridgeMocks = vi.hoisted(() => ({
  createPurchaseOrder: vi.fn(),
  transitionPurchaseOrder: vi.fn(),
}));

vi.mock("../core/access.server", () => ({
  assertCapability: vi.fn(async () => true),
  assertTenantRead: vi.fn(async () => true),
  isPlatformAdmin: vi.fn(async () => true),
  rolesInTenant: vi.fn(async () => ["owner"]),
  getTenantScope: vi.fn(async () => ({})),
  resolveMultiPropertyScope: vi.fn(async () => null),
}));
vi.mock("../inventory/movements.server", () => ({
  insertMovement: vi.fn(async (_sb: unknown, _u: string, m: any) => {
    if (movements.some((x) => x.dedupeKey === m.dedupeKey)) return null;
    const row = { id: `mv-${movements.length + 1}`, ...m };
    movements.push(row);
    return row;
  }),
}));
vi.mock("../prepare/resolve.server", () => ({
  resolveTenantCurrency: vi.fn(async () => "TZS"),
}));
vi.mock("../purchasing/purchasing.server", () => ({
  createPurchaseOrder: (...args: any[]) => poBridgeMocks.createPurchaseOrder(...args),
  transitionPurchaseOrder: (...args: any[]) => poBridgeMocks.transitionPurchaseOrder(...args),
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
import { createIntelligentPurchaseOrders } from "./ask-lexibite.server";

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
    gte(col: string, value: any) {
      filters.push(["__gte:" + col, value]);
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
        filters.every(([c, v]) => {
          if (c.startsWith("__gte:")) return String(r[c.slice(6)] ?? "") >= String(v);
          return v && v.__in ? v.__in.includes(r[c]) : r[c] === v;
        }),
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
function rpc(name: string, args: any) {
  if (name === "restaurant_increment_po_item_fulfilment") {
    const rows = db["restaurant_purchase_order_items"] ?? [];
    const row = rows.find((r) => r.id === args._po_item_id && r.tenant_id === args._tenant);
    if (row) {
      row.received_quantity =
        Number(row.received_quantity ?? 0) + Number(args._received_delta ?? 0);
      row.accepted_quantity =
        Number(row.accepted_quantity ?? 0) + Number(args._accepted_delta ?? 0);
      row.rejected_quantity =
        Number(row.rejected_quantity ?? 0) + Number(args._rejected_delta ?? 0);
    }
    return Promise.resolve({ data: row ? [row] : [], error: null });
  }
  return Promise.resolve({ data: null, error: null });
}
const sb: any = { from: (t: string) => query(t), rpc };

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
  poBridgeMocks.createPurchaseOrder.mockReset();
  poBridgeMocks.transitionPurchaseOrder.mockReset();
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

describe("IA-BRIDGE-01 persisted procurement-to-receiving closure", () => {
  it("persists the intelligent PO, verifies an idempotent retry, then posts a partial receipt to the stock ledger", async () => {
    const supplierId = "sup-bridge";
    const inventoryId = "inv-bridge";
    const supplierProductId = "supplier-product-bridge";
    const stockUnitId = "unit-bridge";
    const purchaseOrderId = "po-bridge";
    const idempotencyKey = "77777777-7777-4777-8777-777777777777";
    const recent = new Date(Date.now() - 86400000).toISOString();

    db["restaurant_inventory_items"] = [
      {
        id: inventoryId,
        tenant_id: TENANT,
        property_id: null,
        location_id: null,
        name: "Tomatoes",
        current_quantity: 2,
        average_cost: 1000,
        currency: "TZS",
        unit_id: stockUnitId,
        purchase_unit_id: stockUnitId,
        pack_size: 1,
        track_batches: false,
      },
    ];
    db["restaurant_stock_movements"] = [
      {
        tenant_id: TENANT,
        property_id: null,
        location_id: null,
        inventory_item_id: inventoryId,
        movement_type: "consumption",
        quantity: 300,
        total_cost: 300000,
        occurred_at: recent,
      },
    ];
    db["restaurant_supplier_products"] = [
      {
        id: supplierProductId,
        tenant_id: TENANT,
        supplier_id: supplierId,
        inventory_item_id: inventoryId,
        unit_id: stockUnitId,
        unit_price: 1000,
        pack_size: 1,
        lead_time_days: 2,
        active: true,
      },
    ];
    db["restaurant_suppliers"] = [
      {
        id: supplierId,
        tenant_id: TENANT,
        name: "Bridge Supplier",
        lead_time_days: 2,
        reliability_score: 80,
        status: "active",
      },
    ];
    db["restaurant_purchase_orders"] = [];
    db["restaurant_purchase_order_items"] = [];
    db["restaurant_inventory_batches"] = [];
    db["restaurant_goods_receipts"] = [];
    db["restaurant_goods_receipt_items"] = [];

    poBridgeMocks.createPurchaseOrder.mockImplementation(
      async (_sb: any, _user: string, input: any) => {
        const po = {
          id: purchaseOrderId,
          tenant_id: input.tenantId,
          document_number: "PO-BRIDGE",
          reference: input.reference,
          status: "draft",
          supplier_id: input.supplierId,
          property_id: input.propertyId ?? null,
          location_id: input.locationId ?? null,
          total: input.lines.reduce(
            (sum: number, item: any) => sum + item.quantity * item.unitPrice,
            0,
          ),
          currency: input.currency,
          correlation_id: "corr-bridge",
          expected_at: null,
        };
        db["restaurant_purchase_orders"]!.push(po);
        for (const item of input.lines) {
          db["restaurant_purchase_order_items"]!.push({
            id: id("poi-bridge"),
            tenant_id: input.tenantId,
            purchase_order_id: purchaseOrderId,
            inventory_item_id: item.inventoryItemId,
            supplier_product_id: item.supplierProductId,
            unit_id: item.unitId,
            description: item.description,
            quantity: item.quantity,
            unit_price: item.unitPrice,
            received_quantity: 0,
            accepted_quantity: 0,
            rejected_quantity: 0,
          });
        }
        return {
          id: po.id,
          document_number: po.document_number,
          status: po.status,
          total: po.total,
          currency: po.currency,
        };
      },
    );

    const request = {
      tenantId: TENANT,
      inventoryItemIds: [],
      supplierId: supplierId,
      idempotencyKey,
      lineOverrides: [],
    };
    const first = await createIntelligentPurchaseOrders(sb, USER, request as any);
    const retry = await createIntelligentPurchaseOrders(sb, USER, request as any);
    expect(first.created[0]?.id).toBe(purchaseOrderId);
    expect(retry.created[0]?.id).toBe(purchaseOrderId);
    expect(poBridgeMocks.createPurchaseOrder).toHaveBeenCalledTimes(1);
    expect(db["restaurant_purchase_order_items"]).toHaveLength(1);

    const persistedPo = db["restaurant_purchase_orders"]![0]!;
    const persistedLine = db["restaurant_purchase_order_items"]![0]!;
    persistedPo.status = "approved";
    const receipt = await createGoodsReceipt(sb, USER, {
      tenantId: TENANT,
      purchaseOrderId,
      currency: "TZS",
      post: true,
      lines: [
        {
          purchaseOrderItemId: persistedLine.id,
          inventoryItemId: inventoryId,
          unitId: stockUnitId,
          description: "Tomatoes",
          orderedQuantity: persistedLine.quantity,
          receivedQuantity: 10,
          acceptedQuantity: 8,
          rejectedQuantity: 2,
          damagedQuantity: 0,
          orderedUnitCost: 1000,
          unitCost: 1000,
          rejectionReason: "Damaged on arrival",
        },
      ],
    } as any);

    expect(receipt.posted).toBe(true);
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({
      inventoryItemId: inventoryId,
      quantity: 8,
      movementType: "purchase_receipt",
    });
    expect(persistedLine.received_quantity).toBe(10);
    expect(persistedLine.accepted_quantity).toBe(8);
    expect(persistedLine.rejected_quantity).toBe(2);
    expect(persistedPo.status).toBe("partially_received");
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
