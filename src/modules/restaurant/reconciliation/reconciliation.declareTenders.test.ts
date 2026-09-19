/* eslint-disable @typescript-eslint/no-explicit-any -- fake Supabase rows are untyped at this boundary. */
/**
 * ME-04: declareTenders' revision handling.
 *
 * restaurant_tender_declaration_control (DB trigger, migration 0076)
 * requires a corrected declaration (declared_amount changing on an
 * existing row) to carry revision = previous revision + 1 and a
 * revision_reason of at least 5 characters, or it rejects the write.
 * declareTenders previously used a single .upsert(..., {onConflict}) call
 * that never set either column — and an INSERT ... ON CONFLICT DO UPDATE
 * can't be patched to set them correctly either: Postgres fires the
 * BEFORE INSERT trigger (forcing revision:=1) before the conflict is even
 * known, so EXCLUDED.revision is always 1 by the time the DO UPDATE branch
 * runs. Every correction failed in production. Reproduced against a local
 * Postgres replica, then fixed by using a genuine UPDATE for an existing
 * row (proven against the same replica to respect the trigger correctly)
 * instead of upsert. See migration 0078's sibling doc and
 * docs/me-04/ME-04-financial-integrity.md.
 *
 * This test exercises declareTenders' own logic (does it call insert vs.
 * update, with what revision/revision_reason) — the trigger's own
 * behavior was proven separately against a real Postgres instance, not
 * re-derived here.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../core/access.server", () => ({
  assertCapability: vi.fn(async () => true),
}));
vi.mock("../events/emit.server", () => ({ emitRestaurantEvent: vi.fn(async () => undefined) }));

const { declareTenders } = await import("./reconciliation.server");

const TENANT = "11111111-1111-1111-1111-111111111111";
const USER = "22222222-2222-2222-2222-222222222222";
const CLOSE = "33333333-3333-3333-3333-333333333333";

function makeFixture(existingDeclarations: any[] = []) {
  const closes = [
    {
      id: CLOSE,
      tenant_id: TENANT,
      location_id: null,
      business_date: "2026-01-01",
      status: "draft",
      opening_float: 0,
      currency: "USD",
    },
  ];
  const declarations = existingDeclarations.map((d) => ({ ...d }));
  const audit: any[] = [];
  const calls: Array<{ op: string; table: string; payload?: any }> = [];

  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let op: "select" | "insert" | "update" = "select";
    let payload: any;
    const api: any = {
      select: () => api,
      eq(col: string, val: unknown) {
        filters.push((r: any) => r[col] === val);
        return api;
      },
      gte: () => api,
      lt: () => api,
      order: () => api,
      limit: () => api,
      insert(row: any) {
        op = "insert";
        payload = row;
        return api;
      },
      update(patch: any) {
        op = "update";
        payload = patch;
        return api;
      },
      maybeSingle: () => resolve("maybeSingle"),
      single: () => resolve("single"),
      then: (onFulfilled: any, onRejected: any) => resolve("list").then(onFulfilled, onRejected),
    };

    function rowsFor(): any[] {
      if (table === "restaurant_daily_closes") return closes;
      if (table === "restaurant_tender_declarations") return declarations;
      if (table === "restaurant_reconciliation_audit") return audit;
      if (table === "restaurant_orders") return [];
      return [];
    }

    async function resolve(mode: "single" | "maybeSingle" | "list") {
      if (op === "insert") {
        calls.push({ op: "insert", table, payload });
        const stored = { id: `row-${declarations.length + 1}`, ...payload };
        rowsFor().push(stored);
        return { data: stored, error: null };
      }
      const matches = (r: any) => filters.every((f) => f(r));
      if (op === "update") {
        calls.push({ op: "update", table, payload });
        const rows = rowsFor().filter(matches);
        for (const r of rows) Object.assign(r, payload);
        return { data: rows[0] ?? null, error: null };
      }
      const rows = rowsFor().filter(matches);
      if (mode === "list") return { data: rows, error: null };
      return {
        data: rows[0] ?? null,
        error: mode === "single" && !rows[0] ? { message: "not found" } : null,
      };
    }
    return api;
  }

  return {
    supabase: { from, rpc: async () => ({ data: null, error: null }) },
    declarations,
    calls,
  };
}

describe("declareTenders — revision handling (ME-04)", () => {
  it("a brand-new declaration is inserted, never updated", async () => {
    const fixture = makeFixture([]);
    await declareTenders(fixture.supabase, USER, {
      tenantId: TENANT,
      closeId: CLOSE,
      declarations: [{ method: "cash", declaredAmount: 100 }],
    } as any);

    const declCalls = fixture.calls.filter((c) => c.table === "restaurant_tender_declarations");
    expect(declCalls).toHaveLength(1);
    expect(declCalls[0].op).toBe("insert");
  });

  it("re-declaring the same amount updates without requiring a reason and leaves revision unchanged", async () => {
    const fixture = makeFixture([
      { tenant_id: TENANT, close_id: CLOSE, method: "cash", declared_amount: 100, revision: 1 },
    ]);
    await declareTenders(fixture.supabase, USER, {
      tenantId: TENANT,
      closeId: CLOSE,
      declarations: [{ method: "cash", declaredAmount: 100 }],
    } as any);

    const declCalls = fixture.calls.filter((c) => c.table === "restaurant_tender_declarations");
    expect(declCalls[0].op).toBe("update");
    expect(declCalls[0].payload.revision).toBe(1);
    expect(declCalls[0].payload.revision_reason).toBeNull();
  });

  it("correcting a declared amount without a reason is rejected before any write is attempted", async () => {
    const fixture = makeFixture([
      { tenant_id: TENANT, close_id: CLOSE, method: "cash", declared_amount: 100, revision: 1 },
    ]);
    await expect(
      declareTenders(fixture.supabase, USER, {
        tenantId: TENANT,
        closeId: CLOSE,
        declarations: [{ method: "cash", declaredAmount: 130 }],
      } as any),
    ).rejects.toThrow(/requires a reason/);

    const declCalls = fixture.calls.filter((c) => c.table === "restaurant_tender_declarations");
    expect(declCalls).toHaveLength(0);
    expect(fixture.declarations[0].declared_amount).toBe(100);
  });

  it("correcting a declared amount with a reason increments revision and records the reason", async () => {
    const fixture = makeFixture([
      { tenant_id: TENANT, close_id: CLOSE, method: "cash", declared_amount: 100, revision: 1 },
    ]);
    await declareTenders(fixture.supabase, USER, {
      tenantId: TENANT,
      closeId: CLOSE,
      declarations: [{ method: "cash", declaredAmount: 130, notes: "recount found more cash" }],
    } as any);

    const declCalls = fixture.calls.filter((c) => c.table === "restaurant_tender_declarations");
    expect(declCalls[0].op).toBe("update");
    expect(declCalls[0].payload.revision).toBe(2);
    expect(declCalls[0].payload.revision_reason).toBe("recount found more cash");
    expect(fixture.declarations[0].declared_amount).toBe(130);
  });
});
