/* eslint-disable @typescript-eslint/no-explicit-any -- fake Supabase rows are untyped at this boundary. */
/**
 * P0 — purchase order reference collision (regression).
 *
 * Reported bug: "duplicate key value violates unique constraint
 * restaurant_purchase_orders_tenant_id_reference_key" during manual PO
 * creation. Root cause, confirmed against the live UAT tenant:
 *
 *   1. createPurchaseOrder let a client-supplied `reference` (the PO form's
 *      free-text reference field) go straight into the unique-constrained
 *      column with no existence check. The UI's create dialog does not
 *      reset its form state on a failed submit, so a tester resubmitting
 *      after a first failure sent the exact same reference again.
 *   2. Because `nextDocumentNumber()` commits its sequence increment in a
 *      separate statement from the row insert that follows it, every one
 *      of those doomed resubmits still consumed a document number before
 *      failing — live evidence: the tenant's `purchase_order` sequence
 *      had reached next_number=8 while exactly one PO row existed.
 *
 * The fix (purchasing.server.ts / procurement/audit.server.ts):
 *   - An explicit `reference` is checked for an existing collision BEFORE
 *     any sequence number is consumed, and fails fast with a clear,
 *     actionable error — a retry with the same value gets the same clear
 *     rejection every time, never a raw Postgres constraint violation, and
 *     never burns another document number.
 *   - An auto-generated reference (no explicit value given) is collision-
 *     safe: insertWithUniqueDocumentNumber retries with a freshly
 *     generated number if the insert still collides (e.g. legacy/imported
 *     data the sequence doesn't know about), bounded so a genuinely broken
 *     sequence can't loop forever.
 */
import { describe, expect, it } from "vitest";
import { createPurchaseOrder } from "./purchasing.server";

const TENANT = "11111111-1111-1111-1111-111111111111";
const OTHER_TENANT = "99999999-9999-9999-9999-999999999999";
const USER = "22222222-2222-2222-2222-222222222222";

const PO_REFERENCE_CONSTRAINT = "restaurant_purchase_orders_tenant_id_reference_key";

function baseInput(overrides: Partial<Record<string, any>> = {}) {
  return {
    tenantId: TENANT,
    currency: "TZS",
    directReason: "UAT regression test",
    lines: [{ description: "Test item", quantity: 1, unitPrice: 1000 }],
    ...overrides,
  } as any;
}

/**
 * Mirrors the real schema exactly enough to reproduce the bug: an
 * in-memory per-(tenant,doc_type) counter for restaurant_next_document_number
 * (atomic — each call always returns a fresh, never-repeated number, exactly
 * like the real `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` function),
 * and a restaurant_purchase_orders table that enforces the real
 * UNIQUE (tenant_id, reference) constraint, including the real Postgres
 * error code and constraint name.
 */
function makeFakeSupabase(seedReferences: Array<{ tenantId: string; reference: string }> = []) {
  const sequences = new Map<string, number>();
  const purchaseOrders: any[] = seedReferences.map((s, i) => ({
    id: `seed-${i}`,
    tenant_id: s.tenantId,
    reference: s.reference,
  }));
  const purchaseOrderItems: any[] = [];
  let seq = 0;

  function nextSequenceNumber(tenantId: string, docType: string): number {
    const key = `${tenantId}:${docType}`;
    const next = (sequences.get(key) ?? 0) + 1;
    sequences.set(key, next);
    return next;
  }

  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let op: "select" | "insert" = "select";
    let payload: any;
    const api: any = {
      select: () => api,
      eq(col: string, val: unknown) {
        filters.push((r: any) => r[col] === val);
        return api;
      },
      order: () => api,
      limit: () => api,
      insert(row: any) {
        op = "insert";
        payload = row;
        return api;
      },
      maybeSingle: () => resolve("maybeSingle"),
      single: () => resolve("single"),
      then: (onFulfilled: any, onRejected: any) => resolve("list").then(onFulfilled, onRejected),
    };

    async function resolve(mode: "single" | "maybeSingle" | "list") {
      if (table === "restaurant_members") {
        return { data: [{ tenant_id: TENANT, user_id: USER, role: "owner" }], error: null };
      }
      if (table === "restaurant_purchase_orders") {
        if (op === "insert") {
          const violates = purchaseOrders.some(
            (r) => r.tenant_id === payload.tenant_id && r.reference === payload.reference,
          );
          if (violates) {
            return {
              data: null,
              error: {
                code: "23505",
                message: `duplicate key value violates unique constraint "${PO_REFERENCE_CONSTRAINT}"`,
              },
            };
          }
          seq += 1;
          const stored = { id: `po-${seq}`, ...payload };
          purchaseOrders.push(stored);
          return { data: stored, error: null };
        }
        const rows = purchaseOrders.filter((r) => filters.every((f) => f(r)));
        if (mode === "list") return { data: rows, error: null };
        return { data: rows[0] ?? null, error: null };
      }
      if (table === "restaurant_purchase_order_items") {
        if (op === "insert") {
          const rows = Array.isArray(payload) ? payload : [payload];
          purchaseOrderItems.push(...rows);
          return { data: null, error: null };
        }
        return { data: [], error: null };
      }
      if (table === "restaurant_procurement_audit") {
        return { data: null, error: null };
      }
      return { data: mode === "list" ? [] : null, error: null };
    }
    return api;
  }

  return {
    supabase: {
      from: (table: string) => from(table),
      rpc: async (fn: string, args: any) => {
        if (fn === "has_any_role") return { data: false, error: null };
        if (fn === "restaurant_next_document_number") {
          const n = nextSequenceNumber(args._tenant, args._doc_type);
          const prefix = args._prefix || "DOC";
          return { data: `${prefix}-2026-${String(n).padStart(5, "0")}`, error: null };
        }
        return { data: null, error: null };
      },
    },
    purchaseOrders,
    purchaseOrderItems,
    sequences,
  };
}

describe("createPurchaseOrder — reference uniqueness (P0 regression)", () => {
  it("multiple POs created without an explicit reference each get a unique, auto-generated reference", async () => {
    const fake = makeFakeSupabase();
    const a = await createPurchaseOrder(fake.supabase, USER, baseInput());
    const b = await createPurchaseOrder(fake.supabase, USER, baseInput());
    const c = await createPurchaseOrder(fake.supabase, USER, baseInput());

    const references = [a.reference, b.reference, c.reference];
    expect(new Set(references).size).toBe(3); // no duplicates
    expect(fake.purchaseOrders).toHaveLength(3);
  });

  it("an explicit reference that does not yet exist succeeds and is stored verbatim, not replaced by the generated document number", async () => {
    const fake = makeFakeSupabase();
    const po = await createPurchaseOrder(
      fake.supabase,
      USER,
      baseInput({ reference: "SUPPLIER-PO-0042" }),
    );
    expect(po.reference).toBe("SUPPLIER-PO-0042");
    expect(po.document_number).toMatch(/^PO-2026-\d{5}$/); // still generated, just not used as the reference
  });

  it("THE REPORTED BUG: resubmitting the exact same explicit reference twice — as the UI does on a failed submit — fails fast and clearly both times, never a raw duplicate-key error, and never creates a second row", async () => {
    const fake = makeFakeSupabase();
    const input = baseInput({ reference: "PO-TEST-001" });

    const first = await createPurchaseOrder(fake.supabase, USER, input);
    expect(first.reference).toBe("PO-TEST-001");

    // The exact retry scenario observed in the live UAT tenant: the same
    // caller, the same input, submitted again.
    await expect(createPurchaseOrder(fake.supabase, USER, input)).rejects.toThrow(
      /a purchase order with reference "PO-TEST-001" already exists/i,
    );
    // And a third, fourth, fifth resubmit — never "eventually succeeds" with
    // a mutated reference, never a raw 23505 leaking through.
    await expect(createPurchaseOrder(fake.supabase, USER, input)).rejects.toThrow(
      /already exists/i,
    );

    expect(fake.purchaseOrders).toHaveLength(1); // only the first attempt ever created a row
  });

  it("RETRY IS COLLISION-SAFE: resubmitting the same explicit reference never burns a document number on the doomed attempt — the sequence counter only advances for the one attempt that could ever succeed", async () => {
    const fake = makeFakeSupabase();
    const input = baseInput({ reference: "PO-TEST-001" });

    await createPurchaseOrder(fake.supabase, USER, input); // succeeds, consumes exactly one number
    const afterFirst = fake.sequences.get(`${TENANT}:purchase_order`);

    await expect(createPurchaseOrder(fake.supabase, USER, input)).rejects.toThrow(
      /already exists/i,
    );
    await expect(createPurchaseOrder(fake.supabase, USER, input)).rejects.toThrow(
      /already exists/i,
    );

    // The failed pre-check rejections never even call the generator — the
    // exact defect that produced next_number=8 against a single real row
    // in the live tenant.
    expect(fake.sequences.get(`${TENANT}:purchase_order`)).toBe(afterFirst);
  });

  it("COLLISION/RETRY SCENARIO: an auto-generated document number that collides with a pre-existing reference (e.g. legacy/imported data the sequence never learned about) is retried with a fresh number instead of throwing", async () => {
    // Seed a PO whose reference is EXACTLY what the very first generated
    // document number would be for a fresh sequence — reproducing an
    // import/seed drift where historical references were inserted outside
    // nextDocumentNumber and the counter was never synced against them.
    const fake = makeFakeSupabase([{ tenantId: TENANT, reference: "PO-2026-00001" }]);

    const po = await createPurchaseOrder(fake.supabase, USER, baseInput());

    // Never the colliding number, and the collision never surfaced as an error.
    expect(po.reference).not.toBe("PO-2026-00001");
    expect(po.reference).toMatch(/^PO-2026-\d{5}$/);
    expect(fake.purchaseOrders.filter((r) => r.reference === po.reference)).toHaveLength(1);
  });

  it("tenant isolation: an identical reference is allowed in a DIFFERENT tenant — the uniqueness check is scoped to (tenant_id, reference), never global", async () => {
    const fake = makeFakeSupabase([{ tenantId: OTHER_TENANT, reference: "PO-TEST-001" }]);
    const po = await createPurchaseOrder(
      fake.supabase,
      USER,
      baseInput({ reference: "PO-TEST-001" }),
    );
    expect(po.reference).toBe("PO-TEST-001");
    expect(
      fake.purchaseOrders.filter((r) => r.tenant_id === TENANT && r.reference === "PO-TEST-001"),
    ).toHaveLength(1);
    expect(
      fake.purchaseOrders.filter(
        (r) => r.tenant_id === OTHER_TENANT && r.reference === "PO-TEST-001",
      ),
    ).toHaveLength(1);
  });
});
