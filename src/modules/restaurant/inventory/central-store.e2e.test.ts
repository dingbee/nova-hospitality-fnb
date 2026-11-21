/* eslint-disable @typescript-eslint/no-explicit-any -- rows are untyped at this boundary. */
/**
 * Central store & procurement governance — full-stack acceptance suite.
 *
 * Runs the REAL server services (purchasing, procurement receiving,
 * transfers, Main Store overview) through a real supabase-js client against
 * PostgREST and a fully migrated PostgreSQL: every request carries a signed
 * user JWT, so RLS, SECURITY DEFINER helpers and the 0157 triggers are all
 * exercised exactly as in production. Nothing is mocked.
 *
 * Fixtures are synthetic tenants with random ids, seeded per run; no live or
 * production record is read or written.
 *
 * Skipped unless the harness is configured:
 *   NOVA_E2E_POSTGREST_URL   e.g. http://127.0.0.1:3901
 *   NOVA_E2E_JWT_SECRET      PostgREST jwt-secret
 *   NOVA_E2E_DATABASE_URL    superuser URL used only to seed fixtures
 */
import { createHmac, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";
import { createPurchaseOrder, transitionPurchaseOrder } from "../purchasing/purchasing.server";
import { createGoodsReceipt, postGoodsReceipt } from "../procurement/receiving.server";
import { convertRequestToOrder } from "../procurement/requests.server";
import {
  closeTransfer,
  createTransfer,
  dispatchTransfer,
  receiveTransfer,
} from "./transfers.server";
import { getCentralStoreStatus } from "./central-store.server";
import { getMainStoreOverview } from "./main-store.server";
import { createPurchaseOrderSchema } from "../core/contracts";
// Same startup registration the restaurant admin route performs, so events
// are recorded (and their RLS exercised) exactly as in the running app.
import "../intelligence/provider";

const URL_ = process.env.NOVA_E2E_POSTGREST_URL;
const SECRET = process.env.NOVA_E2E_JWT_SECRET;
const DB = process.env.NOVA_E2E_DATABASE_URL;
const enabled = Boolean(URL_ && SECRET && DB);

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
function jwt(sub: string, role = "authenticated") {
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ sub, role, aud: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600 });
  const sig = createHmac("sha256", SECRET!).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}
/** A real supabase-js client acting as one user; PostgREST is served at the root. */
function clientFor(userId: string) {
  return createClient("http://e2e.local", "anon-key-unused", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      headers: { Authorization: `Bearer ${jwt(userId)}` },
      fetch: (input: any, init?: any) =>
        fetch(String(input).replace("http://e2e.local/rest/v1", URL_!), init),
    },
  });
}
function sql(text: string): string {
  return execFileSync("psql", ["-X", "-At", "-v", "ON_ERROR_STOP=1", DB!, "-c", text], {
    encoding: "utf8",
  }).trim();
}

const id = () => randomUUID();
const T = id(); // tenant with central store
const TB = id(); // tenant without central store (property-level mode)
const P_KAR = id();
const P_MSA = id();
const P_B = id();
const L_HQ = id();
const L_KAR = id();
const L_B = id();
const U = {
  owner: id(),
  gm: id(),
  hqKeeper: id(),
  karManager: id(),
  karOfficer: id(),
  karKeeper: id(),
  ownerB: id(),
};
const S_ACTIVE = id();
const S_INACTIVE = id();
const S_B = id();
const I_BEEF = id();
const I_BITTERS = id();
const I_B = id();

const sb = (u: keyof typeof U) => clientFor(U[u]);
const directReason = "E2E central purchasing acceptance test";

function poInput(overrides: Record<string, unknown> = {}) {
  return createPurchaseOrderSchema.parse({
    tenantId: T,
    supplierId: S_ACTIVE,
    currency: "TZS",
    directReason,
    lines: [
      {
        description: "Angostura Bitters",
        inventoryItemId: I_BITTERS,
        quantity: 10,
        unitPrice: 12500,
      },
    ],
    ...overrides,
  });
}
const onHand = (item: string, loc: string) =>
  Number(
    sql(
      `SELECT coalesce(sum(quantity),0) FROM public.restaurant_stock_movements WHERE inventory_item_id='${item}' AND location_id='${loc}'`,
    ),
  );

async function approvedHqOrder(quantity = 10, unitPrice = 12500) {
  const po = await createPurchaseOrder(
    sb("owner"),
    U.owner,
    poInput({
      lines: [
        { description: "Angostura Bitters", inventoryItemId: I_BITTERS, quantity, unitPrice },
      ],
    }),
  );
  await transitionPurchaseOrder(sb("owner"), U.owner, {
    tenantId: T,
    id: po.id,
    status: "submitted",
  });
  await transitionPurchaseOrder(sb("gm"), U.gm, { tenantId: T, id: po.id, status: "approved" });
  const item = sql(
    `SELECT id FROM public.restaurant_purchase_order_items WHERE purchase_order_id='${po.id}'`,
  );
  return { po, itemId: item };
}
const grnLine = (itemId: string, received: number, accepted: number, rejected = 0, extra = {}) => ({
  purchaseOrderItemId: itemId,
  inventoryItemId: I_BITTERS,
  description: "Angostura Bitters",
  orderedQuantity: 10,
  receivedQuantity: received,
  acceptedQuantity: accepted,
  rejectedQuantity: rejected,
  damagedQuantity: 0,
  orderedUnitCost: 12500,
  unitCost: 12500,
  ...(rejected > 0 ? { rejectionReason: "Broken seal on delivery" } : {}),
  ...extra,
});

describe.skipIf(!enabled)("central store & procurement governance (full stack)", () => {
  beforeAll(() => {
    const users = Object.values(U)
      .map((u) => `('${u}', '${u}@e2e.invalid')`)
      .join(",");
    sql(`
      BEGIN;
      INSERT INTO auth.users (id, email) VALUES ${users};
      INSERT INTO public.restaurant_tenants (id, slug, name) VALUES
        ('${T}', 'e2e-${T.slice(0, 8)}', 'E2E Central Tenant'),
        ('${TB}', 'e2e-${TB.slice(0, 8)}', 'E2E Property Tenant');
      SET LOCAL session_replication_role = replica; -- fixture properties are already activated
      INSERT INTO public.restaurant_properties (id, tenant_id, slug, name, status) VALUES
        ('${P_KAR}', '${T}', 'kar', 'Kariakoo', 'active'),
        ('${P_MSA}', '${T}', 'msa', 'Msasani', 'active'),
        ('${P_B}', '${TB}', 'b', 'B Property', 'active');
      SET LOCAL session_replication_role = origin;
      INSERT INTO public.restaurant_locations (id, tenant_id, property_id, scope, slug, name, location_type, is_storage, status) VALUES
        ('${L_HQ}', '${T}', NULL, 'tenant', 'hq', 'HQ Unit', 'store', true, 'active'),
        ('${L_KAR}', '${T}', '${P_KAR}', 'property', 'kar-store', 'Kariakoo Store', 'store', true, 'active'),
        ('${L_B}', '${TB}', '${P_B}', 'property', 'b-store', 'B Store', 'store', true, 'active');
      INSERT INTO public.restaurant_members (tenant_id, property_id, user_id, role) VALUES
        ('${T}', NULL, '${U.owner}', 'owner'),
        ('${T}', NULL, '${U.gm}', 'general_manager'),
        ('${T}', NULL, '${U.hqKeeper}', 'inventory_manager'),
        ('${T}', '${P_KAR}', '${U.karManager}', 'restaurant_manager'),
        ('${T}', '${P_KAR}', '${U.karOfficer}', 'purchasing_officer'),
        ('${T}', '${P_KAR}', '${U.karKeeper}', 'inventory_manager'),
        ('${TB}', NULL, '${U.ownerB}', 'owner');
      INSERT INTO public.restaurant_suppliers (id, tenant_id, name, status) VALUES
        ('${S_ACTIVE}', '${T}', 'E2E Active Supplier', 'active'),
        ('${S_INACTIVE}', '${T}', 'E2E Inactive Supplier', 'inactive'),
        ('${S_B}', '${TB}', 'E2E B Supplier', 'active');
      INSERT INTO public.restaurant_inventory_items (id, tenant_id, name, average_cost, currency) VALUES
        ('${I_BEEF}', '${T}', 'Beef topside', 18000, 'TZS'),
        ('${I_BITTERS}', '${T}', 'Angostura Bitters', 12500, 'TZS'),
        ('${I_B}', '${TB}', 'B Flour', 2000, 'TZS');
      -- Opening balances through the canonical ledger.
      INSERT INTO public.restaurant_stock_movements (tenant_id, location_id, inventory_item_id, movement_type, quantity, unit_cost, reason) VALUES
        ('${T}', '${L_HQ}', '${I_BEEF}', 'opening_balance', 14, 18000, 'E2E opening'),
        ('${T}', '${L_KAR}', '${I_BEEF}', 'opening_balance', 200, 18000, 'E2E opening');
      COMMIT;
    `);
  });

  /* ---------------- Central store ---------------- */

  it("1. resolves the active HQ Unit as the tenant central store", async () => {
    const status = await getCentralStoreStatus(sb("owner"), T);
    expect(status).toMatchObject({
      resolution: "active",
      active: true,
      locationId: L_HQ,
      name: "HQ Unit",
    });
  });

  it("2. property-only staff cannot open the Main Store workspace", async () => {
    await expect(getMainStoreOverview(sb("karManager"), U.karManager, T)).rejects.toThrow(
      /Forbidden/,
    );
  });

  it("3. tenant-wide staff get the Main Store workspace with the 14 kg HQ balance", async () => {
    const overview: any = await getMainStoreOverview(sb("hqKeeper"), U.hqKeeper, T);
    expect(overview.active).toBe(true);
    const beef = overview.stock.find((s: any) => s.itemId === I_BEEF);
    expect(beef.onHand).toBe(14);
  });

  it("4. missing / broken configuration produces a clear result, never a silent fallback", async () => {
    expect((await getCentralStoreStatus(sb("ownerB"), TB)).resolution).toBe("not_configured");
    await expect(getCentralStoreStatus(sb("ownerB"), T)).rejects.toThrow(/Forbidden/);
    sql(`UPDATE public.restaurant_locations SET status='inactive' WHERE id='${L_HQ}'`);
    try {
      expect((await getCentralStoreStatus(sb("owner"), T)).resolution).toBe("inactive");
      await expect(createPurchaseOrder(sb("owner"), U.owner, poInput())).rejects.toThrow(
        /CENTRAL_STORE_UNRESOLVED/,
      );
      const overview: any = await getMainStoreOverview(sb("owner"), U.owner, T);
      expect(overview.active).toBe(false);
    } finally {
      sql(`UPDATE public.restaurant_locations SET status='active' WHERE id='${L_HQ}'`);
    }
  });

  /* ---------------- Purchase orders ---------------- */

  it("7. a direct PO without a destination resolves to HQ Unit", async () => {
    const po = await createPurchaseOrder(sb("owner"), U.owner, poInput());
    const row = sql(
      `SELECT coalesce(property_id::text,'-')||'|'||location_id||'|'||(metadata->'destination'->>'resolved_by') FROM public.restaurant_purchase_orders WHERE id='${po.id}'`,
    );
    expect(row).toBe(`-|${L_HQ}|central_store_policy`);
  });

  it("7b. a property-originated direct PO goes to HQ and keeps its originating property", async () => {
    const po = await createPurchaseOrder(sb("owner"), U.owner, poInput({ propertyId: P_KAR }));
    expect(
      sql(
        `SELECT location_id||'|'||(metadata->'destination'->>'originating_property_id') FROM public.restaurant_purchase_orders WHERE id='${po.id}'`,
      ),
    ).toBe(`${L_HQ}|${P_KAR}`);
  });

  it("8. a PO can never be stored unassigned, even by a direct table write", async () => {
    const { error } = await sb("owner")
      .from("restaurant_purchase_orders")
      .insert({ tenant_id: T, reference: `RAW-${id().slice(0, 6)}`, supplier_id: S_ACTIVE });
    expect(error?.message).toMatch(/PO_DESTINATION_UNRESOLVED/);
  });

  it("9. inactive suppliers are rejected by the service and by a manipulated direct write", async () => {
    await expect(
      createPurchaseOrder(sb("owner"), U.owner, poInput({ supplierId: S_INACTIVE })),
    ).rejects.toThrow(/PO_SUPPLIER_INACTIVE/);
    const { error } = await sb("owner")
      .from("restaurant_purchase_orders")
      .insert({
        tenant_id: T,
        location_id: L_HQ,
        reference: `RAW-${id().slice(0, 6)}`,
        supplier_id: S_INACTIVE,
      });
    expect(error?.message).toMatch(/PO_SUPPLIER_INACTIVE/);
  });

  it("9b. a supplier deactivated after submission blocks approval; the order is left intact", async () => {
    const po = await createPurchaseOrder(sb("owner"), U.owner, poInput());
    await transitionPurchaseOrder(sb("owner"), U.owner, {
      tenantId: T,
      id: po.id,
      status: "submitted",
    });
    sql(`UPDATE public.restaurant_suppliers SET status='inactive' WHERE id='${S_ACTIVE}'`);
    try {
      await expect(
        transitionPurchaseOrder(sb("gm"), U.gm, { tenantId: T, id: po.id, status: "approved" }),
      ).rejects.toThrow(/PO_SUPPLIER_INACTIVE/);
      expect(sql(`SELECT status FROM public.restaurant_purchase_orders WHERE id='${po.id}'`)).toBe(
        "submitted",
      );
    } finally {
      sql(`UPDATE public.restaurant_suppliers SET status='active' WHERE id='${S_ACTIVE}'`);
    }
  });

  it("10. zero, missing and negative prices are rejected under normal rules", async () => {
    await expect(
      createPurchaseOrder(
        sb("owner"),
        U.owner,
        poInput({ lines: [{ description: "Free?", quantity: 1, unitPrice: 0 }] }),
      ),
    ).rejects.toThrow(/PO_PRICE_REQUIRED/);
    expect(() =>
      poInput({ lines: [{ description: "Neg", quantity: 1, unitPrice: -5 }] }),
    ).toThrow();
    expect(() => poInput({ lines: [{ description: "Missing", quantity: 1 }] })).toThrow();
    expect(() =>
      poInput({ lines: [{ description: "Qty", quantity: 0, unitPrice: 10 }] }),
    ).toThrow();
  });

  it("11. an authorised zero-price exception needs a justification and is audited", async () => {
    const po = await createPurchaseOrder(
      sb("owner"),
      U.owner,
      poInput({
        lines: [
          {
            description: "Sample case",
            quantity: 1,
            unitPrice: 0,
            priceExceptionReason: "Supplier-funded tasting sample",
          },
          {
            description: "Angostura Bitters",
            inventoryItemId: I_BITTERS,
            quantity: 2,
            unitPrice: 12500,
          },
        ],
      }),
    );
    expect(
      sql(
        `SELECT price_exception_authorised_by FROM public.restaurant_purchase_order_items WHERE purchase_order_id='${po.id}' AND unit_price=0`,
      ),
    ).toBe(U.owner);
    expect(
      sql(
        `SELECT count(*) FROM public.restaurant_procurement_audit WHERE document_id='${po.id}' AND action='zero_price_exception_authorised'`,
      ),
    ).toBe("1");
    await transitionPurchaseOrder(sb("owner"), U.owner, {
      tenantId: T,
      id: po.id,
      status: "submitted",
    });
  });

  it("12. the server calculates and reconciles line and order totals", async () => {
    const po = await createPurchaseOrder(
      sb("owner"),
      U.owner,
      poInput({
        lines: [
          { description: "A", quantity: 3, unitPrice: 333.335 },
          { description: "B", quantity: 1.5, unitPrice: 1000.1 },
        ],
      }),
    );
    const totals = sql(
      `SELECT o.subtotal||'|'||o.total||'|'||(SELECT sum(line_total) FROM public.restaurant_purchase_order_items i WHERE i.purchase_order_id=o.id) FROM public.restaurant_purchase_orders o WHERE o.id='${po.id}'`,
    );
    // 3 × 333.335 = 1000.005 → 1000.01; 1.5 × 1000.1 = 1500.15
    expect(totals).toBe("2500.16|2500.16|2500.16");
  });

  it("13. unauthorized users cannot approve (property-scoped approver, requester, outsider)", async () => {
    const po = await createPurchaseOrder(sb("owner"), U.owner, poInput());
    await transitionPurchaseOrder(sb("owner"), U.owner, {
      tenantId: T,
      id: po.id,
      status: "submitted",
    });
    await expect(
      transitionPurchaseOrder(sb("karManager"), U.karManager, {
        tenantId: T,
        id: po.id,
        status: "approved",
      }),
    ).rejects.toThrow(/Forbidden|not found/i);
    await expect(
      transitionPurchaseOrder(sb("owner"), U.owner, { tenantId: T, id: po.id, status: "approved" }),
    ).rejects.toThrow(/Separation of duties/);
    await expect(
      transitionPurchaseOrder(sb("ownerB"), U.ownerB, {
        tenantId: T,
        id: po.id,
        status: "approved",
      }),
    ).rejects.toThrow(/not found|Forbidden/i);
    expect(sql(`SELECT status FROM public.restaurant_purchase_orders WHERE id='${po.id}'`)).toBe(
      "submitted",
    );
    // Property-scoped staff cannot even see the central-store order.
    const { data } = await sb("karOfficer")
      .from("restaurant_purchase_orders")
      .select("id")
      .eq("id", po.id);
    expect(data).toEqual([]);
  });

  it("14. an approved PO does not change inventory", async () => {
    const before = onHand(I_BITTERS, L_HQ);
    const { po } = await approvedHqOrder();
    expect(sql(`SELECT status FROM public.restaurant_purchase_orders WHERE id='${po.id}'`)).toBe(
      "approved",
    );
    expect(onHand(I_BITTERS, L_HQ)).toBe(before);
  });

  it("14b. a submitted (unapproved) PO cannot be received", async () => {
    const po = await createPurchaseOrder(sb("owner"), U.owner, poInput());
    await transitionPurchaseOrder(sb("owner"), U.owner, {
      tenantId: T,
      id: po.id,
      status: "submitted",
    });
    const item = sql(
      `SELECT id FROM public.restaurant_purchase_order_items WHERE purchase_order_id='${po.id}'`,
    );
    await expect(
      createGoodsReceipt(sb("hqKeeper"), U.hqKeeper, {
        tenantId: T,
        purchaseOrderId: po.id,
        currency: "TZS",
        post: true,
        lines: [grnLine(item, 10, 10)],
      } as any),
    ).rejects.toThrow(/not been approved/);
  });

  it("requisition-originated orders keep their origin and follow central-store policy", async () => {
    const req = id();
    sql(`
      INSERT INTO public.restaurant_purchase_requests (id, tenant_id, property_id, document_number, status, requested_by, currency)
      VALUES ('${req}', '${T}', '${P_KAR}', 'PR-E2E-${req.slice(0, 6)}', 'approved', '${U.karOfficer}', 'TZS');
      INSERT INTO public.restaurant_purchase_request_items (tenant_id, purchase_request_id, inventory_item_id, description, quantity, estimated_unit_cost)
      VALUES ('${T}', '${req}', '${I_BITTERS}', 'Angostura Bitters', 6, 12000);
    `);
    await expect(
      convertRequestToOrder(sb("owner"), U.owner, {
        tenantId: T,
        requestId: req,
        supplierId: S_INACTIVE,
      } as any),
    ).rejects.toThrow(/PO_SUPPLIER_INACTIVE/);
    const po: any = await convertRequestToOrder(sb("owner"), U.owner, {
      tenantId: T,
      requestId: req,
      supplierId: S_ACTIVE,
    } as any);
    expect(
      sql(
        `SELECT location_id||'|'||purchase_request_id||'|'||(metadata->'destination'->>'originating_property_id')||'|'||total FROM public.restaurant_purchase_orders WHERE id='${po.id}'`,
      ),
    ).toBe(`${L_HQ}|${req}|${P_KAR}|72000.00`);
  });

  /* ---------------- Goods receiving ---------------- */

  it("15–16, 20. complete and partial deliveries post accepted stock and reconcile", async () => {
    const before = onHand(I_BITTERS, L_HQ);
    const { po, itemId } = await approvedHqOrder(10);
    const first: any = await createGoodsReceipt(sb("hqKeeper"), U.hqKeeper, {
      tenantId: T,
      purchaseOrderId: po.id,
      currency: "TZS",
      post: true,
      lines: [grnLine(itemId, 4, 4)],
    } as any);
    expect(first.orderStatus).toBe("partially_received");
    expect(
      sql(
        `SELECT received_quantity||'/'||quantity FROM public.restaurant_purchase_order_items WHERE id='${itemId}'`,
      ),
    ).toBe("4.0000/10.0000");
    const second: any = await createGoodsReceipt(sb("hqKeeper"), U.hqKeeper, {
      tenantId: T,
      purchaseOrderId: po.id,
      currency: "TZS",
      post: true,
      lines: [grnLine(itemId, 6, 6)],
    } as any);
    expect(second.orderStatus).toBe("received");
    expect(onHand(I_BITTERS, L_HQ)).toBe(before + 10);
    // PO ⇄ GRN ⇄ ledger reconcile for this order.
    const grnValue = Number(
      sql(
        `SELECT sum(accepted_value) FROM public.restaurant_goods_receipts WHERE purchase_order_id='${po.id}' AND status='posted'`,
      ),
    );
    const ledgerValue = Number(
      sql(
        `SELECT sum(m.total_cost) FROM public.restaurant_stock_movements m JOIN public.restaurant_goods_receipts g ON g.id=m.reference_id WHERE g.purchase_order_id='${po.id}'`,
      ),
    );
    expect(grnValue).toBe(125000);
    expect(ledgerValue).toBe(125000);
  });

  it("17, 19. rejected quantities never enter stock and the discrepancy is traceable", async () => {
    const before = onHand(I_BITTERS, L_HQ);
    const { po, itemId } = await approvedHqOrder(10);
    const grn: any = await createGoodsReceipt(sb("hqKeeper"), U.hqKeeper, {
      tenantId: T,
      purchaseOrderId: po.id,
      currency: "TZS",
      post: true,
      lines: [grnLine(itemId, 10, 7, 3)],
    } as any);
    expect(onHand(I_BITTERS, L_HQ)).toBe(before + 7);
    expect(
      sql(
        `SELECT accepted_quantity||'/'||rejected_quantity FROM public.restaurant_purchase_order_items WHERE id='${itemId}'`,
      ),
    ).toBe("7.000/3.000");
    expect(
      Number(
        sql(
          `SELECT count(*) FROM public.restaurant_procurement_variances WHERE receipt_id='${grn.id}' AND variance_type='quality'`,
        ),
      ),
    ).toBe(1);
  });

  it("18. duplicate GRN posting is prevented", async () => {
    const before = onHand(I_BITTERS, L_HQ);
    const { po, itemId } = await approvedHqOrder(5);
    const draft: any = await createGoodsReceipt(sb("hqKeeper"), U.hqKeeper, {
      tenantId: T,
      purchaseOrderId: po.id,
      currency: "TZS",
      post: false,
      lines: [grnLine(itemId, 5, 5)],
    } as any);
    await postGoodsReceipt(sb("hqKeeper"), U.hqKeeper, T, draft.id);
    await postGoodsReceipt(sb("hqKeeper"), U.hqKeeper, T, draft.id);
    await Promise.allSettled([
      postGoodsReceipt(sb("hqKeeper"), U.hqKeeper, T, draft.id),
      postGoodsReceipt(sb("gm"), U.gm, T, draft.id),
    ]);
    expect(onHand(I_BITTERS, L_HQ)).toBe(before + 5);
    expect(
      sql(
        `SELECT received_quantity FROM public.restaurant_purchase_order_items WHERE id='${itemId}'`,
      ),
    ).toBe("5.0000");
  });

  it("receiving cannot be redirected away from the order's destination, nor by property staff", async () => {
    const { po, itemId } = await approvedHqOrder(3);
    await expect(
      createGoodsReceipt(sb("owner"), U.owner, {
        tenantId: T,
        purchaseOrderId: po.id,
        locationId: L_KAR,
        currency: "TZS",
        post: true,
        lines: [grnLine(itemId, 3, 3)],
      } as any),
    ).rejects.toThrow(/destination/);
    await expect(
      createGoodsReceipt(sb("karKeeper"), U.karKeeper, {
        tenantId: T,
        purchaseOrderId: po.id,
        currency: "TZS",
        post: true,
        lines: [grnLine(itemId, 3, 3)],
      } as any),
    ).rejects.toThrow(/not found|Forbidden/i);
  });

  /* ---------------- Transfers ---------------- */

  it("21–27. Kariakoo → HQ transfer: in transit, partial receipts, exactly-once posting, closure", async () => {
    const karBefore = onHand(I_BEEF, L_KAR);
    const hqBefore = onHand(I_BEEF, L_HQ);
    expect(hqBefore).toBe(14);

    const created = await createTransfer(sb("hqKeeper"), U.hqKeeper, {
      tenantId: T,
      sourceLocationId: L_KAR,
      destinationLocationId: L_HQ,
      requiresApproval: false,
      submit: true,
      lines: [{ inventoryItemId: I_BEEF, requestedQuantity: 102 }],
    } as any);
    const lineId = sql(
      `SELECT id FROM public.restaurant_stock_transfer_lines WHERE transfer_id='${created.id}'`,
    );
    await dispatchTransfer(sb("hqKeeper"), U.hqKeeper, {
      tenantId: T,
      transferId: created.id,
      lines: [{ lineId, dispatchedQuantity: 102 }],
    });
    // 21–22: in transit; destination unchanged at dispatch.
    expect(
      sql(`SELECT status FROM public.restaurant_stock_transfers WHERE id='${created.id}'`),
    ).toBe("dispatched");
    expect(onHand(I_BEEF, L_KAR)).toBe(karBefore - 102);
    expect(onHand(I_BEEF, L_HQ)).toBe(14);

    // 26: unauthorized receipt (property-only storekeeper) is blocked.
    await expect(
      receiveTransfer(sb("karKeeper"), U.karKeeper, {
        tenantId: T,
        transferId: created.id,
        lines: [{ lineId, receivedQuantity: 102, rejectedQuantity: 0, damagedQuantity: 0 }],
      }),
    ).rejects.toThrow(/Forbidden|not found/i);
    expect(onHand(I_BEEF, L_HQ)).toBe(14);

    // 23: partial receipt.
    const r1 = await receiveTransfer(sb("gm"), U.gm, {
      tenantId: T,
      transferId: created.id,
      lines: [
        {
          lineId,
          receivedQuantity: 60,
          rejectedQuantity: 0,
          damagedQuantity: 0,
          expectedPriorAccounted: 0,
        },
      ],
    });
    expect(r1.status).toBe("partially_received");
    expect(onHand(I_BEEF, L_HQ)).toBe(74);

    // 24: a stale/replayed submission is refused, never posted twice.
    await expect(
      receiveTransfer(sb("gm"), U.gm, {
        tenantId: T,
        transferId: created.id,
        lines: [
          {
            lineId,
            receivedQuantity: 60,
            rejectedQuantity: 0,
            damagedQuantity: 0,
            expectedPriorAccounted: 0,
          },
        ],
      }),
    ).rejects.toThrow(/received by someone else/);
    expect(onHand(I_BEEF, L_HQ)).toBe(74);

    // Over-receipt beyond what is still in transit is refused.
    await expect(
      receiveTransfer(sb("gm"), U.gm, {
        tenantId: T,
        transferId: created.id,
        lines: [{ lineId, receivedQuantity: 50, rejectedQuantity: 0, damagedQuantity: 0 }],
      }),
    ).rejects.toThrow(/still in transit/);

    // 25: rejected/damaged quantities need a reason and never enter stock.
    await expect(
      receiveTransfer(sb("gm"), U.gm, {
        tenantId: T,
        transferId: created.id,
        lines: [{ lineId, receivedQuantity: 30, rejectedQuantity: 2, damagedQuantity: 0 }],
      }),
    ).rejects.toThrow(/reason is required/);
    const r2 = await receiveTransfer(sb("gm"), U.gm, {
      tenantId: T,
      transferId: created.id,
      lines: [
        {
          lineId,
          receivedQuantity: 30,
          rejectedQuantity: 2,
          damagedQuantity: 0,
          expectedPriorAccounted: 60,
          notes: "Two kg spoiled in transit",
        },
      ],
    });
    expect(r2.status).toBe("partially_received");
    expect(onHand(I_BEEF, L_HQ)).toBe(104);
    expect(
      sql(
        `SELECT received_quantity||'/'||rejected_quantity||'/'||variance_quantity FROM public.restaurant_stock_transfer_lines WHERE id='${lineId}'`,
      ),
    ).toBe("90/2/10");
    // 24: exactly two ledger credits for the two receiving events.
    expect(
      sql(
        `SELECT count(*)||'/'||sum(quantity) FROM public.restaurant_stock_movements WHERE transfer_line_id='${lineId}' AND movement_type='transfer_in'`,
      ),
    ).toBe("2/90.0000");

    // 27: closure requires reconciliation authority and a reason.
    await expect(
      closeTransfer(sb("karKeeper"), U.karKeeper, {
        tenantId: T,
        transferId: created.id,
        reason: "Lost in transit, driver report filed",
      }),
    ).rejects.toThrow(/Forbidden|not found/i);
    const closed = await closeTransfer(sb("gm"), U.gm, {
      tenantId: T,
      transferId: created.id,
      reason: "Remaining 10 kg lost in transit, driver report filed",
    });
    expect(closed.status).toBe("completed");
    expect(closed.unaccountedValue).toBe(180000);
    expect(onHand(I_BEEF, L_HQ)).toBe(104); // nothing credited at closure
    // Source ledger reconciles with the dispatch.
    expect(onHand(I_BEEF, L_KAR)).toBe(karBefore - 102);
    await expect(
      receiveTransfer(sb("gm"), U.gm, {
        tenantId: T,
        transferId: created.id,
        lines: [{ lineId, receivedQuantity: 1, rejectedQuantity: 0, damagedQuantity: 0 }],
      }),
    ).rejects.toThrow(/cannot be received/);
  });

  it("completion covers every line, not only the lines named in a receipt", async () => {
    const created = await createTransfer(sb("hqKeeper"), U.hqKeeper, {
      tenantId: T,
      sourceLocationId: L_HQ,
      destinationLocationId: L_KAR,
      requiresApproval: false,
      submit: true,
      lines: [
        { inventoryItemId: I_BEEF, requestedQuantity: 2 },
        { inventoryItemId: I_BITTERS, requestedQuantity: 1 },
      ],
    } as any);
    const lines = sql(
      `SELECT string_agg(id::text||':'||inventory_item_id::text, ',') FROM public.restaurant_stock_transfer_lines WHERE transfer_id='${created.id}'`,
    )
      .split(",")
      .map((s) => s.split(":"));
    const beefLine = lines.find(([, item]) => item === I_BEEF)![0]!;
    const bittersLine = lines.find(([, item]) => item === I_BITTERS)![0]!;
    await dispatchTransfer(sb("hqKeeper"), U.hqKeeper, {
      tenantId: T,
      transferId: created.id,
      lines: [
        { lineId: beefLine, dispatchedQuantity: 2 },
        { lineId: bittersLine, dispatchedQuantity: 1 },
      ],
    });
    const r = await receiveTransfer(sb("gm"), U.gm, {
      tenantId: T,
      transferId: created.id,
      lines: [{ lineId: beefLine, receivedQuantity: 2, rejectedQuantity: 0, damagedQuantity: 0 }],
    });
    expect(r.status).toBe("partially_received");
  });

  /* ---------------- Regression ---------------- */

  it("6, 28. property-level purchasing still works when central-store mode is off", async () => {
    const po = await createPurchaseOrder(sb("ownerB"), U.ownerB, {
      ...poInput(),
      tenantId: TB,
      supplierId: S_B,
      propertyId: P_B,
      lines: [{ description: "B Flour", inventoryItemId: I_B, quantity: 4, unitPrice: 2000 }],
    });
    expect(
      sql(
        `SELECT property_id||'|'||coalesce(location_id::text,'-') FROM public.restaurant_purchase_orders WHERE id='${po.id}'`,
      ),
    ).toBe(`${P_B}|-`);
    await expect(
      createPurchaseOrder(sb("ownerB"), U.ownerB, { ...poInput(), tenantId: TB, supplierId: S_B }),
    ).rejects.toThrow(/PO_DESTINATION_UNRESOLVED/);
    // An explicit property store works and is received there.
    const stored = await createPurchaseOrder(sb("ownerB"), U.ownerB, {
      ...poInput(),
      tenantId: TB,
      supplierId: S_B,
      locationId: L_B,
      lines: [{ description: "B Flour", inventoryItemId: I_B, quantity: 4, unitPrice: 2000 }],
    });
    expect(
      sql(`SELECT property_id FROM public.restaurant_purchase_orders WHERE id='${stored.id}'`),
    ).toBe(P_B);
  });

  it("29. property-scoped staff keep their property purchasing workflow", async () => {
    const po = await createPurchaseOrder(
      sb("karManager"),
      U.karManager,
      poInput({ locationId: L_KAR, propertyId: P_KAR }),
    );
    const { data } = await sb("karManager")
      .from("restaurant_purchase_orders")
      .select("id, property_id")
      .eq("id", po.id);
    expect(data).toEqual([{ id: po.id, property_id: P_KAR }]);
    // …but cannot place an order into the central store.
    await expect(
      createPurchaseOrder(sb("karManager"), U.karManager, poInput({ propertyId: P_KAR })),
    ).rejects.toThrow(/Forbidden/);
  });

  it("30. tenant isolation holds for central-store data", async () => {
    const { data } = await sb("ownerB")
      .from("restaurant_purchase_orders")
      .select("id")
      .eq("tenant_id", T);
    expect(data).toEqual([]);
    await expect(getMainStoreOverview(sb("ownerB"), U.ownerB, T)).rejects.toThrow(/Forbidden/);
  });

  it("31. the Main Store workspace shows real records, reconciliation and exceptions", async () => {
    // A legacy unassigned order (pre-0157 shape) is surfaced, not hidden or rewritten.
    const legacy = id();
    sql(`
      BEGIN;
      SET LOCAL session_replication_role = replica;
      INSERT INTO public.restaurant_purchase_orders (id, tenant_id, supplier_id, reference, status)
      VALUES ('${legacy}', '${T}', '${S_INACTIVE}', 'LEGACY-${legacy.slice(0, 6)}', 'submitted');
      INSERT INTO public.restaurant_purchase_order_items (tenant_id, purchase_order_id, description, quantity, unit_price, line_total)
      VALUES ('${T}', '${legacy}', 'Legacy bitters', 10, 0, 0);
      COMMIT;
    `);
    const overview: any = await getMainStoreOverview(sb("owner"), U.owner, T);
    expect(overview.reconciliation.reconciled).toBe(true);
    expect(overview.incomingOrders.length).toBeGreaterThan(0);
    expect(overview.receipts.length).toBeGreaterThan(0);
    expect(overview.movements.length).toBeGreaterThan(0);
    const kinds = overview.exceptions
      .filter((e: any) => e.entityId === legacy)
      .map((e: any) => e.kind);
    expect(kinds).toEqual(
      expect.arrayContaining([
        "unassigned_purchase_order",
        "inactive_supplier_on_open_order",
        "unpriced_order_line",
      ]),
    );
    await expect(
      transitionPurchaseOrder(sb("gm"), U.gm, { tenantId: T, id: legacy, status: "approved" }),
    ).rejects.toThrow(/PO_DESTINATION_UNRESOLVED/);
    await transitionPurchaseOrder(sb("gm"), U.gm, {
      tenantId: T,
      id: legacy,
      status: "cancelled",
      reason: "Unassigned legacy order re-raised to the Main Store",
    });
    expect(sql(`SELECT status FROM public.restaurant_purchase_orders WHERE id='${legacy}'`)).toBe(
      "cancelled",
    );
  });
});
