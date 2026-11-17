/* eslint-disable @typescript-eslint/no-explicit-any -- fake Supabase client is untyped at this boundary. */
import { describe, expect, it } from "vitest";
import {
  classifyMatchOutcome,
  listPreferredSuppliers,
  matchLocationEntities,
  matchMenuEntities,
  matchSupplierEntities,
} from "./entity-matchers.server";
import type { CatalogMatchResult } from "../catalog/matching";

const TENANT = "11111111-1111-1111-1111-111111111111";
const OTHER_TENANT = "99999999-9999-9999-9999-999999999999";
const USER = "22222222-2222-2222-2222-222222222222";

function makeFakeSupabase(rowsByTable: Record<string, any[]>) {
  function builder(table: string) {
    const filters: Array<[string, unknown]> = [];
    const api: any = {
      select: () => api,
      eq: (col: string, val: unknown) => {
        filters.push([col, val]);
        return api;
      },
      then: (resolve: any) => {
        if (table === "restaurant_members") {
          return resolve({
            data: [{ tenant_id: TENANT, user_id: USER, role: "inventory_manager" }],
            error: null,
          });
        }
        const rows = rowsByTable[table] ?? [];
        const tenantFilter = filters.find(([c]) => c === "tenant_id");
        const filtered = tenantFilter ? rows.filter((r) => r.tenant_id === tenantFilter[1]) : rows;
        return resolve({ data: filtered, error: null });
      },
    };
    return api;
  }
  return {
    from: (table: string) => builder(table),
    rpc: async (fn: string) =>
      fn === "has_any_role" ? { data: false, error: null } : { data: null, error: null },
  };
}

describe("matchMenuEntities", () => {
  it("resolves a menu item by fuzzy name within the caller's tenant", async () => {
    const sb = makeFakeSupabase({
      restaurant_menu_items: [
        {
          id: "mi-1",
          name: "Margherita Pizza",
          slug: "margherita-pizza",
          available: true,
          tenant_id: TENANT,
        },
        {
          id: "mi-2",
          name: "Margherita Pizza",
          slug: "margherita-pizza",
          available: true,
          tenant_id: OTHER_TENANT,
        },
      ],
    });
    const ranked = await matchMenuEntities(sb as any, USER, {
      tenantId: TENANT,
      name: "margherita",
    });
    expect(ranked[0]!.candidate.id).toBe("mi-1"); // never the other tenant's row
  });
});

describe("matchLocationEntities", () => {
  it("resolves 'Kitchen' against real restaurant_locations rows", async () => {
    const sb = makeFakeSupabase({
      restaurant_locations: [
        { id: "loc-1", code: "MAIN", name: "Main Store", status: "active", tenant_id: TENANT },
        { id: "loc-2", code: "KITCHEN", name: "Kitchen", status: "active", tenant_id: TENANT },
      ],
    });
    const ranked = await matchLocationEntities(sb as any, USER, {
      tenantId: TENANT,
      name: "Kitchen",
    });
    expect(ranked[0]!.candidate.id).toBe("loc-2");
    expect(ranked[0]!.confidence).toBe("exact");
  });
});

describe("matchSupplierEntities / listPreferredSuppliers", () => {
  it("matches a named supplier by fuzzy name", async () => {
    const sb = makeFakeSupabase({
      restaurant_suppliers: [
        {
          id: "sup-1",
          code: "MET",
          name: "Metro Wholesale",
          status: "active",
          tenant_id: TENANT,
          metadata: {},
        },
      ],
    });
    const ranked = await matchSupplierEntities(sb as any, USER, {
      tenantId: TENANT,
      name: "Metro Wholesale",
    });
    expect(ranked[0]!.candidate.id).toBe("sup-1");
  });

  it("lists only suppliers flagged preferred for this tenant", async () => {
    const sb = makeFakeSupabase({
      restaurant_suppliers: [
        {
          id: "sup-1",
          code: "A",
          name: "Supplier A",
          status: "active",
          tenant_id: TENANT,
          metadata: { preferred: true },
        },
        {
          id: "sup-2",
          code: "B",
          name: "Supplier B",
          status: "active",
          tenant_id: TENANT,
          metadata: { preferred: false },
        },
        {
          id: "sup-3",
          code: "C",
          name: "Supplier C",
          status: "active",
          tenant_id: OTHER_TENANT,
          metadata: { preferred: true },
        },
      ],
    });
    const preferred = await listPreferredSuppliers(sb as any, USER, TENANT);
    expect(preferred.map((p) => p.id)).toEqual(["sup-1"]);
  });
});

describe("classifyMatchOutcome — ambiguity semantics (reused from Import Studio's stage.ts precedent)", () => {
  function resultAt(id: string, name: string, score: number): CatalogMatchResult {
    return {
      candidate: { id, sku: id, name },
      score,
      confidence:
        score >= 0.999 ? "exact" : score >= 0.7 ? "high" : score >= 0.4 ? "medium" : "low",
      evidence: [],
    };
  }

  it("EXACT: a single clear winner resolves", () => {
    const outcome = classifyMatchOutcome([resultAt("a", "Beef Fillet", 1)]);
    expect(outcome).toMatchObject({ status: "exact", resolvedId: "a" });
  });

  it("HIGH: a strong but non-exact single winner resolves", () => {
    const outcome = classifyMatchOutcome([resultAt("a", "Beef Fillet Premium", 0.8)]);
    expect(outcome).toMatchObject({ status: "high", resolvedId: "a" });
  });

  it("AMBIGUOUS: two candidates within 0.05 of each other never resolve, even at 'exact' tier — the top candidate is never silently picked", () => {
    const outcome = classifyMatchOutcome([
      resultAt("a", "Beef Fillet", 1),
      resultAt("b", "Beef Topside", 0.97),
    ]);
    expect(outcome.status).toBe("ambiguous");
    expect(outcome.resolvedId).toBeNull();
    expect(outcome.candidates.length).toBeGreaterThanOrEqual(2);
  });

  it("AMBIGUOUS: three plausible candidates ('beef' matching Fillet/Topside/Mince) surfaces candidates, resolves nothing", () => {
    const outcome = classifyMatchOutcome([
      resultAt("a", "Beef Fillet", 0.5),
      resultAt("b", "Beef Topside", 0.5),
      resultAt("c", "Beef Mince", 0.48),
    ]);
    expect(outcome.status).toBe("ambiguous");
    expect(outcome.resolvedId).toBeNull();
  });

  it("UNRESOLVED: nothing above the floor", () => {
    const outcome = classifyMatchOutcome([]);
    expect(outcome).toEqual({
      status: "unresolved",
      resolvedId: null,
      resolvedName: null,
      candidates: [],
    });
  });

  it("UNRESOLVED: a single weak candidate is not confident enough to resolve, but is still surfaced", () => {
    const outcome = classifyMatchOutcome([resultAt("a", "Something Unrelated", 0.2)]);
    expect(outcome.status).toBe("unresolved");
    expect(outcome.resolvedId).toBeNull();
    expect(outcome.candidates).toHaveLength(1);
  });
});
