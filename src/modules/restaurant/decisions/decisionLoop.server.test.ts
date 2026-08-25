/* eslint-disable @typescript-eslint/no-explicit-any -- fake Supabase rows are untyped at this boundary. */
/**
 * I4 — the real finding → decision → persistence loop, proven at the
 * application-code layer.
 *
 * This calls the REAL restaurant/intelligence/purchasing.server.ts,
 * restaurant/decisions/findings.ts, restaurantDecisionEngine.ts and
 * decisions.server.ts — not stubs of them — against a fake Supabase client
 * seeded with rows shaped exactly like the live schema (restaurant_inventory_
 * items, restaurant_stock_movements, restaurant_supplier_products,
 * restaurant_suppliers). It proves the deterministic engine turns real
 * operational data into a real purchasing_replenishment finding, and that
 * runRestaurantDecisionPass persists it idempotently — the same methodology
 * decision.server.test.ts and actions.server.test.ts use for the rest of the
 * loop.
 *
 * restaurant_members is empty for every tenant in the live database (see I3,
 * reconfirmed in I4), so there is currently no way to run this same chain
 * over a real authenticated HTTP session — see the I4 report for what that
 * means for live UAT.
 */
import { describe, expect, it } from "vitest";
import { runRestaurantDecisionPass } from "./decisions.server";

import "@/modules/restaurant/intelligence/provider";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const MANAGER = "22222222-2222-2222-2222-222222222222";
const ITEM_ID = "33333333-3333-3333-3333-333333333333";
const SUPPLIER_ID = "44444444-4444-4444-4444-444444444444";

function makeFakeSupabase() {
  const inventoryItems = [
    {
      id: ITEM_ID,
      name: "UAT reorder ingredient",
      current_quantity: 10,
      reorder_point: null,
      average_cost: 1200,
      currency: "TZS",
      status: "active",
    },
  ];
  const stockMovements = [
    {
      inventory_item_id: ITEM_ID,
      movement_type: "consumption",
      quantity: 30,
      total_cost: 36000,
      occurred_at: new Date(Date.now() - 2 * 864e5).toISOString(),
    },
    {
      inventory_item_id: ITEM_ID,
      movement_type: "consumption",
      quantity: 30,
      total_cost: 36000,
      occurred_at: new Date(Date.now() - 10 * 864e5).toISOString(),
    },
    {
      inventory_item_id: ITEM_ID,
      movement_type: "consumption",
      quantity: 30,
      total_cost: 36000,
      occurred_at: new Date(Date.now() - 20 * 864e5).toISOString(),
    },
  ];
  const supplierProducts = [
    {
      supplier_id: SUPPLIER_ID,
      inventory_item_id: ITEM_ID,
      name: "UAT reorder ingredient",
      unit_price: 1300,
      lead_time_days: 3,
      active: true,
    },
  ];
  const suppliers = [
    {
      id: SUPPLIER_ID,
      name: "UAT supplier",
      lead_time_days: 3,
      reliability_score: null,
      status: "active",
    },
  ];

  const decisions: Record<string, any> = {};
  const plans: Record<string, any> = {};
  const planSteps: Record<string, any> = {};
  const calls: Array<{ table: string; op: string }> = [];
  let decisionSeq = 0;
  let planSeq = 0;

  function builder(table: string) {
    const filters: Record<string, unknown> = {};
    let op: "select" | "update" | "insert" = "select";
    let payload: any;

    const api: any = {
      select: () => api,
      eq: (col: string, val: unknown) => {
        filters[col] = val;
        return api;
      },
      gte: () => api,
      lte: () => api,
      order: () => api,
      limit: () => api,
      in: () => api,
      not: () => api,
      update: (patch: any) => {
        op = "update";
        payload = patch;
        return api;
      },
      insert: (row: any) => {
        op = "insert";
        payload = row;
        return api;
      },
      single: () => resolve(true),
      maybeSingle: () => resolve(false),
      then: (onFulfilled: any, onRejected: any) => resolve(false).then(onFulfilled, onRejected),
    };

    async function resolve(single: boolean) {
      calls.push({ table, op });

      if (op === "select") {
        if (table === "restaurant_inventory_items") return { data: inventoryItems, error: null };
        if (table === "restaurant_stock_movements") return { data: stockMovements, error: null };
        if (table === "restaurant_supplier_products")
          return { data: supplierProducts, error: null };
        if (table === "restaurant_suppliers") return { data: suppliers, error: null };
        if (table === "restaurant_purchase_orders") return { data: [], error: null };
        if (table === "restaurant_members") {
          const rows =
            filters.tenant_id === TENANT_A && filters.user_id === MANAGER
              ? [{ tenant_id: TENANT_A, user_id: MANAGER, role: "restaurant_manager" }]
              : [];
          return { data: rows, error: null };
        }
        if (table === "intelligence_decisions") {
          if (filters.decision_key) {
            const existing = Object.values(decisions).find(
              (d: any) =>
                d.decision_key === filters.decision_key && d.tenant_id === filters.tenant_id,
            );
            return { data: existing ?? null, error: null };
          }
          return { data: Object.values(decisions), error: null };
        }
        return { data: single ? null : [], error: null };
      }

      if (op === "insert") {
        if (table === "intelligence_decisions") {
          decisionSeq += 1;
          const id = `decision-${decisionSeq}`;
          decisions[id] = { id, ...payload };
          return { data: { id }, error: null };
        }
        if (table === "intelligence_plans") {
          planSeq += 1;
          const id = `plan-${planSeq}`;
          plans[id] = { id, ...payload };
          return { data: { id }, error: null };
        }
        if (table === "intelligence_plan_steps") {
          for (const s of Array.isArray(payload) ? payload : [payload]) {
            planSteps[`${s.plan_id}-${s.sequence}`] = s;
          }
          return { data: null, error: null };
        }
        return { data: { id: "generated" }, error: null };
      }
      return { data: null, error: null };
    }

    return api;
  }

  return {
    supabase: {
      from: (table: string) => builder(table),
      rpc: async (fn: string) => {
        if (fn === "has_any_role") return { data: false, error: null };
        return { data: null, error: null };
      },
    },
    calls,
    decisions,
    plans,
  };
}

describe("real finding → decision → persistence loop (purchasing intelligence)", () => {
  it("produces a genuine purchasing_replenishment finding from real operational data and persists it", async () => {
    const fake = makeFakeSupabase();

    const result = await runRestaurantDecisionPass(fake.supabase, MANAGER, {
      tenantId: TENANT_A,
      windowDays: 30,
      persist: true,
    });

    expect(result.findings).toBeGreaterThan(0);
    expect(result.decisionsRecorded).toBeGreaterThan(0);
    expect(result.plansCreated).toBe(result.decisionsRecorded);

    const purchasingDecision = Object.values(fake.decisions).find((d: any) =>
      d.decision_key.includes(`finding.purchasing.${ITEM_ID}`),
    ) as any;
    expect(purchasingDecision).toBeDefined();
    expect(purchasingDecision.tenant_id).toBe(TENANT_A);
    expect(purchasingDecision.module).toBe("restaurant");

    const finding = purchasingDecision.context.finding;
    expect(finding.kind).toBe("purchasing_replenishment");
    // The structured facts a governed procurement executor needs — proves
    // the I4 fix to findings.ts actually reaches persisted decisions.
    expect(finding.facts.inventoryItemId).toBe(ITEM_ID);
    expect(finding.facts.supplierId).toBe(SUPPLIER_ID);
    expect(finding.facts.recommendedQuantity).toBeGreaterThan(0);

    const recommended = purchasingDecision.options.find(
      (o: any) => o.option.key === purchasingDecision.recommended_option_key,
    );
    expect(recommended?.option.actionType).toBe("restaurant.purchase.suggest");
  });

  it("is idempotent — running the same pass twice never duplicates the decision", async () => {
    const fake = makeFakeSupabase();

    const first = await runRestaurantDecisionPass(fake.supabase, MANAGER, {
      tenantId: TENANT_A,
      windowDays: 30,
      persist: true,
    });
    const second = await runRestaurantDecisionPass(fake.supabase, MANAGER, {
      tenantId: TENANT_A,
      windowDays: 30,
      persist: true,
    });

    expect(first.decisionsRecorded).toBeGreaterThan(0);
    expect(second.decisionsRecorded).toBe(0); // every decision_key already existed
    expect(Object.keys(fake.decisions)).toHaveLength(first.decisionsRecorded);
  });
});
